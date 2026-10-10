import { randomUUID } from 'node:crypto'
import type { AdviceLearning, AdviceOutcome, IntelligenceContext } from '@shared/intelligence'
import type { EventBus } from '@main/modules/events'
import type { Repositories } from '@main/modules/persistence'

/**
 * Outcome learning. Advice is judged by what became of the work it was given to, and that is on record nowhere
 * in the advice itself: a specification, a memo and a decision are immutable. When a mission ends, what it was
 * admitted with and how it ended are written down once (whether its verification passed, how many repairs it
 * took, how many tasks failed). The record is shown with the Director's history, and a summary of it is part of
 * the evidence of the next Director request of the project, so that advice is given knowing how earlier advice
 * turned out. Nothing here changes a policy or a depth by itself.
 */
export function recordAdviceOutcome(repos: Repositories, runId: string, now: () => string = () => new Date().toISOString()): AdviceOutcome[] {
  const run = repos.runs.get(runId)
  // Read-only runs carry no work to judge, and only a run that has ended has an outcome.
  if (!run || run.mode === 'ask' || run.mode === 'audit') return []
  if (run.state !== 'completed' && run.state !== 'failed' && run.state !== 'cancelled') return []
  const tasks = repos.tasks.listByRun(runId).filter((t) => t.parentTaskId === null)
  const result = {
    runState: run.state,
    // A mission completes only when its verification has passed.
    verified: run.state === 'completed',
    tasks: tasks.length,
    tasksFailed: tasks.filter((t) => t.state === 'failed').length,
    // A cycle from a rejected review or verification back to a repair, and every new attempt after the first.
    repairs: tasks.reduce((n, t) => n + t.repairCycles + Math.max(0, t.attempt - 1), 0),
  } as const
  const written: AdviceOutcome[] = []
  const save = (outcome: Omit<AdviceOutcome, 'id' | 'projectId' | 'runId' | 'createdAt' | keyof typeof result>): void => {
    const full: AdviceOutcome = { id: randomUUID(), projectId: run.projectId, runId, createdAt: now(), ...result, ...outcome }
    if (repos.intelligenceArtifacts.saveAdviceOutcome(full)) written.push(full)
  }
  const spec = run.config.compiledTaskSpec
  if (spec) save({ sourceKind: 'SPECIFICATION', sourceId: spec.id, depth: spec.mode, level: null, recommendations: spec.recommendations.length })
  // A Director request the user made about this mission (an escalation that names it and was answered).
  for (const escalation of repos.intelligenceArtifacts.escalationsOfRun(run.projectId, runId)) {
    if (escalation.invocationId && escalation.state === 'COMPLETED') save({ sourceKind: 'DIRECTOR', sourceId: escalation.invocationId, depth: null, level: escalation.level, recommendations: 0 })
  }
  return written
}

/** Records the outcome when a run ends. A failure to record never reaches the orchestrator. Returns an unsubscribe. */
export function attachAdviceOutcomes(bus: EventBus, repos: Repositories, log: (line: string) => void = () => undefined): () => void {
  return bus.subscribe((event) => {
    if (event.type !== 'run.completed' && event.type !== 'run.failed' && event.type !== 'run.cancelled') return
    try {
      recordAdviceOutcome(repos, event.runId)
    } catch (e) {
      log(`advice outcome: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}

const label = (o: Pick<AdviceOutcome, 'sourceKind' | 'depth' | 'level'>): string =>
  o.sourceKind === 'SPECIFICATION' ? `Specification, ${o.depth ?? 'unknown'} depth` : `Director request, level ${o.level ?? '?'}`

/** What is on record for a project: each kind of advice with how the work it was given to ended. */
export function adviceLearning(repos: Repositories, projectId: string): AdviceLearning {
  const outcomes = repos.intelligenceArtifacts.adviceOutcomes(projectId, 500)
  const groups = new Map<string, AdviceLearning['groups'][number]>()
  for (const o of outcomes) {
    const key = label(o)
    const g = groups.get(key) ?? { label: key, sourceKind: o.sourceKind, depth: o.depth, level: o.level, runs: 0, verified: 0, failed: 0, cancelled: 0, repairs: 0, tasksFailed: 0 }
    g.runs += 1
    if (o.runState === 'completed') g.verified += 1
    else if (o.runState === 'failed') g.failed += 1
    else g.cancelled += 1
    g.repairs += o.repairs
    g.tasksFailed += o.tasksFailed
    groups.set(key, g)
  }
  return { groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)), recent: outcomes.slice(0, 20), total: outcomes.length }
}

/**
 * The record as one item of evidence for a Director request: counts only, written by NEXUS from what it
 * observed, no text of any model. Absent when nothing is on record yet.
 */
export function learningEvidence(repos: Repositories, projectId: string): IntelligenceContext | null {
  const learning = adviceLearning(repos, projectId)
  if (learning.total === 0) return null
  const lines = learning.groups.map((g) => `${g.label}: ${g.runs} mission(s), ${g.verified} verified, ${g.failed} failed, ${g.cancelled} cancelled, ${g.repairs} repair attempt(s), ${g.tasksFailed} failed task(s).`)
  return {
    id: `advice-outcomes:${projectId}`,
    version: `${learning.total}:${learning.recent[0]?.id ?? ''}`,
    text: `[record, observed by NEXUS] What became of earlier missions of this project, by the advice they were admitted with. Counts of observed results, not a judgement of the advice:\n${lines.join('\n')}`,
  }
}
