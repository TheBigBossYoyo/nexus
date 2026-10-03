import type {
  ContextPack,
  ContextPackEntry,
  FactKind,
  GraphProposal,
  GraphRevision,
  PlanningCandidate,
  PlanningCritique,
  ProposalStatus,
  RepositoryFact,
  RoutingDecision,
  TaskOutcome,
} from '@shared/v2'
import type { Database } from '../database'
import { Table, decode, guard, prepare, type Codec, type Row, type SqlValue } from '../table'
import { toFtsQuery } from './memory'

const revisionCodec: Codec<GraphRevision> = {
  table: 'graph_revisions',
  fields: { id: 'text', runId: 'text', version: 'num', reason: 'text', proposalId: 'text', snapshot: 'json', createdAt: 'text' },
}

export class GraphRevisionRepository extends Table<GraphRevision> {
  constructor(db: Database) {
    super(db, revisionCodec, 'graph revision')
  }

  /** Ordered by version. */
  listByRun(runId: string): GraphRevision[] {
    return this.byRun(runId, 'version')
  }

  latest(runId: string): GraphRevision | null {
    return this.one('WHERE run_id = ? ORDER BY version DESC', [runId])
  }

  /** 1 when the run has no revision yet. */
  nextVersion(runId: string): number {
    const row = prepare(this.db, 'SELECT MAX(version) AS v FROM graph_revisions WHERE run_id = ?').get(runId) as {
      v: number | null
    }
    return (row.v ?? 0) + 1
  }
}

const proposalCodec: Codec<GraphProposal> = {
  table: 'graph_proposals',
  fields: {
    id: 'text',
    runId: 'text',
    proposedByAgentId: 'text',
    proposedBy: 'text',
    taskId: 'text',
    type: 'text',
    reason: 'text',
    evidence: 'text',
    changes: 'json',
    status: 'text',
    rejectionReason: 'text',
    revisionId: 'text',
    createdAt: 'text',
    resolvedAt: 'text',
  },
}

export class GraphProposalRepository extends Table<GraphProposal> {
  constructor(db: Database) {
    super(db, proposalCodec, 'graph proposal')
  }

  listByRun(runId: string): GraphProposal[] {
    return this.byRun(runId)
  }

  listByStatus(runId: string, status: ProposalStatus): GraphProposal[] {
    return this.query('WHERE run_id = ? AND status = ? ORDER BY created_at, rowid', [runId, status])
  }
}

const candidateCodec: Codec<PlanningCandidate> = {
  table: 'planning_candidates',
  fields: {
    id: 'text',
    runId: 'text',
    label: 'text',
    lens: 'text',
    agentId: 'text',
    plan: 'json',
    valid: 'bool',
    errors: 'json',
    durationMs: 'num',
    model: 'text',
    costUsd: 'num',
    createdAt: 'text',
  },
}

export class PlanningCandidateRepository extends Table<PlanningCandidate> {
  constructor(db: Database) {
    super(db, candidateCodec, 'planning candidate')
  }

  listByRun(runId: string): PlanningCandidate[] {
    return this.byRun(runId)
  }
}

const critiqueCodec: Codec<PlanningCritique> = {
  table: 'planning_critiques',
  fields: { id: 'text', runId: 'text', agentId: 'text', output: 'json', createdAt: 'text' },
}

export class PlanningCritiqueRepository extends Table<PlanningCritique> {
  constructor(db: Database) {
    super(db, critiqueCodec, 'planning critique')
  }

  listByRun(runId: string): PlanningCritique[] {
    return this.byRun(runId)
  }
}

const routingCodec: Codec<RoutingDecision> = {
  table: 'routing_decisions',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    role: 'text',
    purpose: 'text',
    requestedPolicy: 'text',
    resolvedPolicy: 'text',
    resolvedTier: 'text',
    resolvedModel: 'text',
    reasons: 'json',
    createdAt: 'text',
  },
}

export class RoutingDecisionRepository extends Table<RoutingDecision> {
  constructor(db: Database) {
    super(db, routingCodec, 'routing decision')
  }

  listByRun(runId: string): RoutingDecision[] {
    return this.byRun(runId)
  }

  listByTask(taskId: string): RoutingDecision[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid', [taskId])
  }

  latestForAgent(agentId: string): RoutingDecision | null {
    return this.one('WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC', [agentId])
  }
}

const outcomeCodec: Codec<TaskOutcome> = {
  table: 'task_outcomes',
  fields: {
    id: 'text',
    projectId: 'text',
    runId: 'text',
    taskId: 'text',
    role: 'text',
    model: 'text',
    tier: 'text',
    category: 'text',
    complexity: 'text',
    risk: 'text',
    attempts: 'num',
    firstPassVerified: 'bool',
    completed: 'bool',
    reviewRejections: 'num',
    repairCount: 'num',
    checksFailed: 'num',
    humanInterventions: 'num',
    elapsedMs: 'num',
    inputTokens: 'num',
    outputTokens: 'num',
    createdAt: 'text',
  },
}

