import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type {
  AccountInfo,
  CanUseTool,
  HookCallback,
  McpServerConfig,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { API_KEY_WARNING } from '@shared/auth'
import type { AuthStatus, ModelOption } from '@shared/auth'
import { AgentRoleSchema, MessageTypeSchema, SeveritySchema } from '@shared/domain'
import { nowIso } from '@shared/ids'
import { NexusError, errorMessage } from '@shared/result'
import { AsyncQueue } from './async-queue'
import { createTranslatorState, translateSdkMessage } from './translate'
import type {
  AgentEvent,
  AgentRuntime,
  AgentSessionHandle,
  NexusToolHandlers,
  RuntimeCapabilities,
  SessionSpec,
  ToolDecision,
  ToolRequest,
} from './types'

export interface ClaudeSdkRuntimeOptions {
  /** Explicit claude.exe path; wins over `resolveExecutable`. */
  executablePath?: string
  resolveExecutable?: () => string | undefined
  debug?: boolean
  logger?: (line: string) => void
  /** Environment the agents inherit. Defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>
}

const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
const NEXUS_TOOL_PREFIX = 'mcp__nexus__'
/** The runtime delivers `outputFormat` results through this internal tool; it has no side effects. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'
const INIT_TIMEOUT_MS = 20_000

/**
 * The SDK REPLACES the child environment, so this copies everything. Windows env names are
 * case-insensitive, hence the lowercase comparison. Never mutates its input.
 */
export function buildAgentEnv(
  processEnv: Record<string, string | undefined>,
  options: { subscriptionMode: boolean },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue
    if (options.subscriptionMode && KEY_VARS.includes(key.toUpperCase())) continue
    env[key] = value
  }
  env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
  env['CLAUDE_AGENT_SDK_CLIENT_APP'] = 'nexus'
  return env
}

function apiKeyEnvPresent(env: Record<string, string | undefined>): boolean {
  return Object.entries(env).some(([k, v]) => KEY_VARS.includes(k.toUpperCase()) && !!v)
}

// ---------------------------------------------------------------------------------------------
// Auth status mapping

interface AuthFlags {
  subscriptionMode: boolean
  apiKeyEnvDetected: boolean
  /** Version of the Claude Code binary in use, when known; null/absent shows as unknown. */
  claudeCodeVersion?: string | null
}

export function authStatusFromAccount(
  account: AccountInfo,
  flags: AuthFlags,
): AuthStatus {
  const keyInUse = !!account.apiKeySource && account.apiKeySource !== 'none'
  const bearerToken = account.tokenSource?.toUpperCase().startsWith('ANTHROPIC_') === true
  const thirdParty = !!account.apiProvider && account.apiProvider !== 'firstParty'
  const loggedIn = !!(account.subscriptionType || account.tokenSource || account.email)

  let state: AuthStatus['state'] = 'authentication_required'
  let mode: AuthStatus['mode'] = 'unknown'
  if (thirdParty) {
    state = 'authenticated'
    mode = 'third_party'
  } else if (keyInUse || bearerToken) {
    state = 'authenticated'
    mode = 'api_key'
  } else if (loggedIn) {
    state = 'authenticated'
    mode = 'subscription'
  }

  return {
    ...baseStatus(flags),
    state,
    mode,
    subscriptionType: account.subscriptionType ?? null,
    apiProvider: account.apiProvider ?? null,
    apiKeySource: account.apiKeySource ?? null,
    email: account.email ?? null,
    organization: account.organization ?? null,
    error: state === 'authentication_required' ? 'No Claude credentials were reported by the runtime.' : null,
  }
}

export function authStatusFromError(
  error: unknown,
  flags: AuthFlags,
): AuthStatus {
  const message = errorMessage(error).slice(0, 300)
  const unavailable = /not found|ENOENT|EACCES|EPERM|spawn|Native CLI binary/i.test(message)
  return {
    ...baseStatus(flags),
    state: unavailable ? 'runtime_unavailable' : 'sdk_error',
    mode: 'unknown',
    subscriptionType: null,
    apiProvider: null,
    apiKeySource: null,
    email: null,
    organization: null,
    error: message,
  }
}

function baseStatus(flags: AuthFlags) {
  return {
    apiKeyEnvDetected: flags.apiKeyEnvDetected,
    apiKeyEnvStripped: flags.apiKeyEnvDetected && flags.subscriptionMode,
    claudeCodeVersion: flags.claudeCodeVersion ?? null,
    warnings: flags.apiKeyEnvDetected ? [API_KEY_WARNING] : [],
    checkedAt: nowIso(),
  }
}

function toModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    supportsEffort: m.supportsEffort ?? (m.supportedEffortLevels?.length ?? 0) > 0,
  }
}

