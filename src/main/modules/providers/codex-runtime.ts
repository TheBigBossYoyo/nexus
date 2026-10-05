import { READ_ONLY_ROLES } from '@shared/provider'
import type { AuthStatus } from '@shared/auth'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import type { AgentEvent, AgentRuntime, AgentSessionHandle, RuntimeCapabilities, SessionSpec, TurnResult, UsageInfo } from '@main/modules/agent-runtime'
import { runCli } from './cli'

/**
 * Sessions through the Codex command line tool (`codex exec --json`), which carries its own login. NEXUS
 * starts the tool, writes the prompt to its stdin and reads its JSON events; it never sees a credential.
 *
 * What differs from a Claude session, and is stated in the provider's capabilities:
 * - Tool calls are not authorized by NEXUS. The agent is confined by the Codex sandbox, which NEXUS always
 *   starts read-only: a Codex agent reviews, researches and criticises, and changes nothing. NEXUS checks
 *   afterwards that the working directory is as it was.
 * - The NEXUS agent tools (messages, blockers, memory proposals) are not available to it.
 * - Structured output is asked for in the prompt and parsed from the answer.
 * - A turn is one process; its events are read when it ends, so the agent's output appears per turn, not live.
 * - A failure is an error of this session. It is never reported as a Claude usage limit.
 */
export const CODEX_TOOL = 'codex'
export const CODEX_DEFAULT_MODEL = 'gpt-5.5'
/** One turn of a reviewing agent. Longer than that and the turn is ended as an error. */
const TURN_TIMEOUT_MS = 30 * 60_000
/** A Codex session id. It is placed on the command line, so it must not be able to look like an option. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export interface CodexExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

export interface CodexRuntimeOptions {
  /** Test seam: runs one `codex` process to its end. The default runs the real command line tool. */
  exec?: (args: readonly string[], cwd: string, prompt: string, signal: AbortSignal) => Promise<CodexExecResult>
  /** The state of a working directory, to prove a read-only session changed nothing. */
  snapshot?: (cwd: string) => Promise<string | null>
  defaultModel?: string
  version?: () => string | null
}

/** The arguments of one turn. Everything here is a fixed flag or a checked token; the prompt is not among them. */
export function codexArgs(input: { model: string; resumeSessionId?: string | null }): string[] {
  if (!MODEL.test(input.model)) throw new Error(`Not a model name: ${JSON.stringify(input.model)}`)
  if (input.resumeSessionId && !SESSION_ID.test(input.resumeSessionId)) throw new Error('Not a Codex session id')
  // The sandbox is also given as a configuration override, which is what applies to a resumed session.
  const common = ['--json', '--skip-git-repo-check', '-m', input.model, '-c', 'sandbox_mode=read-only']
  return input.resumeSessionId ? ['exec', 'resume', input.resumeSessionId, ...common, '-'] : ['exec', ...common, '-s', 'read-only', '--color', 'never', '-']
}

export function codexPrompt(spec: Pick<SessionSpec, 'systemPromptAppend' | 'prompt' | 'outputSchema'>): string {
  const parts = [spec.systemPromptAppend.trim(), spec.prompt.trim()].filter((p) => p.length > 0)
  parts.push('You are working read-only: inspect files and run read-only commands, and do not change, create or delete anything.')
  if (spec.outputSchema) {
    parts.push(`Finish with ONE JSON object that matches this JSON Schema, in a \`\`\`json fenced block, and nothing after it:\n${JSON.stringify(spec.outputSchema)}`)
  }
  return parts.join('\n\n')
}

function lastJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '').reverse()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  const candidates = first !== -1 && last > first ? [...fences, text.slice(first, last + 1)] : fences
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      // A structured answer is an object; a bare number, string or list is not one.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

interface CodexEvent {
  type?: string
  thread_id?: string
  item?: { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null }
  message?: string
  error?: { message?: string }
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
}

class CodexHandle implements AgentSessionHandle {
  readonly agentId: string
  readonly events: AsyncIterable<AgentEvent>
  private readonly queue = new AsyncQueue<AgentEvent>()
  private readonly inbox = new AsyncQueue<string>()
  private abort: AbortController | null = null
  private threadId: string | null
  private finished = false
  private stopped = false
  private started = false
  private readonly done: Promise<void>

