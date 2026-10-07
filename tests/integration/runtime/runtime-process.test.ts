import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ControlPlaneOverview } from '@shared/control-plane'
import type { RunDetail } from '@shared/ipc'
import type { ConnectionState, RuntimeStatus } from '@shared/runtime-protocol'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT } from '@shared/overnight'
import type { Settings } from '@shared/settings'
import type { WorkersOverview } from '@shared/workers'
import { buildRuntime, call, connect, processAlive, readEndpoint, removeDir, startRuntime, tempDataDir, until, type RuntimeProcess } from '../../helpers/runtime-process'
import type { RuntimeClient } from '@main/modules/runtime/client'

/**
 * The runtime as a process of its own: started, connected to, left alone by a client that goes away, killed and
 * started again. Every test here runs real processes (the runtime hosted by Node, and the workers it forks)
 * with the scripted agent runtime.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

function createRepo(): string {
  const root = tempDataDir('repo')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Runtime Tester')
  git(root, 'config', 'user.email', 'runtime@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), '# Scratch project\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', main: 'src/index.js' }, null, 2) + '\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.js'), "module.exports = { name: 'scratch' }\n")
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Initial commit')
  return root
}

const dirs: string[] = []
const runtimes: RuntimeProcess[] = []
const clients: RuntimeClient[] = []

function dataDir(): string {
  const dir = tempDataDir()
  dirs.push(dir)
  return dir
}
async function runtime(dir: string, env: Record<string, string> = {}): Promise<RuntimeProcess> {
  const started = await startRuntime(dir, env)
  runtimes.push(started)
  return started
}
async function client(dir: string, options: Parameters<typeof connect>[1] = {}): Promise<RuntimeClient> {
  const connected = await connect(dir, options)
  clients.push(connected)
  return connected
}

/** Opens a project and starts a mission that the scripted runtime plans and executes; returns the run id. */
async function startMission(c: RuntimeClient, repo: string): Promise<string> {
  const project = await call<{ id: string }>(c, 'projects.open', { path: repo })
  const run = await call<{ id: string }>(c, 'runs.create', { projectId: project.id, mode: 'build', prompt: 'Build the demo modules', preset: 'balanced', requirePlanApproval: false })
  return run.id
}

beforeAll(async () => {
  await buildRuntime()
}, 120_000)

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const r of runtimes.splice(0)) await r.kill()
  for (const dir of dirs.splice(0)) removeDir(dir)
})

