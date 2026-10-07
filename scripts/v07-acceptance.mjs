// 0.7 acceptance: the persistent runtime with REAL Claude Agent SDK sessions. Consumes usage.
//
//   node scripts/v07-acceptance.mjs [path-to-NEXUS.exe|-]
//
// Two kinds of workload run at once through the global queue: a small program and a one-trial Arena campaign,
// in disposable repositories. While they run the script
//   1. closes the window's process and leaves the runtime alone for a while, then opens a new window;
//   2. ends one worker process that holds a real session, and watches the runtime take the session back.
// It only starts the work and records what NEXUS did. It changes no threshold and forces no result.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtureRepo, log, reportGates, requireAuth, root, writeEvidence } from './acceptance-common.mjs'

const exe = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : undefined
const TIMEOUT_MS = Number(process.env.NEXUS_V07_ACCEPT_TIMEOUT_MIN ?? 90) * 60_000
const WINDOW_CLOSED_MS = Number(process.env.NEXUS_V07_WINDOW_CLOSED_S ?? 40) * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { repo, baseCommit } = createFixtureRepo('nexus-v07', {
  'package.json': JSON.stringify({ name: 'durations', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/index.js': "export { parseDuration } from './parse.js'\n",
  'src/parse.js': ['/** Parses "90s", "15m" or "2h" into seconds. */', 'export function parseDuration(text) {', '  const match = /^(\\d+)([smh])$/.exec(String(text).trim())', '  if (!match) throw new TypeError(`Not a duration: ${text}`)', '  const n = Number(match[1])', "  return match[2] === 's' ? n : match[2] === 'm' ? n * 60 : n * 3600", '}', ''].join('\n'),
  'test/parse.test.js': ["import test from 'node:test'", "import assert from 'node:assert/strict'", "import { parseDuration } from '../src/index.js'", '', "test('seconds, minutes, hours', () => {", "  assert.equal(parseDuration('90s'), 90)", "  assert.equal(parseDuration('15m'), 900)", "  assert.equal(parseDuration('2h'), 7200)", '})', ''].join('\n'),
  'README.md': '# durations\n\nSmall duration utilities in plain ESM JavaScript. Tests: `npm test` (node:test, no dependencies).\n',
})
const GOAL = [
  'Extend this small library in two steps.',
  'First: add `formatDuration(seconds)` in src/format.js, exported from src/index.js, which turns a non-negative integer number of seconds into the shortest of "<n>s", "<n>m" or "<n>h" that is exact (90 -> "90s", 900 -> "15m", 7200 -> "2h", 0 -> "0s"), and throws RangeError for a negative or non-integer number. With node:test tests.',
  'Second, building on the first: add `roundTrip(text)` in src/round-trip.js, exported from src/index.js, which returns `formatDuration(parseDuration(text))`, with tests.',
  '`npm test` must pass after each step.',
].join('\n')

const dataDir = mkdtempSync(join(tmpdir(), 'nexus-v07-data-'))
const evidence = { kind: 'v0.7-control-plane', startedAt: new Date().toISOString(), executable: exe ?? 'dev build', dataDir, baseCommit, samples: [], windowClosed: null, workerKill: null }

const endpoint = () => {
  const file = join(dataDir, 'runtime', 'endpoint.json')
  if (!existsSync(file)) return null
  try {
    const { pid, bootId, pipe, version, protocol } = JSON.parse(readFileSync(file, 'utf8'))
    // The token stays in the file; it is not evidence.
    return { pid, bootId, pipe, version, protocol }
  } catch {
    return null
  }
}
// Asked of Windows, not of a process handle this script may still hold: a process that has ended but whose handle
// is open somewhere answers a signal check as if it were alive.
const alive = (pid) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).includes(`"${Number(pid)}"`)
  } catch {
    return false
  }
}

