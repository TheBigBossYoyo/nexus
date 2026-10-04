// 0.3 acceptance: one real SPECULATIVE task or one real ADAPTIVE mission with REAL Claude Agent SDK
// sessions. Consumes usage.
//
//   node scripts/strategy-acceptance.mjs speculative [path-to-NEXUS.exe]
//   node scripts/strategy-acceptance.mjs adaptive    [path-to-NEXUS.exe]
//
// speculative: two candidates implement the same bounded task in separate worktrees from the same commit;
// the objective tournament picks one; the winner is reviewed and verified; the losers' evidence is kept and
// their worktrees removed; the user's repository is untouched.
// adaptive: the policy engine profiles the task, decides the strategy and records why; the mission runs and
// its outcome is recorded with the observed usage.
import { existsSync } from 'node:fs'
import {
  collectSessions,
  createFixtureRepo,
  driveRun,
  independentTestRun,
  launchNexus,
  log,
  reportGates,
  requireAuth,
  writeEvidence,
} from './acceptance-common.mjs'

const kind = process.argv[2]
if (kind !== 'speculative' && kind !== 'adaptive') {
  console.error('usage: node scripts/strategy-acceptance.mjs speculative|adaptive [path-to-NEXUS.exe]')
  process.exit(2)
}
const exe = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : undefined