describe('the runtime process', () => {
  it('starts without a window, writes its endpoint, and answers an authenticated client', async () => {
    const dir = dataDir()
    const r = await runtime(dir)
    const endpoint = readEndpoint(dir)
    expect(endpoint?.bootId).toBe(r.bootId)
    expect(endpoint?.pid).toBe(r.child.pid)
    expect(endpoint?.pipe).toMatch(process.platform === 'win32' ? /^\\\\\.\\pipe\\nexus-runtime-[0-9a-f]{12}-[0-9a-f]{16}$/ : /\.sock$/)

    const c = await client(dir)
    const status = await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    expect(status.bootId).toBe(r.bootId)
    expect(status.clients.desktop).toBe(1)
    const overview = await call<ControlPlaneOverview>(c, 'control.overview')
    expect(overview.health.components.map((x) => x.component)).toEqual(['database', 'scheduler', 'workers', 'providers', 'git', 'usage', 'power_supervisor', 'ipc', 'schedules'])
    expect(overview.health.components.find((x) => x.component === 'ipc')?.detail).toContain('Nothing listens on the network')
  }, 120_000)

  it('refuses a channel outside the contract and an input that does not match its schema', async () => {
    const dir = dataDir()
    await runtime(dir)
    const c = await client(dir)
    expect(await c.invoke('shell.exec', { command: 'whoami' })).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'Unknown IPC channel' } })
    expect(await c.invoke('control.setPriority', { itemId: 'x', priority: 'P9' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await c.invoke('control.setPriority', { itemId: 'x', priority: 'P1', extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    // A channel that only the window's own process answers is not served by the runtime.
    expect(await c.invoke('desktop.connection', {})).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
  }, 120_000)

  it('keeps a mission running after its client has gone, and gives a new client the whole state', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    const r = await runtime(dir)
    const first = await client(dir)
    await until(
      () => call<RuntimeStatus>(first, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    const runId = await startMission(first, repo)
    await until(
      () => call<RunDetail>(first, 'runs.get', { runId }),
      (d) => d.run.state !== 'planning',
      60_000,
      'the mission to leave planning',
    )

    // The window goes away in the middle of the mission.
    first.close()
    clients.splice(clients.indexOf(first), 1)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(processAlive(r.child.pid as number)).toBe(true)

    // A new window: nothing but the runtime and its database tells it what happened meanwhile.
    const second = await client(dir)
    const done = await until(
      () => call<RunDetail>(second, 'runs.get', { runId }),
      (d) => d.run.state === 'completed' || d.run.state === 'failed' || d.run.state === 'paused',
      120_000,
      'the mission to finish without a client',
    )
    expect(done.run.state).toBe('completed')
    expect(done.tasks.length).toBeGreaterThan(0)
    expect(done.tasks.every((t) => t.state === 'completed')).toBe(true)
    // The queue reads the run on its next pass.
    await until(
      () => call<ControlPlaneOverview>(second, 'control.overview'),
      (o) => o.finished.some((i) => i.refId === runId && i.state === 'COMPLETED'),
      15_000,
      'the queue to record the finished mission',
    )
  }, 240_000)

  it('is found again by a client after it was killed and started anew, with the queue it had', async () => {
    const dir = dataDir()
    const states: ConnectionState[] = []
    const first = await runtime(dir)
    const c = await client(dir, { onState: (s) => states.push(s) })
    await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    const schedule = await call<{ id: string }>(c, 'control.createSchedule', { schedule: { name: 'Weekly audit', rule: { kind: 'weekly', day: 'sunday', time: '03:00' }, action: { type: 'program', programId: 'missing' }, priority: 'P3', enabled: true } }).catch((e: Error) => e)
    // A schedule for a program that does not exist is still a stored schedule; it says so when it fires.
    expect(schedule).not.toBeInstanceOf(Error)
    await call(c, 'control.setLimits', { limits: { maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'hold', agingMinutes: 15 } })

    await first.kill()
    await until(
      () => c.state(),
      (s) => s.phase === 'DISCONNECTED',
      15_000,
      'the client to notice the loss',
    )
    // While disconnected a request fails at once; it does not hang and it does not show old data.
    expect(await c.invoke('control.overview', {})).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })

    const second = await runtime(dir)
    expect(second.bootId).not.toBe(first.bootId)
    await until(
      () => c.state(),
      (s) => s.phase === 'READY' && s.runtime?.bootId === second.bootId,
      30_000,
      'the client to reconnect to the new runtime',
    )
    const overview = await call<ControlPlaneOverview>(c, 'control.overview')
    expect(overview.limits).toMatchObject({ maxAgents: 3, maxActiveItems: 2, agingMinutes: 15 })
    expect(overview.schedules.map((s) => s.name)).toEqual(['Weekly audit'])
    expect(states.map((s) => s.phase)).toContain('DISCONNECTED')
  }, 240_000)

  it('stops cleanly when asked, removes its endpoint, and a second runtime for the same data cannot listen beside it', async () => {
    const dir = dataDir()
    const r = await runtime(dir)
    const c = await client(dir)
    await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    expect(await call<{ stopping: boolean }>(c, 'runtime.stop')).toEqual({ stopping: true })
    expect(await r.exited()).toBe(0)
    expect(readEndpoint(dir)).toBeNull()
  }, 120_000)

  it('stops by itself when nothing is running and no window is connected', async () => {
    const dir = dataDir()
    const r = await runtime(dir, { NEXUS_RUNTIME_IDLE_EXIT_MS: '1500' })
    expect(await r.exited(30_000)).toBe(0)
    expect(readEndpoint(dir)).toBeNull()
  }, 120_000)
})

describe('workers of the runtime process', () => {
  it('runs a mission in worker processes, one session per worker, and stops them when idle work ends', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    await runtime(dir, { NEXUS_FAKE_WORKERS: '1' })
    const c = await client(dir)
    await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    const runId = await startMission(c, repo)
    const seen = new Set<number>()
    const done = await until(
      async () => {
        const workers = await call<WorkersOverview>(c, 'runtime.workers')
        for (const w of workers.workers) if (w.pid !== null && w.assignment) seen.add(w.pid)
        // Never two live leases for one agent session, never two for one worker.
        const active = workers.leases.filter((l) => l.state === 'ACTIVE')
        expect(new Set(active.map((l) => l.agentId)).size).toBe(active.length)
        expect(new Set(active.map((l) => l.workerId)).size).toBe(active.length)
        return call<RunDetail>(c, 'runs.get', { runId })
      },
      (d) => d.run.state === 'completed' || d.run.state === 'failed' || d.run.state === 'paused',
      180_000,
      'the mission to finish in workers',
    )
    expect(done.run.state).toBe('completed')
    expect(seen.size).toBeGreaterThan(0)
    const workers = await call<WorkersOverview>(c, 'runtime.workers')
    expect(workers.enabled).toBe(true)
    expect(workers.leases.filter((l) => l.state === 'ACTIVE')).toEqual([])
    expect(workers.leases.some((l) => l.state === 'RELEASED')).toBe(true)
  }, 300_000)
})

