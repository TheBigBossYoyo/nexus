import type {
  AgentState,
  ApprovalStatus,
  MessageType,
  PauseReason,
  RunState,
  Severity,
  TaskState,
} from './domain'
import type { OvernightStatus } from './overnight'
import type { ConnectionState } from './runtime-protocol'
import type { UsageOverview } from './v3'

/**
 * Why a run paused, more precisely than PauseReason: 'user' is the person pausing it, 'intervention'
 * is NEXUS stopping because no task can make progress. Absent on events written before 0.2.1.
 */
export type PauseCause = 'user' | 'intervention' | 'time_limit' | 'auth' | 'quota' | 'recovery' | 'capacity'

/** Payload shape for every durable event type. Adding an event means adding a key here. */
export interface EventPayloads {
  'run.created': { mode: string; preset: string }
  'run.state_changed': { from: RunState; to: RunState; reason?: string }
  'run.started': Record<string, never>
  'run.paused': { reason: PauseReason; detail?: string; cause?: PauseCause }
  'run.resumed': Record<string, never>
  'run.completed': { summary: string }
  'run.failed': { error: string }
  'run.cancelled': Record<string, never>
  'run.recovered': { action: string; staleAgents: number }

  'plan.proposed': { taskCount: number; attempt: number }
  'plan.invalid': { errors: string[]; attempt: number }
  'plan.approved': Record<string, never>
  'plan.rejected': { feedback: string }

  'task.created': { key: string; title: string; role: string; kind: string }
  'task.state_changed': { from: TaskState; to: TaskState; reason?: string }
  'task.ready': Record<string, never>
  'task.assigned': { agentId: string }
  'task.started': { attempt: number }
  'task.blocked': { reason: string }
  'task.completed': { summary: string }
  'task.failed': { what: string; where: string | null; why: string | null; retryable: boolean }
  'task.cancelled': Record<string, never>
  'task.retry': { attempt: number; reason: string }
  'task.escalated': { toTier: string }
  'task.updated': { fields: string[] }
  'task.lease_expired': { owner: string | null }
  'task.serialized': { conflictsWith: string; files: string[] }

  'agent.started': { role: string; model: string | null; sessionId: string | null }
  'agent.state_changed': { from: AgentState; to: AgentState }
  'agent.message': { preview: string }
  'agent.tool.started': { toolUseId: string; toolName: string; summary: string }
  'agent.tool.completed': { toolUseId: string; toolName: string; isError: boolean }
  'agent.tool.denied': { toolName: string; reason: string }
  'agent.waiting': { reason: string }
  'capacity.waiting': { routingId: string; provider: string | null; reasons: string[] }
  'agent.failed': { error: string }
  'agent.stopped': { reason: string }
  'agent.rotated': { fromSessionId: string | null; turns: number }
  'agent.usage': {
    inputTokens: number
    outputTokens: number
    costUsd: number
    /** v0.3: this turn's own (delta) figures per model, for the usage service. Absent on older events. */
    turn?: {
      sdkSessionId: string | null
      role: string
      turns: number
      durationMs: number
      models: {
        model: string
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheCreationTokens: number
        costUsd: number
      }[]
    }
  }
  'agent.rate_limited': {
    status: string
    resetsAt: number | null
    limitType: string | null
    /** v0.3: the runtime's own figures, verbatim, when it sent them. */
    utilization?: number | null
    overageStatus?: string | null
    isUsingOverage?: boolean | null
    surpassedThreshold?: number | null
  }

  'git.worktree.created': { path: string; branch: string }
  'git.worktree.removed': { path: string }
  'git.commit.created': { commit: string; branch: string; message: string }
  'git.merged': { branch: string; into: string; commit: string }
  'git.conflict': { branch: string; into: string; files: string[] }

  'checks.started': { commands: string[] }
  'checks.completed': { passed: boolean; failed: string[] }

  'review.started': { attempt: number }
  'review.finding': { severity: Severity; title: string; file: string | null }
  'review.completed': { verdict: 'approved' | 'changes_requested'; findings: number }

  'verification.started': { attempt: number }
  'verification.failed': { failures: number; summary: string }
  'verification.passed': { summary: string }

  'approval.requested': { approvalId: string; action: string; risk: string }
  'approval.granted': { approvalId: string }
  'approval.denied': { approvalId: string; note: string | null }
  'approval.resolved': { approvalId: string; status: ApprovalStatus }

  'message.sent': { messageId: string; type: MessageType; from: string; to: string }
  'memory.proposed': { memoryId: string; title: string }
  'memory.promoted': { memoryId: string }
  'decision.recorded': { decisionId: string; title: string }
  'criterion.updated': { criterionId: string; status: string }
  'user.intervention': { action: string; detail?: string }

