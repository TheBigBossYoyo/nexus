import type { AgentRole } from '@shared/domain'
import type { AuthStatus, ModelOption } from '@shared/auth'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { AsyncQueue } from './async-queue'
import type {
  AgentEvent,
  AgentRuntime,
  AgentSessionHandle,
  NexusToolHandlers,
  RuntimeCapabilities,
  SessionSpec,
  ToolDecision,
  TurnOutcome,
  UsageInfo,
} from './types'

export interface FakeSessionContext {
  readonly spec: SessionSpec
  /** Fires on interrupt() and stop(). After an interrupt the getter returns a fresh, un-aborted signal. */
  readonly signal: AbortSignal
  readonly nexusTools: NexusToolHandlers | undefined
  emitText(text: string): Promise<void>
  /**
   * Runs the same policy path as the real runtime (authorize, then requestApproval for `ask`) and emits
   * tool.started / tool.denied / tool.completed. Resolves true when the tool was allowed and ran.
   */
  useTool(toolName: string, input: Record<string, unknown>, run?: () => Promise<string>): Promise<boolean>
  completeTurn(result: { text: string; structuredOutput?: unknown; outcome?: TurnOutcome }): Promise<void>
  /** Resolves with the next send() message, or null once end() or stop() was called. */
  nextMessage(): Promise<string | null>
  /** Simulates a crash: the session ends with reason 'crashed'. Always throws. */
  fail(error: Error | string): never
  rateLimit(info?: { status?: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number | null; limitType?: string | null }): Promise<void>
  /** Waits `ms`, or until the signal aborts. */
  sleep(ms: number): Promise<void>
}

export type FakeScript = (spec: SessionSpec, ctx: FakeSessionContext) => Promise<void>

export interface FakeRuntimeOptions {
  script: FakeScript
  /** Artificial delay before every emitted event. Default 0. */
  delayMs?: number
  authStatus?: AuthStatus | ((options: { subscriptionMode: boolean }) => AuthStatus)
  models?: ModelOption[]
}

export function defaultFakeAuthStatus(): AuthStatus {
  return {
    state: 'authenticated',
    mode: 'subscription',
    subscriptionType: 'max',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
    email: null,
    organization: null,
    apiKeyEnvDetected: false,
    apiKeyEnvStripped: false,
    claudeCodeVersion: 'fake',
    warnings: [],
    error: null,
    checkedAt: nowIso(),
  }
}

/** Picks a script by session role; roles without an entry use `fallback` (default: complete with "done"). */
export function scriptsByRole(
  byRole: Partial<Record<AgentRole, FakeScript>>,
  fallback: FakeScript = completeWith({ text: 'done' }),
): FakeScript {
  return (spec, ctx) => (byRole[spec.role] ?? fallback)(spec, ctx)
}

/** A script that emits the text and completes one turn. */
export function completeWith(result: { text: string; structuredOutput?: unknown; outcome?: TurnOutcome }): FakeScript {
  return async (_spec, ctx) => {
    await ctx.emitText(result.text)
    await ctx.completeTurn(result)
  }
}

class FakeCrash extends Error {}

class FakeHandle implements AgentSessionHandle {
  readonly agentId: string
  readonly events: AsyncIterable<AgentEvent>
  private readonly eventQueue = new AsyncQueue<AgentEvent>()
  private readonly inbox = new AsyncQueue<string>()
  private controller = new AbortController()
  private finished = false
  private stopRequested = false
  private readonly sdkSessionId: string
  private turns = 0
  private costUsd = 0
  private readonly usageTotals = new Map<string, UsageInfo>()
  private readonly done: Promise<void>

  constructor(
    private readonly spec: SessionSpec,
    sessionId: string,
    script: FakeScript,
    private readonly delayMs: number,
    private readonly onFinished: (h: FakeHandle) => void,
  ) {
    this.agentId = spec.agentId
    this.events = this.eventQueue
    this.sdkSessionId = sessionId
    this.emitNow({
      type: 'session.started',
      sessionId,
      model: spec.model ?? 'fake-model',
      tools: [...spec.tools],
      apiKeySource: 'none',
    })
    this.done = this.run(script)
  }

  get isFinished(): boolean {
    return this.finished
  }

  sessionId(): string | null {
    return this.sdkSessionId
  }

  send(text: string): void {
    this.inbox.push(text)
  }

  async interrupt(): Promise<void> {
    if (this.finished) return
    const old = this.controller
    this.controller = new AbortController()
    old.abort()
  }

  end(): void {
    this.inbox.close()
  }

