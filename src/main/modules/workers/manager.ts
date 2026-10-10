import { fork } from 'node:child_process'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { canTransitionWorker, LIVE_WORKER_STATES, type WorkerLease, type WorkerRecord, type WorkersOverview, type WorkerState } from '@shared/workers'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import type { AgentEvent, AgentSessionHandle, SessionSpec, ToolRequest } from '@main/modules/agent-runtime/types'
import { toWireSpec, type RuntimeToWorker, type WorkerCallMethod, type WorkerConfig, type WorkerToRuntime } from './protocol'

/** One worker process as the manager sees it. Tests supply their own; production forks `worker.js`. */
export interface WorkerProcess {
  readonly pid: number | null
  send(message: RuntimeToWorker): void
  /** Ends the process and what it started, without asking it. */
  kill(): Promise<void>
  onMessage(listener: (message: WorkerToRuntime) => void): void
  /** Called once, when the process is gone. */
  onExit(listener: (code: number | null, signal: string | null) => void): void
}

export type WorkerLauncher = (workerId: string) => WorkerProcess

export interface WorkerStorePort {
  insert(worker: WorkerRecord): void
  save(worker: WorkerRecord): void
  listLive(): WorkerRecord[]
  listEnded(limit: number): WorkerRecord[]
  event(event: { workerId: string; at: string; kind: string; detail: string | null }): void
  recentEvents(limit: number): { workerId: string; at: string; kind: string; detail: string | null }[]
  prune(keep?: number): void
}

export interface LeaseStorePort {
  grant(lease: WorkerLease): void
  renew(id: string, heartbeatAt: string, expiresAt: string): boolean
  end(id: string, state: 'RELEASED' | 'EXPIRED' | 'REVOKED', at: string, reason: string | null): boolean
  listActive(): WorkerLease[]
  recent(limit: number): WorkerLease[]
}

export interface WorkerTimings {
  /** How often a worker says that it is alive. */
  heartbeatMs: number
  /** A worker that has said nothing for this long is taken for lost and ended. */
  heartbeatTimeoutMs: number
  /** How long a lease lasts beyond its last renewal. */
  leaseTtlMs: number
  /** An idle worker is stopped after this long. */
  idleTtlMs: number
  /** A worker is replaced after this many assignments. */
  maxAssignments: number
  /** A worker that has not reported ready after this long failed to start. */
  startTimeoutMs: number
  /** How long a session may take to obey `stop` before its worker is ended. */
  stopTimeoutMs: number
  /** Milliseconds between checks; 0 disables the timer (tests call `tick()`). */
  tickMs: number
}

export const DEFAULT_WORKER_TIMINGS: WorkerTimings = { heartbeatMs: 2000, heartbeatTimeoutMs: 20_000, leaseTtlMs: 30_000, idleTtlMs: 60_000, maxAssignments: 25, startTimeoutMs: 45_000, stopTimeoutMs: 15_000, tickMs: 1000 }

export interface WorkerManagerDeps {
  workers: WorkerStorePort
  leases: LeaseStorePort
  /** The id of this start of the runtime. */
  bootId: string
  launcher: WorkerLauncher
  config: () => WorkerConfig
  /** The most worker processes at once; a session beyond it waits for a worker. */
  maxWorkers: () => number
  /** The run and task an agent session belongs to, for the lease and the worker view. */
  context?: (agentId: string) => { runId: string | null; taskId: string | null }
  timings?: Partial<WorkerTimings>
  now?: () => number
  onChange?: () => void
  logger?: (line: string) => void
}

interface Session {
  provider: string
  spec: SessionSpec
  events: AsyncQueue<AgentEvent>
  sessionId: string | null
  /** Messages sent before a worker took the session. */
  queued: { op: 'send' | 'end'; text?: string }[]
  workerId: string | null
  leaseId: string | null
  ended: boolean
  stopConfirmed: boolean
}

