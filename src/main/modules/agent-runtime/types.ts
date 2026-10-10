import type { AgentRole, MessageType, Severity } from '@shared/domain'
import type { AuthStatus, ModelOption } from '@shared/auth'

/**
 * NEXUS-facing abstraction over the Claude Agent SDK. Nothing outside `agent-runtime/` imports the
 * SDK or its types; the orchestrator only sees this file.
 */

export interface ToolRequest {
  agentId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
}

export type ToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  /** Requires a human decision. The runtime calls `SessionSpec.requestApproval` and waits. */
  | { behavior: 'ask'; reason: string; risk: 'low' | 'medium' | 'high' }

/** Tools NEXUS exposes to agents through an in-process MCP server named `nexus`. */
export interface NexusToolHandlers {
  sendMessage(input: {
    type: MessageType
    subject: string
    body: string
    toTask: string | null
    toRole: AgentRole | null
    severity: Severity | null
  }): Promise<string>
  reportBlocker(input: { summary: string; evidence: string }): Promise<string>
  recordDecision(input: { title: string; decision: string; rationale: string }): Promise<string>
  proposeMemory(input: {
    title: string
    content: string
    evidence: string
    tags: string[]
    filePaths: string[]
  }): Promise<string>
  /** v0.2: propose a task-graph change. The input is validated by the orchestrator, never trusted. */
  proposeGraphChange?(input: unknown): Promise<string>
  /**
   * v0.7.1: the Context Graph tools (`op`: open, search, related, note). The input is validated by the
   * orchestrator, never trusted; the answer is text for the model. Absent when the session gets no graph tools.
   */
  contextTool?(input: unknown): Promise<string>
}

/**
 * v0.7.1: what a session asks of its runtime about context. Provider-neutral: a runtime applies what it
 * supports and ignores the rest, so nothing provider-specific is ever sent to a provider that lacks it.
 */
export interface SessionContextOptions {
  /** Keep per-session text (working directory, git status) out of the system prompt so sessions share a cached prefix. */
  stablePrefix: boolean
  /** Put the NEXUS tool definitions in the prompt instead of behind tool search. */
  alwaysLoadNexusTools: boolean
  /** Whether and how the runtime's context breakdown is read at the end of each turn. */
  contextUsageDetail: 'off' | 'summary' | 'full'
}

/** The runtime's breakdown of a session's context window. Mirrors the SDK's `getContextUsage()` response; plain data. */
export interface RuntimeContextUsage {
  detail: 'summary' | 'full'
  model: string | null
  totalTokens: number
  /** The window usage is measured against. */
  maxTokens: number | null
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
  systemPromptSections: { name: string; tokens: number }[]
  systemTools: { name: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean | null }[]
  memoryFiles: { path: string; tokens: number }[]
  messageBreakdown: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: { name: string; callTokens: number; resultTokens: number }[]
  } | null
}

export interface ExternalMcpServer {
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
}

