import type {
  AgentState,
  ApprovalStatus,
  MessageType,
  PauseReason,
  RunState,
  Severity,
  TaskState,
} from './domain'

/** Payload shape for every durable event type. Adding an event means adding a key here. */
export interface EventPayloads {
  'run.created': { mode: string; preset: string }
  'run.state_changed': { from: RunState; to: RunState; reason?: string }
  'run.started': Record<string, never>
  'run.paused': { reason: PauseReason; detail?: string }
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
  'agent.failed': { error: string }
  'agent.stopped': { reason: string }
  'agent.rotated': { fromSessionId: string | null; turns: number }
  'agent.usage': { inputTokens: number; outputTokens: number; costUsd: number }
  'agent.rate_limited': { status: string; resetsAt: number | null; limitType: string | null }

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
