import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allocate, DEFAULT_CONTROL_LIMITS, effectivePriority, serviceOrder, ControlLimitsSchema, type ControlLimits, type GlobalWorkItem, type WorkloadPhase, type WorkloadSnapshot } from '@shared/control-plane'
import { ControlPlane, type WorkloadAdapter } from '@main/modules/control-plane'
import { createRepositories, openDatabase, type Database, type Repositories } from '@main/modules/persistence'

/**
 * What 0.7 added to the scheduler after the first control plane: fairness by aging, the dispatch pause, the
 * record of decisions, and schedules that fire once across restarts of the runtime.
 */

const T0 = Date.parse('2026-10-05T10:00:00.000Z')
let n = 0
const item = (over: Partial<GlobalWorkItem> = {}): GlobalWorkItem => {
  n++
  return { id: `i${n}`, type: 'program', refId: `ref${n}`, title: `Item ${n}`, priority: 'P2', position: n, state: 'QUEUED', requestedAgents: 1, deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false, payload: null, detail: null, createdAt: new Date(T0).toISOString(), updatedAt: '', startedAt: null, finishedAt: null, ...over }
}
const limits = (over: Partial<ControlLimits> = {}): ControlLimits => ({ ...DEFAULT_CONTROL_LIMITS, ...over })
const minutes = (m: number): number => T0 + m * 60_000

describe('fairness: priority with aging', () => {
  it('serves a waiting item one priority higher for every aging period, never above P0, and only while it waits', () => {
    const waiting = item({ priority: 'P3' })
    expect(effectivePriority(waiting, minutes(0), 30)).toBe('P3')
    expect(effectivePriority(waiting, minutes(29), 30)).toBe('P3')
    expect(effectivePriority(waiting, minutes(30), 30)).toBe('P2')
    expect(effectivePriority(waiting, minutes(61), 30)).toBe('P1')
    expect(effectivePriority(waiting, minutes(90), 30)).toBe('P0')
    expect(effectivePriority(waiting, minutes(900), 30)).toBe('P0')
    // Switched off, no clock, or an item that already runs: its own priority.
    expect(effectivePriority(waiting, minutes(900), 0)).toBe('P3')
    expect(effectivePriority(waiting, undefined, 30)).toBe('P3')
    expect(effectivePriority({ ...waiting, state: 'RUNNING', startedAt: new Date(T0).toISOString() }, minutes(900), 30)).toBe('P3')
    expect(effectivePriority({ ...waiting, state: 'PAUSED' }, minutes(900), 30)).toBe('P3')
  })

  it('a higher priority gets the capacity first', () => {
    const low = item({ priority: 'P3' })
    const high = item({ priority: 'P0' })
    const out = allocate({ items: [low, high], active: new Map(), limits: limits({ maxAgents: 1 }), claudeAvailable: true, now: minutes(1) })
    expect(out.admit).toEqual([high.id])
    expect(out.waiting.get(low.id)).toContain('higher-priority work is active')
    expect(out.waiting.get(low.id)).toContain(high.title)
  })

  it('a low priority is not starved by a stream of higher-priority arrivals', () => {
    // One agent. A P3 item arrives first; every ten minutes a fresh P1 item arrives and the running one ends.
    const patient = item({ priority: 'P3', createdAt: new Date(T0).toISOString() })
    let queue: GlobalWorkItem[] = [patient]
    let startedAt: number | null = null
    for (let step = 0; step < 30 && startedAt === null; step++) {
      const now = minutes(step * 10)
      queue = queue.filter((i) => i.state !== 'RUNNING')
      queue.push(item({ priority: 'P1', createdAt: new Date(now).toISOString() }))
      const out = allocate({ items: queue, active: new Map(), limits: limits({ maxAgents: 1, agingMinutes: 30 }), claudeAvailable: true, now })
      expect(out.admit).toHaveLength(1)
      queue = queue.map((i) => (i.id === out.admit[0] ? { ...i, state: 'RUNNING' as const, startedAt: new Date(now).toISOString() } : i))
      if (out.admit[0] === patient.id) startedAt = now
    }
    // It waits behind the urgent work at first, and is served once it has aged past it: bounded, not for ever.
    expect(startedAt).not.toBeNull()
    expect(startedAt as number).toBeGreaterThanOrEqual(minutes(60))
    expect(startedAt as number).toBeLessThanOrEqual(minutes(120))

    // Without aging the same history never serves it.
    const stuck = item({ priority: 'P3', createdAt: new Date(T0).toISOString() })
    let q: GlobalWorkItem[] = [stuck]
    for (let step = 0; step < 30; step++) {
      const now = minutes(step * 10)
      q = q.filter((i) => i.state !== 'RUNNING')
      q.push(item({ priority: 'P1', createdAt: new Date(now).toISOString() }))
      const out = allocate({ items: q, active: new Map(), limits: limits({ maxAgents: 1, agingMinutes: 0 }), claudeAvailable: true, now })
      expect(out.admit[0]).not.toBe(stuck.id)
      q = q.map((i) => (i.id === out.admit[0] ? { ...i, state: 'RUNNING' as const, startedAt: new Date(now).toISOString() } : i))
    }
  })

  it('is deterministic: the same items and the same time give the same order', () => {
    const items = [item({ priority: 'P3' }), item({ priority: 'P1' }), item({ priority: 'P2', deadlineAt: '2026-10-06T00:00:00.000Z' }), item({ priority: 'P2' })]
    const a = serviceOrder(items, minutes(45), 30).map((i) => i.id)
    const b = serviceOrder([...items].reverse(), minutes(45), 30).map((i) => i.id)
    expect(a).toEqual(b)
  })

  it('limits stored before aging existed still parse, with the default', () => {
    const stored = ControlLimitsSchema.parse({ maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'resume' })
    expect(stored).toEqual({ maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'resume', agingMinutes: 30 })
    expect(ControlLimitsSchema.safeParse({ maxAgents: 3, maxActiveItems: 2, resumeOnBoot: 'resume', agingMinutes: -1 }).success).toBe(false)
  })
})