async function launch() {
  const env = { ...process.env, NEXUS_DATA_DIR: dataDir, ...(process.env.NEXUS_ACCEPT_SHOW === '1' ? {} : { NEXUS_WINDOW_OFFSCREEN: '1' }) }
  delete env.NEXUS_FAKE_RUNTIME
  delete env.NEXUS_FAKE_POWER
  delete env.NEXUS_FAKE_WORKERS
  const app = await electron.launch(exe ? { executablePath: exe, env } : { args: ['.'], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })
  const raw = (channel, input = {}) => page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
  const call = async (channel, input = {}) => {
    const result = await raw(channel, input)
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const started = Date.now()
  for (;;) {
    const state = await raw('desktop.connection')
    if (state.ok && state.value.phase === 'READY') break
    if (Date.now() - started > 120_000) throw new Error(`The window did not reach READY: ${JSON.stringify(state)}`)
    await sleep(200)
  }
  return { app, page, call }
}

let { app, call } = await launch()
let ok = false
try {
  await requireAuth(call, evidence)
  evidence.usageBefore = await call('usage.refresh').catch(() => null)
  const connection = await call('desktop.connection')
  const runtime0 = await call('runtime.status')
  evidence.runtime = { pid: runtime0.pid, bootId: runtime0.bootId, version: runtime0.version, protocol: runtime0.protocol, endpointAcl: runtime0.endpointAcl, endpoint: endpoint(), windowPid: app.process().pid }
  log('runtime', JSON.stringify(evidence.runtime), 'connection', connection.phase)

  await call('control.setLimits', { limits: { maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'resume', agingMinutes: 30 } })
  const project = await call('projects.open', { path: repo })
  const presets = await call('program.presets')
  const policy = { ...presets.autonomous, preset: 'custom', missionStrategy: 'SINGLE', maxAgents: 2, maxTotalMissions: 6, maxMissionsPerMilestone: 2, maxReplans: 3 }
  const program = await call('program.create', { projectId: project.id, name: 'Durations: format and round trip', goal: GOAL, preset: 'autonomous', policy, start: false })
  const campaign = await call('arena.createCampaign', { name: `v0.7 acceptance ${new Date().toISOString().slice(0, 16)}`, caseIds: ['bugfix-localized'], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco', start: false })
  // Both go through the global queue; the program is the more urgent one.
  const programItem = await call('control.enqueue', { item: { type: 'program', programId: program.id, priority: 'P1' } })
  const arenaItem = await call('control.enqueue', { item: { type: 'arena', campaignId: campaign.id, priority: 'P2' } })
  evidence.items = { program: programItem.id, arena: arenaItem.id }
  log('queued', program.id, campaign.id)

  const started = Date.now()
  const seen = { maxAgents: 0, bothActive: false, workerPids: new Set(), sessionIds: new Set(), leaseViolations: 0, maxBusyWorkers: 0, decisions: null }
  let lastLine = ''
  let closedDone = false
  let killDone = false
  let finished = false

  const sample = async () => {
    const overview = await call('control.overview')
    const workers = await call('runtime.workers')
    const active = workers.leases.filter((l) => l.state === 'ACTIVE')
    if (new Set(active.map((l) => l.agentId)).size !== active.length || new Set(active.map((l) => l.workerId)).size !== active.length) seen.leaseViolations += 1
    seen.maxAgents = Math.max(seen.maxAgents, overview.agents.active)
    seen.maxBusyWorkers = Math.max(seen.maxBusyWorkers, workers.counts.busy)
    const activeTypes = new Set(overview.active.map((i) => i.type))
    if (activeTypes.has('program') && activeTypes.has('arena')) seen.bothActive = true
    for (const w of workers.workers) {
      if (w.assignment && w.pid) seen.workerPids.add(w.pid)
      if (w.assignment?.sessionId) seen.sessionIds.add(w.assignment.sessionId)
    }
    const all = [...overview.active, ...overview.waiting, ...overview.scheduled, ...overview.finished]
    const stateOf = (id) => all.find((i) => i.id === id)?.state ?? 'gone'
    const line = `program ${stateOf(programItem.id)} | arena ${stateOf(arenaItem.id)} | agents ${overview.agents.active}/${overview.agents.max} | workers ${workers.counts.busy} busy of ${workers.counts.live} | health ${overview.health.level}`
    if (line !== lastLine) {
      log(line)
      lastLine = line
      evidence.samples.push({ at: new Date().toISOString(), line })
    }
    return { overview, workers, programState: stateOf(programItem.id), arenaState: stateOf(arenaItem.id) }
  }

  while (!finished) {
    if (Date.now() - started > TIMEOUT_MS) {
      log('timeout: cancelling both workloads')
      await call('control.cancel', { itemId: programItem.id }).catch(() => undefined)
      await call('control.cancel', { itemId: arenaItem.id }).catch(() => undefined)
      break
    }
    const { overview, workers, programState, arenaState } = await sample()
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED']
    finished = terminal.includes(programState) && terminal.includes(arenaState)

    // 1. Close the window in the middle of the work.
    const busy = workers.workers.filter((w) => w.assignment && w.state === 'RUNNING')
    if (!closedDone && busy.length > 0 && overview.active.length > 0) {
      closedDone = true
      const before = { at: new Date().toISOString(), runtime: endpoint(), busyWorkers: busy.map((w) => ({ pid: w.pid, agent: w.assignment.agentId, session: w.assignment.sessionId })), leases: workers.leases.filter((l) => l.state === 'ACTIVE').length }
      const runIds = [...new Set(busy.map((w) => w.assignment.runId).filter(Boolean))]
      const seqBefore = {}
      for (const runId of runIds) seqBefore[runId] = (await call('events.list', { runId, limit: 5000 })).at(-1)?.seq ?? 0
      log('closing the window; the runtime is left alone for', WINDOW_CLOSED_MS / 1000, 's')
      // The window is closed as a user closes it. Not `app.close()`: Playwright waits for the output streams of the
      // process it launched, and the runtime that process started holds them open for as long as it lives.
      // The window's own process, as it reports itself: what Playwright launched may be a shell around it.
      const closedWindowPid = await app.evaluate(() => process.pid)
      void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => undefined)
      let waitedMs = 0
      for (; waitedMs < 20_000 && alive(closedWindowPid); waitedMs += 250) await sleep(250)
      await sleep(3000)
      const windowGone = !alive(closedWindowPid)
      const runtimeAliveWithoutWindow = alive(before.runtime.pid)
      await sleep(WINDOW_CLOSED_MS)
      const runtimeAliveAfterWait = alive(before.runtime.pid)
      ;({ app, call } = await launch())
      const after = await call('runtime.status')
      let eventsWhileClosed = 0
      for (const runId of runIds) eventsWhileClosed += (await call('events.list', { runId, limit: 5000 })).filter((e) => e.seq > seqBefore[runId] && e.createdAt > before.at).length
      evidence.windowClosed = { before, closedForMs: WINDOW_CLOSED_MS, windowGone, runtimeAliveWithoutWindow, runtimeAliveAfterWait, sameRuntime: after.bootId === before.runtime.bootId && after.pid === before.runtime.pid, eventsWhileClosed, closedWindowPid, windowGoneAfterMs: waitedMs, reopenedAt: new Date().toISOString() }
      log('window reopened', JSON.stringify({ windowGone, runtimeAliveWithoutWindow, runtimeAliveAfterWait, sameRuntime: evidence.windowClosed.sameRuntime, eventsWhileClosed }))
      continue
    }

    // 2. End one worker that holds a real session.
    if (closedDone && !killDone && busy.length > 0) {
      const victim = busy.find((w) => w.assignment.sessionId) ?? null
      if (victim) {
        const at = new Date().toISOString()
        log('ending worker', victim.pid, 'agent', victim.assignment.agentId, 'task', victim.assignment.taskId)
        // The pid is the runtime's own record of a worker it started in this run; its tree is the session's processes.
        try {
          execFileSync('taskkill', ['/PID', String(victim.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // Its session had just ended and the worker with it: nothing was killed. The next busy worker is taken.
          log('that worker had already gone; taking the next one')
          await sleep(1000)
          continue
        }
        killDone = true
        let record = null
        let lease = null
        for (let i = 0; i < 60; i++) {
          await sleep(500)
          const now = await call('runtime.workers')
          record = now.workers.find((w) => w.id === victim.id) ?? null
          lease = now.leases.find((l) => l.id === victim.assignment.leaseId) ?? null
          if (record?.state === 'FAILED' && lease && lease.state !== 'ACTIVE') break
        }
        evidence.workerKill = { at, worker: { id: victim.id, pid: victim.pid }, agentId: victim.assignment.agentId, taskId: victim.assignment.taskId, runId: victim.assignment.runId, sessionId: victim.assignment.sessionId, workerAfter: record ? { state: record.state, error: record.error, exitCode: record.exitCode } : null, leaseAfter: lease ? { state: lease.state, reason: lease.reason } : null, processGone: !alive(victim.pid) }
        log('worker ended', JSON.stringify(evidence.workerKill.workerAfter), JSON.stringify(evidence.workerKill.leaseAfter))
      }
    }
    await sleep(4000)
  }

  const final = await sample()
  // What became of the task whose worker was ended: the orchestrator's records, read after everything is over.
  if (evidence.workerKill?.runId) {
    const run = await call('runs.get', { runId: evidence.workerKill.runId }).catch(() => null)
    const task = run?.tasks.find((t) => t.id === evidence.workerKill.taskId) ?? null
    const agents = run?.agents.filter((a) => a.taskId === evidence.workerKill.taskId) ?? []
    evidence.workerKill.after = { runState: run?.run.state ?? null, taskState: task?.state ?? null, taskAttempts: task?.attempts ?? null, agentsOfTask: agents.map((a) => ({ id: a.id, state: a.state, role: a.role })) }
    const leases = (await call('runtime.workers')).leases.filter((l) => l.runId === evidence.workerKill.runId)
    evidence.workerKill.leasesOfRunAfter = leases.map((l) => ({ agentId: l.agentId, state: l.state, grantedAt: l.grantedAt }))
  }
  const programDetail = await call('program.get', { programId: program.id })
  const campaignDetail = await call('arena.campaign', { campaignId: campaign.id })
  const trials = (await call('arena.trials', { campaignId: campaign.id, limit: 20 })).trials
  seen.decisions = { program: await call('control.decisions', { itemId: programItem.id }), arena: await call('control.decisions', { itemId: arenaItem.id }) }
  const workersEnd = await call('runtime.workers')
  const security = await call('security.decisions', { limit: 200 }).catch(() => null)
  evidence.result = {
    program: { state: programDetail.program.state, roadmap: programDetail.roadmap.map((m) => ({ key: m.key, state: m.state, attempts: m.attempts })), missions: programDetail.program.missions },
    arena: { state: campaignDetail.campaign.state, trials: trials.map((t) => ({ state: t.trial.state, strategy: t.trial.strategy, success: t.trial.success ?? null, score: t.trial.score ?? null })) },
    items: { program: final.programState, arena: final.arenaState },
    seen: { maxAgents: seen.maxAgents, maxBusyWorkers: seen.maxBusyWorkers, bothActive: seen.bothActive, distinctWorkerPids: seen.workerPids.size, distinctSessionIds: seen.sessionIds.size, leaseViolations: seen.leaseViolations },
    decisions: seen.decisions,
    workers: { ended: workersEnd.workers.filter((w) => w.state === 'STOPPED' || w.state === 'FAILED').length, failed: workersEnd.workers.filter((w) => w.state === 'FAILED').map((w) => ({ pid: w.pid, error: w.error })), activeLeases: workersEnd.leases.filter((l) => l.state === 'ACTIVE').length },
    security: security ? { recorded: security.decisions.length, byDecision: security.decisions.reduce((acc, d) => ({ ...acc, [d.decision]: (acc[d.decision] ?? 0) + 1 }), {}) } : null,
    health: final.overview.health,
  }
  evidence.usageAfter = await call('usage.refresh').catch(() => null)

  // The runtime is stopped cleanly; a new start must find everything in the database.
  const rt = endpoint()
  const stop = await call('runtime.stop')
  await app.close().catch(() => undefined)
  for (let i = 0; i < 120 && rt && alive(rt.pid); i++) await sleep(500)
  const stoppedCleanly = stop.stopping === true && rt !== null && !alive(rt.pid) && endpoint() === null
  ;({ app, call } = await launch())
  const reopened = await call('control.overview')
  const again = await call('runtime.status')
  evidence.persistence = { stoppedCleanly, newBootId: again.bootId !== rt?.bootId, finished: reopened.finished.filter((i) => [programItem.id, arenaItem.id].includes(i.id)).map((i) => ({ type: i.type, state: i.state })), programStateAfterRestart: (await call('program.get', { programId: program.id })).program.state }
  await call('runtime.stop')
  await app.close().catch(() => undefined)

  const r = evidence.result
  ok = reportGates({
    'the runtime is a process of its own, found through its endpoint': evidence.runtime.pid !== evidence.runtime.windowPid && evidence.runtime.endpoint?.pid === evidence.runtime.pid,
    'two kinds of workload were active at the same time through the global queue': r.seen.bothActive,
    'agent sessions never exceeded the global limit of 3': r.seen.maxAgents <= 3 && r.seen.maxAgents >= 1,
    'several real sessions ran in worker processes': r.seen.distinctWorkerPids >= 2 && r.seen.distinctSessionIds >= 2,
    'no agent session and no worker ever held two leases': r.seen.leaseViolations === 0,
    'the window process ended and the runtime went on without it': evidence.windowClosed?.windowGone === true && evidence.windowClosed.runtimeAliveWithoutWindow === true && evidence.windowClosed.runtimeAliveAfterWait === true,
    'work progressed while no window existed': (evidence.windowClosed?.eventsWhileClosed ?? 0) > 0,
    'the new window found the same runtime': evidence.windowClosed?.sameRuntime === true,
    'a worker holding a real session was ended, recorded as failed, and its lease revoked': evidence.workerKill?.workerAfter?.state === 'FAILED' && evidence.workerKill.leaseAfter?.state === 'REVOKED' && evidence.workerKill.processGone === true,
    'the run of the ended worker did not fail because of it': evidence.workerKill?.after ? ['completed', 'executing', 'testing', 'reviewing', 'verifying', 'repairing'].includes(evidence.workerKill.after.runState) : false,
    'the program completed': r.program.state === 'COMPLETED' && r.items.program === 'COMPLETED',
    'the Arena campaign completed': r.arena.state === 'completed' && r.items.arena === 'COMPLETED',
    'no lease was left active at the end': r.workers.activeLeases === 0,
    'the runtime stopped cleanly and a new one found the finished work in the database': evidence.persistence.stoppedCleanly && evidence.persistence.newBootId && evidence.persistence.finished.length === 2 && evidence.persistence.programStateAfterRestart === 'COMPLETED',
  })
} catch (e) {
  evidence.error = String(e?.stack ?? e)
  log('ERROR', evidence.error)
} finally {
  evidence.finishedAt = new Date().toISOString()
  evidence.ok = ok
  log('evidence', writeEvidence('v07-acceptance', evidence))
  // Nothing of this run stays behind: the window, and the runtime of this run's own data directory.
  await app.close().catch(() => undefined)
  const rt = endpoint()
  if (rt && alive(rt.pid)) {
    try {
      execFileSync('taskkill', ['/PID', String(rt.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already gone.
    }
  }
}
process.exit(ok ? 0 : 1)
