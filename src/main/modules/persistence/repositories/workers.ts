import { LIVE_WORKER_STATES, type LeaseState, type WorkerEvent, type WorkerLease, type WorkerRecord, type WorkerState } from '@shared/workers'
import type { Database } from '../database'
import { guard, prepare, type Row } from '../table'

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

function workerOf(row: Row): WorkerRecord {
  const leaseId = text(row['lease_id'])
  return {
    id: String(row['id']),
    bootId: String(row['boot_id']),
    pid: num(row['pid']),
    state: String(row['state']) as WorkerState,
    startedAt: String(row['started_at']),
    heartbeatAt: text(row['heartbeat_at']),
    stoppedAt: text(row['stopped_at']),
    exitCode: num(row['exit_code']),
    error: text(row['error']),
    assignments: Number(row['assignments'] ?? 0),
    capabilities: JSON.parse(String(row['capabilities'] ?? '[]')) as string[],
    assignment: leaseId
      ? {
          leaseId,
          agentId: String(row['agent_id'] ?? ''),
          runId: text(row['run_id']),
          taskId: text(row['task_id']),
          provider: String(row['provider'] ?? ''),
          sessionId: text(row['session_id']),
          worktree: String(row['worktree'] ?? ''),
          assignedAt: String(row['assigned_at'] ?? ''),
        }
      : null,
  }
}