describe('dispatch pause (pure)', () => {
  it('starts nothing and grants nothing more, and leaves what runs alone', () => {
    const running = item({ state: 'RUNNING', requestedAgents: 3, startedAt: new Date(T0).toISOString() })
    const queued = item()
    const out = allocate({ items: [running, queued], active: new Map([[running.id, 1]]), limits: limits(), claudeAvailable: true, paused: true })
    expect(out.admit).toEqual([])
    expect(out.allowance.get(running.id)).toBe(1)
    expect(out.waiting.get(queued.id)).toContain('Dispatch is paused')
  })
})

function fakeWorkloads() {
  const workloads = new Map<string, WorkloadSnapshot & { title: string; agents: number }>()
  const starts: string[] = []
  const adapter: WorkloadAdapter = {
    start: async (i) => {
      const id = i.refId ?? `job-${workloads.size + 1}`
      starts.push(id)
      const w = workloads.get(id) ?? { phase: 'not_started' as WorkloadPhase, activeAgents: 0, runIds: [], detail: null, title: id, agents: 1 }
      workloads.set(id, { ...w, phase: 'working', runIds: [`run-${id}`] })
      return id
    },
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async (id) => {
      const w = workloads.get(id)
      if (w) workloads.set(id, { ...w, phase: 'cancelled', activeAgents: 0 })
    },
    snapshot: (id) => workloads.get(id) ?? { phase: 'missing', activeAgents: 0, runIds: [], detail: 'It no longer exists.' },
    title: ({ refId }) => (refId ? (workloads.get(refId)?.title ?? null) : 'Audit'),
    requestedAgents: ({ refId }) => (refId ? (workloads.get(refId)?.agents ?? 1) : 1),
  }
  return {
    adapter,
    starts,
    add: (id: string, agents = 1): void => void workloads.set(id, { phase: 'not_started', activeAgents: 0, runIds: [], detail: null, title: `Workload ${id}`, agents }),
    set: (id: string, patch: Partial<WorkloadSnapshot>): void => void workloads.set(id, { ...(workloads.get(id) as WorkloadSnapshot & { title: string; agents: number }), ...patch }),
  }
}

