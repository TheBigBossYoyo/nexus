import type {
  AcceptanceCriterion,
  ApprovalRequest,
  Artifact,
  Decision,
  Review,
  UsageSnapshot,
  Verification,
  Worktree,
} from '@shared/domain'
import type { Database } from '../database'
import { Table, decode, prepare, type Codec, type Row } from '../table'

const worktreeCodec: Codec<Worktree> = {
  table: 'worktrees',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    path: 'text',
    branch: 'text',
    baseCommit: 'text',
    state: 'text',
    createdAt: 'text',
  },
}

export class WorktreeRepository extends Table<Worktree> {
  constructor(db: Database) {
    super(db, worktreeCodec, 'worktree')
  }

  listByRun(runId: string): Worktree[] {
    return this.byRun(runId)
  }

  /** The most recently created worktree for the task, whatever its state. */
  getByTask(taskId: string): Worktree | null {
    return this.one('WHERE task_id = ? ORDER BY created_at DESC, rowid DESC', [taskId])
  }

  listActive(runId?: string): Worktree[] {
    return runId === undefined
      ? this.query("WHERE state = 'active' ORDER BY created_at, rowid")
      : this.query("WHERE run_id = ? AND state = 'active' ORDER BY created_at, rowid", [runId])
  }
}

// `arbitration` is not a column: it is stored as an artifact and attached by the IPC layer.
const storedReviewCodec: Codec<Omit<Review, 'arbitration'>> = {
  table: 'reviews',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    attempt: 'num',
    verdict: 'text',
    summary: 'text',
    findings: 'json',
    createdAt: 'text',
  },
}
const reviewCodec = storedReviewCodec as Codec<Review>

export class ReviewRepository extends Table<Review> {
  constructor(db: Database) {
    super(db, reviewCodec, 'review')
  }

  listByTask(taskId: string): Review[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid', [taskId])
  }

  listByRun(runId: string): Review[] {
    return this.byRun(runId)
  }

  /** Reviews of several tasks in one query, oldest first. */
  listByTasks(taskIds: readonly string[]): Review[] {
    if (taskIds.length === 0) return []
    return this.query(`WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`, [...taskIds])
  }
}

const verificationCodec: Codec<Verification> = {
  table: 'verification_results',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    attempt: 'num',
    kind: 'text',
    passed: 'bool',
    summary: 'text',
    criteria: 'json',
    commands: 'json',
    failures: 'json',
    createdAt: 'text',
  },
}

export class VerificationRepository extends Table<Verification> {
  constructor(db: Database) {
    super(db, verificationCodec, 'verification')
  }

  listByTask(taskId: string): Verification[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid', [taskId])
  }

  listByRun(runId: string): Verification[] {
    return this.byRun(runId)
  }

  /** The newest `limit` check runs of the given tasks (the whole run when taskIds is null), newest first, with the true total. */
  latestChecks(runId: string, taskIds: readonly string[] | null, limit: number): { items: Verification[]; total: number } {
    if (taskIds && taskIds.length === 0) return { items: [], total: 0 }
    const scope = taskIds ? `AND task_id IN (${taskIds.map(() => '?').join(',')})` : ''
    const params = [runId, ...(taskIds ?? [])]
    const items = this.query(
      `WHERE run_id = ? AND kind = 'checks' ${scope} ORDER BY created_at DESC, rowid DESC LIMIT ${Math.floor(limit)}`,
      params,
    )
    const total = (prepare(this.db, `SELECT COUNT(*) AS n FROM verification_results WHERE run_id = ? AND kind = 'checks' ${scope}`).get(...params) as { n: number }).n
    return { items, total }
  }
}

const criterionCodec: Codec<AcceptanceCriterion> = {
  table: 'acceptance_criteria',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    text: 'text',
    status: 'text',
    evidence: 'text',
    updatedAt: 'text',
  },
}

export class CriterionRepository extends Table<AcceptanceCriterion> {
  constructor(db: Database) {
    super(db, criterionCodec, 'acceptance criterion')
  }

  /** Includes mission-level (taskId null) and task-level criteria. */
  listByRun(runId: string): AcceptanceCriterion[] {
    return this.byRun(runId, 'rowid')
  }

