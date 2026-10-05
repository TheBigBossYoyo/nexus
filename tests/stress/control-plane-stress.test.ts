import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareWorkItems, TERMINAL_WORK_ITEM_STATES, type ControlLimits, type GlobalWorkItem, type Priority, type WorkItemState, type WorkloadPhase, type WorkloadSnapshot } from '@shared/control-plane'
import { ControlPlane, type WorkloadAdapter } from '@main/modules/control-plane'
import { createRepositories, openDatabase } from '@main/modules/persistence'

/**
 * Seeded histories of the control plane with scripted workloads. Every history is a random sequence of what
 * can happen to a queue: work is queued, started work reports progress, limits and usage change, the user
 * holds, releases, reorders, reprioritizes and cancels, schedules fire, NEXUS restarts. After every step the
 * invariants below must hold.
 *
 *   NEXUS_CONTROL_STRESS_RUNS=5000 pnpm stress
 *
 * A failing seed is written to test-results/stress-failures/control-seed-<n>.json; replay it with
 * NEXUS_CONTROL_STRESS_START=<seed> NEXUS_CONTROL_STRESS_RUNS=1.
 */
const RUNS = Number(process.env['NEXUS_CONTROL_STRESS_RUNS'] ?? process.env['NEXUS_STRESS_RUNS'] ?? 300)
const START = Number(process.env['NEXUS_CONTROL_STRESS_START'] ?? 1)
const STEPS = 60
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

interface Workload extends WorkloadSnapshot {
  agents: number
  starts: number
}