describe('scenarios of the 0.7 control plane, on a real runtime process', () => {
  async function ready(dir: string, env: Record<string, string> = {}): Promise<{ r: RuntimeProcess; c: RuntimeClient }> {
    const r = await runtime(dir, env)
    const c = await client(dir)
    await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )
    return { r, c }
  }

  it('a program and an Arena campaign run at the same time through the queue, within the global capacity', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    const { c } = await ready(dir)
    await call(c, 'control.setLimits', { limits: { maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'hold', agingMinutes: 30 } })
    const project = await call<{ id: string }>(c, 'projects.open', { path: repo })
    const program = await call<{ id: string }>(c, 'program.create', { projectId: project.id, name: 'Scenario program', goal: 'Build the demo modules in two milestones.', preset: 'autonomous', policy: { ...(await call<Record<string, Record<string, unknown>>>(c, 'program.presets'))['autonomous'], preset: 'custom', maxAgents: 2 }, start: false })
    const campaign = await call<{ id: string }>(c, 'arena.createCampaign', { name: 'Scenario campaign', caseIds: ['bugfix-localized'], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco', start: false })
    const programItem = await call<{ id: string }>(c, 'control.enqueue', { item: { type: 'program', programId: program.id, priority: 'P1' } })
    const arenaItem = await call<{ id: string }>(c, 'control.enqueue', { item: { type: 'arena', campaignId: campaign.id, priority: 'P2' } })

    let together = false
    let maxAgents = 0
    const end = await until(
      async () => {
        const o = await call<ControlPlaneOverview>(c, 'control.overview')
        maxAgents = Math.max(maxAgents, o.agents.active)
        const types = new Set(o.active.map((i) => i.type))
        if (types.has('program') && types.has('arena')) together = true
        return o
      },
      (o) => [programItem.id, arenaItem.id].every((id) => o.finished.some((i) => i.id === id)),
      200_000,
      'both workloads to finish',
    )
    expect(together).toBe(true)
    expect(maxAgents).toBeGreaterThan(0)
    expect(maxAgents).toBeLessThanOrEqual(3)
    expect(end.finished.find((i) => i.id === programItem.id)?.state).toBe('COMPLETED')
    expect(['COMPLETED', 'FAILED']).toContain(end.finished.find((i) => i.id === arenaItem.id)?.state)
    const decisions = await call<{ decision: string }[]>(c, 'control.decisions', { itemId: programItem.id })
    expect(decisions.map((d) => d.decision)).toContain('ADMIT')
  }, 300_000)

  it('a worker is killed in the middle of a mission: its session is taken back, the task is done again, the mission completes', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    const { c } = await ready(dir, { NEXUS_FAKE_WORKERS: '1' })
    const runId = await startMission(c, repo)
    // The first worker seen holding a task's session is ended from outside, with its process tree.
    const victim = await until(
      async () => (await call<WorkersOverview>(c, 'runtime.workers')).workers.find((w) => w.state === 'RUNNING' && w.assignment?.taskId) ?? null,
      (w) => w !== null,
      120_000,
      'a worker to hold a task session',
    )
    const lease = victim?.assignment?.leaseId as string
    execFileSync('taskkill', ['/PID', String(victim?.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const after = await until(
      () => call<WorkersOverview>(c, 'runtime.workers'),
      (o) => o.workers.find((w) => w.id === victim?.id)?.state === 'FAILED',
      30_000,
      'the killed worker to be recorded as failed',
    )
    // The scripted sessions last milliseconds: the one seen on the worker may have ended by itself in the moment
    // before the kill landed, and its lease was then released, not revoked. Either way no lease of the dead
    // worker is left active. (The revocation itself is pinned down, without this race, in
    // tests/integration/workers/worker-process.test.ts.)
    expect(['REVOKED', 'RELEASED']).toContain(after.leases.find((l) => l.id === lease)?.state)
    expect(after.leases.filter((l) => l.workerId === victim?.id && l.state === 'ACTIVE')).toEqual([])
    expect(processAlive(victim?.pid as number)).toBe(false)

    const done = await until(
      () => call<RunDetail>(c, 'runs.get', { runId }),
      (d) => d.run.state === 'completed' || d.run.state === 'failed' || d.run.state === 'paused',
      200_000,
      'the mission to finish after the worker was lost',
    )
    expect(done.run.state).toBe('completed')
    expect(done.tasks.every((t) => t.state === 'completed')).toBe(true)
    const workers = await call<WorkersOverview>(c, 'runtime.workers')
    expect(workers.leases.filter((l) => l.state === 'ACTIVE')).toEqual([])
    const health = (await call<ControlPlaneOverview>(c, 'control.overview')).health.components.find((x) => x.component === 'workers')
    expect(health?.level).toBe('DEGRADED')
    expect(health?.detail).toContain('failed in the last five minutes')
  }, 300_000)

  it('the runtime is killed in the middle of a mission: the next start pauses it for recovery, judges nothing, and resumes it to completion', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    const first = await ready(dir, { NEXUS_FAKE_WORKERS: '1' })
    await call(first.c, 'control.setLimits', { limits: { maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'resume', agingMinutes: 30 } })
    const runId = await startMission(first.c, repo)
    const busy = await until(
      async () => (await call<WorkersOverview>(first.c, 'runtime.workers')).workers.filter((w) => w.assignment && w.pid !== null),
      (w) => w.length > 0,
      120_000,
      'a worker to hold a session',
    )
    const workerPids = busy.map((w) => w.pid as number)
    const before = await call<RunDetail>(first.c, 'runs.get', { runId })
    expect(['completed', 'failed', 'cancelled']).not.toContain(before.run.state)
    first.c.close()
    clients.splice(clients.indexOf(first.c), 1)
    await first.r.kill()
    // The workers of the dead runtime end themselves; nobody has to find and kill them.
    await until(
      () => workerPids.filter(processAlive),
      (alive) => alive.length === 0,
      30_000,
      'the workers of the killed runtime to end',
    )

    const second = await ready(dir, { NEXUS_FAKE_WORKERS: '1' })
    const status = await call<RuntimeStatus>(second.c, 'runtime.status')
    expect(status.bootId).not.toBe(first.r.bootId)
    expect(status.recovery.workloads).toBeGreaterThanOrEqual(1)
    expect(status.recovery.workers).toBeGreaterThanOrEqual(1)
    const events = await call<{ type: string; payload: Record<string, unknown> }[]>(second.c, 'events.list', { runId, limit: 5000 })
    // Neither completed nor failed by the restart: paused for recovery, with the reason on record.
    expect(events.some((e) => e.type === 'run.paused' && e.payload['reason'] === 'recovery')).toBe(true)
    expect(events.some((e) => e.type === 'run.failed')).toBe(false)
    const workers = await call<WorkersOverview>(second.c, 'runtime.workers')
    expect(workers.workers.filter((w) => w.bootId === first.r.bootId).every((w) => w.state === 'STOPPED')).toBe(true)
    expect(workers.leases.filter((l) => l.bootId === first.r.bootId).every((l) => l.state !== 'ACTIVE')).toBe(true)

    const done = await until(
      () => call<RunDetail>(second.c, 'runs.get', { runId }),
      (d) => d.run.state === 'completed' || d.run.state === 'failed',
      200_000,
      'the recovered mission to finish',
    )
    expect(done.run.state).toBe('completed')
    expect(done.tasks.every((t) => t.state === 'completed')).toBe(true)
    const overview = await call<ControlPlaneOverview>(second.c, 'control.overview')
    expect(overview.incidents.some((i) => i.summary.includes('reconciled'))).toBe(true)
  }, 400_000)

  it('a schedule fires once while no window is connected, and not again after the runtime is killed and restarted', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    const first = await ready(dir)
    const project = await call<{ id: string }>(first.c, 'projects.open', { path: repo })
    const program = await call<{ id: string }>(first.c, 'program.create', { projectId: project.id, name: 'Scheduled program', goal: 'Build the demo modules.', preset: 'autonomous', start: false })
    const at = new Date(Date.now() + 4000).toISOString()
    const schedule = await call<{ id: string }>(first.c, 'control.createSchedule', { schedule: { name: 'Soon', rule: { kind: 'once', at }, action: { type: 'program', programId: program.id }, priority: 'P2', enabled: true } })
    // The window goes away before the schedule is due.
    first.c.close()
    clients.splice(clients.indexOf(first.c), 1)
    await new Promise((resolve) => setTimeout(resolve, 9000))
    expect(processAlive(first.r.child.pid as number)).toBe(true)

    const back = await client(dir)
    const fired = await call<ControlPlaneOverview>(back, 'control.overview')
    const items = [...fired.active, ...fired.waiting, ...fired.finished].filter((i) => i.scheduleId === schedule.id)
    expect(items).toHaveLength(1)
    expect(fired.schedules.find((s) => s.id === schedule.id)).toMatchObject({ enabled: false, nextRunAt: null })
    expect(fired.schedules.find((s) => s.id === schedule.id)?.lastResult).toContain('Queued')
    back.close()
    clients.splice(clients.indexOf(back), 1)
    await first.r.kill()

    const second = await ready(dir)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const again = await call<ControlPlaneOverview>(second.c, 'control.overview')
    expect([...again.active, ...again.waiting, ...again.scheduled, ...again.finished].filter((i) => i.scheduleId === schedule.id)).toHaveLength(1)
  }, 300_000)
})

