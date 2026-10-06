import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalWorkItem, Priority, WorkloadSnapshot } from '@shared/control-plane'
import { ControlPlane, type WorkloadAdapter } from '@main/modules/control-plane'
import { createRepositories, openDatabase, type Database } from '@main/modules/persistence'

/**
 * The control plane with a long history and a full queue: 100 open workloads, 10,000 finished ones, thousands
 * of incidents, decisions, worker records and security decisions. What a window reads must stay bounded however
 * long NEXUS has been used, and a scheduler pass must stay cheap.
 */
describe('control plane at scale', () => {
  let db: Database | null = null
  let control: ControlPlane | null = null
  afterEach(() => {
    control?.dispose()
    if (db?.open) db.close()
  })

  it('answers the overview and runs a pass quickly with 100 open and 10,000 finished workloads, and returns bounded lists', async () => {
    db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const at = Date.parse('2026-10-05T10:00:00.000Z')
    const iso = (ms: number): string => new Date(ms).toISOString()
    const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3']
    const workloads = new Map<string, WorkloadSnapshot>()

    const base = (i: number): GlobalWorkItem => ({ id: `item-${i}`, type: 'program', refId: `w-${i}`, title: `Workload ${i}`, priority: priorities[i % 4] as Priority, position: i, state: 'COMPLETED', requestedAgents: 2, deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false, payload: null, detail: null, createdAt: iso(at - (20_000 - i) * 1000), updatedAt: iso(at), startedAt: iso(at - 1000), finishedAt: iso(at - (10_000 - i) * 1000) })
    repos.transaction(() => {
      for (let i = 0; i < 10_000; i++) repos.workItems.insert(base(i))
      for (let i = 10_000; i < 10_100; i++) {
        const running = i < 10_004
        const blocked = i >= 10_090
        repos.workItems.insert({ ...base(i), state: running ? 'RUNNING' : blocked ? 'BLOCKED' : 'QUEUED', startedAt: running || blocked ? iso(at - 5000) : null, finishedAt: null })
        workloads.set(`w-${i}`, { phase: running ? 'working' : blocked ? 'blocked' : 'not_started', activeAgents: running ? 1 : 0, runIds: running ? [`run-${i}`] : [], detail: blocked ? 'Waiting for a decision.' : null })
      }
      for (let i = 0; i < 5000; i++) {
        repos.controlIncidents.insert({ id: `inc-${i}`, at: iso(at - i * 1000), summary: `Incident ${i}`, itemId: `item-${10_000 + (i % 100)}` })
        repos.schedulerDecisions.insert({ at: iso(at - i * 1000), itemId: `item-${10_000 + (i % 100)}`, decision: 'WAIT', reason: `Reason ${i}` })
        repos.securityDecisions.record({ id: `sec-${i}`, timestamp: iso(at - i * 1000), runId: `run-${i % 50}`, taskId: null, agentId: null, action: `command ${i}`, classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: 'AGENT_WRITTEN', decision: 'DENY', reason: 'refused', policyVersion: '1' } as never)
      }
      for (let i = 0; i < 3000; i++) {
        repos.workers.insert({ id: `worker-${i}`, bootId: 'old', pid: 1000 + i, state: 'STARTING', startedAt: iso(at - i * 1000), heartbeatAt: null, stoppedAt: null, exitCode: null, error: null, assignments: 0, capabilities: ['claude'], assignment: null })
        repos.workers.save({ id: `worker-${i}`, bootId: 'old', pid: 1000 + i, state: 'STOPPED', startedAt: iso(at - i * 1000), heartbeatAt: null, stoppedAt: iso(at - i * 900), exitCode: 0, error: null, assignments: 3, capabilities: ['claude'], assignment: null })
        repos.workers.event({ workerId: `worker-${i}`, at: iso(at - i * 900), kind: 'STOPPED', detail: null })
      }
    })

    const adapter: WorkloadAdapter = {
      start: async (item) => {
        workloads.set(item.refId as string, { phase: 'working', activeAgents: 0, runIds: [`run-${item.refId}`], detail: null })
        return item.refId as string
      },
      pause: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
      snapshot: (id) => workloads.get(id) ?? { phase: 'missing', activeAgents: 0, runIds: [], detail: null },
      title: ({ refId }) => refId,
      requestedAgents: () => 2,
    }
    control = new ControlPlane({
      items: repos.workItems,
      schedules: repos.controlSchedules,
      incidents: repos.controlIncidents,
      firings: repos.scheduleFirings,
      decisions: repos.schedulerDecisions,
      transaction: repos.transaction,
      settings: repos.settings,
      adapters: { program: adapter },
      usage: { canDispatch: () => true },
      now: () => at,
      tickIntervalMs: 0,
    })
    control.setLimits({ maxAgents: 6, maxActiveItems: 4, resumeOnBoot: 'hold', agingMinutes: 30 })
    await control.idle()

    const passes: number[] = []
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      await control.tick()
      passes.push(performance.now() - started)
    }
    const reads: number[] = []
    let overview = control.overview()
    for (let i = 0; i < 20; i++) {
      const started = performance.now()
      overview = control.overview()
      reads.push(performance.now() - started)
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
    // Generous bounds: they catch a pass or a read that walks the whole history, not a slow machine.
    expect(median(passes), `a scheduler pass took ${median(passes).toFixed(1)} ms`).toBeLessThan(250)
    expect(median(reads), `the overview took ${median(reads).toFixed(1)} ms`).toBeLessThan(100)

    // The window gets every open item and a bounded slice of everything that is history.
    expect(overview.active.length + overview.waiting.length + overview.scheduled.length).toBe(100)
    expect(overview.finished).toHaveLength(20)
    expect(overview.incidents).toHaveLength(20)
    expect(overview.waiting.filter((i) => i.state === 'BLOCKED')).toHaveLength(10)
    expect(overview.waiting.filter((i) => i.state === 'BLOCKED').every((i) => i.reason === 'Waiting for a decision.')).toBe(true)
    const bytes = Buffer.byteLength(JSON.stringify(overview))
    expect(bytes, `the overview is ${bytes} bytes`).toBeLessThan(200_000)
    // Capacity holds with a full queue: nothing beyond the limits was started.
    expect(overview.active.length).toBeLessThanOrEqual(4)
    expect(overview.active.reduce((n, i) => n + i.allowance, 0)).toBeLessThanOrEqual(6)

    // The other histories are read in pages, never whole.
    expect(repos.schedulerDecisions.ofItem('item-10050', 30).length).toBeLessThanOrEqual(30)
    expect(repos.securityDecisions.list({ limit: 10_000 }).decisions.length).toBeLessThanOrEqual(200)
    expect(repos.workers.listEnded(10_000).length).toBeLessThanOrEqual(200)
    expect(repos.workers.recentEvents(10_000).length).toBeLessThanOrEqual(500)
    expect(repos.workItems.listFinished(10_000).length).toBeLessThanOrEqual(200)
    // And the worker history prunes itself.
    repos.workers.prune(500)
    expect(repos.workers.listEnded(200).length).toBe(200)
    expect((db.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number }).n).toBe(500)
  })
})