function leaseOf(row: Row): WorkerLease {
  return {
    id: String(row['id']),
    workerId: String(row['worker_id']),
    bootId: String(row['boot_id']),
    agentId: String(row['agent_id']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    provider: String(row['provider']),
    state: String(row['state']) as LeaseState,
    grantedAt: String(row['granted_at']),
    heartbeatAt: String(row['heartbeat_at']),
    expiresAt: String(row['expires_at']),
    releasedAt: text(row['released_at']),
    reason: text(row['reason']),
  }
}

/** v0.7: the worker processes the runtime started, and what each one holds. */
export class WorkerStore {
  constructor(private readonly db: Database) {}

  insert(worker: WorkerRecord): void {
    guard(() =>
      prepare(this.db, 'INSERT INTO workers (id, boot_id, pid, state, started_at, heartbeat_at, capabilities, assignments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        worker.id,
        worker.bootId,
        worker.pid,
        worker.state,
        worker.startedAt,
        worker.heartbeatAt,
        JSON.stringify(worker.capabilities),
        worker.assignments,
      ),
    )
  }

  /** Writes the whole record; the manager keeps the truth in memory and stores every change. */
  save(worker: WorkerRecord): void {
    const a = worker.assignment
    guard(() =>
      prepare(
        this.db,
        'UPDATE workers SET pid = ?, state = ?, heartbeat_at = ?, stopped_at = ?, exit_code = ?, error = ?, assignments = ?, lease_id = ?, agent_id = ?, run_id = ?, task_id = ?, provider = ?, session_id = ?, worktree = ?, assigned_at = ? WHERE id = ?',
      ).run(worker.pid, worker.state, worker.heartbeatAt, worker.stoppedAt, worker.exitCode, worker.error, worker.assignments, a?.leaseId ?? null, a?.agentId ?? null, a?.runId ?? null, a?.taskId ?? null, a?.provider ?? null, a?.sessionId ?? null, a?.worktree ?? null, a?.assignedAt ?? null, worker.id),
    )
  }

  get(id: string): WorkerRecord | null {
    const row = prepare(this.db, 'SELECT * FROM workers WHERE id = ?').get(id) as Row | undefined
    return row ? workerOf(row) : null
  }

  /** Workers recorded as alive, of any start of the runtime. */
  listLive(): WorkerRecord[] {
    return (prepare(this.db, `SELECT * FROM workers WHERE state IN (${marks(LIVE_WORKER_STATES.length)}) ORDER BY started_at, rowid`).all(...LIVE_WORKER_STATES) as Row[]).map(workerOf)
  }

  /** The newest workers that ended. */
  listEnded(limit = 20): WorkerRecord[] {
    return (prepare(this.db, `SELECT * FROM workers WHERE state NOT IN (${marks(LIVE_WORKER_STATES.length)}) ORDER BY stopped_at DESC, rowid DESC LIMIT ?`).all(...LIVE_WORKER_STATES, Math.min(Math.max(1, limit), 200)) as Row[]).map(workerOf)
  }

  /** History is kept bounded: the oldest ended workers and their events go once there are more than `keep`. */
  prune(keep = 500): void {
    guard(() => {
      prepare(this.db, `DELETE FROM workers WHERE state IN ('STOPPED', 'FAILED') AND rowid NOT IN (SELECT rowid FROM workers WHERE state IN ('STOPPED', 'FAILED') ORDER BY rowid DESC LIMIT ?)`).run(keep)
      prepare(this.db, 'DELETE FROM worker_events WHERE worker_id NOT IN (SELECT id FROM workers)').run()
      prepare(this.db, `DELETE FROM worker_leases WHERE state <> 'ACTIVE' AND rowid NOT IN (SELECT rowid FROM worker_leases WHERE state <> 'ACTIVE' ORDER BY rowid DESC LIMIT ?)`).run(keep * 4)
    })
  }

  event(event: WorkerEvent): void {
    guard(() => prepare(this.db, 'INSERT INTO worker_events (worker_id, at, kind, detail) VALUES (?, ?, ?, ?)').run(event.workerId, event.at, event.kind, event.detail?.slice(0, 1000) ?? null))
  }

  recentEvents(limit = 50): WorkerEvent[] {
    return (prepare(this.db, 'SELECT worker_id, at, kind, detail FROM worker_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as Row[]).map((r) => ({ workerId: String(r['worker_id']), at: String(r['at']), kind: String(r['kind']), detail: text(r['detail']) }))
  }
}

/** v0.7: leases. The unique indexes refuse a second active lease for one agent session or one worker. */
export class WorkerLeaseStore {
  constructor(private readonly db: Database) {}

  /** Grants a lease. Throws when the agent session or the worker already holds an active one. */
  grant(lease: WorkerLease): void {
    guard(() =>
      prepare(this.db, 'INSERT INTO worker_leases (id, worker_id, boot_id, agent_id, run_id, task_id, provider, state, granted_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        lease.id,
        lease.workerId,
        lease.bootId,
        lease.agentId,
        lease.runId,
        lease.taskId,
        lease.provider,
        'ACTIVE',
        lease.grantedAt,
        lease.heartbeatAt,
        lease.expiresAt,
      ),
    )
  }

  /** Extends an active lease. Returns false when it is no longer active (it expired or was revoked meanwhile). */
  renew(id: string, heartbeatAt: string, expiresAt: string): boolean {
    return guard(() => prepare(this.db, "UPDATE worker_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND state = 'ACTIVE'").run(heartbeatAt, expiresAt, id)).changes > 0
  }

  /** Ends an active lease. Returns false when it had already ended: a lease ends once. */
  end(id: string, state: Exclude<LeaseState, 'ACTIVE'>, at: string, reason: string | null): boolean {
    return guard(() => prepare(this.db, "UPDATE worker_leases SET state = ?, released_at = ?, reason = ? WHERE id = ? AND state = 'ACTIVE'").run(state, at, reason?.slice(0, 500) ?? null, id)).changes > 0
  }

  get(id: string): WorkerLease | null {
    const row = prepare(this.db, 'SELECT * FROM worker_leases WHERE id = ?').get(id) as Row | undefined
    return row ? leaseOf(row) : null
  }

  listActive(): WorkerLease[] {
    return (prepare(this.db, "SELECT * FROM worker_leases WHERE state = 'ACTIVE' ORDER BY granted_at, rowid").all() as Row[]).map(leaseOf)
  }

  activeOfAgent(agentId: string): WorkerLease | null {
    const row = prepare(this.db, "SELECT * FROM worker_leases WHERE agent_id = ? AND state = 'ACTIVE'").get(agentId) as Row | undefined
    return row ? leaseOf(row) : null
  }

  recent(limit = 50): WorkerLease[] {
    return (prepare(this.db, 'SELECT * FROM worker_leases ORDER BY rowid DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as Row[]).map(leaseOf)
  }
}

/** v0.7: one row per occurrence of a schedule that fired. The primary key is what makes a firing happen once. */
export class ScheduleFiringStore {
  constructor(private readonly db: Database) {}

  /** Claims an occurrence. Returns false when it was already claimed (by this runtime or an earlier start). */
  claim(scheduleId: string, occurrence: string, firedAt: string): boolean {
    return guard(() => prepare(this.db, 'INSERT OR IGNORE INTO schedule_firings (schedule_id, occurrence, fired_at) VALUES (?, ?, ?)').run(scheduleId, occurrence, firedAt)).changes > 0
  }

  complete(scheduleId: string, occurrence: string, itemId: string | null, result: string): void {
    guard(() => prepare(this.db, 'UPDATE schedule_firings SET item_id = ?, result = ? WHERE schedule_id = ? AND occurrence = ?').run(itemId, result.slice(0, 300), scheduleId, occurrence))
  }

  count(scheduleId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM schedule_firings WHERE schedule_id = ?').get(scheduleId) as { n: number }).n
  }

  list(scheduleId: string, limit = 20): { occurrence: string; firedAt: string; itemId: string | null; result: string | null }[] {
    return (prepare(this.db, 'SELECT occurrence, fired_at, item_id, result FROM schedule_firings WHERE schedule_id = ? ORDER BY occurrence DESC LIMIT ?').all(scheduleId, Math.min(Math.max(1, limit), 200)) as Row[]).map((r) => ({
      occurrence: String(r['occurrence']),
      firedAt: String(r['fired_at']),
      itemId: text(r['item_id']),
      result: text(r['result']),
    }))
  }

  /** Firings of schedules that no longer exist are history nobody reads. */
  prune(keepPerSchedule = 200): void {
    guard(() => prepare(this.db, 'DELETE FROM schedule_firings WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY occurrence DESC) AS n FROM schedule_firings) WHERE n > ?)').run(keepPerSchedule))
  }
}

export interface SchedulerDecision {
  at: string
  itemId: string
  decision: string
  reason: string
}

/** v0.7: why an item was started, granted capacity or made to wait. One row when the answer changes. */
export class SchedulerDecisionStore {
  constructor(private readonly db: Database) {}

  insert(decision: SchedulerDecision): void {
    guard(() => prepare(this.db, 'INSERT INTO scheduler_decisions (at, item_id, decision, reason) VALUES (?, ?, ?, ?)').run(decision.at, decision.itemId, decision.decision, decision.reason.slice(0, 500)))
  }

  ofItem(itemId: string, limit = 20): SchedulerDecision[] {
    return (prepare(this.db, 'SELECT at, item_id, decision, reason FROM scheduler_decisions WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, Math.min(Math.max(1, limit), 200)) as Row[]).map((r) => ({ at: String(r['at']), itemId: String(r['item_id']), decision: String(r['decision']), reason: String(r['reason']) }))
  }

  recent(limit = 50): SchedulerDecision[] {
    return (prepare(this.db, 'SELECT at, item_id, decision, reason FROM scheduler_decisions ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as Row[]).map((r) => ({ at: String(r['at']), itemId: String(r['item_id']), decision: String(r['decision']), reason: String(r['reason']) }))
  }

  prune(keep = 5000): void {
    guard(() => prepare(this.db, 'DELETE FROM scheduler_decisions WHERE id <= (SELECT MAX(id) FROM scheduler_decisions) - ?').run(keep))
  }
}
