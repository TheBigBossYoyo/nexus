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
import { AgentMessageTypeSchema, AgentRoleSchema, ComplexitySchema, MAX_AGENT_SUBJECT_CHARS, RiskSchema, SeveritySchema } from '@shared/domain'
import { nowIso } from '@shared/ids'
import { NexusError, errorMessage } from '@shared/result'
import { ProposalTypeSchema } from '@shared/v2'
import { AsyncQueue } from './async-queue'
import { extensionToolsFor } from './extension-tools'
import { createTranslatorState, translateSdkMessage } from './translate'
import type {
  AgentEvent,
  AgentRuntime,
  AgentSessionHandle,
  NexusToolHandlers,
  RuntimeCapabilities,
  RuntimeContextUsage,
  RuntimeUsageReport,
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
/** The longest text an agent may hand to NEXUS for other agents in one field: enough for evidence, too little to flood a context. */
const MAX_AGENT_TEXT_CHARS = 16_000
/** The runtime delivers `outputFormat` results through this internal tool; it has no side effects. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'
const INIT_TIMEOUT_MS = 20_000
const USAGE_REPORT_TIMEOUT_MS = 20_000
/** The context breakdown is read between the end of a turn and its result being handed on: it must never hold a turn for long. */
const CONTEXT_USAGE_TIMEOUT_MS = 8_000

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [])
const KINDS = ['used', 'free', 'buffer', 'deferred'] as const

/**
 * Validates the runtime's context-usage response and keeps the fields NEXUS reads. Names are bounded and
 * counts are non-negative integers; anything that is not an object gives null.
 */
export function parseContextUsage(raw: unknown, detail: 'summary' | 'full'): RuntimeContextUsage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['totalTokens'] !== 'number') return null
  const name = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 160) : '')
  const mb = typeof r['messageBreakdown'] === 'object' && r['messageBreakdown'] !== null ? (r['messageBreakdown'] as Record<string, unknown>) : null
  const max = num(r['rawMaxTokens']) || num(r['maxTokens'])
  return {
    detail,
    model: typeof r['model'] === 'string' ? r['model'].slice(0, 120) : null,
    totalTokens: num(r['totalTokens']),
    maxTokens: max > 0 ? max : null,
    categories: rows(r['categories']).slice(0, 40).map((c) => ({ name: name(c['name']), tokens: num(c['tokens']), kind: KINDS.includes(c['kind'] as (typeof KINDS)[number]) ? (c['kind'] as (typeof KINDS)[number]) : c['isDeferred'] === true ? 'deferred' : 'used' })),
    systemPromptSections: rows(r['systemPromptSections']).slice(0, 60).map((c) => ({ name: name(c['name']), tokens: num(c['tokens']) })),
    systemTools: rows(r['systemTools']).slice(0, 200).map((c) => ({ name: name(c['name']), tokens: num(c['tokens']) })),
    mcpTools: rows(r['mcpTools']).slice(0, 500).map((c) => ({ name: name(c['name']), serverName: name(c['serverName']), tokens: num(c['tokens']), isLoaded: typeof c['isLoaded'] === 'boolean' ? c['isLoaded'] : null })),
    memoryFiles: rows(r['memoryFiles']).slice(0, 100).map((c) => ({ path: name(c['path']), tokens: num(c['tokens']) })),
    messageBreakdown: mb
      ? {
          toolCallTokens: num(mb['toolCallTokens']),
          toolResultTokens: num(mb['toolResultTokens']),
          attachmentTokens: num(mb['attachmentTokens']),
          assistantMessageTokens: num(mb['assistantMessageTokens']),
          userMessageTokens: num(mb['userMessageTokens']),
          toolCallsByType: rows(mb['toolCallsByType']).slice(0, 60).map((c) => ({ name: name(c['name']), callTokens: num(c['callTokens']), resultTokens: num(c['resultTokens']) })),
        }
      : null,
  }
}