describe('what a holder of the runtime token cannot do', () => {
  it('cannot answer its own confirmation: power control, a program in the settings, and trust are asked by the runtime itself', async () => {
    const dir = dataDir()
    const repo = createRepo()
    dirs.push(repo)
    await runtime(dir)
    const asked: string[] = []
    // A client that claims to be the window and says yes to everything it is asked.
    const c = await client(dir, {
      kind: 'desktop',
      onUiRequest: async (request) => {
        asked.push(request.kind)
        if (request.kind === 'confirm') return { response: 0 }
        if (request.kind === 'pickDirectory') return { path: repo }
        return { done: true }
      },
    })
    await until(
      () => call<RuntimeStatus>(c, 'runtime.status'),
      (s) => s.phase === 'READY',
    )

    // A folder picker carries no authority and is still shown by the window.
    const project = await call<{ id: string }>(c, 'projects.open', {})
    expect(asked).toEqual(['pickDirectory'])

    // Power control: the question never reaches the client, and without anyone to ask the answer is no.
    const overnight = await c.invoke('overnight.start', { projectId: project.id, preset: 'balanced', prompt: 'Build the modules.', policy: DEFAULT_OVERNIGHT_POLICY, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT, planningMode: 'single' })
    expect(overnight).toMatchObject({ ok: false, error: { code: 'invalid_state', message: 'The overnight run was not authorized.' } })
    expect(await call<unknown[]>(c, 'overnight.active')).toEqual([])
    expect(existsSync(join(dir, 'fake-power.log'))).toBe(false)

    // A program in the settings: the same.
    const settings = await call<Settings>(c, 'settings.get')
    for (const changed of [
      { ...settings, claude: { ...settings.claude, executablePath: 'C:\\Temp\\not-claude.exe' } },
      { ...settings, mcp: { servers: [{ name: 'x', type: 'stdio' as const, command: 'C:\\Temp\\server.exe', args: ['--all'], enabled: true, roles: ['worker' as const] }] } },
      { ...settings, permissions: { ...settings.permissions, safeCommandPrefixes: [...settings.permissions.safeCommandPrefixes, 'powershell'] } },
    ]) {
      expect(await c.invoke('settings.update', { settings: changed })).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    }
    expect(await call<Settings>(c, 'settings.get')).toEqual(settings)
    // A change that starts nothing and widens nothing needs no question.
    const harmless = { ...settings, execution: { ...settings.execution, maxParallelAgents: 2, profile: 'RESTRICTED' as const } }
    expect((await call<Settings>(c, 'settings.update', { settings: harmless })).execution).toMatchObject({ maxParallelAgents: 2, profile: 'RESTRICTED' })
    // Lowering the profile again is a widening.
    expect(await c.invoke('settings.update', { settings })).toMatchObject({ ok: false, error: { code: 'invalid_state' } })

    expect(asked.filter((kind) => kind === 'confirm')).toEqual([])
  }, 120_000)

  it('cannot start a second runtime on the same data while one is running', async () => {
    const dir = dataDir()
    const first = await runtime(dir)
    await expect(startRuntime(dir)).rejects.toThrow(/already running/)
    expect(processAlive(first.child.pid as number)).toBe(true)
    expect(readEndpoint(dir)?.bootId).toBe(first.bootId)
  }, 120_000)
})
