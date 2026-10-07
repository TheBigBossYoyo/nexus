import { MAX_DECISION_PAGE, type ExecutionDecision, type ProvenanceKind, type SecurityDecisionPage, type SecurityDecisionRecord, type TrustClass } from '@shared/security'
import type { Database } from '../database'
import { guard, prepare, type Row } from '../table'

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** The newest rows kept per run, and in total. Older rows are pruned as new ones arrive. */
export const MAX_DECISIONS_PER_RUN = 2000
export const MAX_DECISIONS_TOTAL = 20000
const PRUNE_EVERY = 25

function decisionOf(row: Row): SecurityDecisionRecord {
  return {
    seq: Number(row['seq']),
    id: String(row['id']),
    timestamp: String(row['timestamp']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    agentId: text(row['agent_id']),
    action: String(row['action']),
    classification: String(row['classification']) as TrustClass,
    provenance: String(row['provenance']) as ProvenanceKind,
    decision: String(row['decision']) as ExecutionDecision,
    reason: String(row['reason']),
    policyVersion: String(row['policy_version']),
  }
}

/**
 * v0.7: the security decision log. Bounded: every PRUNE_EVERY inserts the run's oldest rows beyond
 * MAX_DECISIONS_PER_RUN and the log's oldest rows beyond MAX_DECISIONS_TOTAL are deleted.
 */
export class SecurityDecisionRepository {
  private inserts = 0
  /** Told about every decision after it is stored (the runtime's notifications). Never throws into the caller. */
  onRecord: ((entry: Omit<SecurityDecisionRecord, 'seq'>) => void) | null = null

  constructor(private readonly db: Database) {}

  record(entry: Omit<SecurityDecisionRecord, 'seq'>): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO security_decisions (id, timestamp, run_id, task_id, agent_id, action, classification, provenance, decision, reason, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(entry.id, entry.timestamp, entry.runId, entry.taskId, entry.agentId, entry.action, entry.classification, entry.provenance, entry.decision, entry.reason, entry.policyVersion),
    )
    if (++this.inserts % PRUNE_EVERY === 0) this.prune(entry.runId)
    try {
      this.onRecord?.(entry)
    } catch {
      // A listener's failure is not the policy's.
    }
  }

  /** Newest first. `before` is the `nextBefore` of the previous page. */
  list(opts: { runId?: string; limit?: number; before?: number } = {}): SecurityDecisionPage {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), MAX_DECISION_PAGE)
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.before !== undefined) {
      where.push('seq < ?')
      params.push(opts.before)
    }
    const rows = prepare(this.db, `SELECT * FROM security_decisions ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, limit + 1) as Row[]
    const page = rows.slice(0, limit).map(decisionOf)
    const last = page[page.length - 1]
    return { decisions: page, nextBefore: rows.length > limit && last !== undefined ? last.seq : null }
  }

  count(runId?: string): number {
    const row = (runId === undefined
      ? prepare(this.db, 'SELECT COUNT(*) AS n FROM security_decisions').get()
      : prepare(this.db, 'SELECT COUNT(*) AS n FROM security_decisions WHERE run_id = ?').get(runId)) as { n: number }
    return row.n
  }

  prune(runId: string | null): void {
    if (runId !== null) {
      prepare(
        this.db,
        'DELETE FROM security_decisions WHERE run_id = ? AND seq <= COALESCE((SELECT seq FROM security_decisions WHERE run_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)',
      ).run(runId, runId, MAX_DECISIONS_PER_RUN)
    }
    prepare(
      this.db,
      'DELETE FROM security_decisions WHERE seq <= COALESCE((SELECT seq FROM security_decisions ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)',
    ).run(MAX_DECISIONS_TOTAL)
  }
}

export interface FileProvenanceRow {
  id: string
  path: string
  worktree: string
  sha256: string | null
  createdByAgentId: string | null
  modifiedByAgentId: string | null
  taskId: string | null
  runId: string | null
  firstSeenAt: string
  updatedAt: string
  trust: TrustClass
}

const MAX_PROVENANCE_PER_WORKTREE = 5000

/** v0.7: which files agents wrote, per worktree. Implements the policy layer's ProvenanceStore. */
export class FileProvenanceRepository {
  private writes = 0

  constructor(private readonly db: Database) {}

  upsert(r: FileProvenanceRow): void {
    const key = process.platform === 'win32' ? r.path.toLowerCase() : r.path
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO file_provenance (id, worktree, path, path_key, sha256, created_by_agent_id, modified_by_agent_id, task_id, run_id, first_seen_at, updated_at, trust)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worktree, path_key) DO UPDATE SET sha256 = excluded.sha256, modified_by_agent_id = excluded.modified_by_agent_id,
           task_id = excluded.task_id, run_id = excluded.run_id, updated_at = excluded.updated_at, trust = excluded.trust`,
      ).run(r.id, r.worktree, r.path, key, r.sha256, r.createdByAgentId, r.modifiedByAgentId, r.taskId, r.runId, r.firstSeenAt, r.updatedAt, r.trust),
    )
    if (++this.writes % PRUNE_EVERY === 0) {
      prepare(
        this.db,
        'DELETE FROM file_provenance WHERE worktree = ? AND updated_at <= COALESCE((SELECT updated_at FROM file_provenance WHERE worktree = ? ORDER BY updated_at DESC LIMIT 1 OFFSET ?), \'\')',
      ).run(r.worktree, r.worktree, MAX_PROVENANCE_PER_WORKTREE)
    }
  }

  listByWorktree(worktree: string): FileProvenanceRow[] {
    const rows = prepare(this.db, 'SELECT * FROM file_provenance WHERE worktree = ? ORDER BY updated_at DESC LIMIT ?').all(worktree, MAX_PROVENANCE_PER_WORKTREE) as Row[]
    return rows.map((row) => ({
      id: String(row['id']),
      path: String(row['path']),
      worktree: String(row['worktree']),
      sha256: text(row['sha256']),
      createdByAgentId: text(row['created_by_agent_id']),
      modifiedByAgentId: text(row['modified_by_agent_id']),
      taskId: text(row['task_id']),
      runId: text(row['run_id']),
      firstSeenAt: String(row['first_seen_at']),
      updatedAt: String(row['updated_at']),
      trust: String(row['trust']) as TrustClass,
    }))
  }
}