interface Live {
  record: WorkerRecord
  process: WorkerProcess
  session: Session | null
  lastRenewAt: number
  idleSince: number
  startedAt: number
  nextCommand: number
  commands: Map<number, { resolve: () => void; reject: (e: Error) => void }>
  exited: boolean
}

/**
 * The worker manager: starts worker processes, gives each at most one agent session to run under a durable
 * lease, watches their heartbeats, and takes a session back when its worker is lost. A lost worker never
 * counts as a finished session: the session ends as crashed, and what happens to its task is decided by the
 * orchestrator from what is on disk, as for any crashed session.
 */
export class WorkerManager {
  private readonly live = new Map<string, Live>()
  private readonly waiting: Session[] = []
  private readonly timings: WorkerTimings
  private timer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private lastPruneAt = 0

  constructor(private readonly deps: WorkerManagerDeps) {
    this.timings = { ...DEFAULT_WORKER_TIMINGS, ...deps.timings }
    if (this.timings.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.timings.tickMs)
      this.timer.unref()
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  private log(line: string): void {
    this.deps.logger?.(`workers: ${line}`)
  }

  private event(workerId: string, kind: string, detail: string | null): void {
    try {
      this.deps.workers.event({ workerId, at: this.iso(), kind, detail })
    } catch (e) {
      this.log(`event not recorded: ${errorMessage(e)}`)
    }
  }

  private save(record: WorkerRecord): void {
    try {
      this.deps.workers.save(record)
    } catch (e) {
      this.log(`worker ${record.id} not saved: ${errorMessage(e)}`)
    }
    this.deps.onChange?.()
  }

  private transition(worker: Live, to: WorkerState, detail: string | null = null): void {
    const from = worker.record.state
    if (from === to) return
    if (!canTransitionWorker(from, to)) {
      this.log(`refused transition of worker ${worker.record.id}: ${from} -> ${to}`)
      return
    }
    worker.record.state = to
    if (to === 'STOPPED' || to === 'FAILED') worker.record.stoppedAt = this.iso()
    this.event(worker.record.id, to, detail)
    this.save(worker.record)
  }

  // ───────────────────────────── start of the runtime ─────────────────────────────

  /**
   * After a restart of the runtime: workers and leases of the earlier start are stale. A worker ends itself
   * when its runtime is gone, so nothing is killed here: a process id from an earlier start may by now belong
   * to anything. Sessions those workers ran are not judged; the orchestrator's recovery reads the worktrees.
   */
  recoverOnBoot(): { workers: number; leases: number } {
    let workers = 0
    let leases = 0
    for (const record of this.deps.workers.listLive()) {
      if (record.bootId === this.deps.bootId) continue
      workers += 1
      record.state = 'RECOVERING'
      this.deps.workers.save(record)
      record.state = 'STOPPED'
      record.stoppedAt = this.iso()
      record.error = 'The runtime restarted; this worker belonged to its earlier start.'
      record.assignment = null
      this.deps.workers.save(record)
      this.event(record.id, 'STOPPED', record.error)
    }
    for (const lease of this.deps.leases.listActive()) {
      if (lease.bootId === this.deps.bootId) continue
      if (this.deps.leases.end(lease.id, 'EXPIRED', this.iso(), 'The runtime restarted while the lease was held.')) leases += 1
    }
    if (workers > 0 || leases > 0) this.deps.onChange?.()
    return { workers, leases }
  }

  // ───────────────────────────── sessions ─────────────────────────────

  /** Starts a session of `provider` on a worker. Returns at once; the session waits for a worker if none is free. */
  startSession(provider: string, spec: SessionSpec): AgentSessionHandle {
    const session: Session = { provider, spec, events: new AsyncQueue<AgentEvent>(), sessionId: null, queued: [], workerId: null, leaseId: null, ended: false, stopConfirmed: false }
    if (this.stopping) this.endSession(session, 'crashed', 'The runtime is stopping.')
    else {
      this.waiting.push(session)
      // Not in this call: the caller gets its handle before anything can happen to the session.
      queueMicrotask(() => this.pump())
    }
    return {
      agentId: spec.agentId,
      sessionId: () => session.sessionId,
      events: session.events,
      send: (text) => this.sendToSession(session, 'send', text),
      end: () => this.sendToSession(session, 'end'),
      interrupt: () => this.command(session, 'interrupt').catch(() => undefined),
      stop: () => this.stopSession(session),
      stopConfirmed: () => session.stopConfirmed,
    }
  }

  private endSession(session: Session, reason: 'completed' | 'stopped' | 'crashed', error: string | null): void {
    if (session.ended) return
    session.ended = true
    session.events.push({ type: 'session.ended', reason, error })
    session.events.close()
  }

  private sendToSession(session: Session, op: 'send' | 'end', text?: string): void {
    if (session.ended) return
    const worker = session.workerId ? this.live.get(session.workerId) : undefined
    if (!worker || !session.leaseId) {
      session.queued.push({ op, ...(text !== undefined ? { text } : {}) })
      return
    }
    void this.command(session, op, text).catch((e: unknown) => this.log(`${op} failed: ${errorMessage(e)}`))
  }

  private command(session: Session, op: 'send' | 'interrupt' | 'end' | 'stop', text?: string): Promise<void> {
    const worker = session.workerId ? this.live.get(session.workerId) : undefined
    if (!worker || !session.leaseId || session.ended) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const id = worker.nextCommand++
      worker.commands.set(id, { resolve, reject })
      worker.process.send({ t: 'cmd', id, leaseId: session.leaseId as string, op, ...(text !== undefined ? { text } : {}) })
    })
  }

  private async stopSession(session: Session): Promise<void> {
    if (session.ended) return
    const index = this.waiting.indexOf(session)
    if (index >= 0) {
      this.waiting.splice(index, 1)
      session.stopConfirmed = true
      this.endSession(session, 'stopped', null)
      return
    }
    const worker = session.workerId ? this.live.get(session.workerId) : undefined
    if (!worker) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const obeyed = await Promise.race([
      this.command(session, 'stop').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.timings.stopTimeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    // A session that does not stop is stopped with its worker: cancelling must end what NEXUS started.
    if (!obeyed && !session.ended) await this.failWorker(worker, 'The session did not stop when asked; its worker was ended.', 'stopped')
  }

  // ───────────────────────────── workers ─────────────────────────────

  private liveCount(): number {
    let n = 0
    for (const w of this.live.values()) if (LIVE_WORKER_STATES.includes(w.record.state) && w.record.state !== 'STOPPING' && w.record.state !== 'DRAINING') n += 1
    return n
  }

  private spawn(): Live | null {
    const id = newId()
    const record: WorkerRecord = { id, bootId: this.deps.bootId, pid: null, state: 'STARTING', startedAt: this.iso(), heartbeatAt: null, stoppedAt: null, exitCode: null, error: null, assignments: 0, capabilities: [], assignment: null }
    let child: WorkerProcess
    try {
      child = this.deps.launcher(id)
    } catch (e) {
      this.log(`a worker could not be started: ${errorMessage(e)}`)
      return null
    }
    record.pid = child.pid
    const worker: Live = { record, process: child, session: null, lastRenewAt: 0, idleSince: this.now(), startedAt: this.now(), nextCommand: 1, commands: new Map(), exited: false }
    this.live.set(id, worker)
    try {
      this.deps.workers.insert(record)
    } catch (e) {
      this.log(`worker ${id} not recorded: ${errorMessage(e)}`)
    }
    this.event(id, 'STARTING', `pid ${child.pid ?? 'unknown'}`)
    child.onMessage((message) => this.onMessage(worker, message))
    child.onExit((code, signal) => this.onExit(worker, code, signal))
    child.send({ t: 'init', workerId: id, config: { ...this.deps.config(), heartbeatMs: this.timings.heartbeatMs } })
    this.deps.onChange?.()
    return worker
  }

  /** Gives waiting sessions to idle workers, and starts workers while the limit allows. */
  private pump(): void {
    if (this.stopping) return
    while (this.waiting.length > 0) {
      const idle = [...this.live.values()].find((w) => w.record.state === 'IDLE' && !w.session)
      if (!idle) break
      const session = this.waiting.shift() as Session
      this.assign(idle, session)
    }
    const starting = [...this.live.values()].filter((w) => w.record.state === 'STARTING').length
    let wanted = this.waiting.length - starting
    while (wanted > 0 && this.liveCount() < Math.max(1, this.deps.maxWorkers())) {
      if (!this.spawn()) {
        // Without a worker the session cannot run; saying so beats waiting for good.
        const session = this.waiting.shift()
        if (session) this.endSession(session, 'crashed', 'No worker process could be started.')
      }
      wanted -= 1
    }
  }

  private assign(worker: Live, session: Session): void {
    const context = this.deps.context?.(session.spec.agentId) ?? { runId: null, taskId: null }
    const at = this.now()
    const lease: WorkerLease = { id: newId(), workerId: worker.record.id, bootId: this.deps.bootId, agentId: session.spec.agentId, runId: context.runId, taskId: context.taskId, provider: session.provider, state: 'ACTIVE', grantedAt: this.iso(at), heartbeatAt: this.iso(at), expiresAt: this.iso(at + this.timings.leaseTtlMs), releasedAt: null, reason: null }
    try {
      // The unique indexes refuse a second live lease for this agent session or this worker.
      this.deps.leases.grant(lease)
    } catch (e) {
      this.endSession(session, 'crashed', `The session could not be assigned: ${errorMessage(e)}`)
      return
    }
    session.workerId = worker.record.id
    session.leaseId = lease.id
    worker.session = session
    worker.lastRenewAt = at
    worker.record.assignments += 1
    worker.record.assignment = { leaseId: lease.id, agentId: lease.agentId, runId: lease.runId, taskId: lease.taskId, provider: lease.provider, sessionId: null, worktree: session.spec.cwd, assignedAt: lease.grantedAt }
    this.transition(worker, 'ASSIGNED', `agent ${lease.agentId}`)
    worker.process.send({ t: 'assign', leaseId: lease.id, provider: session.provider, spec: toWireSpec(session.spec) })
    for (const queued of session.queued.splice(0)) this.sendToSession(session, queued.op, queued.text)
  }

  private onMessage(worker: Live, raw: WorkerToRuntime): void {
    if (worker.exited) return
    // A worker hosts a provider's process and parses its output; what it sends is checked before it is used.
    const message = checkedWorkerMessage(raw)
    if (!message) {
      this.log(`worker ${worker.record.id} sent a message that is not part of the protocol; ignored`)
      return
    }
    worker.record.heartbeatAt = this.iso()
    switch (message.t) {
      case 'ready':
        worker.record.pid = message.pid
        worker.record.capabilities = message.capabilities
        worker.idleSince = this.now()
        this.transition(worker, 'IDLE')
        this.pump()
        return
      case 'hb':
        this.renew(worker)
        return
      case 'log':
        this.log(`worker ${worker.record.id}: ${message.line.replace(/\s+/g, ' ').slice(0, 500)}`)
        return
      case 'cmdResult': {
        const pending = worker.commands.get(message.id)
        if (!pending) return
        worker.commands.delete(message.id)
        if (message.ok) pending.resolve()
        else pending.reject(new Error(message.error ?? 'The worker refused the command.'))
        return
      }
      case 'event': {
        const session = worker.session
        // A worker speaks only for the lease it holds.
        if (!session || session.leaseId !== message.leaseId || session.ended) return
        if (worker.record.state === 'ASSIGNED') this.transition(worker, 'RUNNING')
        if (message.event.type === 'session.started') {
          session.sessionId = message.event.sessionId
          if (worker.record.assignment) worker.record.assignment.sessionId = message.event.sessionId
          this.save(worker.record)
        }
        if (message.event.type === 'session.ended') {
          session.stopConfirmed = message.event.stopConfirmed === true
          // The lease ends with the session, before anyone can react to its end: the same agent session may be
          // started again at once (a rotation), and must not find its own old lease in the way.
          this.endLease(message.leaseId, 'RELEASED', null)
          this.endSession(session, message.event.reason, message.event.error)
        }
        else session.events.push(message.event)
        return
      }
      case 'ended':
        if (message.stopConfirmed === false) {
          void this.failWorker(worker, 'Its runtime could not confirm the child session stopped.', 'crashed')
          return
        }
        if (message.stopConfirmed && worker.session) worker.session.stopConfirmed = true
        this.release(worker, message.leaseId)
        return
      case 'call':
        void this.onCall(worker, message.id, message.leaseId, message.method, message.args)
        return
    }
  }

  private async onCall(worker: Live, id: number, leaseId: string, method: WorkerCallMethod, args: unknown[]): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      if (!worker.exited) worker.process.send({ t: 'callResult', id, ok, ...(value !== undefined ? { value } : {}), ...(error !== undefined ? { error } : {}) })
    }
    const session = worker.session
    if (!session || session.leaseId !== leaseId || session.ended) return reply(false, undefined, 'The worker does not hold this assignment.')
    try {
      const spec = session.spec
      if (method === 'authorize') return reply(true, await spec.authorize(args[0] as ToolRequest))
      if (method === 'requestApproval') return reply(true, await spec.requestApproval(args[0] as ToolRequest, String(args[1]), args[2] as 'low' | 'medium' | 'high'))
      const tools = spec.nexusTools
      // Only the NEXUS tools by name, and only what the session's own object defines: no inherited property is callable.
      const handler = tools && NEXUS_TOOL_METHODS.includes(method) && Object.hasOwn(tools, method) ? (tools[method as keyof typeof tools] as ((input: unknown) => Promise<string>) | undefined) : undefined
      if (typeof handler !== 'function') return reply(false, undefined, 'The session has no such tool.')
      return reply(true, await handler.call(tools, args[0]))
    } catch (e) {
      reply(false, undefined, errorMessage(e))
    }
  }

  private renew(worker: Live): void {
    const leaseId = worker.session?.leaseId
    if (!leaseId) return
    const at = this.now()
    if (at - worker.lastRenewAt < this.timings.leaseTtlMs / 3) return
    worker.lastRenewAt = at
    try {
      // A lease that is no longer active was taken away; the worker must not go on under it.
      if (!this.deps.leases.renew(leaseId, this.iso(at), this.iso(at + this.timings.leaseTtlMs))) void this.failWorker(worker, 'Its lease had ended while it still worked.', 'crashed')
    } catch (e) {
      this.log(`lease ${leaseId} not renewed: ${errorMessage(e)}`)
    }
  }

  /** The assignment is over and the worker is still there. */
  private release(worker: Live, leaseId: string): void {
    const session = worker.session
    if (!session || session.leaseId !== leaseId) return
    this.endLease(leaseId, 'RELEASED', null)
    // A worker that reports the end without a final event still ends the session; it is not left open.
    this.endSession(session, 'crashed', 'The worker ended the assignment without a final event.')
    worker.session = null
    worker.record.assignment = null
    worker.idleSince = this.now()
    if (worker.record.state === 'ASSIGNED' || worker.record.state === 'RUNNING') {
      if (worker.record.assignments >= this.timings.maxAssignments || this.stopping) this.stopWorker(worker, 'Replaced after its share of assignments.')
      else this.transition(worker, 'IDLE')
    }
    this.pump()
  }

  private endLease(leaseId: string, state: 'RELEASED' | 'EXPIRED' | 'REVOKED', reason: string | null): void {
    try {
      this.deps.leases.end(leaseId, state, this.iso(), reason)
    } catch (e) {
      this.log(`lease ${leaseId} not ended: ${errorMessage(e)}`)
    }
  }

  /** Asks a worker to end. It has no assignment when this is called. */
  private stopWorker(worker: Live, why: string): void {
    if (worker.record.state === 'STOPPING' || worker.exited) return
    this.transition(worker, 'DRAINING', why)
    this.transition(worker, 'STOPPING')
    worker.process.send({ t: 'shutdown' })
    const timer = setTimeout(() => {
      if (!worker.exited) void worker.process.kill()
    }, 10_000)
    timer.unref()
  }

  /** Ends a worker that is lost or must not go on, and takes its session back. */
  private async failWorker(worker: Live, why: string, sessionEnds: 'crashed' | 'stopped'): Promise<void> {
    if (worker.exited && !LIVE_WORKER_STATES.includes(worker.record.state)) return
    const session = worker.session
    this.revoke(worker, why, sessionEnds, sessionEnds === 'stopped' ? 'REVOKED' : 'EXPIRED')
    worker.record.error = why
    this.transition(worker, 'FAILED', why)
    try {
      await worker.process.kill()
      if (session) session.stopConfirmed = true
    } catch (e) {
      this.log(`worker ${worker.record.id} could not be ended: ${errorMessage(e)}`)
    }
  }

  private revoke(worker: Live, why: string, sessionEnds: 'crashed' | 'stopped', leaseState: 'EXPIRED' | 'REVOKED'): void {
    const session = worker.session
    worker.session = null
    worker.record.assignment = null
    for (const pending of worker.commands.values()) pending.reject(new Error(why))
    worker.commands.clear()
    if (!session) return
    if (session.leaseId) this.endLease(session.leaseId, leaseState, why)
    this.endSession(session, sessionEnds, sessionEnds === 'crashed' ? `Worker lost: ${why}` : null)
  }

  private onExit(worker: Live, code: number | null, signal: string | null): void {
    if (worker.exited) return
    worker.exited = true
    worker.record.exitCode = code
    const expected = worker.record.state === 'STOPPING' || worker.record.state === 'DRAINING'
    const why = `The worker process ended (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`
    // The exit of a process says that it is gone, not what its session achieved.
    this.revoke(worker, why, 'crashed', 'REVOKED')
    if (LIVE_WORKER_STATES.includes(worker.record.state)) {
      if (expected) this.transition(worker, 'STOPPED')
      else {
        worker.record.error = why
        this.transition(worker, 'FAILED', why)
      }
    } else this.save(worker.record)
    this.live.delete(worker.record.id)
    this.pump()
  }

  /** One check: starts that never finished, heartbeats that stopped, leases that ran out, idle workers. */
  tick(): void {
    const now = this.now()
    for (const worker of [...this.live.values()]) {
      const state = worker.record.state
      if (worker.exited) continue
      if (state === 'STARTING' && now - worker.startedAt > this.timings.startTimeoutMs) {
        void this.failWorker(worker, 'It did not report ready in time.', 'crashed')
        continue
      }
      const heard = worker.record.heartbeatAt ? Date.parse(worker.record.heartbeatAt) : worker.startedAt
      if ((state === 'IDLE' || state === 'ASSIGNED' || state === 'RUNNING') && now - heard > this.timings.heartbeatTimeoutMs) {
        void this.failWorker(worker, `No heartbeat for ${Math.round((now - heard) / 1000)} s.`, 'crashed')
        continue
      }
      if (state === 'IDLE' && this.waiting.length === 0 && now - worker.idleSince > this.timings.idleTtlMs) this.stopWorker(worker, 'Idle.')
    }
    // A lease nobody renews ends by itself, whatever became of its worker: no stale lease survives.
    try {
      for (const lease of this.deps.leases.listActive()) {
        if (Date.parse(lease.expiresAt) > now) continue
        const holder = this.live.get(lease.workerId)
        if (holder && holder.session?.leaseId === lease.id) void this.failWorker(holder, 'Its lease expired.', 'crashed')
        else this.endLease(lease.id, 'EXPIRED', 'The lease was not renewed.')
      }
      if (now - this.lastPruneAt > 10 * 60_000) {
        this.lastPruneAt = now
        this.deps.workers.prune()
      }
    } catch (e) {
      this.log(`lease check failed: ${errorMessage(e)}`)
    }
    this.pump()
  }

  /**
   * Starts one worker process and waits until it reports ready, without giving it a session. It answers the
   * question "can this installation start a worker at all" (the entry point is found, the binary runs it, the
   * provider runtimes load) and uses no provider. The worker stays idle and is stopped like any idle worker.
   */
  async selfTest(timeoutMs = 30_000): Promise<{ ok: boolean; pid: number | null; capabilities: string[]; milliseconds: number; detail: string }> {
    const started = Date.now()
    if (this.stopping) return { ok: false, pid: null, capabilities: [], milliseconds: 0, detail: 'The runtime is stopping.' }
    const idle = [...this.live.values()].find((w) => w.record.state === 'IDLE')
    if (idle) return { ok: true, pid: idle.record.pid, capabilities: idle.record.capabilities, milliseconds: 0, detail: 'An idle worker is already running.' }
    if (this.liveCount() >= Math.max(1, this.deps.maxWorkers())) return { ok: true, pid: null, capabilities: [], milliseconds: 0, detail: 'Every worker is busy with a session; workers start.' }
    const worker = this.spawn()
    if (!worker) return { ok: false, pid: null, capabilities: [], milliseconds: Date.now() - started, detail: 'The worker process could not be started.' }
    while (Date.now() - started < timeoutMs) {
      if (worker.record.state !== 'STARTING') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const milliseconds = Date.now() - started
    if (worker.record.state === 'STARTING') return { ok: false, pid: worker.record.pid, capabilities: [], milliseconds, detail: 'The worker did not report ready in time.' }
    if (worker.record.state === 'FAILED' || worker.record.state === 'STOPPED') return { ok: false, pid: worker.record.pid, capabilities: [], milliseconds, detail: worker.record.error ?? 'The worker ended before it was ready.' }
    return { ok: true, pid: worker.record.pid, capabilities: worker.record.capabilities, milliseconds, detail: 'A worker process started and reported ready.' }
  }

  // ───────────────────────────── read model ─────────────────────────────

  counts(): { live: number; busy: number; idle: number; waitingAssignments: number } {
    let busy = 0
    let idle = 0
    for (const w of this.live.values()) {
      if (w.session) busy += 1
      else if (w.record.state === 'IDLE') idle += 1
    }
    return { live: this.live.size, busy, idle, waitingAssignments: this.waiting.length }
  }

  /** The record of a live worker; tests and diagnostics read it. */
  get(id: string): WorkerRecord | null {
    return this.live.get(id)?.record ?? null
  }

  overview(): WorkersOverview {
    const live = [...this.live.values()].map((w) => ({ ...w.record, assignment: w.record.assignment ? { ...w.record.assignment } : null }))
    return {
      workers: [...live, ...this.deps.workers.listEnded(15)],
      leases: this.deps.leases.recent(30),
      limits: { maxWorkers: Math.max(1, this.deps.maxWorkers()) },
      counts: this.counts(),
      enabled: true,
      events: this.deps.workers.recentEvents(40),
    }
  }

  /** Stops every worker: asks first, then ends what is left. Sessions end as stopped. */
  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    for (const session of this.waiting.splice(0)) this.endSession(session, 'stopped', null)
    const workers = [...this.live.values()]
    for (const worker of workers) {
      if (worker.session) this.revoke(worker, 'The runtime is stopping.', 'stopped', 'REVOKED')
      if (!worker.exited && worker.record.state !== 'STOPPING') {
        if (worker.record.state === 'STARTING' || worker.record.state === 'ASSIGNED' || worker.record.state === 'RUNNING' || worker.record.state === 'IDLE') {
          worker.record.state = worker.record.state === 'STARTING' ? 'STARTING' : worker.record.state
          this.transition(worker, 'STOPPING', 'The runtime is stopping.')
        }
        worker.process.send({ t: 'shutdown' })
      }
    }
    const until = Date.now() + 8000
    while (workers.some((w) => !w.exited) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
    await Promise.allSettled(workers.filter((w) => !w.exited).map((w) => w.process.kill()))
  }
}

