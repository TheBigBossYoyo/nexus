import { afterEach, describe, expect, it } from 'vitest'
import { canTransitionWorker, WORKER_STATES, WORKER_TRANSITIONS } from '@shared/workers'
import type { AgentEvent, AgentSessionHandle, SessionSpec, ToolDecision } from '@main/modules/agent-runtime/types'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { WorkerManager, type WorkerProcess } from '@main/modules/workers'
import type { RuntimeToWorker, WorkerToRuntime } from '@main/modules/workers'

/** A worker process that exists only in the test: it records what the manager sends and says what the test makes it say. */
class FakeWorker implements WorkerProcess {
  readonly sent: RuntimeToWorker[] = []
  killed = false
  exited = false
  private messageListener: ((message: WorkerToRuntime) => void) | null = null
  private exitListener: ((code: number | null, signal: string | null) => void) | null = null

  constructor(readonly pid: number) {}

  /** Set at the end of a test: the worker then obeys `shutdown` like a real one. */
  obeysShutdown = false

  send(message: RuntimeToWorker): void {
    this.sent.push(message)
    if (message.t === 'shutdown' && this.obeysShutdown) queueMicrotask(() => this.exit(0))
  }
  async kill(): Promise<void> {
    this.killed = true
    this.exit(null, 'SIGKILL')
  }
  onMessage(listener: (message: WorkerToRuntime) => void): void {
    this.messageListener = listener
  }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListener = listener
  }
  say(message: WorkerToRuntime): void {
    this.messageListener?.(message)
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return
    this.exited = true
    this.exitListener?.(code, signal)
  }
  assignment(): Extract<RuntimeToWorker, { t: 'assign' }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<RuntimeToWorker, { t: 'assign' }> => m.t === 'assign')
  }
  last<T extends RuntimeToWorker['t']>(t: T): Extract<RuntimeToWorker, { t: T }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<RuntimeToWorker, { t: T }> => m.t === t)
  }
}

function spec(agentId: string, overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId,
    role: 'worker',
    cwd: `C:\\worktrees\\${agentId}`,
    maxTurns: 10,
    systemPromptAppend: '',
    prompt: 'do the task',
    tools: ['Read'],
    authorize: async (): Promise<ToolDecision> => ({ behavior: 'allow' }),
    requestApproval: async () => true,
    loadProjectSettings: false,
    subscriptionMode: true,
    ...overrides,
  }
}

async function drain(handle: AgentSessionHandle): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of handle.events) events.push(event)
  return events
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Rig {
  manager: WorkerManager
  workers: FakeWorker[]
  repos: ReturnType<typeof createRepositories>
  clock: { now: number }
  /** Makes the newest worker report ready. */
  ready(index?: number): FakeWorker
}

const rigs: { manager: WorkerManager; workers: FakeWorker[] }[] = []

function rig(options: { maxWorkers?: number; bootId?: string; repos?: ReturnType<typeof createRepositories>; timings?: Record<string, number> } = {}): Rig {
  const repos = options.repos ?? createRepositories(openDatabase(':memory:'))
  const workers: FakeWorker[] = []
  const clock = { now: Date.parse('2026-10-05T10:00:00.000Z') }
  const manager = new WorkerManager({
    workers: repos.workers,
    leases: repos.workerLeases,
    bootId: options.bootId ?? 'boot-1',
    launcher: () => {
      const worker = new FakeWorker(4000 + workers.length)
      workers.push(worker)
      return worker
    },
    config: () => ({ heartbeatMs: 2000, fake: { script: 'probe' } }),
    maxWorkers: () => options.maxWorkers ?? 2,
    context: (agentId) => ({ runId: `run-of-${agentId}`, taskId: `task-of-${agentId}` }),
    timings: { tickMs: 0, ...options.timings },
    now: () => clock.now,
  })
  rigs.push({ manager, workers })
  return {
    manager,
    workers,
    repos,
    clock,
    ready: (index = workers.length - 1) => {
      const worker = workers[index] as FakeWorker
      worker.say({ t: 'ready', pid: worker.pid, capabilities: ['claude', 'codex'] })
      return worker
    },
  }
}

