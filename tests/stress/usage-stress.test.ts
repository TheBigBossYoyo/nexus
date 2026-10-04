import { describe, expect, it } from 'vitest'
import type { PauseReason, Run } from '@shared/domain'
import type { PauseCause } from '@shared/events'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { FakeAgentRuntime, completeWith } from '@main/modules/agent-runtime/fake-runtime'
import { EventBus } from '@main/modules/events'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { isDispatchBlocked, QuotaRecoveryController, UsageIntelligenceService, type AvailabilityProbe, type ProbeResult } from '@main/modules/usage'
import { makeProject, makeRun } from '../integration/persistence/fixtures'

/**
 * Seeded stress of the usage state machine and the quota recovery controller. Every seed draws a random
 * history of runs, limit hits (exact or unknown reset), user actions, clock jumps, probe answers and
 * restarts of NEXUS, and checks the recovery invariants after every step. The orchestrator is a stub that
 * only moves the run row and emits the events the real one emits; the probe is scripted. Nothing touches
 * Git or Claude.
 *
 * NEXUS_USAGE_STRESS_RUNS / NEXUS_USAGE_STRESS_START select the seeds.
 */
const RUNS = Number(process.env['NEXUS_USAGE_STRESS_RUNS'] ?? 1000)
const START = Number(process.env['NEXUS_USAGE_STRESS_START'] ?? 1)
const MIN = 60_000
const T0 = Date.UTC(2026, 9, 4, 22, 0, 0)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type ProbeMode = 'available' | 'limited' | 'limited_reset' | 'auth' | 'runtime' | 'throw'