const NEXUS_TOOL_METHODS: readonly string[] = ['sendMessage', 'reportBlocker', 'recordDecision', 'proposeMemory', 'proposeGraphChange', 'contextTool']
const CALL_METHODS: readonly string[] = ['authorize', 'requestApproval', ...NEXUS_TOOL_METHODS]
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** The message if it has the shape the protocol gives its kind, else null. */
export function checkedWorkerMessage(raw: unknown): WorkerToRuntime | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  switch (m['t']) {
    case 'ready':
      return Number.isInteger(m['pid']) && Array.isArray(m['capabilities']) && m['capabilities'].length <= 16 && m['capabilities'].every((c) => isText(c, 32)) ? (raw as WorkerToRuntime) : null
    case 'hb':
      return m['leaseId'] === null || isText(m['leaseId'], 64) ? (raw as WorkerToRuntime) : null
    case 'log':
      return typeof m['line'] === 'string' ? (raw as WorkerToRuntime) : null
    case 'cmdResult':
      return Number.isInteger(m['id']) && typeof m['ok'] === 'boolean' ? (raw as WorkerToRuntime) : null
    case 'ended':
      return isText(m['leaseId'], 64) && (m['stopConfirmed'] === undefined || typeof m['stopConfirmed'] === 'boolean') ? (raw as WorkerToRuntime) : null
    case 'call':
      return Number.isInteger(m['id']) && isText(m['leaseId'], 64) && typeof m['method'] === 'string' && CALL_METHODS.includes(m['method']) && Array.isArray(m['args']) && m['args'].length <= 4 ? (raw as WorkerToRuntime) : null
    case 'event': {
      const event = m['event'] as Record<string, unknown> | null
      if (!isText(m['leaseId'], 64) || typeof event !== 'object' || event === null || typeof event['type'] !== 'string') return null
      // The session id is stored and used to resume: it is a short token, nothing else.
      if (event['type'] === 'session.started' && !(isText(event['sessionId'], 200) && /^[\w.:-]+$/.test(event['sessionId']))) return null
      if (event['type'] === 'session.ended' && !['completed', 'stopped', 'crashed'].includes(String(event['reason']))) return null
      if (event['type'] === 'session.ended' && event['stopConfirmed'] !== undefined && typeof event['stopConfirmed'] !== 'boolean') return null
      // Only the host admission kernel can signal a capacity wait.
      if (event['type'] === 'capacity.wait') return null
      return raw as WorkerToRuntime
    }
    default:
      return null
  }
}

