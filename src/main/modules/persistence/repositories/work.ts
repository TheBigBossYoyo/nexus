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
import { Table, type Codec } from '../table'

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

const reviewCodec: Codec<Review> = {
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
