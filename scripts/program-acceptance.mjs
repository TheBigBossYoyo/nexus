// 0.4 acceptance: one real PROGRAM with REAL Claude Agent SDK sessions on a disposable project. Consumes usage.
//
//   node scripts/program-acceptance.mjs [path-to-NEXUS.exe]
//
// A small goal that needs at least two milestones. The script asks for one reassessment of the plan, runs a
// read-only background analysis, quits NEXUS in the middle of the program and starts it again, and checks
// that the program finishes with verified milestones, stored evidence, a plan revision, backlog and memory,
// and with the user's checkout untouched.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtureRepo, log, reportGates, requireAuth, root, writeEvidence } from './acceptance-common.mjs'

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined
const TIMEOUT_MS = 75 * 60_000

const { repo, git, baseCommit } = createFixtureRepo('nexus-program', {
  'package.json': JSON.stringify({ name: 'durations', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/index.js': "export { parseDuration } from './parse.js'\n",
  'src/parse.js': [
    '/** Parses "90s", "15m" or "2h" into seconds. */',
    'export function parseDuration(text) {',
    '  const match = /^(\\d+)([smh])$/.exec(String(text).trim())',
    "  if (!match) throw new TypeError(`Not a duration: ${text}`)",
    '  const n = Number(match[1])',
    "  return match[2] === 's' ? n : match[2] === 'm' ? n * 60 : n * 3600",
    '}',
    '',
    '// Used by nothing and tested by nothing: an older entry point kept from a previous version.',
    'export function legacyParse(text) {',
    '  return parseInt(text) * 60',
    '}',
    '',
  ].join('\n'),
  'test/parse.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { parseDuration } from '../src/index.js'",
    '',
    "test('seconds, minutes, hours', () => {",
    "  assert.equal(parseDuration('90s'), 90)",
    "  assert.equal(parseDuration('15m'), 900)",
    "  assert.equal(parseDuration('2h'), 7200)",
    '})',
    "test('rejects other text', () => assert.throws(() => parseDuration('soon'), TypeError))",
    '',
  ].join('\n'),
  'README.md': '# durations\n\nSmall duration utilities in plain ESM JavaScript. Tests: `npm test` (node:test, no dependencies).\n',
})

const GOAL = [
  'Extend this small library in two steps.',
  'First: add `formatDuration(seconds)` in src/format.js, exported from src/index.js, which turns a non-negative integer number of seconds into the shortest of "<n>s", "<n>m" or "<n>h" that is exact (90 -> "90s", 900 -> "15m", 7200 -> "2h", 0 -> "0s"), and throws RangeError for a negative or non-integer number. With node:test tests.',
  'Second, building on the first: add `roundTrip(text)` in src/round-trip.js, exported from src/index.js, which returns `formatDuration(parseDuration(text))`, with tests showing that "120s" becomes "2m" and "60m" becomes "1h".',
  '`npm test` must pass after each step.',
].join('\n')
const REPLAN_NOTE = 'Add one final milestone after the others: document formatDuration and roundTrip in README.md with one usage example each. Keep the existing milestones as they are.'

const evidence = { kind: 'program', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', goal: GOAL, replanNote: REPLAN_NOTE, baseCommit }
const dataDir = mkdtempSync(join(tmpdir(), 'nexus-program-data-'))

async function launch() {
  const env = { ...process.env, NEXUS_DATA_DIR: dataDir, ...(process.env.NEXUS_ACCEPT_SHOW === '1' ? {} : { NEXUS_WINDOW_OFFSCREEN: '1' }) }
  delete env.NEXUS_FAKE_RUNTIME
  delete env.NEXUS_FAKE_POWER
  const app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  return { app, call }
}

const line = (d) => `${d.program.state}${d.program.pauseReason ? `(${d.program.pauseReason})` : ''} | plan v${d.program.planVersion} | ${d.roadmap.map((m) => `${m.key}:${m.state}:${m.attempts}`).join(' ')} | run ${d.program.currentRunKind ?? '-'} | missions ${d.program.missions}`

let { app, call } = await launch()
let ok = false
try {
  await requireAuth(call, evidence)
  const project = await call('projects.open', { path: repo })
  const presets = await call('program.presets')
  // Autonomous, with a single-agent mission strategy to keep the usage of an acceptance run small.
  const policy = { ...presets.autonomous, preset: 'custom', missionStrategy: 'SINGLE', maxAgents: 2, maxTotalMissions: 8, maxMissionsPerMilestone: 2, maxReplans: 6 }
  const program = await call('program.create', { projectId: project.id, name: 'Durations: format and round trip', goal: GOAL, preset: 'autonomous', policy, start: true })
  evidence.programId = program.id
  log('program', program.id)

  // A read-only background analysis of the same project: proposals for the backlog, nothing else.
  await call('background.setSettings', { settings: { enabled: true, kinds: ['test_gap_analysis'] } })
  const job = await call('background.start', { projectId: project.id, kind: 'test_gap_analysis' })
  log('background job', job.id, job.state)

  const started = Date.now()
  let last = ''
  let replanAsked = false
  let restarted = false
  let detail
  for (;;) {
    if (Date.now() - started > TIMEOUT_MS) {
      log('timeout: cancelling the program')
      await call('program.cancel', { programId: program.id })
      break
    }
    detail = await call('program.get', { programId: program.id })
    const now = line(detail)
    if (now !== last) {
      log(now)
      last = now
    }
    // Once the first plan is accepted, the user asks for one more milestone.
    if (!replanAsked && detail.program.planVersion >= 1) {
      await call('program.replan', { programId: program.id, note: REPLAN_NOTE })
      replanAsked = true
      log('asked for a reassessment')
    }
    // Quit NEXUS in the middle of the second mission and start it again on the same data directory.
    if (!restarted && detail.program.missions >= 2 && detail.program.currentRunKind === 'mission') {
      const run = await call('runs.get', { runId: detail.program.currentRunId })
      if (run.agents.some((a) => ['working', 'starting'].includes(a.state))) {
        evidence.restart = { at: new Date().toISOString(), before: now, runId: detail.program.currentRunId, runState: run.run.state }
        log('quitting NEXUS mid-mission')
        await app.close().catch(() => undefined)
        await new Promise((r) => setTimeout(r, 4000))
        ;({ app, call } = await launch())
        restarted = true
        const after = await call('program.get', { programId: program.id })
        evidence.restart.after = line(after)
        evidence.restart.sameRun = after.program.currentRunId === evidence.restart.runId
        log('restarted:', evidence.restart.after)
        continue
      }
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(detail.program.state)) break
    if (detail.program.state === 'BLOCKED') {
      log('blocked:', detail.program.blockedReason)
      break
    }
    if (detail.program.state === 'WAITING_FOR_QUOTA') {
      evidence.quotaWaitObserved = true
      await new Promise((r) => setTimeout(r, 30_000))
      continue
    }
    await new Promise((r) => setTimeout(r, 5000))
  }

  detail = await call('program.get', { programId: program.id })
  const jobs = await call('background.jobs', { projectId: project.id })
  const projectBacklog = await call('backlog.list', { projectId: project.id })
  const runs = await call('runs.list', { projectId: project.id, includeInternal: true })
  const usage = await call('usage.overview').catch(() => null)
  const p = detail.program
  const completed = detail.roadmap.filter((m) => m.state === 'COMPLETED')
  const accepted = detail.revisions.filter((r) => r.status === 'accepted')
  const branchFiles = p.branch ? git('ls-tree', '-r', '--name-only', p.branch).split('\n') : []
  // The repository's own tests, run outside NEXUS on the program branch in a throwaway worktree.
  let independent = { error: 'no branch' }
  if (p.branch) {
    const wt = mkdtempSync(join(tmpdir(), 'nexus-program-check-'))
    try {
      git('worktree', 'add', '--detach', '-f', wt, p.branch)
      const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: wt, encoding: 'utf8' })
      independent = { pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? -1) }
    } catch (e) {
      independent = { error: String(e.stdout ?? e.message ?? e).slice(-1500) }
    } finally {
      try {
        git('worktree', 'remove', '--force', wt)
      } catch {
        // Left for the operating system's temp cleanup.
      }
    }
  }

  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    program: { state: p.state, planVersion: p.planVersion, missions: p.missions, replans: p.replans, branch: p.branch, outcome: p.outcome, blockedReason: p.blockedReason, activeMinutes: Math.round(p.activeMs / 60_000) },
    roadmap: detail.roadmap.map((m) => ({ key: m.key, title: m.title, state: m.state, attempts: m.attempts, expertise: m.expertise, verdict: m.evidence?.verdict ?? null, reason: m.evidence?.reason ?? null, gates: m.evidence?.gates ?? [], criteria: m.evidence?.judgment?.criteria ?? [] })),
    missions: detail.missions.map((m) => ({ milestone: detail.roadmap.find((x) => x.id === m.milestoneId)?.key, attempt: m.attempt, strategy: m.strategy, outcome: m.outcome, baseCommit: m.baseCommit, resultCommit: m.resultCommit })),
    revisions: detail.revisions.map((r) => ({ version: r.version, trigger: r.trigger, status: r.status, reason: r.reason, diff: r.diff, milestones: r.milestones.map((m) => m.key) })),
    decisions: detail.decisions.map((d) => ({ at: d.createdAt, kind: d.kind, summary: d.summary })).reverse(),
    memory: detail.memory.map((m) => ({ kind: m.kind, title: m.title, content: m.content, evidence: m.evidence, milestone: m.milestoneKey })),
    backlog: projectBacklog.map((b) => ({ title: b.title, category: b.category, severity: b.severity, status: b.status, source: b.provenance.source, evidence: b.evidence })),
    backgroundJobs: jobs.map((j) => ({ kind: j.kind, state: j.state, proposals: j.proposals, summary: j.summary, error: j.error })),
    runs: runs.map((r) => ({ mode: r.mode, state: r.state })),
    usage: usage ? { status: usage.status, session: usage.session } : null,
    branchFiles,
    independentTestRun: independent,
    userCheckout: { head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), status: git('status', '--porcelain') },
  })

  const missionBases = detail.missions.filter((m) => m.resultCommit)
  ok = reportGates({
    'the program completed': p.state === 'COMPLETED',
    'at least 2 milestones were verified and accepted': completed.length >= 2 && completed.every((m) => m.evidence?.verdict === 'accepted' && m.evidence.judgment !== null),
    'at least 2 real missions ran': detail.missions.filter((m) => m.outcome === 'completed').length >= 2,
    'every accepted milestone has stored gates and a per-criterion judgment': completed.every((m) => (m.evidence?.gates.length ?? 0) >= 4 && (m.evidence?.judgment?.criteria.length ?? 0) >= 1),
    'a reassessment the user asked for produced an accepted plan revision with a diff': accepted.some((r) => r.trigger === 'user' && (r.diff.added.length > 0 || r.diff.changed.length > 0)),
    'the revision added a milestone that was then completed': accepted.some((r) => r.trigger === 'user' && r.diff.added.some((k) => completed.some((m) => m.key === k))),
    'later missions started from the accepted work of earlier ones': missionBases.length >= 2 && missionBases.slice(1).every((m, i) => m.baseCommit === missionBases[i].resultCommit || detail.missions.some((x) => x.resultCommit === m.baseCommit)),
    'backlog discovery: at least one proposal was stored with evidence and provenance': projectBacklog.length >= 1 && projectBacklog.every((b) => b.evidence && b.provenance?.source),
    'no backlog proposal became work by itself': projectBacklog.every((b) => b.status === 'proposed'),
    'the background analysis job ended and changed nothing': jobs.length === 1 && ['completed', 'failed'].includes(jobs[0].state),
    'program memory: at least one validated entry': detail.memory.length >= 1,
    'NEXUS was restarted mid-mission and the program continued with the same run': restarted && evidence.restart?.sameRun === true,
    'the accepted work is on the program branch': branchFiles.includes('src/format.js') && branchFiles.includes('src/round-trip.js'),
    "the repository's tests pass on the program branch (independent run)": independent.fail === 0 && independent.pass >= 4,
    "the user's checkout is untouched": evidence.userCheckout.head === baseCommit && evidence.userCheckout.branch === 'main' && evidence.userCheckout.status === '',
  })
  evidence.gatesPassed = ok
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  const file = writeEvidence('program', evidence)
  log('evidence:', file)
  await app.close().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
