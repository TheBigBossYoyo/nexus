import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canTransitionWorker, type WorkerState } from '@shared/workers'
import type { AgentEvent, AgentSessionHandle, SessionSpec } from '@main/modules/agent-runtime/types'
import { ControlPlane, type WorkloadAdapter } from '@main/modules/control-plane'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { WorkerManager, type RuntimeToWorker, type WorkerProcess, type WorkerToRuntime } from '@main/modules/workers'

/**
 * Seeded histories of the runtime's own machinery: the worker manager with its leases, and schedules, across
 * restarts of the runtime. Workers are scripted objects, the clock is the test's, the database is real SQLite.
 * A history is a random sequence of what can happen: sessions start, workers come up, speak, finish, die,
 * fall silent, sessions are stopped, time passes, schedules come due, and the runtime itself is killed and
 * started again on the same database. After every step the invariants below must hold.
 *
 *   NEXUS_RUNTIME_STRESS_RUNS=10000 pnpm stress
 *
 * A failing seed is written to test-results/stress-failures/runtime-seed-<n>.json; replay it with
 * NEXUS_RUNTIME_STRESS_START=<seed> NEXUS_RUNTIME_STRESS_RUNS=1.
 */
const RUNS = Number(process.env['NEXUS_RUNTIME_STRESS_RUNS'] ?? process.env['NEXUS_STRESS_RUNS'] ?? 300)
const START = Number(process.env['NEXUS_RUNTIME_STRESS_START'] ?? 1)
const STEPS = 90
const FAILURE_DIR = join(process.cwd(), 'test-results', 'stress-failures')

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

class ScriptedWorker implements WorkerProcess {
  readonly sent: RuntimeToWorker[] = []
  exited = false
  killed = false
  silent = false
  ready = false
  private onMsg: ((m: WorkerToRuntime) => void) | null = null
  private onEnd: ((code: number | null, signal: string | null) => void) | null = null
  constructor(
    readonly pid: number,
    readonly boot: number,
  ) {}
  send(message: RuntimeToWorker): void {
    if (this.exited) return
    this.sent.push(message)
    // A real worker obeys `shutdown` and a `stop` command unless the history made it deaf.
    if (message.t === 'shutdown' && !this.silent) queueMicrotask(() => this.exit(0))
  }
  async kill(): Promise<void> {
    this.killed = true
    this.exit(null, 'SIGKILL')
  }
  onMessage(listener: (m: WorkerToRuntime) => void): void {
    this.onMsg = listener
  }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.onEnd = listener
  }
  say(message: WorkerToRuntime): void {
    if (!this.exited) this.onMsg?.(message)
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return
    this.exited = true
    this.onEnd?.(code, signal)
  }
  /** The lease of the assignment this worker was last given and has not reported ended. */
  held(): string | null {
    let lease: string | null = null
    for (const m of this.sent) if (m.t === 'assign') lease = m.leaseId
    return lease
  }
}

interface Tracked {
  agentId: string
  boot: number
  handle: AgentSessionHandle
  events: AgentEvent[]
  ended: boolean
  /** Events that arrived after `session.ended`. Must stay 0. */
  afterEnd: number
}

