import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allocate,
  compareWorkItems,
  DEFAULT_CONTROL_LIMITS,
  describeRule,
  mayNotify,
  nextOccurrence,
  NOTIFICATION_BURST,
  overallHealth,
  scheduleDue,
  stateFromPhase,
  type ComponentHealth,
  type ControlLimits,
  type GlobalWorkItem,
  type NotificationKind,
  type Priority,
  type WorkItemState,
  type WorkloadPhase,
  type WorkloadSnapshot,
} from '@shared/control-plane'
import { ipcInputs } from '@shared/ipc'
import { ControlPlane, type WorkloadAdapter } from '@main/modules/control-plane'
import { createRepositories, MIGRATIONS, openDatabase, runMigrations, type Database, type Repositories } from '@main/modules/persistence'

let n = 0
const item = (over: Partial<GlobalWorkItem> = {}): GlobalWorkItem => {
  n++
  return { id: `i${n}`, type: 'program', refId: `ref${n}`, title: `Item ${n}`, priority: 'P2', position: n, state: 'QUEUED', requestedAgents: 2, deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false, payload: null, detail: null, createdAt: `2026-10-05T00:00:${String(n % 60).padStart(2, '0')}.000Z`, updatedAt: '', startedAt: null, finishedAt: null, ...over }
}
const limits = (over: Partial<ControlLimits> = {}): ControlLimits => ({ ...DEFAULT_CONTROL_LIMITS, ...over })