export interface SessionSpec {
  agentId: string
  role: AgentRole
  /** v0.6: the agent's label ("Worker/api · candidate B"). Providers ignore it; the provider router reads it. */
  label?: string
  /** Absolute working directory (the task worktree for writing roles). */
  cwd: string
  /** Model id or alias. Undefined uses the runtime default. */
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTurns: number
  /** Role policy text appended to the runtime's base system prompt. */
  systemPromptAppend: string
  /** First user message (the context pack). */
  prompt: string
  /** Built-in tool names this session may see. Anything else does not exist for the model. */
  tools: string[]
  /** Policy check invoked for every tool call before it runs. Must not throw. */
  authorize(request: ToolRequest): Promise<ToolDecision>
  /** Called for `ask` decisions; resolves when the user approves (true) or denies (false). */
  requestApproval(request: ToolRequest, reason: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  /** JSON Schema (draft-07) for a validated structured final result. */
  outputSchema?: Record<string, unknown>
  nexusTools?: NexusToolHandlers
  mcpServers?: Record<string, ExternalMcpServer>
  /** Resume this SDK session instead of starting fresh. */
  resumeSessionId?: string
  /** Load the project's CLAUDE.md / .claude settings. Default false (isolated). */
  loadProjectSettings: boolean
  /** Strip API-key variables from the child environment. */
  subscriptionMode: boolean
  /** v0.7.1: context options. Absent means the 0.7.0 behaviour. */
  contextOptions?: SessionContextOptions
}

export interface UsageInfo {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  contextWindow: number | null
  /** Thinking tokens, already counted inside `outputTokens`. Absent when the runtime did not report them. */
  thinkingTokens?: number
}

export type TurnOutcome =
  | 'success'
  | 'max_turns'
  | 'structured_output_failed'
  | 'aborted'
  | 'quota'
  | 'auth'
  | 'error'

export interface TurnResult {
  outcome: TurnOutcome
  /** Final assistant text for the turn (empty on error). */
  text: string
  structuredOutput: unknown
  numTurns: number
  durationMs: number
  /** Cumulative for the session, as reported by the SDK. */
  usage: UsageInfo[]
  totalCostUsd: number | null
  errors: string[]
}

export type AgentEvent =
  | { type: 'session.started'; sessionId: string; model: string; tools: string[]; apiKeySource: string | null; /** Set by the provider router. */ provider?: string }
  /**
   * v0.7.1: one model request finished. `requestId` is the API message id: several assistant messages of one
   * response share it. `outputTokens` is the count known when the response began (the turn result has the total).
   */
  | { type: 'request.usage'; requestId: string; model: string | null; inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number }
  /** v0.7.1: the runtime's breakdown of the context window, read at the end of a turn. */
  | { type: 'context.usage'; usage: RuntimeContextUsage }
  /** v0.7.1: the runtime compacted the conversation. */
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null; durationMs: number | null }
  /** A completed assistant text block. */
  | { type: 'text'; text: string }
  /** Incremental text while a block streams. Not persisted. */
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool.completed'; toolUseId: string; isError: boolean; outputPreview: string }
  | { type: 'tool.denied'; toolUseId: string; toolName: string; reason: string }
  | {
      type: 'rate_limit'
      status: 'allowed' | 'allowed_warning' | 'rejected'
      /** Epoch seconds, as the SDK reports it. */
      resetsAt: number | null
      limitType: string | null
      /** Verbatim runtime figure; the SDK does not document its unit. */
      utilization?: number | null
      overageStatus?: 'allowed' | 'allowed_warning' | 'rejected' | null
      isUsingOverage?: boolean | null
      surpassedThreshold?: number | null
    }
  /** A transient throttle (overloaded / server error). Never a quota condition. */
  | { type: 'throttle'; kind: 'overloaded' | 'server_error' | 'rate_limit' }
  | { type: 'status'; status: string }
  | { type: 'turn.completed'; result: TurnResult }
  /** The session process ended. No further events follow. */
  | { type: 'session.ended'; reason: 'completed' | 'stopped' | 'crashed'; error: string | null }

export interface AgentSessionHandle {
  readonly agentId: string
  /** SDK session id once the init message has arrived. */
  sessionId(): string | null
  /** Single-consumer stream of events. Always terminates with `session.ended`. */
  readonly events: AsyncIterable<AgentEvent>
  /** Queue a follow-up user message. It starts a new turn once the current one finishes. */
  send(text: string): void
  /** Abort the current turn but keep the session alive. */
  interrupt(): Promise<void>
  /** Signal that no more input will come, letting the session finish after the current turn. */
  end(): void
  /** Terminate the session process. */
  stop(): Promise<void>
}

export interface RuntimeCapabilities {
  models: ModelOption[]
  supportsResume: boolean
  supportsStructuredOutput: boolean
  supportsEffort: boolean
  sdkVersion: string
}

/** The fixed prompt of the availability probe's minimal session (usage/probe.ts). */
export const USAGE_PROBE_PROMPT = 'Reply with the single word OK.'

/** The runtime's no-prompt plan-usage report (experimental SDK method), already validated. */
export interface RuntimeUsageReport {
  rateLimitsAvailable: boolean
  subscriptionType: string | null
  windows: { limitType: string; utilizationPercent: number | null; resetsAt: string | null }[]
}

export interface AgentRuntime {
  startSession(spec: SessionSpec): AgentSessionHandle
  /** Same as startSession with `resumeSessionId` set; kept explicit for call-site clarity. */
  resumeSession(spec: SessionSpec, sdkSessionId: string): AgentSessionHandle
  sendMessage(handle: AgentSessionHandle, text: string): void
  interruptSession(handle: AgentSessionHandle): Promise<void>
  stopSession(handle: AgentSessionHandle): Promise<void>
  getCapabilities(): Promise<RuntimeCapabilities>
  /** Auth status as reported by the runtime. Never reads credential stores. */
  getAccountInfo(options: { subscriptionMode: boolean }): Promise<AuthStatus>
  /**
   * Plan windows without sending a prompt. Null when unsupported, unavailable or failed; never throws.
   * Experimental in the SDK, so callers must treat null as UNKNOWN.
   */
  getUsageReport?(options: { subscriptionMode: boolean }): Promise<RuntimeUsageReport | null>
  /** Stop every live session (application shutdown). */
  shutdown(): Promise<void>
}
