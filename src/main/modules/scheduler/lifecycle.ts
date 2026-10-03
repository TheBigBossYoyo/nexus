import { TERMINAL_TASK_STATES } from '@shared/domain'
import type { ModelTier, Task, TaskDependency, TaskState } from '@shared/domain'
import { transitiveDependants } from '@main/modules/task-graph/graph'

const isTerminal = (t: Task): boolean => TERMINAL_TASK_STATES.includes(t.state)

/** Non-terminal tasks whose lease has lapsed (an unparseable expiry counts as lapsed). */
export function findExpiredLeases(tasks: readonly Task[], now: string): Task[] {
  const nowMs = Date.parse(now)
  return tasks.filter((t) => {
    if (isTerminal(t) || t.leaseOwner === null || t.leaseExpiresAt === null) return false
    const expires = Date.parse(t.leaseExpiresAt)
    return Number.isNaN(expires) || expires <= nowMs
  })
}

export interface CascadeBlock {
  taskId: string
  /** The failed/cancelled tasks that (transitively) caused it. */
  rootTaskIds: string[]
  reason: string
}

/**
 * Tasks that have not started and must become blocked because a dependency, direct or
 * indirect, failed or was cancelled. Already blocked and terminal tasks are not returned.
 */
export function dependencyFailureCascade(
  tasks: readonly Task[],
  deps: readonly TaskDependency[],
): CascadeBlock[] {
  const roots = tasks.filter((t) => t.state === 'failed' || t.state === 'cancelled')
  const startable: readonly TaskState[] = ['draft', 'ready', 'queued']
  const causes = new Map<string, string[]>()
  for (const root of roots) {
    for (const id of transitiveDependants(deps, root.id)) {
      const list = causes.get(id) ?? []
      list.push(root.id)
      causes.set(id, list)
    }
  }
  const blocks: CascadeBlock[] = []
  for (const task of tasks) {
    const rootTaskIds = causes.get(task.id)
    if (!rootTaskIds || !startable.includes(task.state)) continue
    const keys = rootTaskIds.map((id) => tasks.find((t) => t.id === id)?.key ?? id)
    blocks.push({
      taskId: task.id,
      rootTaskIds,
      reason: `Blocked because dependency ${keys.join(', ')} failed or was cancelled`,
    })
  }
  return blocks
}

/** Non-terminal tasks that must be cancelled when `taskId` is cancelled (its transitive dependants). */
export function cancellationCascade(
  tasks: readonly Task[],
  deps: readonly TaskDependency[],
  taskId: string,
): Task[] {
  const affected = new Set(transitiveDependants(deps, taskId))
  return tasks.filter((t) => affected.has(t.id) && !isTerminal(t))
}

export type FailureKind = 'quota' | 'agent_error' | 'verification_failed' | 'timeout' | 'crash'

export type NextAttemptPlan =
  | {
      action: 'retry'
      /** Run a diagnosis pass before retrying. */
      diagnose: boolean
      /** Tier override to store on the task; null keeps the current one. */
      modelTierOverride: ModelTier | null
      /** Value Task.attempt should hold after recording this failure. */
      attemptAfter: number
      reason: string
    }
  | { action: 'wait_for_quota'; attemptAfter: number; reason: string }
  | { action: 'give_up'; attemptAfter: number; reason: string }

const TIER_ORDER: readonly ModelTier[] = ['fast', 'balanced', 'strongest']

export interface NextAttemptInput {
  /** The task whose attempt (`task.attempt`) just failed. */
  task: Pick<Task, 'attempt' | 'modelTierOverride' | 'key'>
  /** Retries allowed after the first attempt. */
  maxRetries: number
  failureKind: FailureKind
  /** Tier the task would use without an override (role policy); defaults to 'balanced'. */
  baseTier?: ModelTier
}

/**
 * First failure: retry after diagnosis. Second: retry on the next stronger tier.
 * Beyond maxRetries: give up for human intervention. Quota failures never consume an attempt.
 */
export function nextAttemptPlan(input: NextAttemptInput): NextAttemptPlan {
  const { task, maxRetries, failureKind } = input
  if (failureKind === 'quota') {
    return {
      action: 'wait_for_quota',
      attemptAfter: Math.max(0, task.attempt - 1),
      reason: 'Usage quota reached; the attempt is not counted and the task resumes when quota returns',
    }
  }

  const failures = task.attempt
  if (failures > maxRetries) {
    return {
      action: 'give_up',
      attemptAfter: task.attempt,
      reason: `Task failed ${failures} times (max retries ${maxRetries}); human intervention required`,
    }
  }
  if (failures <= 1) {
    return {
      action: 'retry',
      diagnose: true,
      modelTierOverride: null,
      attemptAfter: task.attempt,
      reason: 'First failure: diagnose, then retry',
    }
  }
  const current = task.modelTierOverride ?? input.baseTier ?? 'balanced'
  const promoted = TIER_ORDER[Math.min(TIER_ORDER.indexOf(current) + 1, TIER_ORDER.length - 1)] ?? current
  return {
    action: 'retry',
    diagnose: true,
    modelTierOverride: promoted,
    attemptAfter: task.attempt,
    reason:
      promoted === current
        ? `Failure ${failures}: already on the strongest tier, retrying after diagnosis`
        : `Failure ${failures}: escalating from ${current} to ${promoted}`,
  }
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled'

/** A run is finished when it has tasks and all of them are terminal. */
export function isRunFinished(tasks: readonly Task[]): boolean {
  return tasks.length > 0 && tasks.every(isTerminal)
}

/**
 * A repair child that failed or was cancelled while its parent is not failed. Repair children are
 * attempts, kept as history: once the parent has been retried (or completed) a dead attempt must not
 * make the run failed, stuck or cancelled. A failed parent keeps its dead children visible.
 */
export function isSupersededRepair(task: Task, tasks: readonly Task[]): boolean {
  if (task.kind !== 'repair' || task.parentTaskId === null) return false
  if (task.state !== 'failed' && task.state !== 'cancelled') return false
  const parent = tasks.find((t) => t.id === task.parentTaskId)
  return parent !== undefined && parent.state !== 'failed'
}

/** The tasks that count towards run completion: everything except superseded repair attempts. */
export function countedTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => !isSupersededRepair(t, tasks))
}

/**
 * Null while unfinished. Any failed task makes the run failed; all completed is completed;
 * otherwise (completed mixed with cancelled, or all cancelled) it is cancelled.
 * Superseded repair attempts (see isSupersededRepair) do not count.
 */
export function runOutcome(allTasks: readonly Task[]): RunOutcome | null {
  const tasks = countedTasks(allTasks)
  if (!isRunFinished(tasks)) return null
  if (tasks.some((t) => t.state === 'failed')) return 'failed'
  if (tasks.every((t) => t.state === 'completed')) return 'completed'
  return 'cancelled'
}

export function countByState(tasks: readonly Task[]): Partial<Record<TaskState, number>> {
  const counts: Partial<Record<TaskState, number>> = {}
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1
  return counts
}