describe('control plane model (pure)', () => {
  it('orders the queue by priority, then deadline, then the persisted position', () => {
    const a = item({ priority: 'P2', position: 1 })
    const b = item({ priority: 'P0', position: 9 })
    const c = item({ priority: 'P2', position: 0 })
    const d = item({ priority: 'P2', position: 5, deadlineAt: '2026-10-05T06:00:00.000Z' })
    expect([a, b, c, d].sort(compareWorkItems).map((i) => i.id)).toEqual([b.id, d.id, c.id, a.id])
  })

  it('divides capacity as in the example: 6 agents, three workloads, the rest queued', () => {
    const program = item({ state: 'RUNNING', requestedAgents: 3, priority: 'P1' })
    const migration = item({ state: 'RUNNING', requestedAgents: 2, priority: 'P1' })
    const arena = item({ state: 'RUNNING', requestedAgents: 3, priority: 'P2' })
    const other = item({ state: 'QUEUED', requestedAgents: 2, priority: 'P3' })
    const out = allocate({ items: [program, migration, arena, other], active: new Map(), limits: limits({ maxAgents: 6 }), claudeAvailable: true })
    expect([out.allowance.get(program.id), out.allowance.get(migration.id), out.allowance.get(arena.id)]).toEqual([3, 2, 1])
    expect(out.admit).toEqual([])
    expect(out.waiting.get(other.id)).toContain('agent capacity')
    expect(out.free).toBe(0)
  })

  it('never takes a running session away, and gives free capacity to the higher priority first', () => {
    const low = item({ state: 'RUNNING', requestedAgents: 4, priority: 'P3' })
    const urgent = item({ state: 'QUEUED', requestedAgents: 3, priority: 'P0' })
    // The low-priority workload already runs 3 of 4 agents; one slot is free.
    const out = allocate({ items: [low, urgent], active: new Map([[low.id, 3]]), limits: limits({ maxAgents: 4 }), claudeAvailable: true })
    expect(out.allowance.get(low.id)).toBe(3)
    expect(out.admit).toEqual([urgent.id])
    expect(out.allowance.get(urgent.id)).toBe(1)
    // As the low-priority sessions end, what they free goes to the urgent item, not back to the low one.
    const later = allocate({ items: [low, { ...urgent, state: 'RUNNING' }], active: new Map([[low.id, 1], [urgent.id, 1]]), limits: limits({ maxAgents: 4 }), claudeAvailable: true })
    expect(later.allowance.get(urgent.id)).toBe(3)
    expect(later.allowance.get(low.id)).toBe(1)
  })

  it('starts nothing and grants nothing while Claude is unavailable, and holds what the user held', () => {
    const running = item({ state: 'RUNNING', requestedAgents: 3 })
    const waiting = item({ state: 'QUOTA_WAIT', requestedAgents: 3 })
    const queued = item()
    const held = item({ heldByUser: true })
    const out = allocate({ items: [running, waiting, queued, held], active: new Map([[running.id, 1]]), limits: limits(), claudeAvailable: false })
    expect(out.admit).toEqual([])
    expect(out.allowance.get(running.id)).toBe(1)
    expect(out.allowance.get(waiting.id)).toBe(0)
    expect(out.waiting.get(queued.id)).toContain('usage limit')
    expect(out.waiting.has(held.id)).toBe(false)
    const back = allocate({ items: [running, queued, held], active: new Map([[running.id, 1]]), limits: limits(), claudeAvailable: true })
    expect(back.admit).toEqual([queued.id])
    expect(back.allowance.has(held.id)).toBe(false)
  })

  it('respects the number of workloads at once', () => {
    const items = [item({ state: 'RUNNING', requestedAgents: 1 }), item({ requestedAgents: 1 }), item({ requestedAgents: 1 })]
    const out = allocate({ items, active: new Map(), limits: limits({ maxAgents: 10, maxActiveItems: 2 }), claudeAvailable: true })
    expect(out.admit).toEqual([items[1]!.id])
    expect(out.waiting.get(items[2]!.id)).toContain('workload slot')
  })

  it('holds its invariants over 10000 seeded queues', () => {
    let seed = 20261005
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
    const states: WorkItemState[] = ['QUEUED', 'READY', 'RUNNING', 'PAUSED', 'QUOTA_WAIT', 'BLOCKED', 'SCHEDULED', 'COMPLETED']
    for (let round = 0; round < 10_000; round++) {
      const items = Array.from({ length: 1 + Math.floor(rnd() * 9) }, () => item({ state: pick(states), priority: pick(['P0', 'P1', 'P2', 'P3'] as Priority[]), requestedAgents: 1 + Math.floor(rnd() * 5), heldByUser: rnd() < 0.15, position: Math.floor(rnd() * 20) }))
      const active = new Map(items.map((i) => [i.id, i.state === 'RUNNING' ? Math.floor(rnd() * (i.requestedAgents + 2)) : 0]))
      const l = limits({ maxAgents: 1 + Math.floor(rnd() * 8), maxActiveItems: 1 + Math.floor(rnd() * 5) })
      const claudeAvailable = rnd() < 0.8
      const out = allocate({ items, active, limits: l, claudeAvailable })
      const activeTotal = [...active.values()].reduce((a, b) => a + b, 0)
      const granted = [...out.allowance.values()].reduce((a, b) => a + b, 0)
      const context = `round ${round}`
      // Capacity is never exceeded by a grant: what is granted beyond the running sessions fits in what was free.
      expect(granted - activeTotal, context).toBeLessThanOrEqual(Math.max(0, l.maxAgents - activeTotal))
      expect(out.free, context).toBeGreaterThanOrEqual(0)
      for (const i of items) {
        const a = out.allowance.get(i.id)
        // A running workload never loses a session it holds.
        if (i.state === 'RUNNING') expect(a, context).toBeGreaterThanOrEqual(active.get(i.id) ?? 0)
        // Nothing terminal, paused, blocked or scheduled is granted or admitted.
        if (['PAUSED', 'BLOCKED', 'SCHEDULED', 'COMPLETED'].includes(i.state)) expect(a, context).toBeUndefined()
        if (i.heldByUser) expect(out.admit, context).not.toContain(i.id)
      }
      if (!claudeAvailable) expect(out.admit, context).toEqual([])
      const live = items.filter((i) => i.state === 'RUNNING' || i.state === 'QUOTA_WAIT').length
      expect(out.admit.length, context).toBeLessThanOrEqual(Math.max(0, l.maxActiveItems - live))
      for (const id of out.admit) expect(out.allowance.get(id), context).toBeGreaterThanOrEqual(1)
      // Priority: an admitted item is never of lower priority than a startable item left waiting for capacity.
      const startable = items.filter((i) => (i.state === 'QUEUED' || i.state === 'READY') && !i.heldByUser).sort(compareWorkItems)
      const firstWaiting = startable.findIndex((i) => !out.admit.includes(i.id))
      if (firstWaiting >= 0) for (const later of startable.slice(firstWaiting + 1)) expect(out.admit, context).not.toContain(later.id)
      // Deterministic.
      expect(allocate({ items: [...items].reverse(), active, limits: l, claudeAvailable }).admit, context).toEqual(out.admit)
    }
  })

  it('maps what a workload reports to the item state', () => {
    const cases: [WorkloadPhase, WorkItemState][] = [['working', 'RUNNING'], ['quota_wait', 'QUOTA_WAIT'], ['paused', 'PAUSED'], ['blocked', 'BLOCKED'], ['completed', 'COMPLETED'], ['failed', 'FAILED'], ['missing', 'FAILED'], ['cancelled', 'CANCELLED']]
    for (const [phase, state] of cases) expect(stateFromPhase(phase, 'RUNNING', false), phase).toBe(state)
    expect(stateFromPhase('not_started', 'QUEUED', false)).toBe('QUEUED')
    expect(stateFromPhase('not_started', 'SCHEDULED', false)).toBe('SCHEDULED')
    expect(stateFromPhase('not_started', 'QUEUED', true)).toBe('PAUSED')
  })

  it('computes the next time of a schedule in local time', () => {
    const at = new Date(2026, 9, 5, 21, 30, 0) // Monday 5 October 2026, 21:30 local
    expect(nextOccurrence({ kind: 'daily', time: '22:00' }, at)).toEqual(new Date(2026, 9, 5, 22, 0, 0))
    expect(nextOccurrence({ kind: 'daily', time: '02:00' }, at)).toEqual(new Date(2026, 9, 6, 2, 0, 0))
    expect(nextOccurrence({ kind: 'daily', time: '21:30' }, at)).toEqual(new Date(2026, 9, 6, 21, 30, 0))
    expect(nextOccurrence({ kind: 'weekly', day: 'sunday', time: '03:00' }, at)).toEqual(new Date(2026, 9, 11, 3, 0, 0))
    expect(nextOccurrence({ kind: 'weekly', day: 'monday', time: '22:00' }, at)).toEqual(new Date(2026, 9, 5, 22, 0, 0))
    expect(nextOccurrence({ kind: 'weekly', day: 'monday', time: '09:00' }, at)).toEqual(new Date(2026, 9, 12, 9, 0, 0))
    const once = new Date(2026, 9, 6, 8, 0, 0).toISOString()
    expect(nextOccurrence({ kind: 'once', at: once }, at)?.toISOString()).toBe(once)
    expect(nextOccurrence({ kind: 'once', at: new Date(2026, 9, 1).toISOString() }, at)).toBeNull()
    expect(describeRule({ kind: 'weekly', day: 'sunday', time: '03:00' })).toBe('Every Sunday at 03:00')
  })

  it('a schedule missed while NEXUS was not running fires once, then waits for its next time', () => {
    const rule = { kind: 'daily' as const, time: '22:00' }
    const threeDaysLate = new Date(2026, 9, 8, 9, 0, 0)
    const due = scheduleDue({ enabled: true, nextRunAt: new Date(2026, 9, 5, 22, 0, 0).toISOString(), rule }, threeDaysLate)
    expect(due).toEqual({ due: true, nextRunAt: new Date(2026, 9, 8, 22, 0, 0).toISOString() })
    expect(scheduleDue({ enabled: true, nextRunAt: due.nextRunAt, rule }, threeDaysLate).due).toBe(false)
    expect(scheduleDue({ enabled: false, nextRunAt: new Date(2026, 9, 5).toISOString(), rule }, threeDaysLate).due).toBe(false)
    expect(scheduleDue({ enabled: true, nextRunAt: null, rule }, threeDaysLate).due).toBe(false)
  })

  it('health is the worst component; notifications are restrained', () => {
    const c = (level: ComponentHealth['level']): ComponentHealth => ({ component: 'database', level, detail: '', checkedAt: '' })
    expect(overallHealth([])).toBe('HEALTHY')
    expect(overallHealth([c('HEALTHY'), c('RECOVERING')])).toBe('RECOVERING')
    expect(overallHealth([c('RECOVERING'), c('DEGRADED')])).toBe('DEGRADED')
    expect(overallHealth([c('DEGRADED'), c('BLOCKED'), c('HEALTHY')])).toBe('BLOCKED')
    const t = 1_000_000
    const shown = [{ kind: 'program_blocked' as NotificationKind, subject: 'p1', at: t }]
    expect(mayNotify({ kind: 'program_blocked', subject: 'p1', at: t + 60_000 }, shown)).toBe(false)
    expect(mayNotify({ kind: 'program_blocked', subject: 'p2', at: t + 60_000 }, shown)).toBe(true)
    expect(mayNotify({ kind: 'program_blocked', subject: 'p1', at: t + 11 * 60_000 }, shown)).toBe(true)
    const burst = Array.from({ length: NOTIFICATION_BURST }, (_, i) => ({ kind: 'work_item_failed' as NotificationKind, subject: `s${i}`, at: t + i }))
    expect(mayNotify({ kind: 'milestone_completed', subject: 'm', at: t + 1000 }, burst)).toBe(false)
    expect(mayNotify({ kind: 'milestone_completed', subject: 'm', at: t + 16 * 60_000 }, burst)).toBe(true)
  })
})