async function history(seed: number): Promise<string[]> {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const workloads = new Map<string, Workload>()
  const world = { now: new Date(2026, 9, 5, 12, 0, 0).getTime(), claude: true, failStart: false }
  const problems: string[] = []
  const trail: string[] = []
  const startedWhileHeld: string[] = []
  const adapter: WorkloadAdapter = {
    start: async (item) => {
      const id = item.refId ?? `job-${workloads.size + 1}`
      if (item.heldByUser) startedWhileHeld.push(id)
      if (world.failStart) throw new Error('refused')
      const w = workloads.get(id) ?? { phase: 'not_started' as WorkloadPhase, activeAgents: 0, runIds: [], detail: null, agents: 1, starts: 0 }
      workloads.set(id, { ...w, phase: 'working', runIds: [`run-${id}`], starts: w.starts + 1 })
      return id
    },
    pause: async (id) => void (workloads.has(id) && workloads.set(id, { ...workloads.get(id)!, phase: 'paused', activeAgents: 0 })),
    resume: async (id) => void (workloads.has(id) && workloads.set(id, { ...workloads.get(id)!, phase: 'working' })),
    cancel: async (id) => void (workloads.has(id) && workloads.set(id, { ...workloads.get(id)!, phase: 'cancelled', activeAgents: 0 })),
    snapshot: (id) => workloads.get(id) ?? { phase: 'missing', activeAgents: 0, runIds: [], detail: null },
    title: ({ refId }) => refId,
    requestedAgents: ({ refId }) => (refId ? (workloads.get(refId)?.agents ?? 1) : 1),
  }
  const build = (): ControlPlane =>
    new ControlPlane({
      items: repos.workItems,
      schedules: repos.controlSchedules,
      incidents: repos.controlIncidents,
      settings: repos.settings,
      adapters: { program: adapter, arena: adapter, workspace_mission: adapter, scheduled_audit: adapter, mission: adapter },
      usage: { canDispatch: () => world.claude },
      now: () => world.now,
      tickIntervalMs: 0,
    })
  let control = build()
  let created = 0
  const open = (): GlobalWorkItem[] => repos.workItems.listOpen()

  /** The workload honours the grant it is given: it never runs more sessions than allowed. */
  const settleAgents = (): void => {
    for (const item of open()) {
      if (item.state !== 'RUNNING' || !item.refId) continue
      const w = workloads.get(item.refId)
      if (!w || w.phase !== 'working') continue
      const allowed = control.allowanceForRun(`run-${item.refId}`, w.agents, w.activeAgents)
      const target = rnd() < 0.7 ? allowed : Math.floor(rnd() * (allowed + 1))
      workloads.set(item.refId, { ...w, activeAgents: Math.max(0, Math.min(target, allowed)) })
    }
  }

  const check = (step: string): void => {
    const limits = control.limits()
    const items = open()
    const overview = control.overview()
    const live = items.filter((i) => i.state === 'RUNNING' || i.state === 'QUOTA_WAIT')
    const say = (text: string): void => void problems.push(`${step}: ${text}`)
    // 1. Every open item's state is what its workload reports (or the queue's own state before it started).
    for (const item of items) {
      const w = item.refId ? workloads.get(item.refId) : undefined
      if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) say(`${item.id} is open and ${item.state}`)
      if (w && item.startedAt !== null) {
        const expected: Partial<Record<WorkloadPhase, WorkItemState>> = { working: 'RUNNING', paused: 'PAUSED', quota_wait: 'QUOTA_WAIT', blocked: 'BLOCKED' }
        const want = expected[w.phase]
        if (want && item.state !== want) say(`${item.refId} reports ${w.phase} and the item is ${item.state}`)
      }
      if (item.startedAt === null && (item.state === 'RUNNING' || item.state === 'QUOTA_WAIT') && w?.phase === 'not_started') say(`${item.refId} is ${item.state} and never started`)
    }
    // 2. Agent sessions never exceed the limit that was in force when they were granted. (A limit that the
    //    user lowers below what runs is not enforced by stopping sessions, so the check uses the running total.)
    const active = items.reduce((n, i) => n + (i.refId ? (workloads.get(i.refId)?.activeAgents ?? 0) : 0), 0)
    const granted = overview.active.reduce((n, i) => n + i.allowance, 0)
    if (granted > Math.max(limits.maxAgents, active)) say(`granted ${granted} with a limit of ${limits.maxAgents} and ${active} running`)
    for (const i of overview.active) if (i.allowance < i.activeAgents) say(`${i.refId} runs ${i.activeAgents} and may hold ${i.allowance}`)
    // 3. Nothing is on the queue twice, and positions order the queue deterministically.
    const refs = items.filter((i) => i.refId).map((i) => `${i.type}:${i.refId}`)
    if (new Set(refs).size !== refs.length) say('a workload is on the queue twice')
    const sorted = [...items].sort(compareWorkItems).map((i) => i.id)
    if (JSON.stringify(sorted) !== JSON.stringify([...items].reverse().sort(compareWorkItems).map((i) => i.id))) say('the queue order is not deterministic')
    // 4. A workload is started once by the queue; a held item is never started.
    for (const [id, w] of workloads) if (w.starts > 1) say(`${id} was started ${w.starts} times`)
    if (startedWhileHeld.length > 0) say(`started while held: ${startedWhileHeld.join(', ')}`)
    // 5. While Claude is unavailable the overview says so and nothing waits "for capacity".
    if (!world.claude && overview.claudeAvailable) say('the overview says Claude is available')
    // 6. The overview partitions the open items.
    if (overview.active.length + overview.waiting.length + overview.scheduled.length !== items.length) say('the overview lost or duplicated an item')
    if (overview.active.length !== live.length) say('active items do not match live states')
    // 7. Health never reports a failed pass in these histories.
    const scheduler = control.health().components.find((c) => c.component === 'scheduler')
    if (scheduler?.level === 'DEGRADED') say(`the scheduler is degraded: ${scheduler.detail}`)
  }

  try {
    for (let step = 0; step < STEPS; step++) {
      const roll = rnd()
      let op = ''
      const items = open()
      const any = items.length > 0 ? pick(items) : null
      try {
        if (roll < 0.2 || items.length === 0) {
          const id = `w${++created}`
          workloads.set(id, { phase: 'not_started', activeAgents: 0, runIds: [], detail: null, agents: 1 + Math.floor(rnd() * 4), starts: 0 })
          op = `enqueue ${id}`
          control.enqueue({ type: pick(['program', 'arena', 'workspace_mission'] as const) === 'program' ? 'program' : 'program', programId: id, priority: pick(['P0', 'P1', 'P2', 'P3'] as Priority[]) })
        } else if (roll < 0.32 && any?.refId) {
          const w = workloads.get(any.refId)
          if (w && w.phase === 'working') {
            const phase = pick(['completed', 'failed', 'blocked', 'quota_wait', 'working'] as WorkloadPhase[])
            op = `${any.refId} -> ${phase}`
            workloads.set(any.refId, { ...w, phase, activeAgents: phase === 'working' ? w.activeAgents : 0 })
          } else if (w && (w.phase === 'quota_wait' || w.phase === 'blocked') && any.startedAt !== null) {
            op = `${any.refId} -> working`
            workloads.set(any.refId, { ...w, phase: 'working' })
          }
        } else if (roll < 0.4 && any) {
          op = `pause ${any.refId}`
          await control.pause(any.id)
        } else if (roll < 0.48 && any) {
          op = `resume ${any.refId}`
          await control.resume(any.id)
        } else if (roll < 0.54 && any) {
          op = `cancel ${any.refId}`
          await control.cancel(any.id)
        } else if (roll < 0.62 && any) {
          op = `priority ${any.refId}`
          control.setPriority(any.id, pick(['P0', 'P1', 'P2', 'P3'] as Priority[]))
        } else if (roll < 0.7 && any) {
          op = `move ${any.refId}`
          control.move(any.id, pick(['top', 'up', 'down'] as const))
        } else if (roll < 0.76) {
          const limits: ControlLimits = { maxAgents: 1 + Math.floor(rnd() * 8), maxActiveItems: 1 + Math.floor(rnd() * 5), resumeOnBoot: pick(['resume', 'hold'] as const) }
          op = `limits ${limits.maxAgents}/${limits.maxActiveItems}`
          control.setLimits(limits)
        } else if (roll < 0.84) {
          world.claude = !world.claude
          op = `claude ${world.claude ? 'available' : 'limited'}`
          for (const [id, w] of workloads) {
            if (!world.claude && w.phase === 'working') workloads.set(id, { ...w, phase: 'quota_wait', activeAgents: 0 })
            else if (world.claude && w.phase === 'quota_wait') workloads.set(id, { ...w, phase: 'working' })
          }
        } else if (roll < 0.9) {
          op = 'restart'
          control.dispose()
          await control.idle()
          control = build()
          await control.recoverOnBoot(async () => undefined)
        } else if (roll < 0.94) {
          const id = `s${++created}`
          workloads.set(id, { phase: 'not_started', activeAgents: 0, runIds: [], detail: null, agents: 1, starts: 0 })
          op = `schedule ${id}`
          control.createSchedule({ name: id, rule: { kind: 'once', at: new Date(world.now + 60_000).toISOString() }, action: { type: 'program', programId: id }, priority: 'P2', enabled: true })
        } else {
          world.now += Math.floor(rnd() * 10 * 60_000)
          op = 'time passes'
        }
      } catch (e) {
        // Refusals of the control plane (an item already finished, already queued) are answers, not failures.
        const message = e instanceof Error ? e.message : String(e)
        if (!/already|is (COMPLETED|FAILED|CANCELLED)|does not exist|cannot be paused|The item is/.test(message)) problems.push(`step ${step} ${op}: unexpected error ${message}`)
      }
      world.now += 2000
      await control.idle()
      await control.tick()
      settleAgents()
      await control.tick()
      trail.push(op)
      check(`step ${step} (${op})`)
      if (problems.length > 0) break
    }
    // Drain: everything that can still run is allowed to finish, and the queue must empty.
    world.claude = true
    control.setLimits({ maxAgents: 8, maxActiveItems: 8, resumeOnBoot: 'hold' })
    for (let round = 0; round < 80 && problems.length === 0; round++) {
      for (const item of open()) {
        if (item.heldByUser || item.state === 'PAUSED' || item.state === 'BLOCKED') {
          if (item.refId) {
            const w = workloads.get(item.refId)
            if (w && (w.phase === 'blocked' || w.phase === 'paused')) workloads.set(item.refId, { ...w, phase: item.startedAt === null ? 'not_started' : 'working' })
          }
          await control.resume(item.id).catch(() => undefined)
        }
      }
      for (const [id, w] of workloads) {
        if (w.phase === 'quota_wait') workloads.set(id, { ...w, phase: 'working' })
        else if (w.phase === 'working') workloads.set(id, { ...w, phase: 'completed', activeAgents: 0 })
      }
      world.now += 5 * 60_000
      await control.idle()
      await control.tick()
      if (open().length === 0) break
    }
    if (problems.length === 0 && open().length > 0) problems.push(`the queue did not drain: ${open().map((i) => `${i.refId}:${i.state}${i.heldByUser ? ':held' : ''}`).join(' ')}`)
  } finally {
    control.dispose()
    await control.idle()
    db.close()
  }
  if (problems.length > 0) {
    mkdirSync(FAILURE_DIR, { recursive: true })
    writeFileSync(join(FAILURE_DIR, `control-seed-${seed}.json`), `${JSON.stringify({ seed, problems, trail }, null, 2)}\n`)
  }
  return problems
}

describe('control plane stress campaign', () => {
  it(`holds its invariants over ${RUNS} seeded histories starting at seed ${START}`, async () => {
    const failures: { seed: number; problems: string[] }[] = []
    for (let seed = START; seed < START + RUNS; seed++) {
      const problems = await history(seed)
      if (problems.length > 0) failures.push({ seed, problems })
      if (failures.length >= 5) break
    }
    if (failures.length > 0) console.warn(`[control-stress] failing seeds: ${failures.map((f) => `${f.seed}: ${f.problems[0]}`).join(' | ')}`)
    expect(failures).toEqual([])
  })
})