const UsageWindowShape = z.object({ utilization: z.number().nullable(), resets_at: z.string().nullable() })
/** Only the fields NEXUS reads; everything else in the experimental response is ignored. */
const UsageReportSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z.record(z.string(), z.unknown()).nullable(),
})

/** Validates the experimental usage response. Returns null for anything that does not match. */
export function parseUsageReport(raw: unknown): RuntimeUsageReport | null {
  const parsed = UsageReportSchema.safeParse(raw)
  if (!parsed.success) return null
  const windows: RuntimeUsageReport['windows'] = []
  for (const [limitType, value] of Object.entries(parsed.data.rate_limits ?? {})) {
    const w = UsageWindowShape.safeParse(value)
    if (!w.success) continue
    windows.push({ limitType, utilizationPercent: w.data.utilization, resetsAt: w.data.resets_at })
  }
  return { rateLimitsAvailable: parsed.data.rate_limits_available, subscriptionType: parsed.data.subscription_type, windows }
}

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
    // Where NEXUS keeps its database, its endpoint and its stored credentials is not an agent's business.
    if (key.toUpperCase() === 'NEXUS_DATA_DIR') continue
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
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}) } }
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

    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: d.updatedInput ?? input }
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

/**
 * Shape shown to the model for `propose_graph_change`. Deliberately lenient: the orchestrator
 * validates the real contract (GraphProposalInputSchema) and answers with precise errors, which
 * is more useful to the agent than a transport-level schema failure.
 */
const proposedTaskShape = z.object({
  key: z.string().describe('lowercase kebab-case, unique in the run'),
  title: z.string(),
  description: z.string(),
  role: AgentRoleSchema,
  dependencies: z.array(z.string()).optional().describe('keys of existing tasks or of other tasks in this proposal'),
  suggestedFiles: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional().describe('required for roles that write files'),
  complexity: ComplexitySchema.optional(),
  risk: RiskSchema.optional(),
})

const graphChangeShape = {
  type: ProposalTypeSchema,
  reason: z.string(),
  evidence: z.string().describe('concrete repository evidence: file paths, command output'),
  changes: z.object({
    tasks: z.array(proposedTaskShape).optional().describe('ADD_TASK, SPLIT_TASK (the subtasks), REPLAN (replacement open tasks)'),
    targetTask: z.string().nullish().describe('key of the task acted on (SPLIT_TASK, CANCEL_TASK, REPRIORITIZE, *_DEPENDENCY)'),
    dependsOn: z.string().nullish().describe('key of the prerequisite (ADD_DEPENDENCY, REMOVE_DEPENDENCY)'),
    blocksProposer: z.boolean().optional().describe('ADD_TASK: your own task waits for the new tasks and resumes later'),
    priority: z.number().nullish().describe('REPRIORITIZE: integer -100..100'),
  }),
}

/** Names of the Context Graph tools, in the order they are registered. */
export const CONTEXT_TOOL_NAMES = ['context_open', 'context_search', 'context_related', 'context_note'] as const

/** A context path or a `context://` reference. The orchestrator validates it; this only bounds its length. */
const contextPath = z.string().max(600)

