import type { Run } from '@shared/domain'
import { nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { buildTaskOutcome } from '@main/modules/routing'
import { ARBITRATION_ARTIFACT } from './arbitration'
import type { OrchestratorDeps } from './deps'
import { purposeFor } from './task-kind'

/**
 * Write the empirical outcome of a task that reached a final state. Only top-level implementing tasks
 * (kind implement or repair) are measured; a retried task updates the same row. Never throws: a
 * measurement problem must not fail the work it measures.
 */
export function recordTaskOutcome(deps: OrchestratorDeps, run: Run, taskId: string, log?: (line: string) => void): void {
  const { repos } = deps
  try {
    const task = repos.tasks.get(taskId)
    if (!task || task.parentTaskId !== null || (task.kind !== 'implement' && task.kind !== 'repair')) return
    if (task.state !== 'completed' && task.state !== 'failed') return
    const children = repos.tasks.listByParent(task.id)
    const family = new Set([task.id, ...children.map((c) => c.id)])
    const implementAgent = repos.agents.listByTask(task.id).filter((a) => a.purpose === purposeFor(task)).at(-1) ?? null
    // A dual review writes one row per reviewer plus the arbiter's, which supersedes theirs: count the decision once.
    const arbiterIds = new Set(
      repos.artifacts
        .listByTask(task.id)
        .filter((a) => a.kind === ARBITRATION_ARTIFACT)
        .map((a) => a.title),
    )
    const reviews = repos.reviews.listByTask(task.id)
    const arbitratedAttempts = new Set(reviews.filter((r) => arbiterIds.has(r.id)).map((r) => r.attempt))
    const decisive = reviews.filter((r) => arbiterIds.has(r.id) || !arbitratedAttempts.has(r.attempt))
    const interventions = repos.events.countByTypeForTasks(run.id, 'user.intervention', [...family])
    repos.taskOutcomes.upsertForTask(
      buildTaskOutcome({
        projectId: run.projectId,
        run,
        task,
        implementAgent,
        tier: implementAgent ? (repos.routingDecisions.latestForAgent(implementAgent.id)?.resolvedTier ?? null) : null,
        reviews: decisive,
        verifications: repos.verifications.listByTask(task.id),
        repairChildren: children,
        interventions,
        now: nowIso(),
      }),
    )
  } catch (e) {
    log?.(`recording the outcome of task ${taskId} failed: ${errorMessage(e)}`)
  }
}