describe('control plane service: 0.7 additions', () => {
  let db: Database | null = null
  let repos: Repositories
  let control: ControlPlane | null = null
  const dirs: string[] = []
  afterEach(() => {
    control?.dispose()
    control = null
    if (db?.open) db.close()
    db = null
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  function rig(path = ':memory:', shared?: { fake: ReturnType<typeof fakeWorkloads>; state: { now: number } }) {
    db = openDatabase(path)
    repos = createRepositories(db)
    const fake = shared?.fake ?? fakeWorkloads()
    const state = shared?.state ?? { now: new Date(2026, 9, 5, 21, 0, 0).getTime() }
    control = new ControlPlane({
      items: repos.workItems,
      schedules: repos.controlSchedules,
      incidents: repos.controlIncidents,
      firings: repos.scheduleFirings,
      decisions: repos.schedulerDecisions,
      transaction: repos.transaction,
      settings: repos.settings,
      adapters: { program: fake.adapter, arena: fake.adapter, workspace_mission: fake.adapter, scheduled_audit: fake.adapter, mission: fake.adapter },
      usage: { canDispatch: () => true },
      workers: () => ({ live: 2, busy: 1, max: 7 }),
      now: () => state.now,
      tickIntervalMs: 0,
    })
    return { fake, state, control }
  }

  it('pausing dispatch holds the queue and survives a restart; resuming starts what waited', async () => {
    const { fake, control: c } = rig()
    fake.add('a')
    fake.add('b')
    c.enqueue({ type: 'program', programId: 'a' })
    await c.idle()
    expect(fake.starts).toEqual(['a'])

    expect(c.setDispatchPaused(true)).toBe(true)
    c.enqueue({ type: 'program', programId: 'b' })
    await c.tick()
    expect(fake.starts).toEqual(['a'])
    const paused = c.overview()
    expect(paused.dispatchPaused).toBe(true)
    expect(paused.waiting.find((i) => i.refId === 'b')?.reason).toContain('Dispatch is paused')
    // The running workload was not touched.
    expect(paused.active.map((i) => i.refId)).toEqual(['a'])
    expect(repos.settings.getValue('control-dispatch-paused')).toBe(true)

    c.setDispatchPaused(false)
    await c.tick()
    expect(fake.starts).toEqual(['a', 'b'])
    expect(c.overview().incidents.map((i) => i.summary)).toEqual(expect.arrayContaining(['Dispatch was resumed.', 'Dispatch was paused: nothing new starts until it is resumed.']))
    expect(c.overview().workers).toEqual({ live: 2, busy: 1, max: 7 })
  })

  it('records why an item waited and when it was started, once per change', async () => {
    const { fake, control: c } = rig()
    fake.add('first', 6)
    fake.add('second', 2)
    c.setLimits({ maxAgents: 6, maxActiveItems: 4, resumeOnBoot: 'hold', agingMinutes: 30 })
    const first = c.enqueue({ type: 'program', programId: 'first', priority: 'P0' })
    await c.idle()
    fake.set('first', { activeAgents: 6 })
    const second = c.enqueue({ type: 'program', programId: 'second', priority: 'P2' })
    await c.idle()
    await c.tick()
    await c.tick()
    const waited = repos.schedulerDecisions.ofItem(second.id)
    expect(waited).toHaveLength(1)
    expect(waited[0]).toMatchObject({ decision: 'WAIT' })
    expect(waited[0]?.reason).toContain('higher-priority work is active')
    expect(repos.schedulerDecisions.ofItem(first.id).map((d) => d.decision)).toContain('ADMIT')

    // The first workload ends; the second is started and that is one more record.
    fake.set('first', { phase: 'completed', activeAgents: 0 })
    await c.tick()
    expect(fake.starts).toEqual(['first', 'second'])
    expect(repos.schedulerDecisions.ofItem(second.id).map((d) => d.decision)).toEqual(expect.arrayContaining(['WAIT', 'ADMIT']))
  })

  it('a schedule fires once per occurrence, also when the runtime restarts after the firing was claimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sched-'))
    dirs.push(dir)
    const path = join(dir, 'nexus.db')
    const first = rig(path)
    first.fake.add('nightly')
    const schedule = first.control.createSchedule({ name: 'Nightly', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'nightly' }, priority: 'P2', enabled: true })
    const occurrence = schedule.nextRunAt as string
    first.state.now = new Date(2026, 9, 5, 22, 0, 30).getTime()
    await first.control.tick()
    expect(first.fake.starts).toEqual(['nightly'])
    expect(repos.scheduleFirings.count(schedule.id)).toBe(1)
    expect(repos.scheduleFirings.list(schedule.id)[0]).toMatchObject({ occurrence, result: 'Queued "Workload nightly".' })
    // More passes at the same time fire nothing more.
    await first.control.tick()
    await first.control.tick()
    expect(repos.scheduleFirings.count(schedule.id)).toBe(1)

    // The runtime dies. What a crash between "queued" and "next time stored" would leave is simulated by
    // putting the schedule back to the occurrence it already fired.
    repos.controlSchedules.update(schedule.id, { nextRunAt: occurrence })
    first.fake.set('nightly', { phase: 'completed' })
    first.control.dispose()
    db?.close()

    const second = rig(path, { fake: first.fake, state: first.state })
    await second.control.recoverOnBoot()
    await second.control.tick()
    // The occurrence is not fired again: one firing, one start, and the schedule moved on to tomorrow.
    expect(repos.scheduleFirings.count(schedule.id)).toBe(1)
    expect(second.fake.starts).toEqual(['nightly'])
    expect(repos.workItems.listOpen().filter((i) => i.scheduleId === schedule.id)).toEqual([])
    expect(repos.controlSchedules.get(schedule.id)?.nextRunAt).toBe(new Date(2026, 9, 6, 22, 0, 0).toISOString())

    // Tomorrow is a new occurrence and fires.
    second.fake.add('nightly')
    second.state.now = new Date(2026, 9, 6, 22, 0, 5).getTime()
    await second.control.tick()
    expect(repos.scheduleFirings.count(schedule.id)).toBe(2)
    expect(second.fake.starts).toEqual(['nightly', 'nightly'])
  })

  it('a schedule that was due while no runtime ran fires once when one starts, with no window anywhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sched-'))
    dirs.push(dir)
    const path = join(dir, 'nexus.db')
    const first = rig(path)
    first.fake.add('audit')
    const schedule = first.control.createSchedule({ name: 'Audit', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'audit' }, priority: 'P3', enabled: true })
    first.control.dispose()
    db?.close()

    // Three days pass with nothing running.
    first.state.now = new Date(2026, 9, 8, 9, 0, 0).getTime()
    const second = rig(path, { fake: first.fake, state: first.state })
    await second.control.recoverOnBoot()
    await second.control.tick()
    expect(repos.scheduleFirings.count(schedule.id)).toBe(1)
    expect(second.fake.starts).toEqual(['audit'])
    expect(repos.controlSchedules.get(schedule.id)?.nextRunAt).toBe(new Date(2026, 9, 8, 22, 0, 0).toISOString())
  })

  it('reports the schedules as a health component, and says when one is overdue', async () => {
    const { control: c, fake, state } = rig()
    const component = (): { level: string; detail: string } => c.health().components.find((x) => x.component === 'schedules') as { level: string; detail: string }
    expect(component()).toMatchObject({ level: 'HEALTHY', detail: 'No schedule is switched on.' })
    fake.add('p')
    const schedule = c.createSchedule({ name: 'S', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'p' }, priority: 'P2', enabled: true })
    expect(component().level).toBe('HEALTHY')
    expect(component().detail).toContain('with or without a window')
    // Past its time and no pass fired it (the scheduler is not running in this test).
    state.now = Date.parse(schedule.nextRunAt as string) + 10 * 60_000
    expect(component().level).toBe('DEGRADED')
    await c.tick()
    expect(component().level).toBe('HEALTHY')
    expect(c.health().components.map((x) => x.component)).toEqual(['database', 'scheduler', 'workers', 'providers', 'git', 'usage', 'power_supervisor', 'ipc', 'schedules'])
  })
})