  async stop(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true
      this.inbox.close()
      this.controller.abort()
    }
    // A script that ignores its signal must not be able to hang shutdown.
    await Promise.race([this.done, new Promise<void>((r) => setTimeout(r, 2000).unref())])
    this.finish('stopped', null)
  }

  private async run(script: FakeScript): Promise<void> {
    try {
      await script(this.spec, this.context())
      this.finish(this.stopRequested ? 'stopped' : 'completed', null)
    } catch (e) {
      this.finish(this.stopRequested ? 'stopped' : 'crashed', e instanceof FakeCrash ? e.message : errorMessage(e))
    }
  }

  private finish(reason: 'completed' | 'stopped' | 'crashed', error: string | null): void {
    if (this.finished) return
    this.eventQueue.push({ type: 'session.ended', reason, error })
    this.finished = true
    this.inbox.close()
    this.eventQueue.close()
    this.onFinished(this)
  }

  private emitNow(event: AgentEvent): void {
    if (!this.finished) this.eventQueue.push(event)
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (this.delayMs > 0) await this.sleep(this.delayMs)
    this.emitNow(event)
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.controller.signal
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private async decide(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ToolDecision> {
    if (toolName.startsWith('mcp__nexus__')) return { behavior: 'allow' }
    try {
      return await this.spec.authorize({ agentId: this.spec.agentId, toolName, input, toolUseId })
    } catch (e) {
      return { behavior: 'deny', reason: `Policy check failed: ${errorMessage(e)}` }
    }
  }

  private context(): FakeSessionContext {
    const currentSignal = () => this.controller.signal
    return {
      spec: this.spec,
      get signal() {
        return currentSignal()
      },
      nexusTools: this.spec.nexusTools,
      sleep: (ms) => this.sleep(ms),
      emitText: (text) => this.emit({ type: 'text', text }),
      nextMessage: async () => {
        const it = this.inbox[Symbol.asyncIterator]()
        const r = await it.next()
        return r.done ? null : r.value
      },
      fail: (error) => {
        throw new FakeCrash(typeof error === 'string' ? error : error.message)
      },
      rateLimit: (info = {}) =>
        this.emit({
          type: 'rate_limit',
          status: info.status ?? 'rejected',
          resetsAt: info.resetsAt ?? null,
          limitType: info.limitType ?? null,
        }),
      useTool: async (toolName, input, run) => {
        const toolUseId = newId()
        await this.emit({ type: 'tool.started', toolUseId, toolName, input })
        const decision = await this.decide(toolName, input, toolUseId)
        let denial: string | null = null
        if (decision.behavior === 'deny') denial = decision.reason
        else if (decision.behavior === 'ask') {
          let approved: boolean
          try {
            approved = await this.spec.requestApproval(
              { agentId: this.spec.agentId, toolName, input, toolUseId },
              decision.reason,
              decision.risk,
            )
          } catch {
            approved = false
          }
          if (!approved) denial = 'Denied by the user'
        }
        if (denial !== null) {
          await this.emit({ type: 'tool.denied', toolUseId, toolName, reason: denial })
          await this.emit({ type: 'tool.completed', toolUseId, isError: true, outputPreview: denial })
          return false
        }
        try {
          const output = run ? await run() : 'ok'
          await this.emit({ type: 'tool.completed', toolUseId, isError: false, outputPreview: output.slice(0, 500) })
        } catch (e) {
          await this.emit({ type: 'tool.completed', toolUseId, isError: true, outputPreview: errorMessage(e).slice(0, 500) })
        }
        return true
      },
      completeTurn: (r) => {
        this.turns += 1
        const model = this.spec.model ?? 'fake-model'
        const prev = this.usageTotals.get(model)
        const outputTokens = Math.max(1, Math.ceil(r.text.length / 4))
        const turnCost = 0.001
        this.costUsd += turnCost
        const usage: UsageInfo = {
          model,
          inputTokens: (prev?.inputTokens ?? 0) + 1000,
          outputTokens: (prev?.outputTokens ?? 0) + outputTokens,
          cacheReadTokens: prev?.cacheReadTokens ?? 0,
          cacheCreationTokens: prev?.cacheCreationTokens ?? 0,
          costUsd: (prev?.costUsd ?? 0) + turnCost,
          contextWindow: 200_000,
        }
        this.usageTotals.set(model, usage)
        const outcome = r.outcome ?? 'success'
        return this.emit({
          type: 'turn.completed',
          result: {
            outcome,
            text: outcome === 'success' ? r.text : '',
            structuredOutput: r.structuredOutput ?? null,
            numTurns: this.turns,
            durationMs: this.delayMs,
            usage: [...this.usageTotals.values()],
            totalCostUsd: this.costUsd,
            errors: outcome === 'success' ? [] : [r.text],
          },
        })
      },
    }
  }
}

/** Scriptable AgentRuntime with no Claude usage, for unit, integration and E2E tests. */
export class FakeAgentRuntime implements AgentRuntime {
  /** Every spec passed to startSession/resumeSession, in order. */
  readonly sessions: SessionSpec[] = []
  readonly handles: AgentSessionHandle[] = []
  script: FakeScript
  delayMs: number
  authStatus: NonNullable<FakeRuntimeOptions['authStatus']>
  models: ModelOption[]
  private readonly live = new Set<FakeHandle>()
  private counter = 0

  constructor(options: FakeRuntimeOptions) {
    this.script = options.script
    this.delayMs = options.delayMs ?? 0
    this.authStatus = options.authStatus ?? defaultFakeAuthStatus()
    this.models = options.models ?? [
      { value: 'fake-model', displayName: 'Fake Model', description: 'Scripted test model', supportsEffort: true },
    ]
  }

  startSession(spec: SessionSpec): AgentSessionHandle {
    this.sessions.push(spec)
    this.counter += 1
    const id = spec.resumeSessionId ?? `fake-session-${this.counter}`
    const handle = new FakeHandle(spec, id, this.script, this.delayMs, (h) => this.live.delete(h))
    if (!handle.isFinished) this.live.add(handle)
    this.handles.push(handle)
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

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve({
      models: this.models,
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsEffort: true,
      sdkVersion: 'fake',
    })
  }

  getAccountInfo(options: { subscriptionMode: boolean }): Promise<AuthStatus> {
    const s = typeof this.authStatus === 'function' ? this.authStatus(options) : this.authStatus
    return Promise.resolve({ ...s, checkedAt: nowIso() })
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live].map((h) => h.stop()))
  }
}