/** Starts workers as child processes of this one. `execPath` is the Electron binary in the app (run as Node). */
export function forkLauncher(options: { entry: string; execPath?: string; env?: NodeJS.ProcessEnv; killTree: (pid: number) => Promise<void>; logger?: (line: string) => void }): WorkerLauncher {
  return (workerId) => {
    const child = fork(options.entry, [], {
      ...(options.execPath ? { execPath: options.execPath } : {}),
      env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', NEXUS_WORKER_ID: workerId },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    })
    let tail = ''
    child.stderr?.on('data', (data: Buffer) => {
      tail = `${tail}${data.toString('utf8')}`.slice(-2000)
      options.logger?.(`worker ${workerId} stderr: ${data.toString('utf8').trim().slice(0, 500)}`)
    })
    return {
      pid: child.pid ?? null,
      send: (message) => {
        if (!child.connected) return
        try {
          child.send(message)
        } catch {
          // The process is going; its exit is reported through onExit.
        }
      },
      kill: async () => {
        // The tree, not only the worker: a session's own children (claude.exe, shells) must not be left behind.
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await options.killTree(child.pid)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      },
      onMessage: (listener) => void child.on('message', (message) => listener(message as WorkerToRuntime)),
      onExit: (listener) => {
        let told = false
        const tell = (code: number | null, signal: string | null): void => {
          if (told) return
          told = true
          listener(code, signal)
        }
        child.once('exit', (code, signal) => tell(code, signal))
        child.once('error', () => tell(null, null))
      },
    }
  }
}