  listByTask(taskId: string): AcceptanceCriterion[] {
    return this.query('WHERE task_id = ? ORDER BY rowid', [taskId])
  }
}

const decisionCodec: Codec<Decision> = {
  table: 'decisions',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    title: 'text',
    decision: 'text',
    rationale: 'text',
    createdAt: 'text',
  },
}

export class DecisionRepository extends Table<Decision> {
  constructor(db: Database) {
    super(db, decisionCodec, 'decision')
  }

  listByRun(runId: string): Decision[] {
    return this.byRun(runId)
  }
}

const approvalCodec: Codec<ApprovalRequest> = {
  table: 'approval_requests',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    kind: 'text',
    action: 'text',
    reason: 'text',
    command: 'text',
    requestedBy: 'text',
    risk: 'text',
    status: 'text',
    note: 'text',
    createdAt: 'text',
    resolvedAt: 'text',
  },
}

export class ApprovalRepository extends Table<ApprovalRequest> {
  constructor(db: Database) {
    super(db, approvalCodec, 'approval request')
  }

  listPending(runId?: string): ApprovalRequest[] {
    return runId === undefined
      ? this.query("WHERE status = 'pending' ORDER BY created_at, rowid")
      : this.query("WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid", [runId])
  }

  listByRun(runId: string): ApprovalRequest[] {
    return this.byRun(runId)
  }
}

const artifactCodec: Codec<Artifact> = {
  table: 'artifacts',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    kind: 'text',
    title: 'text',
    content: 'text',
    createdAt: 'text',
  },
}

export type ArtifactMeta = Omit<Artifact, 'content'>
const artifactMetaCodec: Codec<ArtifactMeta> = {
  table: 'artifacts',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', kind: 'text', title: 'text', createdAt: 'text' },
}

export class ArtifactRepository extends Table<Artifact> {
  constructor(db: Database) {
    super(db, artifactCodec, 'artifact')
  }

  listByRun(runId: string): Artifact[] {
    return this.byRun(runId)
  }

  listByTask(taskId: string): Artifact[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid', [taskId])
  }

  /** Artifacts of one kind with their content (e.g. the arbitration records). */
  listByRunKind(runId: string, kind: string): Artifact[] {
    return this.query('WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid', [runId, kind])
  }

  /** Artifact headers (no content: setup logs and reports can be large), newest first, excluding one kind; with the true total. */
  listMeta(runId: string, taskIds: readonly string[] | null, excludeKind: string, limit: number): { items: ArtifactMeta[]; total: number } {
    if (taskIds && taskIds.length === 0) return { items: [], total: 0 }
    const scope = taskIds ? ` AND task_id IN (${taskIds.map(() => '?').join(',')})` : ''
    const params = [runId, excludeKind, ...(taskIds ?? [])]
    const rows = prepare(
      this.db,
      `SELECT id, run_id, task_id, agent_id, kind, title, created_at FROM artifacts WHERE run_id = ? AND kind <> ?${scope} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...params, limit) as Row[]
    const total = (prepare(this.db, `SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ? AND kind <> ?${scope}`).get(...params) as { n: number }).n
    return { items: rows.map((r) => decode(artifactMetaCodec, r)), total }
  }
}

const usageCodec: Codec<UsageSnapshot> = {
  table: 'usage_snapshots',
  fields: {
    id: 'text',
    runId: 'text',
    agentId: 'text',
    model: 'text',
    inputTokens: 'num',
    outputTokens: 'num',
    cacheReadTokens: 'num',
    cacheCreationTokens: 'num',
    costUsd: 'num',
    contextWindow: 'num',
    turns: 'num',
    createdAt: 'text',
  },
}

export class UsageRepository extends Table<UsageSnapshot> {
  constructor(db: Database) {
    super(db, usageCodec, 'usage snapshot')
  }

  listByRun(runId: string): UsageSnapshot[] {
    return this.byRun(runId)
  }

  listByAgent(agentId: string): UsageSnapshot[] {
    return this.query('WHERE agent_id = ? ORDER BY created_at, rowid', [agentId])
  }
}
