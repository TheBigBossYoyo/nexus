import type { PrivilegeSessionScope, PrivilegeSessionState, PrivilegeSessionStatus, PrivilegedCapability, PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'
import { PRIVILEGED_OUTCOMES } from '@shared/privilege'
import type { Database } from '../persistence/database'
import { guard, prepare, type Row } from '../persistence/table'

/** 0.9.1: the sessions and the receipts of every privileged attempt (migration 023). */

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/** Receipts kept in all; the oldest go first. A worker that asks again and again stays visible in the newest. */
const MAX_RECEIPTS = 20_000

export interface PrivilegeSessionRow {
  id: string
  scope: PrivilegeSessionScope
  runId: string | null
  projectId: string | null
  state: PrivilegeSessionState
  capabilities: PrivilegedCapability[]
  createdAt: string
  activeAt: string | null
  expiresAt: string
  endedAt: string | null
  endReason: string | null
  uacPrompts: number
  elevated: boolean
}

export interface PrivilegeStore {
  saveSession(s: PrivilegeSessionRow): void
  session(id: string): PrivilegeSessionRow | null
  sessions(opts?: { runId?: string; limit?: number }): PrivilegeSessionRow[]
  /** Sessions a previous run of NEXUS left marked as preparing or active: their broker ended with that runtime. */
  unfinished(): PrivilegeSessionRow[]
  record(r: PrivilegedOperationReceipt): void
  receipts(opts: { runId?: string; sessionId?: string; since?: string; limit?: number }): PrivilegedOperationReceipt[]
  counts(sessionId: string): Record<PrivilegedOutcome, number>
}

function sessionOf(row: Row): PrivilegeSessionRow {
  let capabilities: PrivilegedCapability[]
  try {
    capabilities = JSON.parse(String(row['capabilities_json'])) as PrivilegedCapability[]
  } catch {
    capabilities = []
  }
  return {
    id: String(row['id']),
    scope: String(row['scope']) as PrivilegeSessionScope,
    runId: text(row['run_id']),
    projectId: text(row['project_id']),
    state: String(row['state']) as PrivilegeSessionState,
    capabilities,
    createdAt: String(row['created_at']),
    activeAt: text(row['active_at']),
    expiresAt: String(row['expires_at']),
    endedAt: text(row['ended_at']),
    endReason: text(row['end_reason']),
    uacPrompts: Number(row['uac_prompts']),
    elevated: Number(row['elevated']) === 1,
  }
}

export class SqlitePrivilegeStore implements PrivilegeStore {
  private inserts = 0

  constructor(private readonly db: Database) {}

  saveSession(s: PrivilegeSessionRow): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO privilege_sessions (id, scope, run_id, project_id, state, capabilities_json, created_at, active_at, expires_at, ended_at, end_reason, uac_prompts, elevated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, active_at = excluded.active_at, expires_at = excluded.expires_at, ended_at = excluded.ended_at,
           end_reason = excluded.end_reason, uac_prompts = excluded.uac_prompts, elevated = excluded.elevated`,
      ).run(s.id, s.scope, s.runId, s.projectId, s.state, JSON.stringify(s.capabilities), s.createdAt, s.activeAt, s.expiresAt, s.endedAt, s.endReason?.slice(0, 400) ?? null, s.uacPrompts, s.elevated ? 1 : 0),
    )
  }

  session(id: string): PrivilegeSessionRow | null {
    const row = prepare(this.db, 'SELECT * FROM privilege_sessions WHERE id = ?').get(id) as Row | undefined
    return row ? sessionOf(row) : null
  }

  sessions(opts: { runId?: string; limit?: number } = {}): PrivilegeSessionRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200)
    const rows = (opts.runId !== undefined
      ? prepare(this.db, 'SELECT * FROM privilege_sessions WHERE run_id = ? ORDER BY created_at DESC LIMIT ?').all(opts.runId, limit)
      : prepare(this.db, 'SELECT * FROM privilege_sessions ORDER BY created_at DESC LIMIT ?').all(limit)) as Row[]
    return rows.map(sessionOf)
  }

  unfinished(): PrivilegeSessionRow[] {
    return (prepare(this.db, "SELECT * FROM privilege_sessions WHERE state IN ('PREPARING', 'ACTIVE')").all() as Row[]).map(sessionOf)
  }

  record(r: PrivilegedOperationReceipt): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO privileged_operations (id, session_id, run_id, project_id, task_id, requested_at, finished_at, capability, outcome, receipt_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.sessionId, r.runId, r.projectId, r.taskId, r.requestedAt, r.finishedAt, r.capability, r.outcome, JSON.stringify(r)),
    )
    if (++this.inserts % 100 === 0) {
      const total = (prepare(this.db, 'SELECT COUNT(*) AS n FROM privileged_operations').get() as { n: number }).n
      if (total > MAX_RECEIPTS) prepare(this.db, 'DELETE FROM privileged_operations WHERE seq IN (SELECT seq FROM privileged_operations ORDER BY seq LIMIT ?)').run(total - MAX_RECEIPTS)
    }
  }

  receipts(opts: { runId?: string; sessionId?: string; since?: string; limit?: number }): PrivilegedOperationReceipt[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(opts.sessionId)
    }
    if (opts.since !== undefined) {
      where.push('requested_at >= ?')
      params.push(opts.since)
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000)
    const rows = prepare(this.db, `SELECT receipt_json FROM privileged_operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, limit) as Row[]
    return rows
      .map((row) => {
        try {
          return JSON.parse(String(row['receipt_json'])) as PrivilegedOperationReceipt
        } catch {
          return null
        }
      })
      .filter((r): r is PrivilegedOperationReceipt => r !== null)
      .reverse()
  }

  counts(sessionId: string): Record<PrivilegedOutcome, number> {
    const out = Object.fromEntries(PRIVILEGED_OUTCOMES.map((o) => [o, 0])) as Record<PrivilegedOutcome, number>
    for (const row of prepare(this.db, 'SELECT outcome, COUNT(*) AS n FROM privileged_operations WHERE session_id = ? GROUP BY outcome').all(sessionId) as { outcome: PrivilegedOutcome; n: number }[]) out[row.outcome] = row.n
    return out
  }
}

