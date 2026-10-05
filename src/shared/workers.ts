/**
 * NEXUS 0.7: workers. A worker is a process of its own that runs one agent session at a time for the runtime.
 * The runtime decides what runs; a worker only executes the assignment it holds a lease for, and every policy
 * decision about a tool call is still made in the runtime.
 */

export const WORKER_STATES = ['STARTING', 'IDLE', 'ASSIGNED', 'RUNNING', 'DRAINING', 'STOPPING', 'STOPPED', 'FAILED', 'RECOVERING'] as const
export type WorkerState = (typeof WORKER_STATES)[number]

/** States in which the worker's process is expected to exist. */
export const LIVE_WORKER_STATES: readonly WorkerState[] = ['STARTING', 'IDLE', 'ASSIGNED', 'RUNNING', 'DRAINING', 'STOPPING', 'RECOVERING']

/** The transitions a worker may make. Anything else is a defect and is refused. */
export const WORKER_TRANSITIONS: Record<WorkerState, readonly WorkerState[]> = {
  STARTING: ['IDLE', 'FAILED', 'STOPPING', 'STOPPED', 'RECOVERING'],
  IDLE: ['ASSIGNED', 'DRAINING', 'STOPPING', 'STOPPED', 'FAILED', 'RECOVERING'],
  ASSIGNED: ['RUNNING', 'IDLE', 'STOPPING', 'STOPPED', 'FAILED', 'RECOVERING'],
  RUNNING: ['IDLE', 'DRAINING', 'STOPPING', 'STOPPED', 'FAILED', 'RECOVERING'],
  DRAINING: ['STOPPING', 'STOPPED', 'FAILED', 'RECOVERING'],
  STOPPING: ['STOPPED', 'FAILED'],
  RECOVERING: ['STOPPED', 'FAILED'],
  STOPPED: [],
  FAILED: [],
}

export function canTransitionWorker(from: WorkerState, to: WorkerState): boolean {
  return WORKER_TRANSITIONS[from].includes(to)
}

export interface WorkerAssignment {
  leaseId: string
  agentId: string
  runId: string | null
  taskId: string | null
  provider: string
  /** The provider's session id, once the session reported it. */
  sessionId: string | null
  worktree: string
  assignedAt: string
}

export interface WorkerRecord {
  id: string
  /** The start of the runtime that owns this worker. A worker of an earlier start is stale. */
  bootId: string
  pid: number | null
  state: WorkerState
  startedAt: string
  heartbeatAt: string | null
  stoppedAt: string | null
  exitCode: number | null
  error: string | null
  /** Assignments this worker has finished or holds. */
  assignments: number
  /** The providers whose sessions this worker can run. */
  capabilities: string[]
  assignment: WorkerAssignment | null
}

export const LEASE_STATES = ['ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'] as const
export type LeaseState = (typeof LEASE_STATES)[number]

export interface WorkerLease {
  id: string
  workerId: string
  bootId: string
  agentId: string
  runId: string | null
  taskId: string | null
  provider: string
  state: LeaseState
  grantedAt: string
  heartbeatAt: string
  expiresAt: string
  releasedAt: string | null
  /** Why the lease ended, when it did not end by the session ending. */
  reason: string | null
}

export interface WorkerEvent {
  workerId: string
  at: string
  kind: string
  detail: string | null
}

/** What the Control Center's worker view reads. */
export interface WorkersOverview {
  /** Workers whose process exists, and the most recent ones that ended. */
  workers: WorkerRecord[]
  leases: WorkerLease[]
  limits: { maxWorkers: number }
  counts: { live: number; busy: number; idle: number; waitingAssignments: number }
  /** True when sessions run in worker processes; false when this runtime runs them itself (scripted runs). */
  enabled: boolean
  events: WorkerEvent[]
}