  'graph.proposed': { proposalId: string; type: string; proposedBy: string }
  'graph.revised': { proposalId: string | null; revisionId: string; version: number; summary: string }
  'graph.rejected': { proposalId: string; errors: string[] }
  'planning.candidate': { candidateId: string; label: string; valid: boolean }
  'planning.critique': { critiqueId: string; findings: number; preferred: string }
  'planning.synthesized': { candidates: number; validCandidates: number }
  'routing.decided': { decisionId: string; role: string; policy: string; model: string | null; reasons: string[] }
  'intelligence.refreshed': { facts: number; stale: number }
  'context.composed': { packId: string; included: number; excluded: number; chars: number }
  'review.arbitrated': { accepted: number; rejected: number }

  // v0.2.1: Overnight Mode. Emitted by the OvernightSupervisor only.
  'overnight.started': { deadlineAt: string; endAction: string; failsafeDeadline: string | null }
  'overnight.state_changed': { from: string; to: string; detail?: string }
  'overnight.failsafe': { action: 'armed' | 'cancelled' | 'rearmed' | 'lost' | 'failed'; deadline: string | null; ok: boolean }
  'overnight.quota': { action: 'waiting' | 'resumed' | 'exhausted'; resetsAt: string | null; resumeAt: string | null }
  'overnight.watchdog': { stage: string; detail: string }
  'overnight.report': { path: string | null; chars: number }
  'overnight.power': { action: string; operation: string; ok: boolean; executeAt: string | null; detail: string }
  'overnight.amended': { change: string }
  'overnight.approval': { approvalId: string; kind: string; decision: 'approved' | 'denied' }
  'checkpoint.saved': { checkpointId: string; reason: string }

  // v0.3: usage and quota recovery (run-scoped records of what the usage service did to this run).
  'usage.quota_paused': { pauseId: string; resetAt: string | null; nextCheckAt: string | null; limitType: string | null }
  'usage.probe': { pauseId: string; method: string; result: string }
  'usage.quota_resumed': { pauseId: string; waitedMs: number; method: string }
  'usage.wait_ended': { pauseId: string; reason: string }
  // v0.3: strategy, policy, speculation
  'strategy.selected': { requested: string; resolved: string; reason: string }
  'policy.decided': { decisionId: string; strategy: string; layer: string; exploration: boolean; policyVersion: number }
  'speculative.started': { speculativeRunId: string; candidates: string[]; baseCommit: string }
  'speculative.candidate': { speculativeRunId: string; label: string; implemented: boolean; checksPassed: boolean | null }
  'speculative.decided': { speculativeRunId: string; winner: string | null; ranking: string[]; confidence: string }
  'outcome.recorded': { outcomeId: string; strategy: string; success: boolean }
}

export type EventType = keyof EventPayloads

export interface RunEvent<T extends EventType = EventType> {
  /** Stable unique id. */
  id: string
  /** Monotonic per-database sequence, used for ordered replay and incremental fetch. */
  seq: number
  runId: string
  taskId: string | null
  agentId: string | null
  type: T
  payload: EventPayloads[T]
  createdAt: string
}

export interface NewEvent<T extends EventType = EventType> {
  runId: string
  taskId?: string | null
  agentId?: string | null
  type: T
  payload: EventPayloads[T]
}

/**
 * Ephemeral push messages main → renderer. Durable events are the source of truth; `agent.delta`
 * is a transient streaming aid and is never persisted.
 */
export type PushMessage =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'agent.output'; agentId: string; runId: string; seq: number; outputKind: string; content: string }
  | { kind: 'agent.delta'; agentId: string; runId: string; text: string }
  | { kind: 'auth.changed' }
  | { kind: 'overnight'; status: OvernightStatus }
  /** v0.3. The usage status changed (limit, wait, probe, resume) or observed totals moved. */
  | { kind: 'usage'; overview: UsageOverview }
  /** v0.3. A notification worth one toast (limit reached, resumed). Never sent for transient throttles. */
  | { kind: 'usage.notice'; notice: 'limit_reached' | 'resumed' | 'wait_ended'; title: string; detail: string }
  /** v0.3. An Arena campaign or one of its trials changed. */
  | { kind: 'arena'; campaignId: string }
  /** v0.3. The policy pointer, candidates or statistics changed. */
  | { kind: 'policy' }
  /** v0.4. A program, its roadmap, decisions, backlog or memory changed. */
  | { kind: 'program'; programId: string }
  /** v0.4. The backlog or the background jobs of a project changed. */
  | { kind: 'backlog'; projectId: string }
  /** v0.5. A workspace, its repositories, graph, contracts, missions or release trains changed. */
  | { kind: 'workspace'; workspaceId: string }
  /** v0.6. A provider's status, the provider policy or the record of provider sessions changed. */
  | { kind: 'providers' }
  /** v0.7. The global queue, the allocation, a schedule or the runtime health changed. */
  | { kind: 'control' }
  /** v0.7. The runtime's own state changed: recovery finished, dispatch paused, a worker started or ended. */
  | { kind: 'runtime' }
  /** v0.7. From the window's main process: its connection to the runtime changed. */
  | { kind: 'connection'; state: ConnectionState }
  /** v0.7. The runtime asks the window to come forward, optionally on a page. Handled by the window's main process. */
  | { kind: 'desktop'; action: 'show'; view: 'control' | null }
