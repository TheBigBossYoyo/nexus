import type { Task } from '@shared/domain'

/**
 * 0.9.1: what a read-only mission (an audit, a question) produced: the report of its synthesis task, else of the task
 * that finished last. The owner's first audit ended on an overview of merge instructions and empty checks, its
 * 22,000-character report one click deep in the task graph.
 */
export function reportOf(tasks: readonly Task[]): { task: Task; others: Task[] } | null {
  const done = tasks.filter((t) => t.state === 'completed' && (t.resultSummary ?? '').trim() !== '')
  const last = [...done].sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')).at(-1)
  if (last === undefined) return null
  const task = done.find((t) => t.kind === 'synthesis') ?? last
  return { task, others: done.filter((t) => t.id !== task.id) }
}
