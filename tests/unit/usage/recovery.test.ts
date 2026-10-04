import { afterEach, describe, expect, it } from 'vitest'
import type { PushMessage } from '@shared/events'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { FakeAgentRuntime, completeWith } from '@main/modules/agent-runtime/fake-runtime'
import { EventBus } from '@main/modules/events'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { QuotaRecoveryController, UsageIntelligenceService, type AvailabilityProbe, type ProbeResult } from '@main/modules/usage'
import { makeProject, makeRun } from '../../integration/persistence/fixtures'

const MIN = 60_000
// Durable events are stamped with the real clock; the controller's clock must not be behind it. A fixed date
// would start failing the moment the wall clock passed it.
const T0 = Math.ceil(Date.now() / MIN) * MIN + 24 * 60 * MIN

function world(usageSettings: Partial<typeof DEFAULT_SETTINGS.usage> = {}) {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const runtime = new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) })
  repos.settings.set({ ...DEFAULT_SETTINGS, usage: { ...DEFAULT_SETTINGS.usage, ...usageSettings } })
  const project = repos.projects.insert(makeProject())
  const pushes: PushMessage[] = []
  const t = { now: T0 }
  const resumes: string[] = []
  let release: ((r: ProbeResult) => void) | null = null
  const probe: AvailabilityProbe = {
    probe: () => new Promise<ProbeResult>((resolve) => void (release = resolve)),
  }
  const orchestrator = {
    pauseRun: async () => undefined,
    resumeRun: async (runId: string) => {
      resumes.push(runId)
      repos.runs.update(runId, { state: 'executing', resumeState: null, pauseReason: null })
    },
  }
  const usage = new UsageIntelligenceService({ repos, bus, runtime, push: (m) => void pushes.push(m), now: () => t.now })
  const make = () =>
    new QuotaRecoveryController({ repos, bus, usage, probe, orchestrator, push: (m) => void pushes.push(m), now: () => t.now, tickIntervalMs: 0, isOvernightRun: () => false })
  const controller = make()
  const quotaPausedRun = () => {
    const run = repos.runs.insert(makeRun(project.id, { state: 'executing' }))
    bus.emit({ runId: run.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: Math.floor((T0 + 10 * MIN) / 1000), limitType: 'five_hour' } })
    repos.runs.update(run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
    bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
    return run
  }
  return { db, repos, bus, usage, controller, make, pushes, t, resumes, quotaPausedRun, release: (r: ProbeResult) => release?.(r), settle: () => new Promise((r) => setTimeout(r, 5)) }
}

describe('quota recovery controller (audit fixes)', () => {
  let w: ReturnType<typeof world>
  afterEach(() => {
    w?.controller.dispose()
    w?.usage.dispose()
  })

  it('S1: a probe answering "available" after dispose() resumes nothing and writes nothing; idle() waits for it', async () => {
    w = world()
    const run = w.quotaPausedRun()
    w.t.now = T0 + 12 * MIN
    const tick = w.controller.tick()
    await w.settle()
    w.controller.dispose()
    let idle = false
    const waiting = w.controller.idle().then(() => (idle = true))
    await w.settle()
    expect(idle).toBe(false) // the probe is still in flight
    w.release({ available: true, method: 'usage_report', resetAt: null, detail: 'x', outcome: 'available' })
    await tick
    await waiting
    expect(w.resumes).toEqual([])
    expect(w.repos.runs.require(run.id).state).toBe('paused')
    expect(w.repos.quotaResumes.listByRun(run.id)).toHaveLength(0)
    expect(w.repos.quotaPauses.liveGlobal()).not.toBeNull() // untouched: the next start re-plans it
  })

  it('a first plan that ends (max wait) writes the run row closed, emits wait_ended and pushes the notice', async () => {
    w = world({ maxQuotaWaitMinutes: 5 }) // the reset is 10 minutes away
    const run = w.quotaPausedRun()
    expect(w.repos.quotaPauses.listLive()).toHaveLength(0)
    const rows = w.repos.quotaPauses.listByRun(run.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ scope: 'run', state: 'ended', resumeState: 'executing' })
    expect(rows[0]?.endReason).toMatch(/maximum of 5 minutes/)
    expect(w.repos.events.listByRun(run.id, 0, 1000).some((e) => e.type === 'usage.wait_ended')).toBe(true)
    expect(w.pushes.find((m) => m.kind === 'usage.notice' && m.notice === 'wait_ended')).toBeTruthy()
    expect(w.repos.runs.require(run.id).state).toBe('paused')
    expect(w.usage.canDispatch()).toBe(true)
  })

  it('an ended wait is durable: a restart does not reopen, re-notify or auto-resume it', async () => {
    w = world()
    const run = w.quotaPausedRun()
    w.controller.endWait(run.id)
    w.pushes.length = 0
    w.controller.dispose()
    w.controller = w.make()
    w.controller.recover()
    expect(w.repos.quotaPauses.listLive()).toHaveLength(0)
    expect(w.pushes.filter((m) => m.kind === 'usage.notice')).toHaveLength(0)
    w.t.now = T0 + 60 * MIN
    await w.controller.tick()
    expect(w.resumes).toEqual([])
    // ...but a NEW quota pause of the same run (after the person resumed it) is tracked again.
    w.repos.runs.update(run.id, { state: 'executing', resumeState: null, pauseReason: null })
    w.bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
    w.repos.runs.update(run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
    w.bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
    expect(w.repos.quotaPauses.liveForRun(run.id)).not.toBeNull()
  })

  it('auto-resume switched on during a wait schedules it on the next tick', async () => {
    w = world({ autoResume: false })
    const run = w.quotaPausedRun()
    expect(w.repos.quotaPauses.liveGlobal()?.nextCheckAt).toBeNull()
    w.repos.settings.set({ ...DEFAULT_SETTINGS, usage: { ...DEFAULT_SETTINGS.usage, autoResume: true } })
    await w.controller.tick()
    const global = w.repos.quotaPauses.liveGlobal()
    expect(Date.parse(global?.nextCheckAt ?? '') - T0).toBe(11 * MIN) // reset + 60 s
    expect(w.repos.quotaPauses.liveForRun(run.id)?.nextCheckAt).toBe(global?.nextCheckAt)
  })

  it('a plan that ends on recover() closes the rows instead of leaving them unscheduled', () => {
    w = world({ autoResume: false })
    const run = w.quotaPausedRun()
    w.controller.dispose()
    w.repos.settings.set({ ...DEFAULT_SETTINGS, usage: { ...DEFAULT_SETTINGS.usage, autoResume: true, maxQuotaWaitMinutes: 1 } })
    w.t.now = T0 + 30 * MIN
    w.controller = w.make()
    w.controller.recover()
    expect(w.repos.quotaPauses.listLive()).toHaveLength(0)
    expect(w.repos.quotaPauses.listByRun(run.id)[0]).toMatchObject({ state: 'ended' })
    expect(w.usage.canDispatch()).toBe(true)
  })
})