/** A scripted workload engine: every workload is a record the test moves through its phases. */
function fakeWorkloads() {
  const workloads = new Map<string, WorkloadSnapshot & { title: string; agents: number }>()
  const calls: string[] = []
  let failStart: string | null = null
  const adapter: WorkloadAdapter = {
    start: async (i) => {
      const id = i.refId ?? `job-${workloads.size + 1}`
      calls.push(`start:${id}`)
      if (failStart) throw new Error(failStart)
      const w = workloads.get(id) ?? { phase: 'not_started' as WorkloadPhase, activeAgents: 0, runIds: [], detail: null, title: id, agents: 1 }
      workloads.set(id, { ...w, phase: 'working', runIds: [`run-${id}`] })
      return id
    },
    pause: async (id) => {
      calls.push(`pause:${id}`)
      const w = workloads.get(id)
      if (w) workloads.set(id, { ...w, phase: 'paused', activeAgents: 0 })
    },
    resume: async (id) => {
      calls.push(`resume:${id}`)
      const w = workloads.get(id)
      if (w) workloads.set(id, { ...w, phase: 'working' })
    },
    cancel: async (id) => {
      calls.push(`cancel:${id}`)
      const w = workloads.get(id)
      if (w) workloads.set(id, { ...w, phase: 'cancelled', activeAgents: 0 })
    },
    snapshot: (id) => workloads.get(id) ?? { phase: 'missing', activeAgents: 0, runIds: [], detail: 'It no longer exists.' },
    title: ({ refId }) => (refId ? (workloads.get(refId)?.title ?? null) : 'Audit'),
    requestedAgents: ({ refId }) => (refId ? (workloads.get(refId)?.agents ?? 1) : 1),
  }
  return {
    adapter,
    calls,
    workloads,
    add: (id: string, agents = 2): void => void workloads.set(id, { phase: 'not_started', activeAgents: 0, runIds: [], detail: null, title: `Workload ${id}`, agents }),
    set: (id: string, patch: Partial<WorkloadSnapshot>): void => void workloads.set(id, { ...workloads.get(id)!, ...patch }),
    failStarts: (message: string | null): void => void (failStart = message),
  }
}

