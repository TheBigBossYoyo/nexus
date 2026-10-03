import { WRITING_ROLES } from '@shared/domain'
import type { Task, TaskDependency } from '@shared/domain'
import { dependenciesOf, transitiveDependants } from '@main/modules/task-graph/graph'
import { findOverlappingFiles } from './file-overlap'

export interface SchedulerInput {
  tasks: readonly Task[]
  dependencies: readonly TaskDependency[]
  /** Tasks currently holding an agent slot. */
  activeTaskIds: readonly string[]
  maxParallelAgents: number
  /** ISO timestamp; passed in so the function stays pure. */
  now: string
  paused: boolean
}

export type DeferReason =
  | { kind: 'run_paused' }
  | { kind: 'leased'; leaseOwner: string; leaseExpiresAt: string }
  | { kind: 'waiting_on_dependencies'; dependencyIds: string[] }
  | { kind: 'awaiting_approval' }
  | { kind: 'no_free_slot' }
  | { kind: 'serialized_file_overlap'; behindTaskId: string; files: string[] }
  | { kind: 'serialized_not_parallelizable'; behindTaskId: string }

export interface DeferredTask {
  taskId: string
  reason: DeferReason
}

export interface SchedulerDecision {
  /** Task ids to start now, in start order. */
  start: string[]
  /** Every other ready/queued task not already active, in consideration order, with why. */
  deferred: DeferredTask[]
  freeSlots: number
}

export const isWritingTask = (task: Pick<Task, 'role'>): boolean => WRITING_ROLES.includes(task.role)

function conflictWith(candidate: Task, running: readonly Task[]): DeferReason | null {
  for (const other of running) {
    const files = findOverlappingFiles(candidate.suggestedFiles, other.suggestedFiles)
    if (files.length > 0) {
      return { kind: 'serialized_file_overlap', behindTaskId: other.id, files }
    }
    if (!candidate.parallelizable || !other.parallelizable) {
      return { kind: 'serialized_not_parallelizable', behindTaskId: other.id }
    }
  }
  return null
}

/**
 * Decide which tasks to start now. Order: priority desc, then transitive dependants desc
 * (unblocks the most work), then createdAt, then id. A task that conflicts or finds no slot
 * does not stop lower-ranked tasks that fit.
 */
export function selectRunnable(input: SchedulerInput): SchedulerDecision {
  const { tasks, dependencies, activeTaskIds, now } = input
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const active = new Set(activeTaskIds)
  const freeSlots = Math.max(0, input.maxParallelAgents - active.size)
  const nowMs = Date.parse(now)

  const dependantCount = new Map<string, number>()
  const candidates = tasks.filter((t) => (t.state === 'ready' || t.state === 'queued') && !active.has(t.id))
  for (const t of candidates) dependantCount.set(t.id, transitiveDependants(dependencies, t.id).length)

  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      (dependantCount.get(b.id) ?? 0) - (dependantCount.get(a.id) ?? 0) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const runningWriters: Task[] = activeTaskIds
    .map((id) => byId.get(id))
    .filter((t): t is Task => t !== undefined && isWritingTask(t))

  const start: string[] = []
  const deferred: DeferredTask[] = []
  const defer = (task: Task, reason: DeferReason): void => {
    deferred.push({ taskId: task.id, reason })
  }

  for (const task of candidates) {
    if (input.paused) {
      defer(task, { kind: 'run_paused' })
      continue
    }
    if (
      task.leaseOwner !== null &&
      task.leaseExpiresAt !== null &&
      Date.parse(task.leaseExpiresAt) > nowMs
    ) {
      defer(task, { kind: 'leased', leaseOwner: task.leaseOwner, leaseExpiresAt: task.leaseExpiresAt })
      continue
    }
    const unmet = dependenciesOf(dependencies, task.id).filter(
      (id) => byId.get(id)?.state !== 'completed',
    )
    if (unmet.length > 0) {
      defer(task, { kind: 'waiting_on_dependencies', dependencyIds: unmet })
      continue
    }
    if (task.requiresApproval && !task.approvalGranted) {
      defer(task, { kind: 'awaiting_approval' })
      continue
    }
    if (start.length >= freeSlots) {
      defer(task, { kind: 'no_free_slot' })
      continue
    }
    if (isWritingTask(task)) {
      const conflict = conflictWith(task, runningWriters)
      if (conflict) {
        defer(task, conflict)
        continue
      }
      runningWriters.push(task)
    }
    start.push(task.id)
  }

  return { start, deferred, freeSlots }
}