/** Columns replaced when a second outcome arrives for the same task (id, task_id and created_at are kept). */
const OUTCOME_REPLACED = [
  'project_id',
  'run_id',
  'role',
  'model',
  'tier',
  'category',
  'complexity',
  'risk',
  'attempts',
  'first_pass_verified',
  'completed',
  'review_rejections',
  'repair_count',
  'checks_failed',
  'human_interventions',
  'elapsed_ms',
  'input_tokens',
  'output_tokens',
] as const

export class TaskOutcomeRepository extends Table<TaskOutcome> {
  constructor(db: Database) {
    super(db, outcomeCodec, 'task outcome')
  }

  getByTask(taskId: string): TaskOutcome | null {
    return this.one('WHERE task_id = ?', [taskId])
  }

  listByProject(projectId: string): TaskOutcome[] {
    return this.query('WHERE project_id = ? ORDER BY created_at, rowid', [projectId])
  }

  listAll(): TaskOutcome[] {
    return this.query('ORDER BY created_at, rowid')
  }

  /** One outcome per task: a second write replaces every measured field but keeps the original id and createdAt. */
  upsertForTask(outcome: TaskOutcome): TaskOutcome {
    const cols = ['id', 'task_id', 'created_at', ...OUTCOME_REPLACED]
    const sql = `INSERT INTO task_outcomes (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
      ON CONFLICT(task_id) DO UPDATE SET ${OUTCOME_REPLACED.map((c) => `${c} = excluded.${c}`).join(', ')}`
    guard(() =>
      prepare(this.db, sql).run({
        id: outcome.id,
        task_id: outcome.taskId,
        created_at: outcome.createdAt,
        project_id: outcome.projectId,
        run_id: outcome.runId,
        role: outcome.role,
        model: outcome.model,
        tier: outcome.tier,
        category: outcome.category,
        complexity: outcome.complexity,
        risk: outcome.risk,
        attempts: outcome.attempts,
        first_pass_verified: outcome.firstPassVerified ? 1 : 0,
        completed: outcome.completed ? 1 : 0,
        review_rejections: outcome.reviewRejections,
        repair_count: outcome.repairCount,
        checks_failed: outcome.checksFailed,
        human_interventions: outcome.humanInterventions,
        elapsed_ms: outcome.elapsedMs,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
      }),
    )
    return this.getByTask(outcome.taskId) ?? outcome
  }
}

const factCodec: Codec<RepositoryFact> = {
  table: 'repository_facts',
  fields: {
    id: 'text',
    projectId: 'text',
    kind: 'text',
    subject: 'text',
    statement: 'text',
    source: 'text',
    confidence: 'text',
    files: 'json',
    fingerprint: 'text',
    stale: 'bool',
    createdAt: 'text',
    verifiedAt: 'text',
  },
}

export interface FactListOptions {
  /** Stale facts are hidden unless this is true. */
  includeStale?: boolean
  kind?: FactKind
}

export interface FactSearchOptions {
  limit?: number
  includeStale?: boolean
}

export class FactRepository extends Table<RepositoryFact> {
  constructor(db: Database) {
    super(db, factCodec, 'repository fact')
  }