function readSdkManifest(): { version?: string; claudeCodeVersion?: string } | null {
  try {
    // package.json is not in the SDK's export map, so locate it next to the resolved entry point.
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    let dir = dirname(entry)
    for (let i = 0; i < 4; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string
          version?: string
          claudeCodeVersion?: string
        }
        if (pkg.name === '@anthropic-ai/claude-agent-sdk') return pkg
      } catch {
        // keep walking up
      }
      dir = dirname(dir)
    }
  } catch {
    // fall through
  }
  return null
}

function readSdkVersion(): string {
  return readSdkManifest()?.version || 'unknown'
}

/** The Claude Code version the SDK package pins (the native binary it ships), or null when unreadable. */
function readBundledClaudeCodeVersion(): string | null {
  return readSdkManifest()?.claudeCodeVersion || null
}

// ---------------------------------------------------------------------------------------------
// Policy enforcement

/**
 * Wraps `spec.authorize` so that every failure path denies. The PreToolUse hook is the primary gate;
 * `canUseTool` serves the "ask" path and any call the hook did not see.
 */
class PolicyGate {
  /** Ask decisions made in the hook, consumed by canUseTool so authorize runs once per tool call. */
  private readonly pendingAsk = new Map<string, Extract<ToolDecision, { behavior: 'ask' }>>()

  constructor(
    private readonly spec: SessionSpec,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  private async decide(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ToolDecision> {
    if (toolName.startsWith(NEXUS_TOOL_PREFIX)) return { behavior: 'allow' }
    if (toolName === STRUCTURED_OUTPUT_TOOL && this.spec.outputSchema) return { behavior: 'allow' }
    try {
      const d = await this.spec.authorize({ agentId: this.spec.agentId, toolName, input, toolUseId })
      if (d.behavior === 'allow') return d
      if (d.behavior === 'deny') return { behavior: 'deny', reason: d.reason || 'Denied by policy' }
      if (d.behavior === 'ask') return d
      return { behavior: 'deny', reason: 'Policy returned an unknown decision' }
    } catch (e) {
      return { behavior: 'deny', reason: `Policy check failed: ${errorMessage(e)}` }
    }
  }

  private denied(toolUseId: string, toolName: string, reason: string): void {
    this.emit({ type: 'tool.denied', toolUseId, toolName, reason })
  }

  readonly preToolUse: HookCallback = async (hookInput, toolUseID) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {}
    const toolUseId = toolUseID ?? hookInput.tool_use_id
    const input = isRecord(hookInput.tool_input) ? hookInput.tool_input : {}
    const d = await this.decide(hookInput.tool_name, input, toolUseId)
    if (d.behavior === 'allow') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    }
    if (d.behavior === 'deny') {
      this.denied(toolUseId, hookInput.tool_name, d.reason)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: d.reason,
        },
      }
    }
    this.pendingAsk.set(toolUseId, d)
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.reason } }
  }

  readonly canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const toolUseId = options.toolUseID
    const pending = this.pendingAsk.get(toolUseId)
    this.pendingAsk.delete(toolUseId)
    const d = pending ?? (await this.decide(toolName, input, toolUseId))

    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input }
    if (d.behavior === 'deny') {
      this.denied(toolUseId, toolName, d.reason)
      return { behavior: 'deny', message: d.reason }
    }

    const request: ToolRequest = { agentId: this.spec.agentId, toolName, input, toolUseId }
    let approved = false
    let reason = 'Denied by the user'
    try {
      approved = await raceAbort(this.spec.requestApproval(request, d.reason, d.risk), options.signal)
    } catch (e) {
      reason = `Approval failed: ${errorMessage(e)}`
    }
    if (approved) return { behavior: 'allow', updatedInput: input }
    this.denied(toolUseId, toolName, reason)
    return { behavior: 'deny', message: reason }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rejects when the signal aborts; the losing promise is detached so it cannot become unhandled. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined)
  if (signal.aborted) return Promise.reject(new Error('Approval cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Approval cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

// ---------------------------------------------------------------------------------------------
// In-process MCP server

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

async function guarded(run: () => Promise<string>) {
  try {
    return textResult(await run())
  } catch (e) {
    return textResult(errorMessage(e), true)
  }
}

export function createNexusMcpServer(handlers: NexusToolHandlers): McpServerConfig {
  return createSdkMcpServer({
    name: 'nexus',
    tools: [
      tool(
        'send_message',
        'Send a message to another task or role in this run (question, handoff, finding, warning).',
        {
          type: MessageTypeSchema,
          subject: z.string(),
          body: z.string(),
          toTask: z.string().nullish(),
          toRole: AgentRoleSchema.nullish(),
          severity: SeveritySchema.nullish(),
        },
        (a) =>
          guarded(() =>
            handlers.sendMessage({
              type: a.type,
              subject: a.subject,
              body: a.body,
              toTask: a.toTask ?? null,
              toRole: a.toRole ?? null,
              severity: a.severity ?? null,
            }),
          ),
      ),
      tool(
        'report_blocker',
        'Report that you cannot make progress, with the evidence that proves it.',
        { summary: z.string(), evidence: z.string() },
        (a) => guarded(() => handlers.reportBlocker(a)),
      ),
      tool(
        'record_decision',
        'Record a design or implementation decision and its rationale for later agents.',
        { title: z.string(), decision: z.string(), rationale: z.string() },
        (a) => guarded(() => handlers.recordDecision(a)),
      ),
      tool(
        'propose_memory',
        'Propose a durable project fact for the shared memory. It is reviewed before being kept.',
        {
          title: z.string(),
          content: z.string(),
          evidence: z.string(),
          tags: z.array(z.string()).optional(),
          filePaths: z.array(z.string()).optional(),
        },
        (a) =>
          guarded(() =>
            handlers.proposeMemory({
              title: a.title,
              content: a.content,
              evidence: a.evidence,
              tags: a.tags ?? [],
              filePaths: a.filePaths ?? [],
            }),
          ),
      ),
    ],
  })
}

function buildMcpServers(spec: SessionSpec): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, s] of Object.entries(spec.mcpServers ?? {})) {
    if (name === 'nexus') throw new NexusError('invalid_input', "MCP server name 'nexus' is reserved")
    if (s.type === 'stdio') {
      if (!s.command) throw new NexusError('invalid_input', `MCP server '${name}' needs a command`)
      servers[name] = { type: 'stdio', command: s.command, ...(s.args ? { args: s.args } : {}) }
    } else {
      if (!s.url) throw new NexusError('invalid_input', `MCP server '${name}' needs a url`)
      servers[name] = { type: s.type, url: s.url }
    }
  }
  if (spec.nexusTools) servers['nexus'] = createNexusMcpServer(spec.nexusTools)
  return servers
}