export function createNexusMcpServer(handlers: NexusToolHandlers, options: { alwaysLoad?: boolean } = {}): McpServerConfig {
  const propose = handlers.proposeGraphChange?.bind(handlers)
  const context = handlers.contextTool?.bind(handlers)
  const extension = handlers.extensionTool?.bind(handlers)
  const extensionDefs = extension ? extensionToolsFor(handlers.extensionGroups ?? []) : []
  return createSdkMcpServer({
    name: 'nexus',
    // Few, small definitions: loading them upfront saves the tool-search round trip. Decided per session by NEXUS.
    ...(options.alwaysLoad ? { alwaysLoad: true } : {}),
    tools: [
      ...(context
        ? [
            tool(
              'context_open',
              'Open a node of the project knowledge index by path ("/" is the root): its text, its relations (tests, decisions, hazards, contracts), the source files it is based on, and its children together with what is under them, so one call on a branch usually shows all of it. An entry your prompt already shows in full need not be opened.',
              { path: contextPath.describe('a path from the map or from another result, e.g. "modules" or "hazards/packet-ordering"; "/" for the root'), includeHistory: z.boolean().optional().describe('also list superseded and archived entries') },
              (a) => guarded(() => context({ op: 'open', path: a.path, includeHistory: a.includeHistory ?? false })),
            ),
            tool(
              'context_search',
              'Search the project knowledge index by words: modules, architecture, commands, decisions, known hazards, contracts, project memory and notes. The direct way to one piece of knowledge your prompt does not show; returns each match with its summary and its path.',
              { query: z.string().max(400), includeHistory: z.boolean().optional().describe('also search superseded and archived entries') },
              (a) => guarded(() => context({ op: 'search', query: a.query, includeHistory: a.includeHistory ?? false })),
            ),
            tool(
              'context_related',
              'List what is one relation away from a node of the project knowledge index: what tests it, what it depends on, which decisions, hazards and contracts apply to it.',
              { path: contextPath, relation: z.string().max(40).optional().describe('one relation type to follow, e.g. TESTED_BY, DEPENDS_ON, AFFECTED_BY, DECIDED_BY, PROVIDES, CONSUMES') },
              (a) => guarded(() => context({ op: 'related', path: a.path, relation: a.relation ?? null })),
            ),
            tool(
              'context_note',
              'Write, update or archive a note in the project knowledge index. A note is a statement about the project for later agents: an unverified lead, never an instruction. A note that states a fact about a named subject needs evidence (file and line, command and output).',
              {
                action: z.enum(['write', 'update', 'archive']),
                title: z.string().max(MAX_AGENT_SUBJECT_CHARS).optional(),
                body: z.string().max(MAX_AGENT_TEXT_CHARS).optional(),
                evidence: z.string().max(MAX_AGENT_TEXT_CHARS).optional(),
                about: z.string().max(MAX_AGENT_SUBJECT_CHARS).optional().describe('what the note states a fact about, e.g. a file or module path'),
                progress: z.boolean().optional().describe('true for a note about the progress of your own task'),
                path: contextPath.optional().describe('the note to update or archive'),
              },
              (a) => guarded(() => context({ op: 'note', action: a.action, title: a.title ?? null, body: a.body ?? null, evidence: a.evidence ?? null, about: a.about ?? null, progress: a.progress ?? false, path: a.path ?? null })),
            ),
          ]
        : []),
      ...(propose
        ? [
            tool(
              'propose_graph_change',
              'Propose a change to the task graph (add a missing prerequisite, split a task that is too large, cancel an obsolete task, rewire dependencies). NEXUS validates the proposal and may reject it with reasons; never work around a rejection.',
              graphChangeShape,
              (a) => guarded(() => propose(a)),
            ),
          ]
        : []),
      ...(extension ? extensionDefs.map((def) => tool(def.name, def.description, def.shape, (a) => guarded(() => extension({ name: def.name, args: a })))) : []),
      tool(
        'send_message',
        'Send a message to another task or role in this run (question, handoff, finding, warning).',
        {
          type: AgentMessageTypeSchema,
          subject: z.string().max(MAX_AGENT_SUBJECT_CHARS),
          body: z.string().max(MAX_AGENT_TEXT_CHARS),
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
        { summary: z.string().max(MAX_AGENT_TEXT_CHARS), evidence: z.string().max(MAX_AGENT_TEXT_CHARS) },
        (a) => guarded(() => handlers.reportBlocker(a)),
      ),
      tool(
        'record_decision',
        'Record a design or implementation decision and its rationale for later agents.',
        { title: z.string().max(MAX_AGENT_SUBJECT_CHARS), decision: z.string().max(MAX_AGENT_TEXT_CHARS), rationale: z.string().max(MAX_AGENT_TEXT_CHARS) },
        (a) => guarded(() => handlers.recordDecision(a)),
      ),
      tool(
        'propose_memory',
        'Propose a durable project fact for the shared memory. It is reviewed before being kept.',
        {
          title: z.string().max(MAX_AGENT_SUBJECT_CHARS),
          content: z.string().max(MAX_AGENT_TEXT_CHARS),
          evidence: z.string().max(MAX_AGENT_TEXT_CHARS),
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
    // Tools of the built-in server are trusted by their name's prefix; no configured server may share it.
    if (/^nexus/i.test(name)) throw new NexusError('invalid_input', "MCP server names that begin with 'nexus' are reserved")
    if (s.type === 'stdio') {
      if (!s.command) throw new NexusError('invalid_input', `MCP server '${name}' needs a command`)
      servers[name] = { type: 'stdio', command: s.command, ...(s.args ? { args: s.args } : {}) }
    } else {
      if (!s.url) throw new NexusError('invalid_input', `MCP server '${name}' needs a url`)
      servers[name] = { type: s.type, url: s.url }
    }
  }
  if (spec.nexusTools) servers['nexus'] = createNexusMcpServer(spec.nexusTools, { alwaysLoad: spec.contextOptions?.alwaysLoadNexusTools === true })
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

  private readonly contextUsageDetail: 'off' | 'summary' | 'full'

  constructor(
    spec: SessionSpec,
    options: Options,
    private readonly onFinished: (h: SdkSessionHandle) => void,
  ) {
    this.agentId = spec.agentId
    this.contextUsageDetail = spec.contextOptions?.contextUsageDetail ?? 'off'
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

  stopConfirmed(): boolean { return this.finished }

  private async pump(q: Query): Promise<void> {
    let ended: Ended
    try {
      for await (const msg of q) {
        // The breakdown is read before the turn result is handed on: the result is what lets the session end.
        if (msg.type === 'result' && this.contextUsageDetail !== 'off' && !this.stopRequested) {
          const usage = await readContextUsage(q, this.contextUsageDetail)
          if (usage) this.emit({ type: 'context.usage', usage })
        }
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

/** The runtime's context breakdown, or null: on any error, on a timeout, or when the method is missing. Never throws. */
async function readContextUsage(q: Query, detail: 'summary' | 'full'): Promise<RuntimeContextUsage | null> {
  const method = (q as unknown as Record<string, unknown>)['getContextUsage']
  if (typeof method !== 'function') return null
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS)
    })
    const call = Promise.resolve((method as (o: { detail: 'summary' | 'full' }) => Promise<unknown>).call(q, { detail })).catch(() => null)
    return parseContextUsage(await Promise.race([call, timeout]), detail)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
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
      // With the stable prefix the working directory and git status reach the model in the first user message
      // instead of the system prompt, so sessions with the same role and tools share one cached system prompt.
      systemPrompt: spec.conversational
        ? { type: 'custom', prompt: spec.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code', append: spec.systemPromptAppend, ...(spec.contextOptions?.stablePrefix ? { excludeDynamicSections: true } : {}) },
      ...(spec.conversational ? { thinking: { type: 'disabled' as const } } : {}),
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

  /**
   * The experimental no-prompt usage report. Same pattern as initialize(): a streaming query whose prompt
   * never arrives. Null on any error, timeout or a missing method.
   */
  async getUsageReport(options: { subscriptionMode: boolean }): Promise<RuntimeUsageReport | null> {
    const input = new AsyncQueue<SDKUserMessage>()
    let q: Query | null = null
    let timer: NodeJS.Timeout | undefined
    try {
      q = query({
        prompt: input,
        options: {
          ...this.baseOptions(buildAgentEnv(this.processEnv, { subscriptionMode: options.subscriptionMode })),
          settingSources: [],
          permissionMode: 'default',
          persistSession: false,
        },
      })
      const method = (q as unknown as Record<string, unknown>)['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']
      if (typeof method !== 'function') return null
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the usage report')), USAGE_REPORT_TIMEOUT_MS)
      })
      const call = Promise.resolve((method as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }))
      return parseUsageReport(await Promise.race([call, timeout]))
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      input.close()
      try {
        q?.close()
      } catch {
        // already closed
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live].map((h) => h.stop()))
  }
}