afterEach(async () => {
  for (const { manager, workers } of rigs.splice(0)) {
    for (const worker of workers) worker.obeysShutdown = true
    await manager.shutdown()
  }
})

describe('worker states', () => {
  it('ended workers never come back, and every state has its transitions written down', () => {
    expect(Object.keys(WORKER_TRANSITIONS).sort()).toEqual([...WORKER_STATES].sort())
    for (const to of WORKER_STATES) {
      expect(canTransitionWorker('STOPPED', to)).toBe(false)
      expect(canTransitionWorker('FAILED', to)).toBe(false)
    }
    expect(canTransitionWorker('STARTING', 'RUNNING')).toBe(false)
    expect(canTransitionWorker('IDLE', 'RUNNING')).toBe(false)
    expect(canTransitionWorker('IDLE', 'ASSIGNED')).toBe(true)
    expect(canTransitionWorker('ASSIGNED', 'RUNNING')).toBe(true)
    expect(canTransitionWorker('RUNNING', 'IDLE')).toBe(true)
  })
})

describe('WorkerManager', () => {
  it('starts a worker for a session, assigns it under a lease, forwards its events, and releases the lease at the end', async () => {
    const r = rig()
    const handle = r.manager.startSession('claude', spec('a1'))
    const events = drain(handle)
    await flush()
    expect(r.workers).toHaveLength(1)
    expect(r.workers[0]?.sent[0]).toMatchObject({ t: 'init' })
    expect(r.manager.overview().workers[0]).toMatchObject({ state: 'STARTING', pid: 4000 })

    const worker = r.ready()
    const assign = worker.assignment()
    expect(assign).toMatchObject({ provider: 'claude', spec: { agentId: 'a1', cwd: 'C:\\worktrees\\a1' } })
    // The specification crosses the process boundary as data: no function is part of it.
    expect(JSON.parse(JSON.stringify(assign?.spec))).toEqual(assign?.spec)
    const leaseId = assign?.leaseId as string
    expect(r.repos.workerLeases.listActive()).toMatchObject([{ id: leaseId, agentId: 'a1', runId: 'run-of-a1', taskId: 'task-of-a1', provider: 'claude', state: 'ACTIVE' }])
    expect(r.manager.overview().workers[0]).toMatchObject({ state: 'ASSIGNED', assignment: { agentId: 'a1', worktree: 'C:\\worktrees\\a1', sessionId: null } })

    worker.say({ t: 'event', leaseId, event: { type: 'session.started', sessionId: 's-1', model: 'm', tools: [], apiKeySource: null } })
    expect(handle.sessionId()).toBe('s-1')
    expect(r.manager.overview().workers[0]).toMatchObject({ state: 'RUNNING', assignment: { sessionId: 's-1' } })
    worker.say({ t: 'event', leaseId, event: { type: 'text', text: 'hello' } })
    worker.say({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'completed', error: null } })
    worker.say({ t: 'ended', leaseId })

    expect((await events).map((e) => e.type)).toEqual(['session.started', 'text', 'session.ended'])
    expect(r.repos.workerLeases.listActive()).toEqual([])
    expect(r.repos.workerLeases.get(leaseId)).toMatchObject({ state: 'RELEASED' })
    expect(r.manager.overview().workers[0]).toMatchObject({ state: 'IDLE', assignment: null, assignments: 1 })
  })

  it('reuses an idle worker, never exceeds the worker limit, and makes a session beyond it wait', async () => {
    const r = rig({ maxWorkers: 2 })
    const first = r.manager.startSession('claude', spec('a1'))
    const second = r.manager.startSession('claude', spec('a2'))
    const third = r.manager.startSession('claude', spec('a3'))
    void drain(first)
    void drain(second)
    const thirdEvents = drain(third)
    await flush()
    expect(r.workers).toHaveLength(2)
    r.ready(0)
    r.ready(1)
    expect(r.manager.counts()).toMatchObject({ live: 2, busy: 2, waitingAssignments: 1 })
    // A worker holds one assignment: the third session was given to nobody.
    expect(r.workers.flatMap((w) => w.sent.filter((m) => m.t === 'assign')).map((m) => (m as { spec: { agentId: string } }).spec.agentId).sort()).toEqual(['a1', 'a2'])

    const w0 = r.workers[0] as FakeWorker
    const lease0 = w0.assignment()?.leaseId as string
    w0.say({ t: 'event', leaseId: lease0, event: { type: 'session.ended', reason: 'completed', error: null } })
    w0.say({ t: 'ended', leaseId: lease0 })
    // The freed worker takes the waiting session; no third process was started.
    expect(r.workers).toHaveLength(2)
    expect(w0.assignment()?.spec.agentId).toBe('a3')
    const lease3 = w0.assignment()?.leaseId as string
    w0.say({ t: 'event', leaseId: lease3, event: { type: 'session.ended', reason: 'completed', error: null } })
    w0.say({ t: 'ended', leaseId: lease3 })
    expect((await thirdEvents).at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' })
  })

  it('takes the session back when its worker process dies: the session ends as crashed, never as completed', async () => {
    const r = rig()
    const handle = r.manager.startSession('claude', spec('a1'))
    const events = drain(handle)
    await flush()
    const worker = r.ready()
    const leaseId = worker.assignment()?.leaseId as string
    worker.say({ t: 'event', leaseId, event: { type: 'text', text: 'working' } })
    // The process is gone, with exit code 0: that says nothing about the work.
    worker.exit(0)

    const all = await events
    expect(all.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    expect((all.at(-1) as { error: string }).error).toContain('Worker lost')
    // The process that hosted the session is gone, so its stop is confirmed: capacity held for it can be freed.
    // (It was not: an unexpected exit left the capacity quarantined until the runtime was restarted.)
    expect(handle.stopConfirmed?.()).toBe(true)
    expect(r.repos.workerLeases.get(leaseId)).toMatchObject({ state: 'REVOKED' })
    expect(r.repos.workerLeases.listActive()).toEqual([])
    const record = r.repos.workers.listEnded(5)[0]
    expect(record).toMatchObject({ state: 'FAILED', exitCode: 0 })

    // The same agent session can be assigned again: nothing stale blocks it.
    const again = r.manager.startSession('claude', spec('a1'))
    void drain(again)
    await flush()
    expect(r.workers).toHaveLength(2)
    r.ready()
    expect(r.repos.workerLeases.listActive()).toMatchObject([{ agentId: 'a1', workerId: expect.not.stringMatching(record?.id ?? 'x') as unknown as string }])
  })

  it('ends a worker whose heartbeat stopped, expires its lease, and ends its process tree', async () => {
    const r = rig({ timings: { heartbeatTimeoutMs: 20_000 } })
    const handle = r.manager.startSession('claude', spec('a1'))
    const events = drain(handle)
    await flush()
    const worker = r.ready()
    const leaseId = worker.assignment()?.leaseId as string
    worker.say({ t: 'hb', leaseId })
    r.clock.now += 19_000
    r.manager.tick()
    expect(worker.killed).toBe(false)
    r.clock.now += 2000
    r.manager.tick()
    await flush()
    expect(worker.killed).toBe(true)
    expect((await events).at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    expect(r.repos.workerLeases.get(leaseId)).toMatchObject({ state: 'EXPIRED' })
    expect(r.repos.workers.listEnded(5)[0]).toMatchObject({ state: 'FAILED' })
    expect(r.repos.workers.listEnded(5)[0]?.error).toContain('No heartbeat')
  })

  it('renews a lease while its worker is heard, and no lease outlives its time when nobody renews it', async () => {
    const r = rig({ timings: { leaseTtlMs: 30_000, heartbeatTimeoutMs: 10 * 60_000 } })
    void drain(r.manager.startSession('claude', spec('a1')))
    await flush()
    const worker = r.ready()
    const leaseId = worker.assignment()?.leaseId as string
    const granted = r.repos.workerLeases.get(leaseId)?.expiresAt as string
    r.clock.now += 15_000
    worker.say({ t: 'hb', leaseId })
    const renewed = r.repos.workerLeases.get(leaseId)?.expiresAt as string
    expect(Date.parse(renewed)).toBeGreaterThan(Date.parse(granted))
    // Silence: the heartbeat limit is far away here, so it is the lease that runs out.
    r.clock.now += 31_000
    r.manager.tick()
    await flush()
    expect(r.repos.workerLeases.get(leaseId)?.state).toBe('EXPIRED')
    expect(worker.killed).toBe(true)

    // A lease whose holder this manager does not know (left by something that vanished) expires too.
    r.repos.workerLeases.grant({ id: 'orphan', workerId: 'gone', bootId: 'boot-1', agentId: 'a9', runId: null, taskId: null, provider: 'claude', state: 'ACTIVE', grantedAt: new Date(r.clock.now).toISOString(), heartbeatAt: new Date(r.clock.now).toISOString(), expiresAt: new Date(r.clock.now + 1000).toISOString(), releasedAt: null, reason: null })
    r.clock.now += 2000
    r.manager.tick()
    expect(r.repos.workerLeases.get('orphan')?.state).toBe('EXPIRED')
    expect(r.repos.workerLeases.listActive()).toEqual([])
  })

  it('never gives one agent session to two workers', async () => {
    const r = rig({ maxWorkers: 3 })
    const first = r.manager.startSession('claude', spec('same'))
    void drain(first)
    await flush()
    const w0 = r.ready(0)
    const second = r.manager.startSession('claude', spec('same'))
    const secondEvents = drain(second)
    await flush()
    r.ready(1)
    // The database refused the second lease; the second session ends, the first is untouched.
    expect((await secondEvents).at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
    const active = r.repos.workerLeases.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]?.id).toBe(w0.assignment()?.leaseId)
    expect((r.workers[1] as FakeWorker).sent.some((m) => m.t === 'assign')).toBe(false)
  })

  it('ignores a worker that speaks for a lease it does not hold', async () => {
    const r = rig({ maxWorkers: 2 })
    const one = r.manager.startSession('claude', spec('a1'))
    const two = r.manager.startSession('claude', spec('a2'))
    void drain(two)
    await flush()
    const w0 = r.ready(0)
    const w1 = r.ready(1)
    const lease0 = w0.assignment()?.leaseId as string
    const lease1 = w1.assignment()?.leaseId as string
    // Worker 1 claims worker 0's lease: nothing reaches session a1, and no callback of a1 runs for it.
    w1.say({ t: 'event', leaseId: lease0, event: { type: 'text', text: 'forged' } })
    w1.say({ t: 'call', id: 7, leaseId: lease0, method: 'authorize', args: [{ agentId: 'a1', toolName: 'Bash', input: {}, toolUseId: 't' }] })
    w1.say({ t: 'ended', leaseId: lease0 })
    await flush()
    expect(w1.last('callResult')).toMatchObject({ id: 7, ok: false })
    expect(r.repos.workerLeases.get(lease0)?.state).toBe('ACTIVE')
    expect(r.repos.workerLeases.get(lease1)?.state).toBe('ACTIVE')
    w0.say({ t: 'event', leaseId: lease0, event: { type: 'session.ended', reason: 'completed', error: null } })
    w0.say({ t: 'ended', leaseId: lease0 })
    expect((await drain(one)).map((e) => e.type)).toEqual(['session.ended'])
  })

  it('decides every tool call in the runtime: the worker asks, the policy of the session answers', async () => {
    const r = rig()
    const asked: string[] = []
    const handle = r.manager.startSession(
      'claude',
      spec('a1', {
        authorize: async (request) => {
          asked.push(request.toolName)
          return request.toolName === 'Bash' ? { behavior: 'deny', reason: 'not in this profile' } : { behavior: 'allow' }
        },
        requestApproval: async () => false,
        nexusTools: {
          sendMessage: async (input) => `sent ${input.subject}`,
          reportBlocker: async () => 'ok',
          recordDecision: async () => 'ok',
          proposeMemory: async () => 'ok',
        },
      }),
    )
    void drain(handle)
    await flush()
    const worker = r.ready()
    const leaseId = worker.assignment()?.leaseId as string
    expect(worker.assignment()?.spec.nexusTools).toEqual({ proposeGraphChange: false, contextTool: false })

    worker.say({ t: 'call', id: 1, leaseId, method: 'authorize', args: [{ agentId: 'a1', toolName: 'Bash', input: { command: 'powershell foo.ps1' }, toolUseId: 't1' }] })
    worker.say({ t: 'call', id: 2, leaseId, method: 'requestApproval', args: [{ agentId: 'a1', toolName: 'Bash', input: {}, toolUseId: 't1' }, 'why', 'high'] })
    worker.say({ t: 'call', id: 3, leaseId, method: 'sendMessage', args: [{ subject: 'status' }] })
    worker.say({ t: 'call', id: 4, leaseId, method: 'proposeGraphChange', args: [{}] })
    await flush()
    const results = worker.sent.filter((m): m is Extract<RuntimeToWorker, { t: 'callResult' }> => m.t === 'callResult')
    expect(results.find((m) => m.id === 1)).toMatchObject({ ok: true, value: { behavior: 'deny', reason: 'not in this profile' } })
    expect(results.find((m) => m.id === 2)).toMatchObject({ ok: true, value: false })
    expect(results.find((m) => m.id === 3)).toMatchObject({ ok: true, value: 'sent status' })
    expect(results.find((m) => m.id === 4)).toMatchObject({ ok: false })
    expect(asked).toEqual(['Bash'])
  })

  it('stops a waiting session without a worker, and ends the worker of a session that does not obey stop', async () => {
    const r = rig({ maxWorkers: 1, timings: { stopTimeoutMs: 30 } })
    const running = r.manager.startSession('claude', spec('a1'))
    const waiting = r.manager.startSession('claude', spec('a2'))
    const runningEvents = drain(running)
    const waitingEvents = drain(waiting)
    await flush()
    const worker = r.ready()
    await waiting.stop()
    expect((await waitingEvents).at(-1)).toMatchObject({ type: 'session.ended', reason: 'stopped' })

    // The worker receives the stop and does nothing: cancelling must still end what NEXUS started.
    await running.stop()
    expect(worker.last('cmd')).toMatchObject({ op: 'stop' })
    expect(worker.killed).toBe(true)
    expect((await runningEvents).at(-1)).toMatchObject({ type: 'session.ended', reason: 'stopped' })
    expect(r.repos.workerLeases.listActive()).toEqual([])
  })

  it('passes messages sent before the assignment, in order', async () => {
    const r = rig()
    const handle = r.manager.startSession('claude', spec('a1'))
    void drain(handle)
    handle.send('first')
    handle.send('second')
    handle.end()
    await flush()
    const worker = r.ready()
    expect(worker.sent.filter((m) => m.t === 'cmd').map((m) => [(m as { op: string }).op, (m as { text?: string }).text])).toEqual([
      ['send', 'first'],
      ['send', 'second'],
      ['end', undefined],
    ])
  })

  it('fails a worker that never reports ready and gives its session a clear end', async () => {
    const r = rig({ maxWorkers: 1, timings: { startTimeoutMs: 5000 } })
    const handle = r.manager.startSession('claude', spec('a1'))
    void drain(handle)
    await flush()
    r.clock.now += 6000
    r.manager.tick()
    await flush()
    expect((r.workers[0] as FakeWorker).killed).toBe(true)
    expect(r.repos.workers.listEnded(5)[0]).toMatchObject({ state: 'FAILED' })
    // The session still waits for a worker; the next one takes it.
    expect(r.workers).toHaveLength(2)
    r.ready(1)
    expect((r.workers[1] as FakeWorker).assignment()?.spec.agentId).toBe('a1')
  })

  it('stops an idle worker after a while, and replaces a worker after its share of assignments', async () => {
    const r = rig({ maxWorkers: 1, timings: { idleTtlMs: 60_000, maxAssignments: 1 } })
    void drain(r.manager.startSession('claude', spec('a1')))
    await flush()
    const worker = r.ready()
    const leaseId = worker.assignment()?.leaseId as string
    worker.say({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'completed', error: null } })
    worker.say({ t: 'ended', leaseId })
    // One assignment was its share: it is asked to end instead of becoming idle.
    expect(worker.last('shutdown')).toBeDefined()
    expect(r.manager.overview().workers[0]?.state).toBe('STOPPING')
    worker.exit(0)
    expect(r.repos.workers.listEnded(5)[0]).toMatchObject({ state: 'STOPPED', exitCode: 0 })

    const r2 = rig({ maxWorkers: 1, timings: { idleTtlMs: 60_000 } })
    void drain(r2.manager.startSession('claude', spec('b1')))
    await flush()
    const idle = r2.ready()
    const lease = idle.assignment()?.leaseId as string
    idle.say({ t: 'event', leaseId: lease, event: { type: 'session.ended', reason: 'completed', error: null } })
    idle.say({ t: 'ended', leaseId: lease })
    expect(r2.manager.overview().workers[0]?.state).toBe('IDLE')
    r2.clock.now += 61_000
    // Heard recently, so it is idle and not lost.
    idle.say({ t: 'hb', leaseId: null })
    r2.manager.tick()
    expect(idle.last('shutdown')).toBeDefined()
  })

  it('after a restart of the runtime marks the earlier workers and leases stale, kills nothing, and judges no session', () => {
    const repos = createRepositories(openDatabase(':memory:'))
    const at = '2026-10-05T09:00:00.000Z'
    repos.workers.insert({ id: 'w-old', bootId: 'boot-0', pid: 99999, state: 'STARTING', startedAt: at, heartbeatAt: at, stoppedAt: null, exitCode: null, error: null, assignments: 1, capabilities: ['claude'], assignment: null })
    repos.workers.save({ id: 'w-old', bootId: 'boot-0', pid: 99999, state: 'RUNNING', startedAt: at, heartbeatAt: at, stoppedAt: null, exitCode: null, error: null, assignments: 1, capabilities: ['claude'], assignment: { leaseId: 'l-old', agentId: 'a1', runId: 'r1', taskId: 't1', provider: 'claude', sessionId: 's1', worktree: 'C:\\w', assignedAt: at } })
    repos.workerLeases.grant({ id: 'l-old', workerId: 'w-old', bootId: 'boot-0', agentId: 'a1', runId: 'r1', taskId: 't1', provider: 'claude', state: 'ACTIVE', grantedAt: at, heartbeatAt: at, expiresAt: '2099-01-01T00:00:00.000Z', releasedAt: null, reason: null })

    const r = rig({ repos, bootId: 'boot-1' })
    expect(r.manager.recoverOnBoot()).toEqual({ workers: 1, leases: 1 })
    expect(repos.workers.get('w-old')).toMatchObject({ state: 'STOPPED', assignment: null })
    expect(repos.workers.get('w-old')?.error).toContain('runtime restarted')
    expect(repos.workerLeases.get('l-old')).toMatchObject({ state: 'EXPIRED' })
    expect(repos.workerLeases.listActive()).toEqual([])
    expect(r.workers).toHaveLength(0)
    // A second pass finds nothing more to do.
    expect(r.manager.recoverOnBoot()).toEqual({ workers: 0, leases: 0 })
  })

  it('on shutdown ends every session as stopped and leaves no worker and no lease', async () => {
    const r = rig({ maxWorkers: 2 })
    const a = r.manager.startSession('claude', spec('a1'))
    const b = r.manager.startSession('claude', spec('a2'))
    const c = r.manager.startSession('claude', spec('a3'))
    const ends = [drain(a), drain(b), drain(c)]
    await flush()
    r.ready(0)
    r.ready(1)
    const stopping = r.manager.shutdown()
    for (const worker of r.workers) {
      expect(worker.last('shutdown')).toBeDefined()
      worker.exit(0)
    }
    await stopping
    for (const events of await Promise.all(ends)) expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'stopped' })
    expect(r.repos.workerLeases.listActive()).toEqual([])
    expect(r.repos.workers.listLive()).toEqual([])
    // Nothing starts after that.
    const late = await drain(r.manager.startSession('claude', spec('a4')))
    expect(late.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
  })
})