  /** Keyed by (projectId, kind, subject). An existing row keeps its id and createdAt; the stored row is returned. */
  upsert(fact: RepositoryFact): RepositoryFact {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO repository_facts (id, project_id, kind, subject, statement, source, confidence, files, fingerprint, stale, created_at, verified_at)
         VALUES (@id, @project_id, @kind, @subject, @statement, @source, @confidence, @files, @fingerprint, @stale, @created_at, @verified_at)
         ON CONFLICT(project_id, kind, subject) DO UPDATE SET
           statement = excluded.statement, source = excluded.source, confidence = excluded.confidence,
           files = excluded.files, fingerprint = excluded.fingerprint, stale = excluded.stale,
           verified_at = excluded.verified_at`,
      ).run({
        id: fact.id,
        project_id: fact.projectId,
        kind: fact.kind,
        subject: fact.subject,
        statement: fact.statement,
        source: fact.source,
        confidence: fact.confidence,
        files: JSON.stringify(fact.files),
        fingerprint: fact.fingerprint,
        stale: fact.stale ? 1 : 0,
        created_at: fact.createdAt,
        verified_at: fact.verifiedAt,
      }),
    )
    return this.one('WHERE project_id = ? AND kind = ? AND subject = ?', [fact.projectId, fact.kind, fact.subject]) ?? fact
  }

  listByProject(projectId: string, options: FactListOptions = {}): RepositoryFact[] {
    const conds = ['project_id = ?']
    const params: SqlValue[] = [projectId]
    if (!options.includeStale) conds.push('stale = 0')
    if (options.kind !== undefined) {
      conds.push('kind = ?')
      params.push(options.kind)
    }
    return this.query(`WHERE ${conds.join(' AND ')} ORDER BY kind, subject`, params)
  }

  /** Full-text search (bm25, subject weighted highest) over subject/statement/files. Stale facts are hidden by default. */
  search(projectId: string, query: string, options: FactSearchOptions = {}): RepositoryFact[] {
    const match = toFtsQuery(query)
    if (!match) return []
    const rows = prepare(
      this.db,
      `SELECT f.* FROM repository_facts_fts JOIN repository_facts f ON f.seq = repository_facts_fts.rowid
       WHERE repository_facts_fts MATCH ? AND f.project_id = ? ${options.includeStale ? '' : 'AND f.stale = 0'}
       ORDER BY bm25(repository_facts_fts, 5.0, 1.0, 2.0), f.seq
       LIMIT ?`,
    ).all(match, projectId, options.limit ?? 10) as Row[]
    return rows.map((r) => decode(factCodec, r))
  }

  /** Returns how many facts were newly marked stale. */
  markStale(ids: readonly string[]): number {
    const stmt = prepare(this.db, 'UPDATE repository_facts SET stale = 1 WHERE id = ? AND stale = 0')
    return guard(() => this.db.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))())
  }

  deleteByProject(projectId: string): number {
    return guard(() => prepare(this.db, 'DELETE FROM repository_facts WHERE project_id = ?').run(projectId)).changes
  }
}

type PackRow = Omit<ContextPack, 'entries'>

const packCodec: Codec<PackRow> = {
  table: 'context_packs',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', purpose: 'text', totalChars: 'num', createdAt: 'text' },
}

const entryCodec: Codec<ContextPackEntry> = {
  table: 'context_pack_entries',
  fields: {
    id: 'text',
    packId: 'text',
    section: 'text',
    sourceKind: 'text',
    sourceId: 'text',
    title: 'text',
    reason: 'text',
    included: 'bool',
    chars: 'num',
  },
}

const ENTRY_COLUMNS = 'id, pack_id, section, source_kind, source_id, title, reason, included, chars'

class PackTable extends Table<PackRow> {
  constructor(db: Database) {
    super(db, packCodec, 'context pack')
  }

  /** Newest first. */
  listWhere(column: 'task_id' | 'agent_id' | 'run_id', value: string): PackRow[] {
    return this.query(`WHERE ${column} = ? ORDER BY created_at DESC, rowid DESC`, [value])
  }
}

export class ContextPackRepository {
  private readonly packs: PackTable

  constructor(private readonly db: Database) {
    this.packs = new PackTable(db)
  }

  /** Writes the pack and all its entries atomically. */
  insert(pack: ContextPack): ContextPack {
    const { entries, ...row } = pack
    guard(() =>
      this.db.transaction(() => {
        this.packs.insert(row)
        const stmt = prepare(
          this.db,
          `INSERT INTO context_pack_entries (${ENTRY_COLUMNS}) VALUES (@id, @pack_id, @section, @source_kind, @source_id, @title, @reason, @included, @chars)`,
        )
        for (const e of entries) {
          stmt.run({
            id: e.id,
            pack_id: pack.id,
            section: e.section,
            source_kind: e.sourceKind,
            source_id: e.sourceId,
            title: e.title,
            reason: e.reason,
            included: e.included ? 1 : 0,
            chars: e.chars,
          })
        }
      })(),
    )
    return pack
  }

  get(id: string): ContextPack | null {
    const row = this.packs.get(id)
    return row ? this.withEntries(row) : null
  }

  /** Newest first, entries included. */
  listByTask(taskId: string): ContextPack[] {
    return this.packs.listWhere('task_id', taskId).map((p) => this.withEntries(p))
  }

  /** Newest first, entries included. */
  listByAgent(agentId: string): ContextPack[] {
    return this.packs.listWhere('agent_id', agentId).map((p) => this.withEntries(p))
  }

  /** Newest first, entries included. */
  listByRun(runId: string): ContextPack[] {
    return this.packs.listWhere('run_id', runId).map((p) => this.withEntries(p))
  }

  private withEntries(pack: PackRow): ContextPack {
    const rows = prepare(this.db, `SELECT ${ENTRY_COLUMNS} FROM context_pack_entries WHERE pack_id = ? ORDER BY rowid`).all(
      pack.id,
    ) as Row[]
    return { ...pack, entries: rows.map((r) => decode(entryCodec, r)) }
  }
}
