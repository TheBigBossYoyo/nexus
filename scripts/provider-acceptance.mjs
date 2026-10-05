// 0.6 acceptance: one real mission with REAL Claude Agent SDK sessions and, when the Codex command line tool is
// installed and signed in on this computer, a REAL cross-model review by Codex. Consumes usage of both.
//
//   node scripts/provider-acceptance.mjs [path-to-NEXUS.exe]
//
// Claude plans, implements and verifies a small bug fix. With Codex available, the script enables it and
// cross-model review through the provider policy, and the reviews of the mission are done by Codex, read-only.
// Without Codex the mission runs on Claude alone and the external part is recorded as NOT VERIFIED.
import { createFixtureRepo, driveRun, independentTestRun, launchNexus, log, reportGates, requireAuth, writeEvidence } from './acceptance-common.mjs'

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined

const { repo, git, baseCommit } = createFixtureRepo('nexus-provider', {
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

const MISSION = [
  'Fix a bug: `overlaps` in src/overlaps.js returns true for intervals that only touch at one end when either interval is marked half-open.',
  'Support an optional `open: true` property on an interval, meaning its end point is excluded: `overlaps({ start: 1, end: 3, open: true }, { start: 3, end: 5 })` must be false, while the same call without `open` stays true.',
  'Keep the existing behaviour for intervals without `open`, add regression tests next to the existing ones, and keep `npm test` passing.',
].join('\n')

const evidence = { kind: 'provider-mission', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', mission: MISSION, baseCommit }
const { app, call } = await launchNexus('nexus-provider', exe)
let ok = false
try {
  await requireAuth(call, evidence)
  const before = await call('providers.refresh')
  evidence.providers = before.statuses.map((s) => ({ id: s.id, installed: s.installed, version: s.version, auth: s.auth, authDetail: s.authDetail, supported: s.supported, health: s.health, writes: s.capabilities.writes, confinement: s.capabilities.confinement }))
  evidence.policyBefore = before.policy
  log('providers', JSON.stringify(evidence.providers))
  const codex = before.statuses.find((s) => s.id === 'codex')
  const codexUsable = codex?.installed === 'installed' && codex.supported && codex.auth === 'authenticated'
  evidence.codexUsable = codexUsable
  if (codexUsable) {
    await call('providers.setPolicy', { policy: { ...before.policy, enabled: { ...before.policy.enabled, codex: true }, crossModelReview: { enabled: true, reviewer: 'codex' } } })
    const probe = await call('providers.probe', { provider: 'codex' })
    evidence.codexProbe = { ok: probe.ok, detail: probe.detail }
    log('codex test session', JSON.stringify(evidence.codexProbe))
  }

  const project = await call('projects.open', { path: repo })
  const run = await call('runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: MISSION, requirePlanApproval: true, strategy: 'BUILD' })
  log('run created', run.id)
  const { detail, approvals } = await driveRun(call, run.id, {
    timeoutMs: 60 * 60_000,
    onPlan: (plan) => {
      evidence.plan = plan
    },
  })
  const sessions = await call('providers.sessions', { runId: run.id })
  const reviews = await call('reviews.list', { runId: run.id })
  const after = await call('providers.overview')
  const usage = await call('usage.overview').catch(() => null)
  const tests = independentTestRun(detail)
  const byProvider = (provider) => sessions.filter((s) => s.provider === provider)
  const reviewerSessions = sessions.filter((s) => s.role === 'reviewer' || s.role === 'security_reviewer')

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    run: { id: run.id, state: detail.run.state, error: detail.run.error, integrationBranch: detail.run.integrationBranch },
    tasks: detail.tasks.map((t) => ({ key: t.key, state: t.state, kind: t.kind })),
    agents: detail.agents.map((a) => ({ id: a.id, role: a.role, label: a.label, model: a.model, state: a.state })),
    providerSessions: sessions.map((s) => ({ agentId: s.agentId, role: s.role, requested: s.requested, provider: s.provider, model: s.model, runtimeVersion: s.runtimeVersion, authMode: s.authMode, reason: s.reason, fallbackReason: s.fallbackReason, outcome: s.outcome, error: s.error, inputTokens: s.inputTokens, outputTokens: s.outputTokens })),
    reviews: reviews.map((r) => ({ taskId: r.taskId, attempt: r.attempt, verdict: r.verdict, summary: (r.summary ?? '').slice(0, 600), findings: r.findings.length, agentId: r.agentId })),
    providersAfter: after.statuses.map((s) => ({ id: s.id, health: s.health, healthDetail: s.healthDetail })),
    performance: after.performance,
    usageByProvider: after.usage,
    claudeUsage: usage ? { status: usage.status, session: usage.session } : null,
    approvals,
    independentTestRun: tests,
    userCheckout: { head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), status: git('status', '--porcelain') },
  })

  const gates = {
    'Claude is detected, authenticated and the required provider': before.statuses.some((s) => s.id === 'claude' && s.required && s.auth === 'authenticated'),
    'nothing but Claude was enabled before the script changed the policy': before.policy.enabled.codex === false && before.policy.enabled.gemini === false && before.policy.crossModelReview.enabled === false,
    'the mission completed': detail.run.state === 'completed',
    'Claude planned, implemented and verified: those sessions ran on Claude and completed': ['planner', 'worker', 'verifier'].every((role) => sessions.some((s) => s.role === role && s.provider === 'claude' && s.outcome === 'completed')) && sessions.filter((s) => ['planner', 'worker', 'verifier', 'debugger'].includes(s.role)).every((s) => s.provider === 'claude'),
    'every session of the run is recorded with its provider and the reason': sessions.length >= detail.agents.length && sessions.every((s) => s.provider && s.reason),
    "the repository's tests pass on the integration branch (independent run), with regression tests added": tests.fail === 0 && tests.pass >= 3,
    "the user's checkout is untouched": evidence.userCheckout.head === baseCommit && evidence.userCheckout.branch === 'main' && evidence.userCheckout.status === '',
    'a review was recorded for the work': reviews.length >= 1 && reviews.some((r) => r.verdict === 'approved'),
  }
  if (codexUsable) {
    Object.assign(gates, {
      'the Codex test session worked': evidence.codexProbe?.ok === true,
      'cross-model review: every review session was asked of Codex': reviewerSessions.length >= 1 && reviewerSessions.every((s) => s.requested === 'codex'),
      'at least one review was done by a real Codex session that completed, read-only, with its own model': byProvider('codex').some((s) => s.outcome === 'completed' && s.fallbackReason === null && s.model && !s.model.startsWith('claude') && s.inputTokens > 0),
      'no Codex session wrote: none was discarded for changing the working directory': byProvider('codex').every((s) => !(s.error ?? '').includes('changed the working directory')),
      "Codex's sessions did not count as Claude usage limits": (usage?.session?.limitEvents ?? 0) === 0,
      'any review Claude did in place of Codex says why': reviewerSessions.filter((s) => s.provider === 'claude').every((s) => typeof s.fallbackReason === 'string' && s.fallbackReason.length > 0),
    })
  } else {
    evidence.externalProvider = 'NOT VERIFIED: the Codex command line tool is not installed, not signed in or not supported on this computer.'
    Object.assign(gates, { 'without another provider every session ran on Claude': sessions.every((s) => s.provider === 'claude') })
  }
  ok = reportGates(gates)
  evidence.gatesPassed = ok
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  const file = writeEvidence('provider-mission', evidence)
  log('evidence:', file)
  await app.close().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
