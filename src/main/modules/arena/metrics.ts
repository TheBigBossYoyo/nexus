import type { Review, Run, Verification } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { ArenaTrial, ArenaTrialMetrics } from '@shared/v3'
import type { Repositories } from '../persistence'

export interface CollectOptions {
  /** Clock for open quota waits. */
  now?: string
  /** Set by the evaluator once it ran; null when it did not (yet). */
  hiddenPassed?: boolean | null
}

const newest = <T extends { createdAt: string }>(rows: readonly T[]): T | null =>
  rows.reduce<T | null>((best, r) => (best === null || r.createdAt >= best.createdAt ? r : best), null)

/** Result of one named check command in a checks verification; null when that command was not part of the run. */
function checkResult(v: Verification | null, name: string): boolean | null {
  const cmd = v?.commands.find((c) => c.name === name)
  if (!cmd) return null
  return cmd.exitCode === 0 && !cmd.timedOut
}

/**
 * Findings that still stand at the end: for every task only its LAST review counts, and only when that review
 * asked for changes (a later approval resolves everything before it, so an approved last review leaves nothing
 * open). Findings the arbiter of a dual review rejected do not count.
 */
function standingFindings(reviews: readonly Review[]): { critical: number; high: number; medium: number } {
  const lastByTask = new Map<string, Review>()
  for (const r of [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) lastByTask.set(r.taskId, r)
  const out = { critical: 0, high: 0, medium: 0 }
  for (const review of lastByTask.values()) {
    if (review.verdict !== 'changes_requested') continue
    const rejected = new Set(
      (review.arbitration?.decisions ?? []).filter((d) => !d.accepted).map((d) => d.findingIndex),
    )
    review.findings.forEach((f, index) => {
      if (rejected.has(index)) return
      if (f.severity === 'critical') out.critical++
      else if (f.severity === 'high') out.high++
      else if (f.severity === 'medium') out.medium++
    })
  }
  return out
}

const sumKnown = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}

/**
 * Raw metrics of one trial, read from durable rows only. Null means "not measured" and is never replaced by a
 * guess; counts that are zero because nothing happened are zero.
 */
export function collectTrialMetrics(
  repos: Repositories,
  trial: ArenaTrial,
  run: Run,
  options: CollectOptions = {},
): ArenaTrialMetrics {
  const now = options.now ?? nowIso()
  const runId = run.id

  // correctness: the final mission-level checks and verifier
  const missionVerifications = repos.verifications.listByRun(runId).filter((v) => v.taskId === null)
  const finalChecks = newest(missionVerifications.filter((v) => v.kind === 'checks'))
  const finalVerifier = newest(missionVerifications.filter((v) => v.kind === 'verifier'))
  const criteria = repos.criteria.listByRun(runId).filter((c) => c.taskId === null)

  // quality
  const tasks = repos.tasks.listByRun(runId)
  const findings = standingFindings(repos.reviews.listByRun(runId))
  // A repair is a repair child task or a mission-level fix task; each counts once.
  const repairs = tasks.filter((t) => t.parentTaskId !== null || t.kind === 'repair' || t.key.startsWith('mission-fix-')).length

  // efficiency
  const agents = repos.agents.listByRun(runId)
  const sessions = agents.reduce((n, a) => n + repos.sessions.listByAgent(a.id).length, 0)
  const wallClockMs =
    run.startedAt && run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null

  // autonomy and stability
  const interventions = repos.events.listByTypes(runId, ['user.intervention'], 2000)
  const failedEvents = repos.events.listByTypes(runId, ['agent.failed'], 2000)
  const crashed = new Set(agents.filter((a) => a.state === 'failed').map((a) => a.id))
  for (const e of failedEvents) if (e.agentId) crashed.add(e.agentId)
  const approvals = repos.approvals.listByRun(runId).filter((a) => a.status !== 'pending').length
  const blockers = repos.messages.listByRun(runId).filter((m) => m.type === 'blocker').length

  // limit behaviour (run-scoped pauses only; a global gate pause has no run)
  const pauses = repos.quotaPauses.listByRun(runId)
  const quotaWaitMs = pauses.reduce((sum, p) => {
    const end = p.endedAt ?? run.finishedAt ?? now
    return sum + Math.max(0, Date.parse(end) - Date.parse(p.pausedAt))
  }, 0)
  const autoResumes = repos.quotaResumes.listByRun(runId).filter((r) => r.kind === 'resume' && r.result === 'resumed').length
  const throttles = repos.usageEvents.listByRun(runId, { limit: 500 }).filter((e) => e.eventType === 'throttle').length

  const reported = agents.length > 0
  return {
    id: newId(),
    trialId: trial.id,
    buildPassed: checkResult(finalChecks, 'build'),
    typecheckPassed: checkResult(finalChecks, 'typecheck'),
    testsPassed: checkResult(finalChecks, 'test'),
    hiddenPassed: options.hiddenPassed ?? null,
    acceptanceTotal: criteria.length === 0 ? null : criteria.length,
    acceptancePassed: criteria.length === 0 ? null : criteria.filter((c) => c.status === 'passed').length,
    verifierPassed: finalVerifier ? finalVerifier.passed : null,
    criticalFindings: findings.critical,
    highFindings: findings.high,
    mediumFindings: findings.medium,
    repairs,
    wallClockMs,
    sessions,
    turns: reported ? agents.reduce((n, a) => n + a.metrics.turns, 0) : null,
    inputTokens: sumKnown(agents.map((a) => a.metrics.inputTokens)),
    outputTokens: sumKnown(agents.map((a) => a.metrics.outputTokens)),
    toolCalls: reported ? agents.reduce((n, a) => n + a.metrics.toolCalls, 0) : null,
    humanInterventions: interventions.length,
    approvals,
    manualRetries: interventions.filter((e) => (e.payload as { action?: string }).action === 'retry_task').length,
    blockers,
    crashedAgents: crashed.size,
    recoveredSessions: repos.events.countByTypes(runId, ['run.recovered']),
    schedulerFailures: repos.events.countByTypes(runId, ['task.lease_expired']),
    unfinishedTasks: tasks.filter((t) => t.state !== 'completed' && t.state !== 'cancelled').length,
    quotaPauses: pauses.length,
    quotaWaitMs,
    autoResumeSuccesses: autoResumes,
    throttleEvents: throttles,
    createdAt: nowIso(),
  }
}