// ---------------------------------------------------------------------------------------------
// Session handle

type Ended = { reason: 'completed' | 'stopped' | 'crashed'; error: string | null }

class SdkSessionHandle implements AgentSessionHandle {
  readonly agentId: string
  readonly events: AsyncIterable<AgentEvent>
  private readonly eventQueue = new AsyncQueue<AgentEvent>()
  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly state
  private query: Query | null = null
  private sdkSessionId: string | null = null
  private stopRequested = false
  private inputEnded = false
  private finished = false
  private readonly done: Promise<void>

  constructor(
    spec: SessionSpec,
    options: Options,
    private readonly onFinished: (h: SdkSessionHandle) => void,
  ) {
    this.agentId = spec.agentId
    this.events = this.eventQueue
    this.state = createTranslatorState({ expectStructuredOutput: spec.outputSchema !== undefined })
    this.input.push(userMessage(spec.prompt))
    try {
      this.query = query({ prompt: this.input, options })
      this.done = this.pump(this.query)
    } catch (e) {
      this.done = Promise.resolve()
      this.finish({ reason: 'crashed', error: errorMessage(e) })
    }
  }

  get isFinished(): boolean {
    return this.finished
  }

  sessionId(): string | null {
    return this.sdkSessionId
  }

  emit(event: AgentEvent): void {
    if (!this.finished) this.eventQueue.push(event)
  }

  send(text: string): void {
    this.input.push(userMessage(text))
  }

  async interrupt(): Promise<void> {
    if (!this.query || this.finished) return
    this.state.interruptRequested = true
    try {
      await this.query.interrupt()
    } catch {
      // The session may already be finishing; nothing to interrupt.
    }
  }

  end(): void {
    this.inputEnded = true
    this.input.close()
  }

