import type {
  AutonomyAuditEvent,
  AutonomyCapability,
  AutonomyProfile,
  BoundaryRequest,
  BoundaryRequestState,
  BrokerOutcome,
  CapabilityGrant,
  GrantCreator,
  GrantScope,
  ProjectEnrollment,
  ResourceKind,
  SecurityEventSeverity,
} from '@shared/autonomy'
import type { Database } from '../database'
import { guard, prepare, type Row } from '../table'

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** 0.8: which projects the user enrolled, and with which profile. One row per project. */
export class EnrollmentRepository {
  constructor(private readonly db: Database) {}

  get(projectId: string): ProjectEnrollment | null {
    const row = prepare(this.db, 'SELECT * FROM autonomy_enrollments WHERE project_id = ?').get(projectId) as Row | undefined
    if (!row) return null
    return { projectId: String(row['project_id']), profile: String(row['profile']) as AutonomyProfile, enrolledAt: String(row['enrolled_at']), policyVersion: String(row['policy_version']) }
  }

  set(enrollment: ProjectEnrollment): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO autonomy_enrollments (project_id, profile, enrolled_at, policy_version) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET profile = excluded.profile, enrolled_at = excluded.enrolled_at, policy_version = excluded.policy_version`,
      ).run(enrollment.projectId, enrollment.profile, enrollment.enrolledAt, enrollment.policyVersion),
    )
  }

  remove(projectId: string): boolean {
    return guard(() => prepare(this.db, 'DELETE FROM autonomy_enrollments WHERE project_id = ?').run(projectId)).changes > 0
  }
}

function grantOf(row: Row): CapabilityGrant {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    capability: String(row['capability']) as AutonomyCapability,
    scope: String(row['scope']) as GrantScope,
    runId: text(row['run_id']),
    resource: { kind: String(row['resource_kind']) as ResourceKind, value: String(row['resource_value']) },
    createdBy: String(row['created_by']) as GrantCreator,
    createdAt: String(row['created_at']),
    expiresAt: text(row['expires_at']),
    reason: String(row['reason']),
    requestId: text(row['request_id']),
    consumedAt: text(row['consumed_at']),
    revokedAt: text(row['revoked_at']),
  }
}

/** 0.8: what the user allowed beyond a project's profile. Implements the broker's GrantStorePort. */
export class CapabilityGrantRepository {
  constructor(private readonly db: Database) {}

  insert(g: CapabilityGrant): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO capability_grants (id, project_id, capability, scope, run_id, resource_kind, resource_value, created_by, created_at, expires_at, reason, request_id, consumed_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(g.id, g.projectId, g.capability, g.scope, g.runId, g.resource.kind, g.resource.value, g.createdBy, g.createdAt, g.expiresAt, g.reason, g.requestId, g.consumedAt, g.revokedAt),
    )
  }

  get(id: string): CapabilityGrant | null {
    const row = prepare(this.db, 'SELECT * FROM capability_grants WHERE id = ?').get(id) as Row | undefined
    return row ? grantOf(row) : null
  }

  listUsable(projectId: string): CapabilityGrant[] {
    return (prepare(this.db, 'SELECT * FROM capability_grants WHERE project_id = ? AND revoked_at IS NULL AND consumed_at IS NULL ORDER BY created_at, rowid').all(projectId) as Row[]).map(grantOf)
  }

  /** Every grant of a project, newest first: what the user sees under "what did I authorize". */
  list(projectId: string, limit = 200): CapabilityGrant[] {
    return (prepare(this.db, 'SELECT * FROM capability_grants WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as Row[]).map(grantOf)
  }

  consume(id: string, at: string): boolean {
    return guard(() => prepare(this.db, "UPDATE capability_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND scope = 'ONCE'").run(at, id)).changes > 0
  }

  revoke(id: string, at: string): boolean {
    return guard(() => prepare(this.db, 'UPDATE capability_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id)).changes > 0
  }
}

function requestOf(row: Row): BoundaryRequest {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    agentId: text(row['agent_id']),
    capability: String(row['capability']) as AutonomyCapability,
    resource: { kind: String(row['resource_kind']) as ResourceKind, value: String(row['resource_value']) },
    action: String(row['action']),
    reason: String(row['reason']),
    dedupeKey: String(row['dedupe_key']),
    state: String(row['state']) as BoundaryRequestState,
    occurrences: Number(row['occurrences']),
    createdAt: String(row['created_at']),
    lastSeenAt: String(row['last_seen_at']),
    decidedAt: text(row['decided_at']),
    decidedScope: text(row['decided_scope']) as GrantScope | null,
    grantId: text(row['grant_id']),
  }
}

/** 0.8: the questions put to the user about a boundary, with their answers. Implements BoundaryRequestStorePort. */
export class BoundaryRequestRepository {
  constructor(private readonly db: Database) {}

  insert(r: BoundaryRequest): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO boundary_requests (id, project_id, run_id, task_id, agent_id, capability, resource_kind, resource_value, action, reason, dedupe_key, state, occurrences, created_at, last_seen_at, decided_at, decided_scope, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.projectId, r.runId, r.taskId, r.agentId, r.capability, r.resource.kind, r.resource.value, r.action, r.reason, r.dedupeKey, r.state, r.occurrences, r.createdAt, r.lastSeenAt, r.decidedAt, r.decidedScope, r.grantId),
    )
  }

  get(id: string): BoundaryRequest | null {
    const row = prepare(this.db, 'SELECT * FROM boundary_requests WHERE id = ?').get(id) as Row | undefined
    return row ? requestOf(row) : null
  }

  /** The newest request for this need. A pending one, if there is one, is always the newest. */
  findByKey(dedupeKey: string): BoundaryRequest | null {
    const row = prepare(this.db, "SELECT * FROM boundary_requests WHERE dedupe_key = ? ORDER BY (state = 'PENDING') DESC, created_at DESC, rowid DESC LIMIT 1").get(dedupeKey) as Row | undefined
    return row ? requestOf(row) : null
  }

  touch(id: string, at: string): void {
    guard(() => prepare(this.db, 'UPDATE boundary_requests SET occurrences = occurrences + 1, last_seen_at = ? WHERE id = ?').run(at, id))
  }

  decide(id: string, state: 'GRANTED' | 'DENIED' | 'EXPIRED', at: string, scope: GrantScope | null, grantId: string | null): boolean {
    return guard(() => prepare(this.db, "UPDATE boundary_requests SET state = ?, decided_at = ?, decided_scope = ?, grant_id = ? WHERE id = ? AND state = 'PENDING'").run(state, at, scope, grantId, id)).changes > 0
  }

  listPending(projectId?: string): BoundaryRequest[] {
    const rows = (projectId === undefined
      ? prepare(this.db, "SELECT * FROM boundary_requests WHERE state = 'PENDING' ORDER BY created_at, rowid").all()
      : prepare(this.db, "SELECT * FROM boundary_requests WHERE state = 'PENDING' AND project_id = ? ORDER BY created_at, rowid").all(projectId)) as Row[]
    return rows.map(requestOf)
  }

  /** Decided requests, newest first. */
  listRecent(limit = 100, projectId?: string): BoundaryRequest[] {
    const rows = (projectId === undefined
      ? prepare(this.db, "SELECT * FROM boundary_requests WHERE state <> 'PENDING' ORDER BY decided_at DESC, rowid DESC LIMIT ?").all(limit)
      : prepare(this.db, "SELECT * FROM boundary_requests WHERE state <> 'PENDING' AND project_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT ?").all(projectId, limit)) as Row[]
    return rows.map(requestOf)
  }

  countPending(): number {
    return (prepare(this.db, "SELECT COUNT(*) AS n FROM boundary_requests WHERE state = 'PENDING'").get() as { n: number }).n
  }

  /** How many requests a mission produced, in any state: the interruption count of the acceptance tests. */
  countForRun(runId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM boundary_requests WHERE run_id = ?').get(runId) as { n: number }).n
  }
}

export const MAX_AUDIT_TOTAL = 50_000
export const MAX_AUDIT_PAGE = 200
const PRUNE_EVERY = 50

function auditOf(row: Row): AutonomyAuditEvent {
  return {
    seq: Number(row['seq']),
    id: String(row['id']),
    timestamp: String(row['timestamp']),
    projectId: text(row['project_id']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    agentId: text(row['agent_id']),
    severity: String(row['severity']) as SecurityEventSeverity,
    capability: text(row['capability']) as AutonomyCapability | null,
    outcome: text(row['outcome']) as BrokerOutcome | null,
    authorizedBy: text(row['authorized_by']),
    action: String(row['action']),
    resource: String(row['resource']),
    reason: String(row['reason']),
  }
}

/**
 * 0.8: what the broker decided, kept quietly. Bounded: every PRUNE_EVERY inserts the oldest rows beyond
 * MAX_AUDIT_TOTAL are deleted, ordinary actions first, so that a long run of builds cannot push a denial out.
 */
export class AutonomyAuditRepository {
  private inserts = 0

  constructor(private readonly db: Database) {}

  record(e: Omit<AutonomyAuditEvent, 'seq'>): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO autonomy_audit (id, timestamp, project_id, run_id, task_id, agent_id, severity, capability, outcome, authorized_by, action, resource, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.id, e.timestamp, e.projectId, e.runId, e.taskId, e.agentId, e.severity, e.capability, e.outcome, e.authorizedBy, e.action.slice(0, 400), e.resource.slice(0, 700), e.reason.slice(0, 600)),
    )
    if (++this.inserts % PRUNE_EVERY === 0) this.prune()
  }

  list(opts: { projectId?: string; runId?: string; severities?: SecurityEventSeverity[]; limit?: number; before?: number } = {}): { events: AutonomyAuditEvent[]; nextBefore: number | null } {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), MAX_AUDIT_PAGE)
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(opts.projectId)
    }
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.severities !== undefined && opts.severities.length > 0) {
      where.push(`severity IN (${opts.severities.map(() => '?').join(', ')})`)
      params.push(...opts.severities)
    }
    if (opts.before !== undefined) {
      where.push('seq < ?')
      params.push(opts.before)
    }
    const rows = prepare(this.db, `SELECT * FROM autonomy_audit ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, limit + 1) as Row[]
    const page = rows.slice(0, limit).map(auditOf)
    const last = page[page.length - 1]
    return { events: page, nextBefore: rows.length > limit && last !== undefined ? last.seq : null }
  }

  /** Counts per severity for a mission or a project: the autonomy metrics. */
  counts(opts: { runId?: string; projectId?: string }): Record<string, number> {
    const rows = (opts.runId !== undefined
      ? prepare(this.db, 'SELECT severity, COUNT(*) AS n FROM autonomy_audit WHERE run_id = ? GROUP BY severity').all(opts.runId)
      : opts.projectId !== undefined
        ? prepare(this.db, 'SELECT severity, COUNT(*) AS n FROM autonomy_audit WHERE project_id = ? GROUP BY severity').all(opts.projectId)
        : prepare(this.db, 'SELECT severity, COUNT(*) AS n FROM autonomy_audit GROUP BY severity').all()) as { severity: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.severity, r.n]))
  }

  prune(): void {
    const total = (prepare(this.db, 'SELECT COUNT(*) AS n FROM autonomy_audit').get() as { n: number }).n
    const excess = total - MAX_AUDIT_TOTAL
    if (excess <= 0) return
    const removed = prepare(this.db, "DELETE FROM autonomy_audit WHERE seq IN (SELECT seq FROM autonomy_audit WHERE severity = 'NORMAL_AUTONOMOUS_ACTION' ORDER BY seq LIMIT ?)").run(excess).changes
    if (removed < excess) prepare(this.db, 'DELETE FROM autonomy_audit WHERE seq IN (SELECT seq FROM autonomy_audit ORDER BY seq LIMIT ?)').run(excess - removed)
  }
}
