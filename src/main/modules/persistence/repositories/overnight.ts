import { LIVE_OVERNIGHT_STATES, type OvernightRun, type PowerAuditEntry, type RunCheckpoint } from '@shared/overnight'
import type { Database } from '../database'
import { guard, prepare, Table, type Codec } from '../table'

const overnightCodec: Codec<OvernightRun> = {
  table: 'overnight_runs',
  fields: {
    id: 'text',
    runId: 'text',
    workloadType: 'text',
    projectId: 'text',
    state: 'text',
    policy: 'json',
    authorization: 'json',
    startedAt: 'text',
    deadlineAt: 'text',
    failsafe: 'json',
    terminalReason: 'text',
    terminalDetail: 'text',
    finalReport: 'text',
    reportPath: 'text',
    reportSavedAt: 'text',
    powerAction: 'json',
    quota: 'json',
    watchdog: 'json',
    amendments: 'json',
    error: 'text',
    createdAt: 'text',
    updatedAt: 'text',
    finishedAt: 'text',
  },
}

export class OvernightRepository extends Table<OvernightRun> {
  constructor(db: Database) {
    super(db, overnightCodec, 'overnight run')
  }

  getByRun(runId: string): OvernightRun | null {
    return this.one('WHERE run_id = ?', [runId])
  }

  /** Records the supervisor still owns: a failsafe may be armed or a power action pending. */
  listLive(): OvernightRun[] {
    return this.query(`WHERE state IN (${LIVE_OVERNIGHT_STATES.map(() => '?').join(', ')}) ORDER BY created_at, rowid`, [...LIVE_OVERNIGHT_STATES])
  }

  listAll(limit = 50): OvernightRun[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit])
  }
}

const auditCodec: Codec<PowerAuditEntry> = {
  table: 'power_audit',
  fields: { id: 'text', runId: 'text', operation: 'text', action: 'text', detail: 'text', result: 'json', createdAt: 'text' },
}

/** Append-only log of every power-controller call (and every refusal). */
export class PowerAuditRepository extends Table<PowerAuditEntry> {
  constructor(db: Database) {
    super(db, auditCodec, 'power audit entry')
  }

  listByRun(runId: string): PowerAuditEntry[] {
    return this.byRun(runId)
  }

  listAll(limit = 200): PowerAuditEntry[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit])
  }
}

const checkpointCodec: Codec<RunCheckpoint> = {
  table: 'run_checkpoints',
  fields: { id: 'text', runId: 'text', reason: 'text', snapshot: 'json', createdAt: 'text' },
}

export class CheckpointRepository extends Table<RunCheckpoint> {
  constructor(db: Database) {
    super(db, checkpointCodec, 'checkpoint')
  }

  listByRun(runId: string): RunCheckpoint[] {
    return this.byRun(runId)
  }

  latest(runId: string): RunCheckpoint | null {
    return this.one('WHERE run_id = ? ORDER BY created_at DESC, rowid DESC', [runId])
  }

  count(runId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM run_checkpoints WHERE run_id = ?').get(runId) as { n: number }).n
  }

  /** Keep the newest `keep` checkpoints of a run. */
  prune(runId: string, keep: number): void {
    guard(() =>
      prepare(
        this.db,
        'DELETE FROM run_checkpoints WHERE run_id = ? AND rowid NOT IN (SELECT rowid FROM run_checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)',
      ).run(runId, runId, keep),
    )
  }
}
