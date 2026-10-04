// 0.2.1 release gate: session rotation with REAL Claude Agent SDK sessions. Consumes usage.
//
//   node scripts/session-rotation-acceptance.mjs [path-to-NEXUS.exe] [turns]
//
// The run is created with a low rotation threshold (`sessionRotationTurns`, default 8 turns here), so a
// worker session is rotated after a handful of turns instead of after a full context: session A works,
// is asked for a structured handoff, and session B continues the same task from that handoff.
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

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined
const ROTATION_TURNS = Number(process.argv[3] ?? 8)

const { repo, git, baseCommit } = createFixtureRepo('nexus-rot', {
  'package.json': JSON.stringify({ name: 'textkit', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/index.js': "export const VERSION = '1.0.0'\n",
  'test/index.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { VERSION } from '../src/index.js'\n\ntest('version', () => assert.equal(VERSION, '1.0.0'))\n",
  'README.md': '# textkit\n\nSmall text utilities in plain ESM JavaScript. Tests: `npm test` (node:test, no dependencies).\n',
})

const MISSION = [
  'Add a text utility module to this library as ONE task (do not split it into several tasks): src/text.js with node:test tests in test/text.test.js.',
  'It exports four functions, to be written and committed one after the other, each with its own tests:',
  '1. `slugify(text)`: lower-case, strip diacritics (NFD), replace every run of non-alphanumeric characters with a single "-", trim "-" from both ends; throws TypeError when the argument is not a string.',
  '2. `wrap(text, width)`: greedy word wrap to lines of at most `width` characters, words longer than the width on their own line; throws TypeError unless width is a positive integer.',
  '3. `truncate(text, max)`: returns the text unchanged when it fits, otherwise cuts at the last word boundary that fits and appends "…", never exceeding `max` characters.',
  '4. `countWords(text)`: the number of words, where a word is a run of letters, digits or apostrophes.',
  'Record one design decision with the decision tool: how word boundaries are defined, since wrap, truncate and countWords must agree on it. `npm test` must pass.',
].join('\n')

const evidence = { kind: 'session-rotation', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', mission: MISSION, sessionRotationTurns: ROTATION_TURNS }
const { app, call } = await launchNexus('nexus-rot', exe)
let ok = false
try {
  await requireAuth(call, evidence)
  const project = await call('projects.open', { path: repo })
  const run = await call('runs.create', {
    projectId: project.id,
    mode: 'build',
    preset: 'balanced',
    prompt: MISSION,
    maxParallelAgents: 2,
    requirePlanApproval: true,
    planningMode: 'single',
    reviewMode: 'standard',
    sessionRotationTurns: ROTATION_TURNS,
  })
  log('run created', run.id, 'rotation after', ROTATION_TURNS, 'turns')

  const { detail, approvals } = await driveRun(call, run.id, {
    timeoutMs: 50 * 60_000,
    onPlan: (plan) => {
      evidence.plan = plan
      log('plan:', JSON.stringify(plan.tasks.map((t) => ({ id: t.id, role: t.role, deps: t.dependencies }))))
    },
  })

  const sessions = await collectSessions(call, detail)
  const events = await call('events.list', { runId: run.id, limit: 5000 })
  const verifications = await call('verifications.list', { runId: run.id })
  const decisions = await call('decisions.list', { runId: run.id })
  const taskKey = (id) => detail.tasks.find((t) => t.id === id)?.key ?? null
  const rotations = events.filter((e) => e.type === 'agent.rotated')

  // Per rotated agent: the session that was rotated (it carries the handoff) and the one that continued.
  const rotated = []
  for (const agent of detail.agents) {
    const own = sessions.filter((s) => s.agentId === agent.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    own.forEach((session, i) => {
      if (session.state !== 'rotated') return
      const next = own.slice(i + 1).find((s) => s.sdkSessionId && s.sdkSessionId !== session.sdkSessionId)
      // The work session that was rotated is the one before the handoff request (which resumes its SDK session).
      const work = own.slice(0, i + 1).find((s) => s.sdkSessionId === session.sdkSessionId) ?? session
      rotated.push({
        agent: agent.label,
        agentId: agent.id,
        task: taskKey(agent.taskId),
        oldSessionId: work.sdkSessionId,
        oldSessionEnd: work.endReason,
        handoff: session.handoff,
        newSessionId: next?.sdkSessionId ?? null,
        newSessionEnd: next?.endReason ?? null,
        newSessionStartedAt: next?.startedAt ?? null,
      })
    })
  }
  const packs = []
  for (const r of rotated) {
    for (const p of await call('context.packs', { agentId: r.agentId })) {
      if (p.entries.some((e) => e.sourceKind === 'handoff')) packs.push({ agent: r.agent, purpose: p.purpose, handoffEntries: p.entries.filter((e) => e.sourceKind === 'handoff').map((e) => e.title) })
    }
  }
  const tests = independentTestRun(detail)
  const missionVerification = verifications.filter((v) => v.taskId === null && v.kind === 'verifier').at(-1) ?? null
  const integrationLog = detail.run.integrationBranch ? git('log', '--format=%h %s', `${baseCommit}..${detail.run.integrationBranch}`).split('\n') : []
  const nonEmpty = (h) => h && [h.completedWork, h.commits, h.filesChanged, h.unresolvedIssues, h.importantFindings, h.nextSteps].some((list) => Array.isArray(list) && list.length > 0)
  const realHandoff = (h) => nonEmpty(h) && !(h.importantFindings ?? []).some((f) => f.startsWith('No handoff was available'))
  const continued = rotated.filter((r) => r.newSessionId && realHandoff(r.handoff))

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    runId: run.id,
    runState: detail.run.state,
    runError: detail.run.error,
    configuredRotationTurns: detail.run.config.sessionRotationTurns,
    tasks: detail.tasks.map((t) => ({ key: t.key, role: t.role, kind: t.kind, state: t.state, attempt: t.attempt, repairCycles: t.repairCycles })),
    rotationEvents: rotations.map((e) => ({ task: taskKey(e.taskId), at: e.createdAt, payload: e.payload })),
    rotated,
    handoffContextPacks: packs,
    sessions: sessions.map(({ handoff, ...s }) => ({ ...s, hasHandoff: handoff !== null })),
    decisions: decisions.map((d) => ({ task: taskKey(d.taskId), title: d.title, decision: d.decision.slice(0, 300) })),
    verifications: verifications.map((v) => ({ task: taskKey(v.taskId) ?? '(mission)', kind: v.kind, passed: v.passed, summary: v.summary.slice(0, 300) })),
    approvals,
    independentTestRun: tests,
    git: { userHeadUnchanged: git('rev-parse', 'HEAD') === baseCommit, userStatus: git('status', '--porcelain'), integrationLog, integrationFiles: detail.run.integrationBranch ? git('ls-tree', '-r', '--name-only', detail.run.integrationBranch).split('\n') : [] },
  })

  const rotatedTasks = new Set(continued.map((r) => r.task))
  const gates = {
    'the run used the configured rotation threshold': detail.run.config.sessionRotationTurns === ROTATION_TURNS,
    'a real worker session A was rotated': rotations.length > 0 && rotated.some((r) => typeof r.oldSessionId === 'string' && r.oldSessionId.length > 8),
    'a structured handoff was generated by the model and persisted': continued.length > 0,
    'a new real session B (different SDK session id) continued the same task': continued.some((r) => r.newSessionId !== r.oldSessionId && typeof r.newSessionId === 'string' && r.newSessionId.length > 8),
    'session B was started from the handoff (context pack)': packs.length > 0,
    'the rotated task finished correctly': [...rotatedTasks].length > 0 && [...rotatedTasks].every((key) => detail.tasks.find((t) => t.key === key)?.state === 'completed'),
    'commits exist on the integration branch': integrationLog.filter(Boolean).length > 0,
    'the run completed': detail.run.state === 'completed',
    'mission verification passed': missionVerification?.passed === true,
    'independent test run passes': tests.fail === 0 && tests.pass > 1,
    'the user checkout is untouched': evidence.git.userHeadUnchanged && evidence.git.userStatus === '',
  }
  evidence.gates = gates
  ok = reportGates(gates)
} catch (e) {
  evidence.scriptError = String(e?.stack ?? e)
  log('ERROR', evidence.scriptError)
} finally {
  await app.close().catch(() => undefined)
}
evidence.verdict = ok ? 'PASS' : 'FAIL'
const outFile = writeEvidence('session-rotation', evidence)
log('RESULT', evidence.verdict, '| run', evidence.runState, '| evidence:', outFile)
log('repo:', repo)
process.exit(ok ? 0 : 1)