  async stop(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true
      this.input.close()
      try {
        this.query?.close()
      } catch {
        // already closed
      }
    }
    await this.done
  }

  private async pump(q: Query): Promise<void> {
    let ended: Ended
    try {
      for await (const msg of q) {
        for (const event of translateSdkMessage(msg, this.state)) this.emit(event)
        this.sdkSessionId = this.state.sessionId
      }
      ended = this.stopRequested
        ? { reason: 'stopped', error: null }
        : this.inputEnded
          ? { reason: 'completed', error: null }
          : { reason: 'crashed', error: 'The Claude process exited unexpectedly.' }
    } catch (e) {
      ended = this.stopRequested
        ? { reason: 'stopped', error: null }
        : { reason: 'crashed', error: errorMessage(e) }
    }
    try {
      q.close()
    } catch {
      // process already gone
    }
    this.finish(ended)
  }

  private finish(ended: Ended): void {
    if (this.finished) return
    this.eventQueue.push({ type: 'session.ended', ...ended })
    this.finished = true
    this.input.close()
    this.eventQueue.close()
    this.onFinished(this)
  }
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

// ---------------------------------------------------------------------------------------------
// Runtime

export class ClaudeSdkRuntime implements AgentRuntime {
  private readonly live = new Set<SdkSessionHandle>()
  private models: ModelOption[] | null = null

  constructor(private readonly options: ClaudeSdkRuntimeOptions = {}) {}

  private get processEnv(): Record<string, string | undefined> {
    return this.options.processEnv ?? process.env
  }

  private executable(): string | undefined {
    return this.options.executablePath ?? this.options.resolveExecutable?.()
  }

  private baseOptions(env: Record<string, string | undefined>): Options {
    const exe = this.executable()
    const logger = this.options.logger
    return {
      env,
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
      ...(this.options.debug ? { debug: true } : {}),
      ...(logger ? { stderr: (data: string) => logger(data.trimEnd()) } : {}),
    }
  }

  startSession(spec: SessionSpec): AgentSessionHandle {
    const options: Options = {
      ...this.baseOptions(buildAgentEnv(this.processEnv, { subscriptionMode: spec.subscriptionMode })),
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      maxTurns: spec.maxTurns,
      includePartialMessages: true,
      permissionMode: 'default',
      tools: spec.tools,
      disallowedTools: ['Agent', 'Task'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPromptAppend },
      settingSources: spec.loadProjectSettings ? ['project'] : [],
      strictMcpConfig: true,
      skills: [],
      mcpServers: buildMcpServers(spec),
      ...(spec.outputSchema ? { outputFormat: { type: 'json_schema', schema: spec.outputSchema } } : {}),
      ...(spec.resumeSessionId ? { resume: spec.resumeSessionId } : {}),
    }

    let handle: SdkSessionHandle | null = null
    const gate = new PolicyGate(spec, (e) => handle?.emit(e))
    options.hooks = { PreToolUse: [{ hooks: [gate.preToolUse] }] }
    options.canUseTool = gate.canUseTool

    handle = new SdkSessionHandle(spec, options, (h) => this.live.delete(h))
    if (!handle.isFinished) this.live.add(handle)
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
    if (!this.models) await this.initialize(false).catch(() => undefined)
    return {
      models: this.models ?? [],
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsEffort: true,
      sdkVersion: readSdkVersion(),
    }
  }

  async getAccountInfo(options: { subscriptionMode: boolean }): Promise<AuthStatus> {
    const flags: AuthFlags = {
      subscriptionMode: options.subscriptionMode,
      apiKeyEnvDetected: apiKeyEnvPresent(this.processEnv),
      // A user-chosen executable may be any version, so only the SDK-shipped binary has a known one.
      claudeCodeVersion: this.options.executablePath ? null : readBundledClaudeCodeVersion(),
    }
    try {
      const init = await this.initialize(options.subscriptionMode)
      return authStatusFromAccount(init.account, flags)
    } catch (e) {
      return authStatusFromError(e, flags)
    }
  }

  /**
   * Starts a streaming-input query whose prompt never arrives, so no model call is made, and reads
   * the initialize response (account and models) before closing it.
   */
  private async initialize(subscriptionMode: boolean): Promise<{ account: AccountInfo; models: ModelInfo[] }> {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        ...this.baseOptions(buildAgentEnv(this.processEnv, { subscriptionMode })),
        settingSources: [],
        permissionMode: 'default',
        persistSession: false,
      },
    })
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the Claude runtime to initialize')), INIT_TIMEOUT_MS)
      })
      const init = await Promise.race([q.initializationResult(), timeout])
      this.models = init.models.map(toModelOption)
      return { account: init.account, models: init.models }
    } finally {
      clearTimeout(timer)
      input.close()
      try {
        q.close()
      } catch {
        // already closed
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live].map((h) => h.stop()))
  }
}
