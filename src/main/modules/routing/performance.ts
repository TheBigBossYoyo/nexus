import type {
  Agent,
  AgentMetrics,
  ModelTier,
  Review,
  Run,
  Task,
  Verification,
} from '@shared/domain'
import { MIN_ROUTING_SAMPLES, type PerformanceStat, type TaskOutcome } from '@shared/v2'

export interface AggregateOptions {
  /** Outcomes needed before a row is `sufficient`. Default MIN_ROUTING_SAMPLES. */
  minSamples?: number
  /** Recent outcomes listed per row, newest first. Default 5. */
  recent?: number
}

const fraction = (count: number, total: number): number => (total === 0 ? 0 : count / total)

function average(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return null
  return present.reduce((sum, v) => sum + v, 0) / present.length
}

/**
 * Group outcomes by role, model and category. Rates are fractions of outcomes (0..1): reviewRejectionRate,
 * checkFailureRate and interventionRate count outcomes with at least one rejection, failed check or
 * intervention. Outcomes without a model never ran and are skipped.
 */
export function aggregatePerformance(
  outcomes: readonly TaskOutcome[],
  opts: AggregateOptions = {},
): PerformanceStat[] {
  const minSamples = opts.minSamples ?? MIN_ROUTING_SAMPLES
  const recentCount = opts.recent ?? 5
  const groups = new Map<string, TaskOutcome[]>()
  for (const o of outcomes) {
    if (o.model === null) continue
    const key = JSON.stringify([o.role, o.model, o.category])
    const list = groups.get(key)
    if (list) list.push(o)
    else groups.set(key, [o])
  }

  const stats: PerformanceStat[] = []
  for (const rows of groups.values()) {
    const first = rows[0] as TaskOutcome
    const n = rows.length
    const newestFirst = [...rows].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId),
    )
    stats.push({
      role: first.role,
      model: first.model as string,
      category: first.category,
      samples: n,
      sufficient: n >= minSamples,
      firstPassRate: fraction(rows.filter((o) => o.firstPassVerified).length, n),
      completionRate: fraction(rows.filter((o) => o.completed).length, n),
      reviewRejectionRate: fraction(rows.filter((o) => o.reviewRejections > 0).length, n),
      averageRepairs: rows.reduce((s, o) => s + o.repairCount, 0) / n,
      checkFailureRate: fraction(rows.filter((o) => o.checksFailed > 0).length, n),
      interventionRate: fraction(rows.filter((o) => o.humanInterventions > 0).length, n),
      averageElapsedMs: average(rows.map((o) => o.elapsedMs)),
      averageOutputTokens: average(rows.map((o) => o.outputTokens)),
      recent: newestFirst.slice(0, Math.max(0, recentCount)).map((o) => ({
        taskId: o.taskId,
        completed: o.completed,
        firstPassVerified: o.firstPassVerified,
        createdAt: o.createdAt,
      })),
    })
  }
  return stats.sort(
    (a, b) =>
      b.samples - a.samples ||
      a.role.localeCompare(b.role) ||
      a.model.localeCompare(b.model) ||
      a.category.localeCompare(b.category),
  )
}

export interface BuildOutcomeInput {
  projectId: string
  run: Pick<Run, 'id'>
  task: Task
  /** The implementing agent's reported model and metrics; null when it never started. */
  implementAgent: (Pick<Agent, 'model'> & { metrics: AgentMetrics | null }) | null
  tier: ModelTier | null
  reviews: readonly Review[]
  verifications: readonly Verification[]
  repairChildren: readonly Task[]
  interventions: number
  now: string
}

/** Derive the outcome row for a finished implementing task. The id is `outcome-<taskId>` (one row per task). */
export function buildTaskOutcome(input: BuildOutcomeInput): TaskOutcome {
  const { task, implementAgent, reviews, verifications, repairChildren } = input
  const reviewRejections = reviews.filter((r) => r.verdict === 'changes_requested').length
  const verifierFailed = verifications.some((v) => v.kind === 'verifier' && !v.passed)
  const completed = task.state === 'completed'
  const started = task.startedAt === null ? null : Date.parse(task.startedAt)
  const finished = task.finishedAt === null ? null : Date.parse(task.finishedAt)
  const elapsedMs =
    started !== null && finished !== null && !Number.isNaN(started) && !Number.isNaN(finished)
      ? Math.max(0, finished - started)
      : null
  const metrics = implementAgent?.metrics ?? null
  return {
    id: `outcome-${task.id}`,
    projectId: input.projectId,
    runId: input.run.id,
    taskId: task.id,
    role: task.role,
    model: implementAgent?.model ?? null,
    tier: input.tier,
    category: task.kind,
    complexity: task.complexity,
    risk: task.risk,
    attempts: task.attempt,
    firstPassVerified:
      completed && task.attempt === 1 && repairChildren.length === 0 && reviewRejections === 0 && !verifierFailed,
    completed,
    reviewRejections,
    repairCount: Math.max(repairChildren.length, task.repairCycles),
    checksFailed: verifications.filter((v) => v.kind === 'checks' && !v.passed).length,
    humanInterventions: input.interventions,
    elapsedMs,
    inputTokens: metrics ? metrics.inputTokens : null,
    outputTokens: metrics ? metrics.outputTokens : null,
    createdAt: input.now,
  }
}