async function history(seed: number): Promise<string[]> {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const world = { now: new Date(2026, 9, 5, 12, 0, 0).getTime(), boot: 1, maxWorkers: 1 + Math.floor(rnd() * 4) }
  const problems: string[] = []
  const trail: string[] = []
  const say = (step: string, text: string): void => void problems.push(`${step}: ${text}`)
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  let workers: ScriptedWorker[] = []
  const allWorkers: ScriptedWorker[] = []
  const sessions: Tracked[] = []
  const scheduleStarts = new Map<string, number>()
  let agentSeq = 0
  let pidSeq = 5000

  const spec = (agentId: string): SessionSpec => ({ agentId, role: 'worker', cwd: `C:\\w\\${agentId}`, maxTurns: 5, systemPromptAppend: '', prompt: 'p', tools: [], authorize: async () => ({ behavior: 'allow' }), requestApproval: async () => true, loadProjectSettings: false, subscriptionMode: true })

  const buildManager = (): WorkerManager =>
    new WorkerManager({
      workers: repos.workers,
      leases: repos.workerLeases,
      bootId: `boot-${world.boot}`,
      launcher: () => {
        const worker = new ScriptedWorker(pidSeq++, world.boot)
        workers.push(worker)
        allWorkers.push(worker)
        return worker
      },
      config: () => ({ heartbeatMs: 2000, fake: { script: 'probe' } }),
      maxWorkers: () => world.maxWorkers,
      timings: { tickMs: 0, heartbeatTimeoutMs: 20_000, leaseTtlMs: 30_000, idleTtlMs: 60_000, maxAssignments: 4, startTimeoutMs: 45_000, stopTimeoutMs: 5 },
      now: () => world.now,
    })

  const adapter: WorkloadAdapter = {
    start: async (item) => {
      const id = item.refId as string
      scheduleStarts.set(id, (scheduleStarts.get(id) ?? 0) + 1)
      return id
    },
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    // A scheduled workload finishes as soon as it was started: the history is about firing, not about running.
    snapshot: (id) => ({ phase: scheduleStarts.has(id) ? 'completed' : 'not_started', activeAgents: 0, runIds: [], detail: null }),
    title: ({ refId }) => refId,
    requestedAgents: () => 1,
  }
  const buildControl = (): ControlPlane =>
    new ControlPlane({
      items: repos.workItems,
      schedules: repos.controlSchedules,
      incidents: repos.controlIncidents,
      firings: repos.scheduleFirings,
      decisions: repos.schedulerDecisions,
      transaction: repos.transaction,
      settings: repos.settings,
      adapters: { program: adapter },
      usage: { canDispatch: () => true },
      now: () => world.now,
      tickIntervalMs: 0,
    })

  let manager = buildManager()
  let control = buildControl()
  let scheduleSeq = 0

  const startSession = (): void => {
    const agentId = `a${++agentSeq}`
    const handle = manager.startSession('claude', spec(agentId))
    const tracked: Tracked = { agentId, boot: world.boot, handle, events: [], ended: false, afterEnd: 0 }
    sessions.push(tracked)
    void (async () => {
      for await (const event of handle.events) {
        if (tracked.ended) tracked.afterEnd += 1
        tracked.events.push(event)
        if (event.type === 'session.ended') tracked.ended = true
      }
    })()
  }

  const transitionsSeen = new Map<string, WorkerState>()
  let eventsChecked = 0
  const check = (step: string): void => {
    // 1. No double assignment: one active lease per agent session and per worker, in the database.
    const active = repos.workerLeases.listActive()
    if (new Set(active.map((l) => l.agentId)).size !== active.length) say(step, 'an agent session holds two active leases')
    if (new Set(active.map((l) => l.workerId)).size !== active.length) say(step, 'a worker holds two active leases')
    // 2. An active lease belongs to this start of the runtime and to a worker that is alive and holds it.
    for (const lease of active) {
      if (lease.bootId !== `boot-${world.boot}`) say(step, `lease ${lease.id} of an earlier start is still active`)
      const record = manager.get(lease.workerId)
      if (!record) say(step, `lease ${lease.id} is active and its worker is not alive`)
      else if (record.assignment?.leaseId !== lease.id) say(step, `lease ${lease.id} is active and its worker holds ${record.assignment?.leaseId ?? 'nothing'}`)
    }
    // 3. No worker holds two assignments, and the workers never exceed the limit.
    const overview = manager.overview()
    const live = overview.workers.filter((w) => w.bootId === `boot-${world.boot}` && w.state !== 'STOPPED' && w.state !== 'FAILED')
    const serving = live.filter((w) => w.state !== 'STOPPING' && w.state !== 'DRAINING')
    if (serving.length > world.maxWorkers) say(step, `${serving.length} workers serve with a limit of ${world.maxWorkers}`)
    const assigned = live.filter((w) => w.assignment).map((w) => w.assignment?.agentId)
    if (new Set(assigned).size !== assigned.length) say(step, 'one agent session is assigned to two workers')
    // 4. No worker of an earlier start is recorded as alive.
    for (const stale of repos.workers.listLive()) if (stale.bootId !== `boot-${world.boot}`) say(step, `worker ${stale.id} of an earlier start is recorded as ${stale.state}`)
    // 5. Worker states move only along the written transitions, and ended workers stay ended.
    const recorded = [...repos.workers.recentEvents(500)].reverse()
    // Only what was recorded since the last check; a history stays far below the 500 the store returns.
    for (const event of recorded.length < 500 ? recorded.slice(eventsChecked) : []) {
      const to = event.kind as WorkerState
      const from = transitionsSeen.get(event.workerId)
      if (from === to) continue
      if (from !== undefined && !canTransitionWorker(from, to)) say(step, `worker ${event.workerId} went ${from} -> ${to}`)
      transitionsSeen.set(event.workerId, to)
    }
    eventsChecked = recorded.length
    // 6. A session that ended stays ended, ends once, and a session of an earlier start has ended.
    for (const s of sessions) {
      if (s.afterEnd > 0) say(step, `session ${s.agentId} received events after it ended`)
      if (s.events.filter((e) => e.type === 'session.ended').length > 1) say(step, `session ${s.agentId} ended twice`)
      if (s.boot !== world.boot && !s.ended) say(step, `session ${s.agentId} of an earlier start never ended`)
      const end = s.events.find((e) => e.type === 'session.ended') as Extract<AgentEvent, { type: 'session.ended' }> | undefined
      // The exit of a worker is never read as completion: a session is completed only when its worker said so.
      if (end?.reason === 'completed' && !s.events.some((e) => e.type === 'text' && e.text === 'final')) say(step, `session ${s.agentId} completed without its worker saying so`)
    }
    // 7. A schedule's occurrence fires once, and starts its work once.
    for (const schedule of repos.controlSchedules.list()) {
      const firings = repos.scheduleFirings.list(schedule.id, 50)
      if (new Set(firings.map((f) => f.occurrence)).size !== firings.length) say(step, `schedule ${schedule.name} fired one occurrence twice`)
      if (schedule.rule.kind === 'once' && firings.length > 1) say(step, `one-time schedule ${schedule.name} fired ${firings.length} times`)
      const starts = scheduleStarts.get(schedule.name) ?? 0
      if (schedule.rule.kind === 'once' && starts > 1) say(step, `the work of schedule ${schedule.name} was started ${starts} times`)
    }
  }

  try {
    for (let step = 0; step < STEPS; step++) {
      const roll = rnd()
      let op = ''
      const alive = workers.filter((w) => !w.exited)
      const busy = alive.filter((w) => w.ready && w.held() !== null && manager.get(repos.workerLeases.listActive().find((l) => l.id === w.held())?.workerId ?? '')?.assignment?.leaseId === w.held())
      if (roll < 0.22) {
        op = 'start session'
        startSession()
      } else if (roll < 0.4) {
        const starting = alive.filter((w) => !w.ready)
        const w = starting.length > 0 ? pick(starting) : null
        if (w) {
          op = `worker ${w.pid} ready`
          w.ready = true
          w.say({ t: 'ready', pid: w.pid, capabilities: ['claude'] })
        }
      } else if (roll < 0.56 && busy.length > 0) {
        const w = pick(busy)
        const leaseId = w.held() as string
        op = `worker ${w.pid} finishes`
        w.say({ t: 'event', leaseId, event: { type: 'text', text: 'final' } })
        w.say({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'completed', error: null } })
        w.say({ t: 'ended', leaseId })
      } else if (roll < 0.64 && busy.length > 0) {
        const w = pick(busy)
        op = `worker ${w.pid} speaks`
        w.say({ t: 'event', leaseId: w.held() as string, event: { type: 'text', text: 'progress' } })
        w.say({ t: 'hb', leaseId: w.held() })
      } else if (roll < 0.72 && alive.length > 0) {
        const w = pick(alive)
        op = `worker ${w.pid} dies`
        w.exit(pick([0, 1, null]), null)
      } else if (roll < 0.77 && alive.length > 0) {
        const w = pick(alive)
        op = `worker ${w.pid} falls silent`
        w.silent = true
      } else if (roll < 0.83 && sessions.some((s) => !s.ended)) {
        const s = pick(sessions.filter((x) => !x.ended))
        op = `stop ${s.agentId}`
        await s.handle.stop()
      } else if (roll < 0.9) {
        const id = `s${++scheduleSeq}`
        op = `schedule ${id}`
        control.createSchedule({ name: id, rule: { kind: 'once', at: new Date(world.now + 30_000 + Math.floor(rnd() * 120_000)).toISOString() }, action: { type: 'program', programId: id }, priority: 'P2', enabled: true })
      } else if (roll < 0.96) {
        // The runtime is killed: nothing is told, nothing is flushed. Its workers end themselves when it is gone.
        op = 'runtime killed and started again'
        if (rnd() < 0.5) {
          // Sometimes in the middle of a firing: the occurrence was claimed and queued, the schedule's new time was lost.
          for (const schedule of repos.controlSchedules.list()) {
            const fired = repos.scheduleFirings.list(schedule.id, 1)[0]
            if (fired) repos.controlSchedules.update(schedule.id, { nextRunAt: fired.occurrence, enabled: true })
          }
        }
        control.dispose()
        const dead = workers
        workers = []
        world.boot += 1
        world.maxWorkers = 1 + Math.floor(rnd() * 4)
        manager = buildManager()
        manager.recoverOnBoot()
        // The old process is gone: its sessions' consumers are gone with it. What matters is the database.
        for (const s of sessions) if (s.boot !== world.boot) s.ended = true
        for (const w of dead) w.exited = true
        control = buildControl()
        await control.recoverOnBoot()
      } else {
        op = 'time passes'
        world.now += 5000 + Math.floor(rnd() * 40_000)
      }
      // Workers that are heard keep their leases; silent ones do not.
      for (const w of workers) if (!w.exited && w.ready && !w.silent) w.say({ t: 'hb', leaseId: w.held() })
      world.now += 2000
      manager.tick()
      await control.tick()
      await flush()
      trail.push(op)
      check(`step ${step} (${op || 'nothing'})`)
      if (problems.length > 0) break
    }

    // Quiesce: every worker goes silent and time passes. No lease and no session may survive that.
    if (problems.length === 0) {
      for (const w of workers) w.silent = true
      for (let round = 0; round < 8; round++) {
        world.now += 30_000
        manager.tick()
        await flush()
      }
      if (repos.workerLeases.listActive().length > 0) problems.push(`quiesce: ${repos.workerLeases.listActive().length} lease(s) survived the silence of every worker`)
      // Sessions still waiting for a worker are stopped by the shutdown; the rest must have ended already.
      await manager.shutdown()
      await flush()
      for (const s of sessions) if (!s.ended) problems.push(`quiesce: session ${s.agentId} never ended`)
      if (repos.workers.listLive().length > 0) problems.push(`quiesce: ${repos.workers.listLive().length} worker(s) recorded as alive after shutdown`)
      // Every schedule that came due fired exactly once in the end.
      world.now += 10 * 60_000
      await control.tick()
      await control.tick()
      for (const schedule of repos.controlSchedules.list()) {
        const n = repos.scheduleFirings.count(schedule.id)
        if (n !== 1) problems.push(`quiesce: one-time schedule ${schedule.name} fired ${n} times`)
        if ((scheduleStarts.get(schedule.name) ?? 0) > 1) problems.push(`quiesce: the work of ${schedule.name} started ${scheduleStarts.get(schedule.name)} times`)
      }
    }
  } catch (e) {
    problems.push(`threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  } finally {
    control.dispose()
    for (const w of allWorkers) w.silent = false
    await manager.shutdown().catch(() => undefined)
    db.close()
  }
  if (problems.length > 0) {
    mkdirSync(FAILURE_DIR, { recursive: true })
    writeFileSync(join(FAILURE_DIR, `runtime-seed-${seed}.json`), JSON.stringify({ seed, problems, trail }, null, 2))
  }
  return problems
}

describe('control plane runtime stress', () => {
  it(`holds its invariants over ${RUNS} seeded histories of workers, leases, schedules and runtime restarts`, async () => {
    const failures: string[] = []
    for (let seed = START; seed < START + RUNS; seed++) {
      const problems = await history(seed)
      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.slice(0, 3).join(' | ')}`)
        if (failures.length >= 5) break
      }
    }
    expect(failures).toEqual([])
  })
})