class World {
  readonly db = openDatabase(':memory:')
  readonly repos: Repositories = createRepositories(this.db)
  readonly bus = new EventBus(this.repos.events, this.repos.transaction)
  readonly runtime = new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) })
  readonly project = makeProject()
  t = T0
  mode: ProbeMode = 'limited'
  forced = false
  /** Every probe: when, whether forced, and what was answered. */
  readonly probes: { at: number; pauseId: string | null; forced: boolean; mode: ProbeMode; plannedAt: number | null }[] = []
  lastProbe: ProbeMode | null = null
  /** Violations found inside callbacks (they cannot throw into the controller without being swallowed). */
  readonly violations: string[] = []
  controllerResumes = 0
  usage!: UsageIntelligenceService
  controller!: QuotaRecoveryController
  readonly runIds: string[] = []
  autoResume: boolean

  constructor(autoResume: boolean, private readonly rand: () => number) {
    this.autoResume = autoResume
    this.repos.projects.insert(this.project)
    this.repos.settings.set({ ...DEFAULT_SETTINGS, usage: { ...DEFAULT_SETTINGS.usage, autoResume } })
    this.boot()
  }

  now = (): number => this.t

  private readonly probe: AvailabilityProbe = {
    probe: async () => {
      const global = this.repos.quotaPauses.liveGlobal()
      const plannedAt = global?.nextCheckAt ? Date.parse(global.nextCheckAt) : null
      this.probes.push({ at: this.t, pauseId: global?.id ?? null, forced: this.forced, mode: this.mode, plannedAt })
      if (!this.forced && (plannedAt === null || this.t < plannedAt)) this.violations.push(`probe at ${this.t} before its planned time ${plannedAt}`)
      this.lastProbe = this.mode
      const base = { method: 'usage_report' as const, detail: this.mode }
      switch (this.mode) {
        case 'available':
          return { ...base, available: true, resetAt: null, outcome: 'available' } satisfies ProbeResult
        case 'limited':
          return { ...base, available: false, resetAt: null, outcome: 'limited' } satisfies ProbeResult
        case 'limited_reset':
          return { ...base, available: false, resetAt: new Date(this.t + (1 + Math.floor(this.rand() * 90)) * MIN).toISOString(), outcome: 'limited' } satisfies ProbeResult
        case 'auth':
          return { ...base, available: false, resetAt: null, outcome: 'auth' } satisfies ProbeResult
        case 'runtime':
          return { ...base, available: false, resetAt: null, outcome: 'runtime' } satisfies ProbeResult
        case 'throw':
          throw new Error('probe exploded')
      }
    },
  }

  private pause(runId: string, reason: PauseReason, cause?: PauseCause): void {
    const run = this.repos.runs.require(runId)
    if (run.state === 'paused' || ['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error(`cannot pause a ${run.state} run`)
    this.repos.runs.update(runId, { state: 'paused', resumeState: run.state, pauseReason: reason })
    this.bus.emit({ runId, type: 'run.paused', payload: { reason, cause: cause ?? reason } })
  }

  readonly orchestrator = {
    pauseRun: async (runId: string, reason: 'quota', _detail?: string, cause?: 'quota'): Promise<Run> => {
      this.pause(runId, reason, cause)
      return this.repos.runs.require(runId)
    },
    /** What the controller calls: it must only ever resume a run that is paused for quota, after an available probe. */
    resumeRun: async (runId: string): Promise<Run> => {
      const run = this.repos.runs.require(runId)
      if (run.state !== 'paused') throw new Error(`Run is ${run.state}, not paused`)
      if (run.pauseReason !== 'quota') this.violations.push(`controller resumed ${runId}, paused for ${String(run.pauseReason)}`)
      if (this.lastProbe !== 'available') this.violations.push(`controller resumed ${runId} without an available probe (last ${String(this.lastProbe)})`)
      this.controllerResumes += 1
      return this.userResume(runId)
    },
  }

  userResume(runId: string): Run {
    const run = this.repos.runs.require(runId)
    this.repos.runs.update(runId, { state: run.resumeState ?? 'executing', resumeState: null, pauseReason: null })
    this.bus.emit({ runId, type: 'run.resumed', payload: {} })
    return this.repos.runs.require(runId)
  }

  boot(): void {
    this.runtime.usage.now = this.now
    this.usage = new UsageIntelligenceService({ repos: this.repos, bus: this.bus, runtime: this.runtime, push: () => undefined, now: this.now })
    this.controller = new QuotaRecoveryController({
      repos: this.repos,
      bus: this.bus,
      usage: this.usage,
      probe: this.probe,
      orchestrator: this.orchestrator,
      push: () => undefined,
      now: this.now,
      tickIntervalMs: 0,
      isOvernightRun: () => false,
    })
    this.controller.recover()
  }

  restart(): void {
    this.controller.dispose()
    this.usage.dispose()
    this.boot()
  }

  startRun(): string {
    const run = this.repos.runs.insert(makeRun(this.project.id, { state: 'executing', startedAt: new Date(this.t).toISOString() }))
    this.runIds.push(run.id)
    return run.id
  }

  runsIn(state: Run['state']): Run[] {
    return this.runIds.map((id) => this.repos.runs.require(id)).filter((r) => r.state === state)
  }

  /** A worker session hits the limit; the pipeline then pauses the run (exact or unknown reset). */
  hitLimit(runId: string): void {
    const exact = this.rand() < 0.6
    this.bus.emit({
      runId,
      type: 'agent.rate_limited',
      payload: { status: 'rejected', resetsAt: exact ? Math.floor((this.t + (1 + Math.floor(this.rand() * 240)) * MIN) / 1000) : null, limitType: 'five_hour' },
    })
    this.pause(runId, 'quota')
  }

  checkInvariants(where: string): void {
    const { repos } = this
    const live = repos.quotaPauses.listLive()
    const globals = live.filter((p) => p.scope === 'global')
    const rows = live.filter((p) => p.scope === 'run')
    const fail = (message: string): never => {
      throw new Error(`${where}: ${message}`)
    }
    if (this.violations.length > 0) fail(this.violations.join('; '))
    if (globals.length > 1) fail(`${globals.length} live global pauses`)
    if (globals.length === 1 && this.usage.canDispatch()) fail('the dispatch gate is open while a global pause is live')
    if (globals.length === 1 && !isDispatchBlocked(this.usage.status())) fail(`the status is ${this.usage.status()} while a global pause is live`)
    if (rows.length > 0 && globals.length === 0) fail('a live run pause without a global pause')
    for (const row of rows) {
      const run = repos.runs.get(row.runId ?? '')
      if (!run || run.state !== 'paused' || run.pauseReason !== 'quota') fail(`live pause for run ${row.runId} which is ${run?.state}/${String(run?.pauseReason)}`)
      if (this.autoResume && row.nextCheckAt === null) fail('auto-resume is on but the live pause has no next check')
    }
    if (globals[0] && this.autoResume && globals[0].nextCheckAt === null) fail('auto-resume is on but the global pause has no next check')
    // Each row closes at most once and a run is resumed once per pause.
    const resumes = repos.quotaResumes.listByRun
    for (const id of this.runIds) {
      const pauses = repos.quotaPauses.listByRun(id)
      const resumed = resumes.call(repos.quotaResumes, id).filter((r) => r.kind === 'resume' && r.result === 'resumed')
      const perPause = new Map<string, number>()
      for (const r of resumed) perPause.set(r.pauseId, (perPause.get(r.pauseId) ?? 0) + 1)
      for (const [pauseId, n] of perPause) if (n > 1) fail(`pause ${pauseId} resumed ${n} times`)
      if (resumed.length > pauses.length) fail('more resumes than pauses')
    }
    // Probes never run before their planned time (unless forced) and respect the schedule's minimum gap.
    const byPause = new Map<string, number[]>()
    for (const p of this.probes) if (p.pauseId && !p.forced) byPause.set(p.pauseId, [...(byPause.get(p.pauseId) ?? []), p.at])
    for (const times of byPause.values()) {
      for (let i = 1; i < times.length; i++) if ((times[i] as number) - (times[i - 1] as number) < MIN) fail('two scheduled probes less than a minute apart')
    }
  }
}

async function step(w: World, rand: () => number): Promise<string> {
  const pick = rand()
  const active = w.runIds.map((id) => w.repos.runs.require(id)).filter((r) => r.state !== 'paused' && !['completed', 'failed', 'cancelled'].includes(r.state))
  const paused = w.runsIn('paused')
  if (pick < 0.12 || w.runIds.length === 0) {
    w.startRun()
    return 'start run'
  }
  if (pick < 0.3) {
    const r = active[Math.floor(rand() * active.length)]
    if (!r) return 'no active run'
    w.hitLimit(r.id)
    return `limit ${r.id.slice(0, 4)}`
  }
  if (pick < 0.55) {
    const jump = [0, 30_000, MIN, 4 * MIN, 6 * MIN, 31 * MIN, 120 * MIN][Math.floor(rand() * 7)] as number
    w.t += jump
    w.forced = false
    await w.controller.tick()
    return `advance ${jump / MIN}m + tick`
  }
  if (pick < 0.68) {
    w.mode = (['available', 'limited', 'limited_reset', 'auth', 'runtime', 'throw', 'available'] as const)[Math.floor(rand() * 7)] as ProbeMode
    return `probe mode ${w.mode}`
  }
  if (pick < 0.74) {
    w.forced = true
    await w.controller.resumeNow()
    w.forced = false
    return 'resumeNow'
  }
  if (pick < 0.8) {
    const r = paused[Math.floor(rand() * paused.length)]
    if (!r) return 'no paused run'
    w.userResume(r.id)
    return `user resume ${r.id.slice(0, 4)}`
  }
  if (pick < 0.85) {
    const r = w.runIds.map((id) => w.repos.runs.require(id)).filter((x) => !['completed', 'failed', 'cancelled'].includes(x.state))[Math.floor(rand() * 3)]
    if (!r) return 'no run to cancel'
    w.repos.runs.update(r.id, { state: 'cancelled', resumeState: null })
    w.bus.emit({ runId: r.id, type: 'run.cancelled', payload: {} })
    return `cancel ${r.id.slice(0, 4)}`
  }
  if (pick < 0.89) {
    const r = paused[Math.floor(rand() * paused.length)]
    if (r && w.repos.quotaPauses.liveForRun(r.id)) {
      w.controller.endWait(rand() < 0.5 ? r.id : undefined)
      return 'end wait'
    }
    return 'no wait to end'
  }
  if (pick < 0.93) {
    w.restart()
    return 'restart'
  }
  if (pick < 0.97) {
    const r = active[Math.floor(rand() * active.length)]
    if (r && !w.usage.canDispatch()) {
      // A planning session that finds the gate closed pauses the run for quota without any new signal.
      const run = w.repos.runs.require(r.id)
      w.repos.runs.update(r.id, { state: 'paused', resumeState: run.state, pauseReason: 'quota' })
      w.bus.emit({ runId: r.id, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
      return 'gate pause'
    }
    return 'no gate pause'
  }
  const kinds = ['allowed_warning', 'allowed', 'throttled'] as const
  const r = active[0]
  if (r) w.bus.emit({ runId: r.id, type: 'agent.rate_limited', payload: { status: kinds[Math.floor(rand() * 3)] as string, resetsAt: null, limitType: 'five_hour' } })
  return 'noise'
}

describe('usage state and recovery stress', () => {
  it(`holds the recovery invariants over ${RUNS} seeded histories`, async () => {
    let totalProbes = 0
    let totalResumes = 0
    for (let seed = START; seed < START + RUNS; seed++) {
      const rand = mulberry32(seed)
      const w = new World(rand() < 0.85, rand)
      const log: string[] = []
      try {
        const steps = 5 + Math.floor(rand() * 21)
        for (let i = 0; i < steps; i++) {
          const what = await step(w, rand)
          log.push(what)
          w.checkInvariants(`seed ${seed} step ${i} (${what})`)
        }
        // Drain: Claude comes back; every wait must end (resumed or closed), none may stay open.
        w.mode = 'available'
        for (let i = 0; i < 12 && w.repos.quotaPauses.listLive().length > 0; i++) {
          w.t += 48 * 60 * MIN
          w.forced = false
          await w.controller.tick()
          w.checkInvariants(`seed ${seed} drain ${i}`)
        }
        if (w.repos.quotaPauses.listLive().length > 0) {
          // auto-resume off: nothing is scheduled by design; the person's explicit action must work.
          expect(w.autoResume, `seed ${seed}: a live pause with auto-resume on after draining`).toBe(false)
          w.forced = true
          await w.controller.resumeNow()
          w.checkInvariants(`seed ${seed} resumeNow drain`)
        }
        expect(w.repos.quotaPauses.listLive(), `seed ${seed}: ${log.join(' > ')}`).toHaveLength(0)
        expect(w.repos.quotaPauses.liveGlobal()).toBeNull()
        for (const run of w.runsIn('paused')) expect(run.pauseReason === 'quota' && w.repos.quotaPauses.liveForRun(run.id) !== null, `seed ${seed}: run left tracked`).toBe(false)
        totalProbes += w.probes.length
        totalResumes += w.controllerResumes
      } catch (e) {
        throw new Error(`${(e as Error).message}\nseed ${seed}\nhistory: ${log.join(' > ')}`, { cause: e })
      } finally {
        w.controller.dispose()
        w.usage.dispose()
        w.db.close()
      }
    }
    // The histories must actually exercise probing and resuming.
    expect(totalProbes).toBeGreaterThan(RUNS / 4)
    expect(totalResumes).toBeGreaterThan(RUNS / 4)
  }, 600_000)
})