/** The same, in memory: for tests and for a runtime without a database. */
export class MemoryPrivilegeStore implements PrivilegeStore {
  readonly sessionRows = new Map<string, PrivilegeSessionRow>()
  readonly receiptRows: PrivilegedOperationReceipt[] = []

  saveSession(s: PrivilegeSessionRow): void {
    this.sessionRows.set(s.id, { ...s })
  }
  session(id: string): PrivilegeSessionRow | null {
    return this.sessionRows.get(id) ?? null
  }
  sessions(opts: { runId?: string } = {}): PrivilegeSessionRow[] {
    return [...this.sessionRows.values()].filter((s) => opts.runId === undefined || s.runId === opts.runId).reverse()
  }
  unfinished(): PrivilegeSessionRow[] {
    return [...this.sessionRows.values()].filter((s) => s.state === 'PREPARING' || s.state === 'ACTIVE')
  }
  record(r: PrivilegedOperationReceipt): void {
    this.receiptRows.push(structuredClone(r))
  }
  receipts(opts: { runId?: string; sessionId?: string; since?: string }): PrivilegedOperationReceipt[] {
    return this.receiptRows.filter((r) => (opts.runId === undefined || r.runId === opts.runId) && (opts.sessionId === undefined || r.sessionId === opts.sessionId) && (opts.since === undefined || r.requestedAt >= opts.since))
  }
  counts(sessionId: string): Record<PrivilegedOutcome, number> {
    const out = Object.fromEntries(PRIVILEGED_OUTCOMES.map((o) => [o, 0])) as Record<PrivilegedOutcome, number>
    for (const r of this.receiptRows) if (r.sessionId === sessionId) out[r.outcome]++
    return out
  }
}

export type { PrivilegeSessionStatus }
