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
}

export interface UsageInfo {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  contextWindow: number | null
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
  | { type: 'session.started'; sessionId: string; model: string; tools: string[]; apiKeySource: string | null }
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
