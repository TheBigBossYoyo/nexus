// 0.3 acceptance: a small real Arena campaign with REAL Claude Agent SDK sessions. Consumes usage.
//
//   node scripts/arena-acceptance.mjs [path-to-NEXUS.exe|-] [caseId,caseId,...] [STRATEGY,STRATEGY]
//
// Default: three built-in cases, two strategies (SINGLE and BUILD), one repetition: six trials. Every
// trial runs in its own fresh repository; the hidden evaluator runs after the run has ended. The script
// only starts the campaign and records what NEXUS measured. It changes no threshold and forces no result.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchNexus, log, reportGates, requireAuth, writeEvidence } from './acceptance-common.mjs'

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined
const CASES = (process.argv[3] ?? 'bugfix-localized,feature-small,ui-state-bug').split(',')
const STRATEGIES = (process.argv[4] ?? 'SINGLE,BUILD').split(',')
const TIMEOUT_MS = Number(process.env.NEXUS_ARENA_ACCEPT_TIMEOUT_MIN ?? 240) * 60_000

const evidence = { kind: 'arena-campaign', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', cases: CASES, strategies: STRATEGIES }
const { app, call } = await launchNexus('nexus-arena', exe)
let ok = false
try {
  await requireAuth(call, evidence)
  evidence.usageBefore = await call('usage.refresh')
  const known = await call('arena.cases')
  const missing = CASES.filter((id) => !known.some((c) => c.case.id === id))
  if (missing.length) throw new Error(`Unknown Arena cases: ${missing.join(', ')}`)

  const campaign = await call('arena.createCampaign', {
    name: `Acceptance ${new Date().toISOString().slice(0, 16)}`,
    caseIds: CASES,
    strategies: STRATEGIES,
    repetitions: 1,
    modelPreset: 'balanced',
    budgetPreset: 'eco',
    start: true,
  })
  log('campaign started', campaign.id)

  const started = Date.now()
  let lastLine = ''
  let detail
  const quotaObserved = []
  for (;;) {
    detail = await call('arena.campaign', { campaignId: campaign.id })
    const cells = detail.matrix.map((c) => `${c.caseId}/${c.strategy}:${c.trials.map((t) => t.state).join(',')}`).join(' ')
    const line = `${detail.campaign.state}${detail.campaign.pauseReason ? `(${detail.campaign.pauseReason})` : ''} | ${cells}`
    if (line !== lastLine) {
      log(line)
      lastLine = line
    }
    if (detail.campaign.state === 'paused' && detail.campaign.pauseReason === 'quota' && quotaObserved.at(-1)?.resumedAt !== null) {
      const usage = await call('usage.overview')
      quotaObserved.push({ at: new Date().toISOString(), status: usage.status, nextResetAt: usage.nextResetAt, nextCheckAt: usage.autoResume.nextCheckAt, resumedAt: null })
      log('real usage limit met: campaign paused, waiting for the automatic resume', JSON.stringify(usage.nextResetAt))
    }
    if (detail.campaign.state === 'running' && quotaObserved.at(-1)?.resumedAt === null) {
      quotaObserved.at(-1).resumedAt = new Date().toISOString()
      log('campaign resumed after the usage limit')
    }
    if (['completed', 'cancelled', 'failed'].includes(detail.campaign.state)) break
    if (Date.now() - started > TIMEOUT_MS) {
      log('timeout: cancelling the campaign')
      await call('arena.cancel', { campaignId: campaign.id })
    }
    await new Promise((r) => setTimeout(r, 6000))
  }

  const { trials } = await call('arena.trials', { campaignId: campaign.id, limit: 200 })
  const trialDetails = []
  for (const row of trials) {
    const t = await call('arena.trial', { trialId: row.trial.id })
    const run = row.trial.runId ? await call('runs.get', { runId: row.trial.runId }).catch(() => null) : null
    trialDetails.push({
      case: row.trial.caseId,
      strategy: row.trial.strategy,
      repetition: row.trial.repetition,
      state: row.trial.state,
      detail: row.trial.detail,
      runId: row.trial.runId,
      runState: run?.run.state ?? null,
      requestedStrategy: run?.run.config.strategy?.requested ?? null,
      resolvedStrategy: run?.run.config.strategy?.resolved ?? null,
      repoPath: row.trial.repoPath,
      repoExists: row.trial.repoPath ? existsSync(row.trial.repoPath) : false,
      evaluatorInRepo: row.trial.repoPath ? existsSync(join(row.trial.repoPath, 'hidden-tests')) : null,
      baselineCommit: row.trial.baselineCommit,
      resultCommit: row.trial.resultCommit,
      policySnapshotId: row.trial.policySnapshotId,
      models: row.trial.models,
      tasks: run?.tasks.map((x) => ({ key: x.key, role: x.role, state: x.state, attempt: x.attempt, repairCycles: x.repairCycles })) ?? [],
      metrics: t.metrics,
      evaluation: t.evaluation
        ? { passed: t.evaluation.passed, exitCode: t.evaluation.exitCode, timedOut: t.evaluation.timedOut, durationMs: t.evaluation.durationMs, skippedReason: t.evaluation.skippedReason, score: t.evaluation.score, scoreVersion: t.evaluation.scoreVersion, scoreBreakdown: t.evaluation.scoreBreakdown, outputTail: t.evaluation.output.slice(-1500) }
        : null,
      contextKey: t.profile?.contextKey ?? null,
    })
  }
  const results = await call('arena.results', { campaignId: campaign.id })
  const usage = await call('usage.totals', { campaignId: campaign.id })
  const usageByStrategy = await call('usage.breakdown', { by: 'strategy', campaignId: campaign.id })
  const limitHistory = await call('usage.limitHistory', { limit: 50 })
  const policyBefore = await call('policy.overview')
  const learned = await call('policy.learn')
  const policyAfter = await call('policy.overview')

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    campaign: detail.campaign,
    counts: detail.counts,
    trials: trialDetails,
    comparison: detail.comparison,
    results: { comparison: results.comparison, byCase: results.byCase, notes: results.notes, regressions: results.regressions },
    usage: { totals: usage, byStrategy: usageByStrategy, after: await call('usage.refresh') },
    quota: { observed: quotaObserved, limitEvents: limitHistory.events.length, pauses: limitHistory.pauses },
    policy: {
      activeVersionBefore: policyBefore.active.version,
      activeVersionAfter: policyAfter.active.version,
      statistics: learned.statistics,
      candidates: learned.candidates.map((c) => ({ contextKey: c.contextKey, from: c.fromStrategy, to: c.toStrategy, label: c.label, arenaTrials: c.arenaTrials })),
      notes: learned.notes,
      evidenceCounted: policyAfter.evidence,
    },
  })

  const finished = trialDetails.filter((t) => ['passed', 'failed'].includes(t.state))
  const byCase = new Map()
  for (const t of trialDetails) byCase.set(t.case, [...(byCase.get(t.case) ?? []), t])
  const gates = {
    'the campaign completed': detail.campaign.state === 'completed',
    [`every (case, strategy) pair has a trial (${CASES.length * STRATEGIES.length})`]: trialDetails.length === CASES.length * STRATEGIES.length,
    'at least three cases produced an evaluated trial for two strategies each': [...byCase.values()].filter((list) => list.filter((t) => ['passed', 'failed'].includes(t.state)).length >= 2).length >= Math.min(3, CASES.length),
    'every trial of a case started from the same baseline commit': [...byCase.values()].every((list) => new Set(list.map((t) => t.baselineCommit)).size === 1),
    'every trial ran in its own repository': new Set(trialDetails.map((t) => t.repoPath)).size === trialDetails.length,
    'no trial repository contains the hidden evaluator': trialDetails.every((t) => t.evaluatorInRepo !== true),
    'each run recorded the strategy the trial asked for': trialDetails.filter((t) => t.runId).every((t) => t.resolvedStrategy === t.strategy),
    'each evaluated trial recorded the models that were used': finished.every((t) => Object.keys(t.models ?? {}).length > 0),
    'raw metrics exist for every evaluated trial': finished.every((t) => t.metrics && typeof t.metrics.sessions === 'number' && t.metrics.sessions > 0 && t.metrics.wallClockMs > 0),
    'a hidden evaluation ran for every evaluated trial': finished.every((t) => t.evaluation && t.evaluation.skippedReason === null && typeof t.evaluation.exitCode === 'number'),
    'trial state equals the hidden evaluation result': finished.every((t) => (t.state === 'passed') === t.evaluation.passed),
    'a failed hidden evaluation scores 0': finished.filter((t) => !t.evaluation.passed).every((t) => t.evaluation.score === 0),
    'usage was observed for the campaign': usage.sessions > 0 && usage.inputTokens > 0,
    'the policy engine consumed the trials as Arena evidence': learned.statistics > 0 && policyAfter.evidence.arenaTrials >= finished.length,
    'the active policy was not changed by learning': policyAfter.active.version === policyBefore.active.version,
  }
  evidence.gates = gates
  ok = reportGates(gates)
  log('strategy comparison', JSON.stringify(detail.comparison.map((r) => ({ strategy: r.strategy, n: r.n, passed: r.passed, label: r.label, medianWallClockMs: r.medianWallClockMs, meanSessions: r.meanSessions, meanObservedTokens: r.meanObservedTokens }))))
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  evidence.result = ok ? 'PASS' : 'FAIL'
  log('evidence', writeEvidence('arena-campaign', evidence))
  await app.close().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