const { repo, git, baseCommit } = createFixtureRepo(`nexus-${kind}`, {
  'package.json': JSON.stringify({ name: 'intervals', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/index.js': "export { overlaps } from './overlaps.js'\n",
  'src/overlaps.js': [
    '/** True when the closed intervals [a.start, a.end] and [b.start, b.end] share at least one point. */',
    'export function overlaps(a, b) {',
    '  return a.start <= b.end && b.start <= a.end',
    '}',
    '',
  ].join('\n'),
  'test/overlaps.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { overlaps } from '../src/index.js'",
    '',
    "test('touching intervals overlap', () => assert.equal(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 }), true))",
    "test('separate intervals do not overlap', () => assert.equal(overlaps({ start: 1, end: 2 }, { start: 3, end: 5 }), false))",
    '',
  ].join('\n'),
  'README.md': '# intervals\n\nSmall interval utilities in plain ESM JavaScript. Tests: `npm test` (node:test, no dependencies).\n',
})

const MISSION =
  kind === 'speculative'
    ? [
        'Add `mergeIntervals(intervals)` to this library in src/merge.js, exported from src/index.js, with node:test tests in test/merge.test.js.',
        'It takes an array of closed intervals `{ start, end }` (numbers, start <= end) in any order and returns a new array, sorted by start, in which overlapping or touching intervals are merged into one. The input array and its objects must not be modified.',
        'It throws TypeError when the argument is not an array or an element is not an object with numeric `start` and `end`, and RangeError when an interval has start > end.',
        'An empty array returns an empty array. `npm test` must pass.',
      ].join('\n')
    : [
        'Fix a bug: `overlaps` in src/overlaps.js returns true for intervals that only touch at one end when either interval is marked half-open.',
        'Support an optional `open: true` property on an interval, meaning its end point is excluded: `overlaps({ start: 1, end: 3, open: true }, { start: 3, end: 5 })` must be false, while the same call without `open` stays true.',
        'Keep the existing behaviour for intervals without `open`, add regression tests next to the existing ones, and keep `npm test` passing.',
      ].join('\n')

const evidence = { kind: `${kind}-mission`, startedAt: new Date().toISOString(), executable: exe ?? 'dev build', mission: MISSION }
const { app, call } = await launchNexus(`nexus-${kind}`, exe)
let ok = false
try {
  await requireAuth(call, evidence)
  const project = await call('projects.open', { path: repo })
  const policyBefore = await call('policy.overview')
  const preview = kind === 'adaptive' ? await call('policy.preview', { projectId: project.id, prompt: MISSION }) : null
  const run = await call('runs.create', {
    projectId: project.id,
    mode: 'build',
    preset: 'balanced',
    prompt: MISSION,
    requirePlanApproval: true,
    strategy: kind === 'speculative' ? 'SPECULATIVE' : 'ADAPTIVE',
    ...(kind === 'speculative' ? { speculativeCandidates: 2 } : {}),
  })
  log('run created', run.id, JSON.stringify(run.config.strategy))

  // Candidate worktrees are removed after the tournament: note them while they exist.
  const seenCandidatePaths = new Map()
  const { detail, approvals } = await driveRun(call, run.id, {
    timeoutMs: 60 * 60_000,
    onPlan: (plan) => {
      evidence.plan = plan
    },
    onTick: async () => {
      if (kind !== 'speculative') return
      const spec = await call('speculative.list', { runId: run.id })
      for (const c of spec.candidates) {
        if (!seenCandidatePaths.has(c.label) && existsSync(c.worktreePath)) {
          seenCandidatePaths.set(c.label, c.worktreePath)
          log('candidate worktree exists', c.label, c.worktreePath)
        }
      }
    },
  })

  const sessions = await collectSessions(call, detail)
  const events = await call('events.list', { runId: run.id, limit: 5000 })
  const verifications = await call('verifications.list', { runId: run.id })
  const reviews = await call('reviews.list', { runId: run.id })
  const routing = await call('routing.list', { runId: run.id })
  const policyRun = await call('policy.run', { runId: run.id })
  const usageRun = await call('usage.run', { runId: run.id })
  const spec = await call('speculative.list', { runId: run.id })
  const policyAfter = await call('policy.overview')
  const tests = independentTestRun(detail)
  const taskKey = (id) => detail.tasks.find((t) => t.id === id)?.key ?? null
  const branches = git('branch', '--list', 'nexus/*', '--format=%(refname:short)').split('\n').filter(Boolean)
  const integrationLog = detail.run.integrationBranch ? git('log', '--format=%h %s', `${baseCommit}..${detail.run.integrationBranch}`).split('\n') : []

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    runId: run.id,
    runState: detail.run.state,
    runError: detail.run.error,
    strategy: detail.run.config.strategy,
    tasks: detail.tasks.map((t) => ({ key: t.key, role: t.role, kind: t.kind, state: t.state, attempt: t.attempt, repairCycles: t.repairCycles })),
    sessions: sessions.map(({ handoff, ...s }) => s),
    resolvedModels: routing.map((r) => ({ role: r.role, purpose: r.purpose, task: taskKey(r.taskId), requestedPolicy: r.requestedPolicy, tier: r.resolvedTier, model: r.resolvedModel, reasons: r.reasons })),
    reviews: reviews.map((r) => ({ task: taskKey(r.taskId), verdict: r.verdict, findings: r.findings.length, summary: r.summary.slice(0, 300) })),
    verifications: verifications.map((v) => ({ task: taskKey(v.taskId) ?? '(mission)', kind: v.kind, passed: v.passed, summary: v.summary.slice(0, 300) })),
    strategyEvents: events.filter((e) => /^(strategy|policy|speculative|outcome)\./.test(e.type)).map((e) => ({ type: e.type, at: e.createdAt, payload: e.payload })),
    quotaEvents: events.filter((e) => e.type.startsWith('usage.')).map((e) => ({ type: e.type, at: e.createdAt, payload: e.payload })),
    approvals,
    independentTestRun: tests,
    observedUsage: { totals: usageRun.totals, byModel: usageRun.byModel, byRole: usageRun.byRole, pauses: usageRun.pauses.length },
    policy: {
      versionBefore: policyBefore.active.version,
      versionAfter: policyAfter.active.version,
      preview: preview ? { contextKey: preview.profile.contextKey, strategy: preview.decision.strategy, layer: preview.decision.layer, reason: preview.decision.reason } : null,
      taskProfile: policyRun.profile ? { id: policyRun.profile.id, contextKey: policyRun.profile.contextKey, features: policyRun.profile.features, profilerVersion: policyRun.profile.profilerVersion } : null,
      decision: policyRun.decision,
      snapshotId: detail.run.config.strategy?.policySnapshotId ?? null,
      outcome: policyRun.outcome,
    },
    speculative: {
      runs: spec.runs,
      candidates: spec.candidates.map((c) => ({ label: c.label, agentId: c.agentId, sdkSessionId: c.sdkSessionId, branch: c.branch, worktreePath: c.worktreePath, headCommit: c.headCommit, evidence: c.evidence, rank: c.rank, outcome: c.outcome, cleanedAt: c.cleanedAt, storedDiffChars: c.diffPatch?.length ?? 0, worktreeStillExists: existsSync(c.worktreePath), worktreeWasSeen: seenCandidatePaths.has(c.label) })),
      decisions: spec.decisions,
    },
    git: { userHeadUnchanged: git('rev-parse', 'HEAD') === baseCommit, userStatus: git('status', '--porcelain'), branches, integrationLog },
  })

  const taskVerified = verifications.some((v) => v.taskId !== null && v.kind === 'verifier' && v.passed)
  const common = {
    'the run completed': detail.run.state === 'completed',
    'commits exist on the integration branch': integrationLog.filter(Boolean).length > 0,
    'independent test run passes': tests.fail === 0 && tests.pass > 1,
    'observed usage was recorded for the run': usageRun.totals.sessions > 0 && usageRun.totals.inputTokens > 0,
    'the policy snapshot used is recorded on the run': typeof evidence.policy.snapshotId === 'string',
    'a mission outcome was recorded': policyRun.outcome !== null && policyRun.outcome.terminal === 'completed' && policyRun.outcome.sessions > 0,
    'the active policy did not change': policyAfter.active.version === policyBefore.active.version,
    'the user checkout is untouched': evidence.git.userHeadUnchanged && evidence.git.userStatus === '',
  }
  let gates
  if (kind === 'speculative') {
    const candidates = evidence.speculative.candidates
    const decision = spec.decisions[0]
    const winner = candidates.find((c) => c.outcome === 'winner')
    const losers = candidates.filter((c) => c.outcome !== 'winner')
    gates = {
      ...common,
      'two candidates ran': spec.runs.length === 1 && candidates.length === 2,
      'the candidates used different real SDK sessions': new Set(candidates.map((c) => c.sdkSessionId)).size === 2 && candidates.every((c) => typeof c.sdkSessionId === 'string' && c.sdkSessionId.length > 8),
      'the candidates used different worktrees and branches': new Set(candidates.map((c) => c.worktreePath)).size === 2 && new Set(candidates.map((c) => c.branch)).size === 2,
      'both candidate worktrees existed during the run': candidates.every((c) => c.worktreeWasSeen),
      'the candidates started from the same baseline commit': typeof spec.runs[0]?.baseCommit === 'string' && spec.runs[0].baseCommit.length === 40,
      'the tournament chose a winner from objective evidence': Boolean(winner) && decision?.winnerLabel === winner?.label && decision.comparisons.length >= 1,
      'the winner was reviewed and verified': reviews.length >= 1 && taskVerified,
      'loser evidence was stored': losers.length === 1 && losers.every((c) => c.evidence.implemented !== undefined && c.rank !== null),
      'candidate worktrees and branches were removed afterwards': candidates.every((c) => c.cleanedAt !== null && !c.worktreeStillExists) && !branches.some((b) => b.includes('-cand-')),
    }
  } else {
    const d = policyRun.decision
    gates = {
      ...common,
      'a task profile was recorded with measured and inferred features': policyRun.profile !== null && Object.values(policyRun.profile.features).some((f) => f.basis === 'MEASURED') && Object.values(policyRun.profile.features).some((f) => f.basis === 'INFERRED'),
      'a policy decision was recorded with its reason and layer': d !== null && d.reason.length > 20 && ['default', 'evidence', 'exploration'].includes(d.layer),
      'the run executed the strategy the policy chose': d !== null && detail.run.config.strategy?.resolved === d.strategy && detail.run.config.strategy?.requested === 'ADAPTIVE',
      'the decision names the snapshot the run recorded': d !== null && d.snapshotId === evidence.policy.snapshotId,
      'resolved models were recorded for the sessions': routing.length > 0 && routing.every((r) => typeof r.resolvedTier === 'string'),
      'the outcome records the executed strategy and observed tokens': policyRun.outcome?.strategy === d?.strategy && (policyRun.outcome?.inputTokens ?? 0) > 0,
      'task and mission gates ran': taskVerified || verifications.some((v) => v.taskId === null && v.passed),
    }
  }
  evidence.gates = gates
  ok = reportGates(gates)
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  evidence.result = ok ? 'PASS' : 'FAIL'
  log('evidence', writeEvidence(`${kind}-mission`, evidence))
  await app.close().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
