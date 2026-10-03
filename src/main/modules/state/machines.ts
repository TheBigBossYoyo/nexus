import type { AgentState, RunState, TaskState } from '@shared/domain'
import { NexusError } from '@shared/result'

export interface StateOf {
  task: TaskState
  agent: AgentState
  run: RunState
}
export type MachineKind = keyof StateOf

type Table<S extends string> = Record<S, readonly S[]>

const TASK_TRANSITIONS: Table<TaskState> = {
  draft: ['ready', 'blocked', 'failed', 'cancelled'],
  ready: ['queued', 'assigned', 'blocked', 'failed', 'cancelled'],
  queued: ['assigned', 'ready', 'blocked', 'failed', 'cancelled'],
  // assigned/running may fall back to queued when a lease expires or the agent never started.
  assigned: ['running', 'queued', 'blocked', 'failed', 'cancelled'],
  running: ['waiting', 'review', 'completed', 'queued', 'blocked', 'failed', 'cancelled'],
  waiting: ['running', 'review', 'blocked', 'failed', 'cancelled'],
  // review/verification may bounce back to running (changes requested) or complete directly
  // when the task needs no further gate.
  review: ['verification', 'completed', 'running', 'waiting', 'blocked', 'failed', 'cancelled'],
  verification: ['completed', 'running', 'waiting', 'blocked', 'failed', 'cancelled'],
  blocked: ['ready', 'failed', 'cancelled'],
  failed: ['ready'],
  completed: [],
  cancelled: [],
}

const AGENT_TRANSITIONS: Table<AgentState> = {
  idle: ['starting', 'stopped', 'failed'],
  starting: ['working', 'stopping', 'failed'],
  working: ['waiting', 'blocked', 'stopping', 'failed'],
  waiting: ['working', 'blocked', 'stopping', 'failed'],
  blocked: ['working', 'waiting', 'stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['failed'],
  failed: [],
}

const RUN_PHASES = ['executing', 'testing', 'reviewing', 'verifying', 'repairing'] as const
/** States in which a run can be paused (and resumed into). */
const RESUMABLE_RUN_STATES: readonly RunState[] = ['planning', 'awaiting_approval', ...RUN_PHASES]

const phasesExcept = (self: RunState): RunState[] => RUN_PHASES.filter((p) => p !== self)

const RUN_TRANSITIONS: Table<RunState> = {
  planning: ['awaiting_approval', 'executing', 'paused', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'planning', 'paused', 'failed', 'cancelled'],
  executing: [...phasesExcept('executing'), 'completed', 'paused', 'failed', 'cancelled'],
  testing: [...phasesExcept('testing'), 'paused', 'failed', 'cancelled'],
  reviewing: [...phasesExcept('reviewing'), 'paused', 'failed', 'cancelled'],
  verifying: [...phasesExcept('verifying'), 'completed', 'paused', 'failed', 'cancelled'],
  repairing: [...phasesExcept('repairing'), 'paused', 'failed', 'cancelled'],
  // Which of these is legal is decided by Run.resumeState; see resumeTarget.
  paused: [...RESUMABLE_RUN_STATES, 'failed', 'cancelled'],
  failed: [],
  completed: [],
  cancelled: [],
}

const TABLES: { [K in MachineKind]: Table<StateOf[K] & string> } = {
  task: TASK_TRANSITIONS,
  agent: AGENT_TRANSITIONS,
  run: RUN_TRANSITIONS,
}

export function allowedTransitions<K extends MachineKind>(kind: K, from: StateOf[K]): readonly StateOf[K][] {
  const table = TABLES[kind] as Record<string, readonly StateOf[K][]>
  return table[from as string] ?? []
}

export function canTransition<K extends MachineKind>(kind: K, from: StateOf[K], to: StateOf[K]): boolean {
  return allowedTransitions(kind, from).includes(to)
}

export function assertTransition<K extends MachineKind>(kind: K, from: StateOf[K], to: StateOf[K]): void {
  if (!canTransition(kind, from, to)) {
    throw new NexusError('invalid_transition', `Invalid ${kind} transition: ${from} -> ${to}`, {
      kind,
      from,
      to,
      allowed: allowedTransitions(kind, from),
    })
  }
}

/** True when no further transition is possible (task `failed` is retryable, so not final). */
export function isFinalState<K extends MachineKind>(kind: K, state: StateOf[K]): boolean {
  return allowedTransitions(kind, state).length === 0
}

/** The state a paused run must resume into; throws if the run is not paused or has no recorded state. */
export function resumeTarget(run: { state: RunState; resumeState: RunState | null }): RunState {
  if (run.state !== 'paused') {
    throw new NexusError('invalid_transition', `Cannot resume a run in state ${run.state}`)
  }
  if (run.resumeState === null || !RESUMABLE_RUN_STATES.includes(run.resumeState)) {
    throw new NexusError('invalid_transition', 'Paused run has no valid resume state', {
      resumeState: run.resumeState,
    })
  }
  return run.resumeState
}

/** True if a run in this state can be paused. */
export function canPauseRun(state: RunState): boolean {
  return canTransition('run', state, 'paused')
}