  constructor(
    private readonly spec: SessionSpec,
    private readonly model: string,
    private readonly options: CodexRuntimeOptions,
    private readonly onFinished: (handle: CodexHandle) => void,
    private readonly onTainted: (cwd: string) => void,
  ) {
    this.agentId = spec.agentId
    this.events = this.queue
    this.threadId = spec.resumeSessionId ?? null
    this.done = this.run()
  }

  sessionId(): string | null {
    return this.threadId
  }

  send(text: string): void {
    this.inbox.push(text)
  }

  async interrupt(): Promise<void> {
    this.abort?.abort()
  }

  end(): void {
    this.inbox.close()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.inbox.close()
    this.abort?.abort()
    await Promise.race([this.done, new Promise<void>((r) => setTimeout(r, 3000).unref())])
    this.finish('stopped', null)
  }

  private finish(reason: 'completed' | 'stopped' | 'crashed', error: string | null): void {
    if (this.finished) return
    this.finished = true
    this.queue.push({ type: 'session.ended', reason, error })
    this.queue.close()
    this.onFinished(this)
  }

  private async run(): Promise<void> {
    try {
      const verify = this.options.snapshot
      const before = verify ? await verify(this.spec.cwd) : null
      // Fail closed: when NEXUS is set up to verify and cannot, the session does not run.
      if (verify && before === null) {
        this.finish('crashed', 'NEXUS could not record the state of the working directory (it is not a Git working tree, or Git failed), so it cannot verify that a read-only Codex session changes nothing. The session was not started.')
        return
      }
      let prompt: string | null = codexPrompt(this.spec)
      let turns = 0
      while (prompt !== null && !this.stopped) {
        const result = await this.turn(prompt)
        turns++
        if (this.stopped) break
        // Read-only is enforced by the Codex sandbox; NEXUS checks that it held.
        const after = verify ? await verify(this.spec.cwd) : null
        if (verify && (after === null || before !== after)) {
          const why = after === null ? 'NEXUS could not read the state of the working directory after the Codex session, so it cannot confirm that nothing changed.' : 'The Codex session changed the working directory although it was started read-only.'
          // The directory is not trusted again for a Codex session: a second attempt would start from the changed state and pass.
          this.onTainted(this.spec.cwd)
          this.queue.push({ type: 'turn.completed', result: { ...result, text: '', outcome: 'error', structuredOutput: undefined, errors: [...result.errors, `${why} Its result is not used.`] } })
          this.finish('crashed', why)
          return
        }
        this.queue.push({ type: 'turn.completed', result: { ...result, numTurns: turns } })
        if (result.outcome !== 'success' || turns >= this.spec.maxTurns) break
        const next = await this.inbox[Symbol.asyncIterator]().next()
        prompt = next.done ? null : next.value
      }
      this.finish(this.stopped ? 'stopped' : 'completed', null)
    } catch (e) {
      this.finish(this.stopped ? 'stopped' : 'crashed', e instanceof Error ? e.message : String(e))
    }
  }