describe('control plane service', () => {
  let db: Database
  let repos: Repositories
  let control: ControlPlane
  afterEach(() => {
    control?.dispose()
    db?.close()
  })

  function rig(options: { path?: string } = {}) {
    db = openDatabase(options.path ?? ':memory:')
    repos = createRepositories(db)
    const fake = fakeWorkloads()
    const state = { now: new Date(2026, 9, 5, 21, 0, 0).getTime(), claude: true, unowned: [] as { id: string; title: string; requestedAgents: number }[] }
    const notes: { kind: NotificationKind; title: string }[] = []
    let allocationChanges = 0
    const build = (): ControlPlane =>
      new ControlPlane({
        items: repos.workItems,
        schedules: repos.controlSchedules,
        incidents: repos.controlIncidents,
        settings: repos.settings,
        adapters: { program: fake.adapter, arena: fake.adapter, workspace_mission: fake.adapter, scheduled_audit: fake.adapter, mission: fake.adapter },
        usage: { canDispatch: () => state.claude },
        unownedActiveRuns: () => state.unowned,
        notify: (kind, title) => void notes.push({ kind, title }),
        onAllocationChange: () => void allocationChanges++,
        now: () => state.now,
        tickIntervalMs: 0,
      })
    control = build()
    return { fake, state, notes, build, changes: () => allocationChanges }
  }

  const states = (): Record<string, WorkItemState> => Object.fromEntries([...repos.workItems.listOpen(), ...repos.workItems.listFinished(50)].map((i) => [i.refId ?? i.id, i.state]))

  it('runs two kinds of workload at once within the global capacity, and queues the rest', async () => {
    const r = rig()
    control.setLimits({ maxAgents: 4, maxActiveItems: 2, resumeOnBoot: 'hold' })
    r.fake.add('program-1', 3)
    r.fake.add('campaign-1', 2)
    r.fake.add('mission-1', 2)
    control.enqueue({ type: 'program', programId: 'program-1', priority: 'P1' })
    control.enqueue({ type: 'arena', campaignId: 'campaign-1', priority: 'P2' })
    control.enqueue({ type: 'workspace_mission', missionId: 'mission-1', priority: 'P2' })
    await control.idle()
    await control.tick()
    expect(states()).toEqual({ 'program-1': 'RUNNING', 'campaign-1': 'RUNNING', 'mission-1': 'QUEUED' })
    expect(r.fake.calls).toEqual(['start:program-1', 'start:campaign-1'])
    // The program holds 3 sessions; the campaign gets the one that is left.
    r.fake.set('program-1', { activeAgents: 3 })
    await control.tick()
    expect(control.allowanceForRun('run-program-1', 4, 3)).toBe(3)
    expect(control.allowanceForRun('run-campaign-1', 2, 0)).toBe(1)
    // A run no item owns keeps its own limit.
    expect(control.allowanceForRun('run-unknown', 2, 0)).toBe(2)
    const overview = control.overview()
    expect(overview.agents).toEqual({ active: 3, max: 4 })
    expect(overview.active.map((i) => [i.refId, i.activeAgents, i.allowance])).toEqual([['program-1', 3, 3], ['campaign-1', 0, 1]])
    expect(overview.waiting.map((i) => [i.refId, i.reason])).toEqual([['mission-1', 'Waiting for a workload slot (2 run at once).']])
    // The program ends: the queued mission starts in the next pass.
    r.fake.set('program-1', { phase: 'completed', activeAgents: 0 })
    await control.tick()
    expect(states()).toEqual({ 'program-1': 'COMPLETED', 'campaign-1': 'RUNNING', 'mission-1': 'RUNNING' })
    expect(r.changes()).toBeGreaterThan(0)
  })

  it('a higher priority gets dispatch capacity first, without stopping what runs', async () => {
    const r = rig()
    control.setLimits({ maxAgents: 3, maxActiveItems: 4, resumeOnBoot: 'hold' })
    r.fake.add('feature', 3)
    r.fake.add('bugfix', 2)
    control.enqueue({ type: 'program', programId: 'feature', priority: 'P2' })
    await control.idle()
    r.fake.set('feature', { activeAgents: 2 })
    await control.tick()
    expect(control.allowanceForRun('run-feature', 3, 2)).toBe(3)
    // A production bug arrives as P0: it starts, and the free session is its, not the feature's.
    control.enqueue({ type: 'program', programId: 'bugfix', priority: 'P0' })
    await control.idle()
    await control.tick()
    expect(states()).toMatchObject({ feature: 'RUNNING', bugfix: 'RUNNING' })
    expect(r.fake.calls).not.toContain('pause:feature')
    expect(control.allowanceForRun('run-bugfix', 2, 0)).toBe(1)
    expect(control.allowanceForRun('run-feature', 3, 2)).toBe(2)
    // When a session of the feature ends, the capacity goes to the bug fix.
    r.fake.set('feature', { activeAgents: 1 })
    r.fake.set('bugfix', { activeAgents: 1 })
    await control.tick()
    expect(control.allowanceForRun('run-bugfix', 2, 1)).toBe(2)
    expect(control.allowanceForRun('run-feature', 3, 1)).toBe(1)
    // The user reprioritizes: with equal priority the older item is first again.
    const bug = repos.workItems.findOpenByRef('program', 'bugfix')!
    control.setPriority(bug.id, 'P2')
    await control.idle()
    r.fake.set('bugfix', { activeAgents: 0 })
    await control.tick()
    expect(control.allowanceForRun('run-feature', 3, 1)).toBe(3)
  })

  it('a Claude usage limit moves work to quota wait and starts nothing; the reset resumes it', async () => {
    const r = rig()
    r.fake.add('p1')
    r.fake.add('p2')
    control.enqueue({ type: 'program', programId: 'p1' })
    await control.idle()
    r.state.claude = false
    r.fake.set('p1', { phase: 'quota_wait', activeAgents: 0 })
    control.enqueue({ type: 'program', programId: 'p2' })
    await control.idle()
    await control.tick()
    expect(states()).toEqual({ p1: 'QUOTA_WAIT', p2: 'QUEUED' })
    expect(control.overview()).toMatchObject({ claudeAvailable: false })
    expect(control.overview().waiting[0]?.reason).toContain('usage limit')
    expect(control.health().components.find((c) => c.component === 'scheduler')?.level).toBe('HEALTHY')
    expect(r.notes.map((x) => x.kind)).toEqual(['quota_paused'])
    r.state.claude = true
    r.fake.set('p1', { phase: 'working' })
    await control.tick()
    expect(states()).toEqual({ p1: 'RUNNING', p2: 'RUNNING' })
    expect(r.notes.map((x) => x.kind)).toEqual(['quota_paused', 'quota_resumed'])
  })

  it('the user holds, releases, reorders and cancels items; the order is persisted', async () => {
    const r = rig()
    control.setLimits({ maxAgents: 2, maxActiveItems: 1, resumeOnBoot: 'hold' })
    for (const id of ['a', 'b', 'c', 'd']) r.fake.add(id, 1)
    const a = control.enqueue({ type: 'program', programId: 'a' })
    await control.idle()
    const [b, c, d] = ['b', 'c', 'd'].map((id) => control.enqueue({ type: 'program', programId: id }))
    await control.idle()
    expect(control.overview().waiting.map((i) => i.refId)).toEqual(['b', 'c', 'd'])
    control.move(d!.id, 'top')
    control.move(b!.id, 'down')
    await control.idle()
    expect(control.overview().waiting.map((i) => i.refId)).toEqual(['d', 'c', 'b'])
    expect(repos.workItems.listOpen().map((i) => i.refId)).toEqual(['d', 'a', 'c', 'b'])
    // Held by the user: skipped by the scheduler, paused if it runs.
    await control.pause(d!.id)
    await control.pause(a.id)
    expect(r.fake.calls).toContain('pause:a')
    expect(states()).toMatchObject({ a: 'PAUSED', d: 'PAUSED', c: 'RUNNING' })
    expect(control.overview().waiting.find((i) => i.refId === 'd')?.reason).toBe('Held by you.')
    await control.resume(a.id)
    expect(r.fake.calls).toContain('resume:a')
    // Taking a queued item off the queue does not cancel the workload itself.
    await control.cancel(b!.id)
    expect(r.fake.calls).not.toContain('cancel:b')
    expect(repos.workItems.get(b!.id)).toMatchObject({ state: 'CANCELLED', detail: 'Taken off the queue before it started.' })
    await control.cancel(c!.id)
    expect(r.fake.calls).toContain('cancel:c')
    expect(() => control.setPriority(c!.id, 'P0')).toThrow(/CANCELLED/)
    // Nothing is queued twice, and a finished or missing workload is refused.
    expect(() => control.enqueue({ type: 'program', programId: 'a' })).toThrow(/already on the queue/)
    expect(() => control.enqueue({ type: 'program', programId: 'ghost' })).toThrow(/does not exist/)
    expect(() => control.enqueue({ type: 'program', programId: 'x', command: 'calc' })).toThrow(/Invalid work item/)
  })

  it('a workload that fails or cannot start is recorded once, with an incident and one notification', async () => {
    const r = rig()
    r.fake.add('p1')
    r.fake.add('p2')
    control.enqueue({ type: 'program', programId: 'p1' })
    await control.idle()
    r.fake.set('p1', { phase: 'failed', detail: 'The planner returned no plan.' })
    await control.tick()
    await control.tick()
    r.fake.failStarts('The engine refused.')
    control.enqueue({ type: 'program', programId: 'p2' })
    await control.idle()
    await control.tick()
    expect(states()).toEqual({ p1: 'FAILED', p2: 'FAILED' })
    // Not retried on every pass.
    expect(r.fake.calls.filter((x) => x === 'start:p2')).toHaveLength(1)
    const incidents = control.overview().incidents.map((i) => i.summary)
    expect(incidents).toHaveLength(2)
    expect(incidents.join(' ')).toContain('The planner returned no plan.')
    expect(incidents.join(' ')).toContain('could not be started: The engine refused.')
    expect(r.notes.filter((x) => x.kind === 'work_item_failed')).toHaveLength(1)
  })

  it('a mission the user started directly is adopted, so everything that uses agents is in one queue', async () => {
    const r = rig()
    control.setLimits({ maxAgents: 2, maxActiveItems: 4, resumeOnBoot: 'hold' })
    r.fake.workloads.set('run-9', { phase: 'working', activeAgents: 2, runIds: ['run-9'], detail: null, title: 'Fix the login bug', agents: 2 })
    r.state.unowned = [{ id: 'run-9', title: 'Fix the login bug', requestedAgents: 2 }]
    r.fake.add('p1')
    control.enqueue({ type: 'program', programId: 'p1' })
    await control.idle()
    await control.tick()
    expect(repos.workItems.findOpenByRef('mission', 'run-9')).toMatchObject({ state: 'RUNNING', title: 'Fix the login bug' })
    // The mission uses the whole capacity: the program waits for it.
    expect(states()).toMatchObject({ 'run-9': 'RUNNING', p1: 'QUEUED' })
    await control.tick()
    expect(repos.workItems.listOpen().filter((i) => i.refId === 'run-9')).toHaveLength(1)
  })

  it('durable schedules: fire at their time, queue their work once, survive a restart, and say why when they cannot', async () => {
    const r = rig()
    r.fake.add('nightly')
    const schedule = control.createSchedule({ name: 'Continue the program', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'nightly' }, priority: 'P1', enabled: true })
    expect(schedule.nextRunAt).toBe(new Date(2026, 9, 5, 22, 0, 0).toISOString())
    await control.tick()
    expect(repos.workItems.listOpen()).toEqual([])
    // NEXUS is restarted before the time: the schedule is still there.
    control.dispose()
    control = r.build()
    r.state.now = new Date(2026, 9, 5, 22, 0, 30).getTime()
    await control.tick()
    await control.idle()
    const queued = repos.workItems.findOpenByRef('program', 'nightly')
    expect(queued).toMatchObject({ scheduleId: schedule.id, priority: 'P1' })
    expect(repos.controlSchedules.get(schedule.id)).toMatchObject({ nextRunAt: new Date(2026, 9, 6, 22, 0, 0).toISOString(), lastResult: 'Queued "Workload nightly".' })
    expect(r.notes.map((x) => x.kind)).toContain('schedule_started')
    // The next night the program is still on the queue: nothing is queued twice, and the schedule says so.
    r.state.now = new Date(2026, 9, 6, 22, 0, 30).getTime()
    await control.tick()
    expect(repos.workItems.listOpen().filter((i) => i.refId === 'nightly')).toHaveLength(1)
    expect(repos.controlSchedules.get(schedule.id)?.lastResult).toContain('already on the queue')
    expect(repos.controlSchedules.get(schedule.id)?.nextRunAt).toBe(new Date(2026, 9, 7, 22, 0, 0).toISOString())
    // A one-time schedule fires once and switches itself off; a disabled one never fires.
    r.fake.add('once')
    const once = control.createSchedule({ name: 'Once', rule: { kind: 'once', at: new Date(2026, 9, 6, 23, 0, 0).toISOString() }, action: { type: 'arena', campaignId: 'once' }, priority: 'P3', enabled: true })
    control.setScheduleEnabled(schedule.id, false)
    r.state.now = new Date(2026, 9, 8, 9, 0, 0).getTime()
    await control.tick()
    expect(repos.controlSchedules.get(once.id)).toMatchObject({ enabled: false, nextRunAt: null })
    expect(repos.workItems.findOpenByRef('arena', 'once')).not.toBeNull()
    expect(repos.controlSchedules.get(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null })
    expect(() => control.createSchedule({ name: 'Past', rule: { kind: 'once', at: new Date(2026, 9, 1).toISOString() }, action: { type: 'arena', campaignId: 'once' }, priority: 'P3', enabled: true })).toThrow(/in the past/)
    expect(() => control.createSchedule({ name: 'Bad', rule: { kind: 'daily', time: '25:00' }, action: { type: 'arena', campaignId: 'once' }, priority: 'P3', enabled: true })).toThrow(/Invalid schedule/)
    control.removeSchedule(once.id)
    expect(control.overview().schedules.map((s) => s.id)).toEqual([schedule.id])
  })

  it('a restart restores the queue, its order and its states, and reads every item against its workload', async () => {
    const r = rig()
    control.setLimits({ maxAgents: 2, maxActiveItems: 1, resumeOnBoot: 'hold' })
    for (const id of ['a', 'b', 'c']) r.fake.add(id, 2)
    control.enqueue({ type: 'program', programId: 'a', priority: 'P1' })
    await control.idle()
    const b = control.enqueue({ type: 'program', programId: 'b', priority: 'P3' })
    const c = control.enqueue({ type: 'program', programId: 'c', priority: 'P3' })
    await control.idle()
    control.move(c.id, 'top')
    await control.pause(b.id)
    const before = control.overview()
    // NEXUS stops. While it is down the running workload ends and another disappears.
    control.dispose()
    r.fake.set('a', { phase: 'completed', activeAgents: 0 })
    r.fake.workloads.delete('b')
    control = r.build()
    expect(control.limits()).toEqual({ maxAgents: 2, maxActiveItems: 1, resumeOnBoot: 'hold' })
    expect(repos.workItems.listOpen().map((i) => [i.refId, i.state, i.priority, i.heldByUser])).toEqual(before.active.concat(before.waiting as never).sort(compareWorkItems).sort((x, y) => x.position - y.position).map((i) => [i.refId, i.state, i.priority, i.heldByUser]))
    const resumed: string[] = []
    await control.recoverOnBoot(async (runId) => void resumed.push(runId))
    expect(states()).toEqual({ a: 'COMPLETED', b: 'FAILED', c: 'RUNNING' })
    expect(resumed).toEqual([])
    expect(control.overview().incidents.map((i) => i.summary).join(' ')).toContain('NEXUS started; 3 open work items read from the queue.')
  })

  it('after a restart a paused mission is resumed only when the limits say so, never one the user held', async () => {
    const r = rig()
    r.fake.workloads.set('run-1', { phase: 'paused', activeAgents: 0, runIds: ['run-1'], detail: 'Paused (recovery).', title: 'Mission one', agents: 1 })
    r.fake.workloads.set('run-2', { phase: 'paused', activeAgents: 0, runIds: ['run-2'], detail: 'Paused (recovery).', title: 'Mission two', agents: 1 })
    const at = new Date(r.state.now).toISOString()
    const base = { type: 'mission' as const, priority: 'P2' as const, requestedAgents: 1, deadlineAt: null, notBefore: null, scheduleId: null, payload: null, detail: null, createdAt: at, updatedAt: at, startedAt: at, finishedAt: null }
    repos.workItems.insert({ ...base, id: 'm1', refId: 'run-1', title: 'Mission one', position: 1, state: 'RUNNING', heldByUser: false })
    repos.workItems.insert({ ...base, id: 'm2', refId: 'run-2', title: 'Mission two', position: 2, state: 'RUNNING', heldByUser: true })
    const resumed: string[] = []
    await control.recoverOnBoot(async (runId) => void resumed.push(runId))
    expect(resumed).toEqual([])
    expect(states()).toEqual({ 'run-1': 'PAUSED', 'run-2': 'PAUSED' })
    control.setLimits({ ...DEFAULT_CONTROL_LIMITS, resumeOnBoot: 'resume' })
    await control.idle()
    await control.recoverOnBoot(async (runId) => void resumed.push(runId))
    expect(resumed).toEqual(['run-1'])
  })

  it('reports health per component and degrades when a check or a pass fails', async () => {
    db = openDatabase(':memory:')
    repos = createRepositories(db)
    let broken = false
    control = new ControlPlane({
      items: repos.workItems,
      schedules: repos.controlSchedules,
      incidents: repos.controlIncidents,
      settings: repos.settings,
      adapters: {},
      usage: { canDispatch: () => true },
      unownedActiveRuns: () => {
        if (broken) throw new Error('the run list could not be read')
        return []
      },
      health: {
        database: () => ({ level: 'HEALTHY', detail: 'ok' }),
        providers: () => ({ level: 'BLOCKED', detail: 'Claude needs authentication.' }),
        git: () => {
          throw new Error('git is missing')
        },
      },
      tickIntervalMs: 0,
    })
    expect(control.health().components.find((c) => c.component === 'scheduler')).toMatchObject({ level: 'RECOVERING' })
    await control.tick()
    const health = control.health()
    expect(health.level).toBe('BLOCKED')
    expect(health.components.map((c) => c.component)).toEqual(['database', 'scheduler', 'workers', 'providers', 'git', 'usage', 'power_supervisor', 'ipc'])
    expect(health.components.find((c) => c.component === 'git')).toMatchObject({ level: 'DEGRADED', detail: 'The check failed: git is missing' })
    expect(health.components.find((c) => c.component === 'scheduler')).toMatchObject({ level: 'HEALTHY' })
    broken = true
    await control.tick()
    expect(control.health().components.find((c) => c.component === 'scheduler')).toMatchObject({ level: 'DEGRADED', detail: 'The last pass failed: the run list could not be read' })
    // The control plane survives the failed pass and recovers with the next one.
    broken = false
    await control.tick()
    expect(control.health().components.find((c) => c.component === 'scheduler')?.level).toBe('HEALTHY')
    expect(() => control.enqueue({ type: 'program', programId: 'p' })).toThrow(/not available/)
  })

  it('migration 009 is additive; the channels accept only ids and values from closed sets', () => {
    const old = new BetterSqlite3(':memory:')
    old.pragma('foreign_keys = ON')
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 8))
    const ddl = (d: BetterSqlite3.Database): Map<string, string> => new Map((d.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((x) => [x.name, x.sql]))
    const earlier = ddl(old)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 9))
    const after = ddl(old)
    for (const [name, sql] of earlier) expect(after.get(name), name).toBe(sql)
    expect([...after.keys()].filter((x) => !earlier.has(x) && !x.startsWith('idx_')).sort()).toEqual(['control_incidents', 'control_schedules', 'global_work_items'])
    old.close()
    expect(ipcInputs['control.enqueue'].safeParse({ item: { type: 'program', programId: 'p1' } }).success).toBe(true)
    expect(ipcInputs['control.enqueue'].safeParse({ item: { type: 'shell', command: 'calc' } }).success).toBe(false)
    expect(ipcInputs['control.enqueue'].safeParse({ item: { type: 'program', programId: 'p1', cwd: 'C:\\' } }).success).toBe(false)
    expect(ipcInputs['control.enqueue'].safeParse({ item: { type: 'scheduled_audit', projectId: 'p', kind: 'rm -rf' } }).success).toBe(false)
    expect(ipcInputs['control.setPriority'].safeParse({ itemId: 'i', priority: 'P9' }).success).toBe(false)
    expect(ipcInputs['control.setLimits'].safeParse({ limits: { maxAgents: 999, maxActiveItems: 1, resumeOnBoot: 'hold' } }).success).toBe(false)
    expect(ipcInputs['control.createSchedule'].safeParse({ schedule: { name: 'x', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'p' }, priority: 'P2', enabled: true, run: 'calc' } }).success).toBe(false)
  })
})