  /** One `codex exec` process: the prompt in, the events out, one result. */
  private async turn(prompt: string): Promise<TurnResult> {
    const startedAt = Date.now()
    const args = codexArgs({ model: this.model, resumeSessionId: this.threadId })
    this.abort = new AbortController()
    const signal = this.abort.signal
    let out: CodexExecResult
    try {
      out = await (this.options.exec ? this.options.exec(args, this.spec.cwd, prompt, signal) : runCli(CODEX_TOOL, args, { cwd: this.spec.cwd, input: prompt, signal, timeoutMs: TURN_TIMEOUT_MS }))
    } catch (e) {
      out = { stdout: '', stderr: `Codex could not be started: ${e instanceof Error ? e.message : String(e)}`, exitCode: null, timedOut: false, aborted: false }
    } finally {
      this.abort = null
    }
    let text = ''
    let usage: UsageInfo[] = []
    const errors: string[] = []
    let completed = false
    for (const line of out.stdout.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue
      let event: CodexEvent
      try {
        event = JSON.parse(line) as CodexEvent
      } catch {
        continue
      }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && SESSION_ID.test(event.thread_id)) {
        this.threadId = event.thread_id
        if (!this.started) {
          this.started = true
          this.queue.push({ type: 'session.started', sessionId: event.thread_id, model: this.model, tools: [], apiKeySource: null })
        }
      } else if (event.type === 'item.started' && event.item?.type === 'command_execution') {
        this.queue.push({ type: 'tool.started', toolUseId: event.item.id ?? 'item', toolName: 'CodexShell', input: { command: String(event.item.command ?? '').slice(0, 2000) } })
      } else if (event.type === 'item.completed' && event.item) {
        const item = event.item
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          text = item.text
          this.queue.push({ type: 'text', text: item.text })
        } else if (item.type === 'command_execution') {
          this.queue.push({ type: 'tool.completed', toolUseId: item.id ?? 'item', isError: (item.exit_code ?? 0) !== 0, outputPreview: String(item.aggregated_output ?? '').slice(0, 500) })
        }
      } else if (event.type === 'turn.completed') {
        completed = true
        const u = event.usage ?? {}
        usage = [{ model: this.model, inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cached_input_tokens ?? 0, cacheCreationTokens: 0, costUsd: 0, contextWindow: null }]
      } else if (event.type === 'error' || event.type === 'turn.failed') {
        const message = (event.message ?? event.error?.message ?? 'Codex reported an error').slice(0, 600)
        if (!errors.includes(message)) errors.push(message)
      }
    }
    const base = { text, numTurns: 1, durationMs: Date.now() - startedAt, usage, totalCostUsd: null }
    if (this.stopped || out.aborted) return { ...base, outcome: 'aborted', structuredOutput: undefined, errors }
    if (out.timedOut) return { ...base, outcome: 'error', structuredOutput: undefined, errors: [`The Codex turn did not end within ${TURN_TIMEOUT_MS / 60_000} minutes.`] }
    if (!completed || errors.length > 0) {
      const fallback = (out.stderr.trim().split(/\r?\n/).at(-1) ?? '').slice(0, 600) || 'Codex ended without a result'
      return { ...base, outcome: 'error', structuredOutput: undefined, errors: errors.length > 0 ? errors : [fallback] }
    }
    if (this.spec.outputSchema) {
      const parsed = lastJson(text)
      if (parsed === undefined) return { ...base, outcome: 'structured_output_failed', structuredOutput: undefined, errors: ['The answer contained no JSON object.'] }
      return { ...base, outcome: 'success', structuredOutput: parsed, errors: [] }
    }
    return { ...base, outcome: 'success', structuredOutput: undefined, errors: [] }
  }
}

export class CodexCliRuntime implements AgentRuntime {
  private readonly live = new Set<CodexHandle>()
  /** Working directories in which a read-only session was seen to change something. */
  private readonly tainted = new Set<string>()

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  startSession(spec: SessionSpec): AgentSessionHandle {
    if (!READ_ONLY_ROLES.includes(spec.role)) throw new Error(`Codex is read-only in NEXUS; it cannot run a ${spec.role} session`)
    // The router hands over a Codex model name or none; a name that is not one falls back to the default.
    const model = spec.model && MODEL.test(spec.model) ? spec.model : (this.options.defaultModel ?? CODEX_DEFAULT_MODEL)
    if (this.tainted.has(spec.cwd)) throw new Error('An earlier Codex session changed this working directory although it was read-only. No further Codex session runs there.')
    const handle = new CodexHandle(spec, model, this.options, (h) => this.live.delete(h), (cwd) => this.tainted.add(cwd))
    this.live.add(handle)
    return handle
  }

  resumeSession(spec: SessionSpec, sdkSessionId: string): AgentSessionHandle {
    return this.startSession({ ...spec, resumeSessionId: sdkSessionId })
  }

  sendMessage(handle: AgentSessionHandle, text: string): void {
    handle.send(text)
  }

  interruptSession(handle: AgentSessionHandle): Promise<void> {
    return handle.interrupt()
  }

  stopSession(handle: AgentSessionHandle): Promise<void> {
    return handle.stop()
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    const model = this.options.defaultModel ?? CODEX_DEFAULT_MODEL
    return { models: [{ value: model, displayName: model, description: 'Codex command line tool', supportsEffort: false }], supportsResume: true, supportsStructuredOutput: false, supportsEffort: false, sdkVersion: this.options.version?.() ?? 'unknown' }
  }

  /** Codex's login is its own; NEXUS reports only that it is not a Claude account. */
  async getAccountInfo(): Promise<AuthStatus> {
    return { state: 'unknown', mode: 'third_party', subscriptionType: null, apiProvider: 'codex', apiKeySource: null, email: null, organization: null, apiKeyEnvDetected: false, apiKeyEnvStripped: false, claudeCodeVersion: null, warnings: [], error: null, checkedAt: new Date().toISOString() }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live].map((h) => h.stop()))
  }
}
