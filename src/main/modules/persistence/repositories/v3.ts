import {
  LIVE_QUOTA_PAUSE_STATES,
  type ArenaCampaign,
  type ArenaCase,
  type ArenaCaseVersion,
  type ArenaEvaluation,
  type ArenaTrial,
  type ArenaTrialMetrics,
  type CandidateResult,
  type MissionOutcome,
  type PolicyCandidate,
  type PolicyDecision,
  type PolicyPromotion,
  type PolicySnapshot,
  type QuotaPause,
  type QuotaResume,
  type SpeculativeRun,
  type StrategyStatistic,
  type TaskProfile,
  type TournamentDecision,
  type TrialState,
  type UsageBreakdownRow,
  type UsageEvent,
  type UsageEventType,
  type UsageGrouping,
  type UsageTotals,
  type UsageWindow,
} from '@shared/v3'
import type { Database } from '../database'
import { Table, guard, prepare, type Codec, type Row, type SqlValue } from '../table'

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

export interface Page {
  limit: number
  offset: number
}

const page = (p: Partial<Page> | undefined, max = 500): Page => ({
  limit: Math.min(Math.max(1, p?.limit ?? 100), max),
  offset: Math.max(0, p?.offset ?? 0),
})

// ───────────────────────────── usage ─────────────────────────────

const usageEventCodec: Codec<UsageEvent> = {
  table: 'usage_events',
  fields: {
    id: 'text',
    createdAt: 'text',
    eventType: 'text',
    projectId: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    sdkSessionId: 'text',
    role: 'text',
    model: 'text',
    strategy: 'text',
    arenaCampaignId: 'text',
    day: 'text',
    inputTokens: 'num',
    outputTokens: 'num',
    cacheReadTokens: 'num',
    cacheCreationTokens: 'num',
    turns: 'num',
    durationMs: 'num',
    costUsd: 'num',
    availability: 'text',
    limitType: 'text',
    utilization: 'num',
    utilizationUnit: 'text',
    resetAt: 'text',
    retryAfterMs: 'num',
    source: 'text',
    confidence: 'text',
    rawClassification: 'text',
  },
}

export interface UsageFilter {
  runId?: string
  projectId?: string
  arenaCampaignId?: string
  /** ISO lower bound (inclusive) on created_at. */
  since?: string
  /** ISO upper bound (exclusive). */
  until?: string
}

const GROUP_COLUMN: Record<UsageGrouping, string> = {
  agent: 'agent_id',
  task: 'task_id',
  run: 'run_id',
  day: 'day',
  model: 'model',
  strategy: 'strategy',
  campaign: 'arena_campaign_id',
  role: 'role',
}

const LIMIT_TYPES: readonly UsageEventType[] = ['limit_rejected']

const TOTALS_SQL = `
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN 1 ELSE 0 END), 0) AS sessions,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN turns ELSE 0 END), 0) AS turns,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN cache_read_tokens ELSE 0 END), 0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN cache_creation_tokens ELSE 0 END), 0) AS cache_creation_tokens,
  COALESCE(SUM(CASE WHEN event_type = 'session' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
  COALESCE(SUM(CASE WHEN event_type IN (${LIMIT_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 1 ELSE 0 END), 0) AS limit_events`

function totalsOf(row: Row | undefined): UsageTotals {
  const n = (k: string): number => Number(row?.[k] ?? 0)
  return {
    sessions: n('sessions'),
    turns: n('turns'),
    inputTokens: n('input_tokens'),
    outputTokens: n('output_tokens'),
    cacheReadTokens: n('cache_read_tokens'),
    cacheCreationTokens: n('cache_creation_tokens'),
    durationMs: n('duration_ms'),
    limitEvents: n('limit_events'),
  }
}

function usageWhere(filter: UsageFilter): { sql: string; params: SqlValue[] } {
  const clauses: string[] = []
  const params: SqlValue[] = []
  if (filter.runId) {
    clauses.push('run_id = ?')
    params.push(filter.runId)
  }
  if (filter.projectId) {
    clauses.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.arenaCampaignId) {
    clauses.push('arena_campaign_id = ?')
    params.push(filter.arenaCampaignId)
  }
  if (filter.since) {
    clauses.push('created_at >= ?')
    params.push(filter.since)
  }
  if (filter.until) {
    clauses.push('created_at < ?')
    params.push(filter.until)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export class UsageEventRepository extends Table<UsageEvent> {
  constructor(db: Database) {
    super(db, usageEventCodec, 'usage event')
  }

  /** Observed totals. Aggregated in SQL; the history is never loaded. */
  totals(filter: UsageFilter = {}): UsageTotals {
    const where = usageWhere(filter)
    const row = prepare(this.db, `SELECT ${TOTALS_SQL} FROM usage_events ${where.sql}`).get(...where.params) as Row
    return totalsOf(row)
  }

  /** One row per group value, largest observed token use first (days: newest first). */
  breakdown(by: UsageGrouping, filter: UsageFilter = {}, limit = 50): UsageBreakdownRow[] {
    const column = GROUP_COLUMN[by]
    const where = usageWhere(filter)
    const tail = where.sql ? `${where.sql} AND ${column} IS NOT NULL` : `WHERE ${column} IS NOT NULL`
    // Ordered in an outer query: inside the grouped one, `input_tokens` would name the raw column, not the sum.
    const order = by === 'day' ? 'group_key DESC' : 'input_tokens + output_tokens DESC, sessions DESC, group_key'
    const rows = prepare(
      this.db,
      `SELECT * FROM (SELECT ${column} AS group_key, ${TOTALS_SQL} FROM usage_events ${tail} GROUP BY ${column}) ORDER BY ${order} LIMIT ?`,
    ).all(...where.params, Math.min(Math.max(1, limit), 400)) as Row[]
    return rows.map((r) => ({ key: String(r['group_key']), label: String(r['group_key']), ...totalsOf(r) }))
  }

  /** Limit, throttle, probe and auth events, newest first. */
  listLimitEvents(p?: Partial<Page>): UsageEvent[] {
    const { limit, offset } = page(p)
    return this.query(
      `WHERE event_type IN ('limit_rejected', 'limit_warning', 'throttle', 'auth', 'runtime_error', 'probe')
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    )
  }

  latestOfType(type: UsageEventType): UsageEvent | null {
    return this.one('WHERE event_type = ? ORDER BY created_at DESC, rowid DESC', [type])
  }

  countOfTypeSince(type: UsageEventType, sinceIso: string): number {
    const row = prepare(this.db, 'SELECT COUNT(*) AS n FROM usage_events WHERE event_type = ? AND created_at >= ?').get(
      type,
      sinceIso,
    ) as Row
    return Number(row['n'] ?? 0)
  }

  listByRun(runId: string, p?: Partial<Page>): UsageEvent[] {
    const { limit, offset } = page(p)
    return this.query('WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [runId, limit, offset])
  }

  count(): number {
    return Number((prepare(this.db, 'SELECT COUNT(*) AS n FROM usage_events').get() as Row)['n'] ?? 0)
  }
}

const usageWindowCodec: Codec<UsageWindow> = {
  table: 'usage_windows',
  fields: {
    id: 'text',
    limitType: 'text',
    status: 'text',
    utilizationPercent: 'num',
    resetAt: 'text',
    source: 'text',
    confidence: 'text',
    observedAt: 'text',
    updatedAt: 'text',
  },
}

export class UsageWindowRepository extends Table<UsageWindow> {
  constructor(db: Database) {
    super(db, usageWindowCodec, 'usage window')
  }

  list(): UsageWindow[] {
    return this.query('ORDER BY limit_type')
  }

  getByType(limitType: string): UsageWindow | null {
    return this.one('WHERE limit_type = ?', [limitType])
  }

  /** One row per window type; the newest report replaces the previous one. */
  upsert(window: UsageWindow): UsageWindow {
    const existing = this.getByType(window.limitType)
    if (!existing) return this.insert(window)
    return this.update(existing.id, {
      status: window.status,
      utilizationPercent: window.utilizationPercent,
      resetAt: window.resetAt,
      source: window.source,
      confidence: window.confidence,
      observedAt: window.observedAt,
      updatedAt: window.updatedAt,
    })
  }
}

const quotaPauseCodec: Codec<QuotaPause> = {
  table: 'quota_pauses',
  fields: {
    id: 'text',
    runId: 'text',
    scope: 'text',
    state: 'text',
    pausedAt: 'text',
    limitType: 'text',
    resetAt: 'text',
    resetConfidence: 'text',
    nextCheckAt: 'text',
    probes: 'num',
    checkpointId: 'text',
    resumeState: 'text',
    endedAt: 'text',
    endReason: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
}

export class QuotaPauseRepository extends Table<QuotaPause> {
  constructor(db: Database) {
    super(db, quotaPauseCodec, 'quota pause')
  }

  /** Waits that are still open (waiting or probing), oldest first. */
  listLive(): QuotaPause[] {
    return this.query(
      `WHERE state IN (${placeholders(LIVE_QUOTA_PAUSE_STATES.length)}) ORDER BY paused_at, rowid`,
      [...LIVE_QUOTA_PAUSE_STATES],
    )
  }

  liveGlobal(): QuotaPause | null {
    return this.one(
      `WHERE scope = 'global' AND state IN (${placeholders(LIVE_QUOTA_PAUSE_STATES.length)}) ORDER BY paused_at, rowid`,
      [...LIVE_QUOTA_PAUSE_STATES],
    )
  }

  liveForRun(runId: string): QuotaPause | null {
    return this.one(
      `WHERE run_id = ? AND state IN (${placeholders(LIVE_QUOTA_PAUSE_STATES.length)}) ORDER BY paused_at DESC, rowid DESC`,
      [runId, ...LIVE_QUOTA_PAUSE_STATES],
    )
  }

  listByRun(runId: string): QuotaPause[] {
    return this.query('WHERE run_id = ? ORDER BY paused_at, rowid', [runId])
  }

  listRecent(p?: Partial<Page>): QuotaPause[] {
    const { limit, offset } = page(p)
    return this.query('ORDER BY paused_at DESC, rowid DESC LIMIT ? OFFSET ?', [limit, offset])
  }

  /**
   * Claims a live wait for closing. Returns false when another caller already closed it, which is what
   * makes a resume idempotent.
   */
  close(id: string, state: 'resumed' | 'ended' | 'cancelled', endedAt: string, endReason: string | null): boolean {
    const info = guard(() =>
      prepare(
        this.db,
        `UPDATE quota_pauses SET state = ?, ended_at = ?, end_reason = ?, next_check_at = NULL, updated_at = ?
         WHERE id = ? AND state IN (${placeholders(LIVE_QUOTA_PAUSE_STATES.length)})`,
      ).run(state, endedAt, endReason, endedAt, id, ...LIVE_QUOTA_PAUSE_STATES),
    )
    return info.changes > 0
  }
}

const quotaResumeCodec: Codec<QuotaResume> = {
  table: 'quota_resumes',
  fields: {
    id: 'text',
    pauseId: 'text',
    runId: 'text',
    attemptedAt: 'text',
    kind: 'text',
    result: 'text',
    method: 'text',
    detail: 'text',
    waitedMs: 'num',
    createdAt: 'text',
  },
}

export class QuotaResumeRepository extends Table<QuotaResume> {
  constructor(db: Database) {
    super(db, quotaResumeCodec, 'quota resume')
  }

  listByPause(pauseId: string): QuotaResume[] {
    return this.query('WHERE pause_id = ? ORDER BY created_at, rowid', [pauseId])
  }

  listByRun(runId: string): QuotaResume[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid', [runId])
  }

  listByPauses(pauseIds: string[]): QuotaResume[] {
    if (pauseIds.length === 0) return []
    return this.query(`WHERE pause_id IN (${placeholders(pauseIds.length)}) ORDER BY created_at, rowid`, pauseIds)
  }
}

// ───────────────────────────── arena ─────────────────────────────

const arenaCaseCodec: Codec<ArenaCase> = {
  table: 'arena_cases',
  fields: {
    id: 'text',
    name: 'text',
    origin: 'text',
    category: 'text',
    complexity: 'text',
    risk: 'text',
    latestVersion: 'num',
    sourcePath: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
}

export class ArenaCaseRepository extends Table<ArenaCase> {
  constructor(db: Database) {
    super(db, arenaCaseCodec, 'arena case')
  }

  list(): ArenaCase[] {
    return this.query('ORDER BY origin, id')
  }
}

const arenaCaseVersionCodec: Codec<ArenaCaseVersion> = {
  table: 'arena_case_versions',
  fields: {
    id: 'text',
    caseId: 'text',
    version: 'num',
    definition: 'json',
    evaluatorHash: 'text',
    fixtureHash: 'text',
    trusted: 'bool',
    createdAt: 'text',
  },
}

export class ArenaCaseVersionRepository extends Table<ArenaCaseVersion> {
  constructor(db: Database) {
    super(db, arenaCaseVersionCodec, 'arena case version')
  }

  getVersion(caseId: string, version: number): ArenaCaseVersion | null {
    return this.one('WHERE case_id = ? AND version = ?', [caseId, version])
  }

  latest(caseId: string): ArenaCaseVersion | null {
    return this.one('WHERE case_id = ? ORDER BY version DESC', [caseId])
  }

  listByCase(caseId: string): ArenaCaseVersion[] {
    return this.query('WHERE case_id = ? ORDER BY version', [caseId])
  }

  listByIds(ids: string[]): ArenaCaseVersion[] {
    if (ids.length === 0) return []
    return this.query(`WHERE id IN (${placeholders(ids.length)})`, ids)
  }
}

const arenaCampaignCodec: Codec<ArenaCampaign> = {
  table: 'arena_campaigns',
  fields: {
    id: 'text',
    name: 'text',
    state: 'text',
    pauseReason: 'text',
    caseVersionIds: 'json',
    strategies: 'json',
    repetitions: 'num',
    modelPreset: 'text',
    budgets: 'json',
    overnight: 'bool',
    policySnapshotId: 'text',
    nexusVersion: 'text',
    environment: 'json',
    error: 'text',
    createdAt: 'text',
    startedAt: 'text',
    completedAt: 'text',
  },
}

export class ArenaCampaignRepository extends Table<ArenaCampaign> {
  constructor(db: Database) {
    super(db, arenaCampaignCodec, 'arena campaign')
  }

  /** Newest first, paged. */
  list(p?: Partial<Page>): ArenaCampaign[] {
    const { limit, offset } = page(p, 200)
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [limit, offset])
  }

  count(): number {
    return Number((prepare(this.db, 'SELECT COUNT(*) AS n FROM arena_campaigns').get() as Row)['n'] ?? 0)
  }

  listByState(states: string[]): ArenaCampaign[] {
    if (states.length === 0) return []
    return this.query(`WHERE state IN (${placeholders(states.length)}) ORDER BY created_at, rowid`, states)
  }
}

const arenaTrialCodec: Codec<ArenaTrial> = {
  table: 'arena_trials',
  fields: {
    id: 'text',
    campaignId: 'text',
    caseId: 'text',
    caseVersionId: 'text',
    strategy: 'text',
    repetition: 'num',
    ordinal: 'num',
    state: 'text',
    projectId: 'text',
    runId: 'text',
    repoPath: 'text',
    baselineCommit: 'text',
    resultCommit: 'text',
    policySnapshotId: 'text',
    taskProfileId: 'text',
    models: 'json',
    detail: 'text',
    blockKind: 'text',
    createdAt: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

export interface TrialStateCount {
  state: TrialState
  n: number
}

export class ArenaTrialRepository extends Table<ArenaTrial> {
  constructor(db: Database) {
    super(db, arenaTrialCodec, 'arena trial')
  }

  listByCampaign(campaignId: string, p?: Partial<Page>): ArenaTrial[] {
    const { limit, offset } = page(p, 2000)
    return this.query('WHERE campaign_id = ? ORDER BY ordinal, rowid LIMIT ? OFFSET ?', [campaignId, limit, offset])
  }

  listByCampaignStates(campaignId: string, states: TrialState[]): ArenaTrial[] {
    if (states.length === 0) return []
    return this.query(
      `WHERE campaign_id = ? AND state IN (${placeholders(states.length)}) ORDER BY ordinal, rowid`,
      [campaignId, ...states],
    )
  }

  getByRun(runId: string): ArenaTrial | null {
    return this.one('WHERE run_id = ?', [runId])
  }

  countsByCampaign(campaignId: string): TrialStateCount[] {
    const rows = prepare(
      this.db,
      'SELECT state, COUNT(*) AS n FROM arena_trials WHERE campaign_id = ? GROUP BY state',
    ).all(campaignId) as Row[]
    return rows.map((r) => ({ state: r['state'] as TrialState, n: Number(r['n']) }))
  }

  /** Finished trials (any campaign), oldest first, for evidence aggregation. Bounded by `sinceIso`. */
  listFinishedSince(sinceIso: string, limit = 20000): ArenaTrial[] {
    // When the window holds more than the limit, the NEWEST trials are the ones kept.
    return this.query(
      `WHERE state IN ('passed', 'failed', 'blocked') AND finished_at >= ? ORDER BY finished_at DESC, rowid DESC LIMIT ?`,
      [sinceIso, limit],
    ).reverse()
  }

  count(): number {
    return Number((prepare(this.db, 'SELECT COUNT(*) AS n FROM arena_trials').get() as Row)['n'] ?? 0)
  }
}

const arenaMetricsCodec: Codec<ArenaTrialMetrics> = {
  table: 'arena_trial_metrics',
  fields: {
    id: 'text',
    trialId: 'text',
    buildPassed: 'bool',
    typecheckPassed: 'bool',
    testsPassed: 'bool',
    hiddenPassed: 'bool',
    acceptanceTotal: 'num',
    acceptancePassed: 'num',
    verifierPassed: 'bool',
    criticalFindings: 'num',
    highFindings: 'num',
    mediumFindings: 'num',
    repairs: 'num',
    wallClockMs: 'num',
    sessions: 'num',
    turns: 'num',
    inputTokens: 'num',
    outputTokens: 'num',
    toolCalls: 'num',
    humanInterventions: 'num',
    approvals: 'num',
    manualRetries: 'num',
    blockers: 'num',
    crashedAgents: 'num',
    recoveredSessions: 'num',
    schedulerFailures: 'num',
    unfinishedTasks: 'num',
    quotaPauses: 'num',
    quotaWaitMs: 'num',
    autoResumeSuccesses: 'num',
    throttleEvents: 'num',
    createdAt: 'text',
  },
}

export class ArenaMetricsRepository extends Table<ArenaTrialMetrics> {
  constructor(db: Database) {
    super(db, arenaMetricsCodec, 'arena trial metrics')
  }

  getByTrial(trialId: string): ArenaTrialMetrics | null {
    return this.one('WHERE trial_id = ?', [trialId])
  }

  /** One metrics row per trial: a re-evaluation replaces it. */
  replaceForTrial(metrics: ArenaTrialMetrics): ArenaTrialMetrics {
    guard(() => prepare(this.db, 'DELETE FROM arena_trial_metrics WHERE trial_id = ?').run(metrics.trialId))
    return this.insert(metrics)
  }

  listByTrials(trialIds: string[]): ArenaTrialMetrics[] {
    const out: ArenaTrialMetrics[] = []
    for (let i = 0; i < trialIds.length; i += 400) {
      const chunk = trialIds.slice(i, i + 400)
      out.push(...this.query(`WHERE trial_id IN (${placeholders(chunk.length)})`, chunk))
    }
    return out
  }

  listByCampaign(campaignId: string): ArenaTrialMetrics[] {
    return this.query('WHERE trial_id IN (SELECT id FROM arena_trials WHERE campaign_id = ?)', [campaignId])
  }
}

const arenaEvaluationCodec: Codec<ArenaEvaluation> = {
  table: 'arena_evaluations',
  fields: {
    id: 'text',
    trialId: 'text',
    kind: 'text',
    command: 'text',
    exitCode: 'num',
    timedOut: 'bool',
    durationMs: 'num',
    output: 'text',
    passed: 'bool',
    skippedReason: 'text',
    evaluatorHash: 'text',
    scoreVersion: 'text',
    score: 'num',
    scoreBreakdown: 'json',
    createdAt: 'text',
  },
}

export class ArenaEvaluationRepository extends Table<ArenaEvaluation> {
  constructor(db: Database) {
    super(db, arenaEvaluationCodec, 'arena evaluation')
  }

  /** The evaluation that counts: the newest one. */
  latestForTrial(trialId: string): ArenaEvaluation | null {
    return this.one('WHERE trial_id = ? ORDER BY created_at DESC, rowid DESC', [trialId])
  }

  listByCampaign(campaignId: string): ArenaEvaluation[] {
    return this.query(
      'WHERE trial_id IN (SELECT id FROM arena_trials WHERE campaign_id = ?) ORDER BY created_at, rowid',
      [campaignId],
    )
  }
}

// ───────────────────────────── policy ─────────────────────────────

const taskProfileCodec: Codec<TaskProfile> = {
  table: 'task_profiles',
  fields: {
    id: 'text',
    projectId: 'text',
    runId: 'text',
    arenaTrialId: 'text',
    contextKey: 'text',
    features: 'json',
    profilerVersion: 'text',
    createdAt: 'text',
  },
}

export class TaskProfileRepository extends Table<TaskProfile> {
  constructor(db: Database) {
    super(db, taskProfileCodec, 'task profile')
  }

  getByRun(runId: string): TaskProfile | null {
    return this.one('WHERE run_id = ? ORDER BY created_at DESC, rowid DESC', [runId])
  }

  /** Newest first, for shadow evaluation. */
  listRecent(limit = 500): TaskProfile[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 5000)])
  }
}

const missionOutcomeCodec: Codec<MissionOutcome> = {
  table: 'mission_outcomes',
  fields: {
    id: 'text',
    runId: 'text',
    projectId: 'text',
    taskProfileId: 'text',
    contextKey: 'text',
    strategy: 'text',
    requestedStrategy: 'text',
    planningMode: 'text',
    reviewMode: 'text',
    policyDecisionId: 'text',
    policySnapshotId: 'text',
    models: 'json',
    agents: 'num',
    sessions: 'num',
    tasks: 'num',
    tasksCompleted: 'num',
    repairs: 'num',
    reviews: 'num',
    reviewRejections: 'num',
    verificationPassed: 'bool',
    elapsedMs: 'num',
    inputTokens: 'num',
    outputTokens: 'num',
    quotaPauses: 'num',
    quotaWaitMs: 'num',
    humanInterventions: 'num',
    terminal: 'text',
    success: 'bool',
    isArena: 'bool',
    nexusVersion: 'text',
    createdAt: 'text',
  },
}

export class MissionOutcomeRepository extends Table<MissionOutcome> {
  constructor(db: Database) {
    super(db, missionOutcomeCodec, 'mission outcome')
  }

  getByRun(runId: string): MissionOutcome | null {
    return this.one('WHERE run_id = ?', [runId])
  }

  /** One outcome per run: a later terminal state (after a manual resume) replaces the earlier row. */
  upsertForRun(outcome: MissionOutcome): MissionOutcome {
    const existing = this.getByRun(outcome.runId)
    if (!existing) return this.insert(outcome)
    const { id: _id, runId: _runId, createdAt: _createdAt, ...rest } = outcome
    return this.update(existing.id, rest)
  }

  /** Real missions only (Arena runs are controlled evidence, recorded as trials). */
  listMissionsSince(sinceIso: string, limit = 20000): MissionOutcome[] {
    return this.query('WHERE is_arena = 0 AND created_at >= ? ORDER BY created_at, rowid LIMIT ?', [sinceIso, limit])
  }

  listRecent(p?: Partial<Page>): MissionOutcome[] {
    const { limit, offset } = page(p)
    return this.query('WHERE is_arena = 0 ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [limit, offset])
  }

  countMissions(): number {
    return Number(
      (prepare(this.db, 'SELECT COUNT(*) AS n FROM mission_outcomes WHERE is_arena = 0').get() as Row)['n'] ?? 0,
    )
  }
}

const policySnapshotCodec: Codec<PolicySnapshot> = {
  table: 'policy_snapshots',
  fields: {
    id: 'text',
    version: 'num',
    createdAt: 'text',
    origin: 'text',
    parentId: 'text',
    preferences: 'json',
    config: 'json',
    routing: 'json',
    note: 'text',
  },
}

/** Snapshots are immutable: this repository exposes no update. */
export class PolicySnapshotRepository {
  private readonly table: Table<PolicySnapshot>

  constructor(private readonly db: Database) {
    this.table = new Table(db, policySnapshotCodec, 'policy snapshot')
  }

  insert(snapshot: PolicySnapshot): PolicySnapshot {
    return this.table.insert(snapshot)
  }

  get(id: string): PolicySnapshot | null {
    return this.table.get(id)
  }

  require(id: string): PolicySnapshot {
    return this.table.require(id)
  }

  list(): PolicySnapshot[] {
    const rows = prepare(this.db, 'SELECT id FROM policy_snapshots ORDER BY version DESC').all() as Row[]
    return rows.map((r) => this.table.require(String(r['id'])))
  }

  latestVersion(): number {
    return Number((prepare(this.db, 'SELECT MAX(version) AS v FROM policy_snapshots').get() as Row)['v'] ?? 0)
  }
}

const policyDecisionCodec: Codec<PolicyDecision> = {
  table: 'policy_decisions',
  fields: {
    id: 'text',
    runId: 'text',
    projectId: 'text',
    taskProfileId: 'text',
    snapshotId: 'text',
    policyVersion: 'num',
    contextKey: 'text',
    evidenceContextKey: 'text',
    strategy: 'text',
    planningMode: 'text',
    workerCount: 'num',
    reviewDepth: 'text',
    speculativeCandidates: 'num',
    modelPolicies: 'json',
    layer: 'text',
    exploration: 'bool',
    seed: 'num',
    reason: 'text',
    evidenceSummary: 'json',
    resourceNotes: 'json',
    usageStatus: 'text',
    createdAt: 'text',
  },
}

export class PolicyDecisionRepository extends Table<PolicyDecision> {
  constructor(db: Database) {
    super(db, policyDecisionCodec, 'policy decision')
  }

  getByRun(runId: string): PolicyDecision | null {
    return this.one('WHERE run_id = ? ORDER BY created_at DESC, rowid DESC', [runId])
  }

  listRecent(p?: Partial<Page>): PolicyDecision[] {
    const { limit, offset } = page(p)
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [limit, offset])
  }
}

const policyCandidateCodec: Codec<PolicyCandidate> = {
  table: 'policy_candidates',
  fields: {
    id: 'text',
    contextKey: 'text',
    fromStrategy: 'text',
    toStrategy: 'text',
    arenaTrials: 'num',
    missions: 'num',
    label: 'text',
    expected: 'json',
    reason: 'text',
    evidence: 'json',
    shadow: 'json',
    status: 'text',
    baseSnapshotId: 'text',
    createdAt: 'text',
    resolvedAt: 'text',
  },
}

export class PolicyCandidateRepository extends Table<PolicyCandidate> {
  constructor(db: Database) {
    super(db, policyCandidateCodec, 'policy candidate')
  }

  listByStatus(status: PolicyCandidate['status']): PolicyCandidate[] {
    return this.query('WHERE status = ? ORDER BY created_at DESC, rowid DESC', [status])
  }

  listRecent(limit = 100): PolicyCandidate[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 500)])
  }
}

const policyPromotionCodec: Codec<PolicyPromotion> = {
  table: 'policy_promotions',
  fields: {
    id: 'text',
    action: 'text',
    candidateId: 'text',
    fromSnapshotId: 'text',
    toSnapshotId: 'text',
    by: 'text',
    note: 'text',
    createdAt: 'text',
  },
}

export class PolicyPromotionRepository extends Table<PolicyPromotion> {
  constructor(db: Database) {
    super(db, policyPromotionCodec, 'policy promotion')
  }

  listRecent(limit = 100): PolicyPromotion[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 500)])
  }
}

const strategyStatisticCodec: Codec<StrategyStatistic> = {
  table: 'strategy_statistics',
  fields: {
    id: 'text',
    contextKey: 'text',
    strategy: 'text',
    kind: 'text',
    n: 'num',
    successes: 'num',
    distinctUnits: 'num',
    effectiveN: 'num',
    effectiveSuccesses: 'num',
    passRate: 'num',
    passInterval: 'json',
    medianDurationMs: 'num',
    meanDurationMs: 'num',
    meanSessions: 'num',
    meanObservedTokens: 'num',
    meanRepairs: 'num',
    repairDistribution: 'json',
    stabilityFailures: 'num',
    label: 'text',
    newestAt: 'text',
    oldestAt: 'text',
    computedAt: 'text',
  },
}

export class StrategyStatisticRepository extends Table<StrategyStatistic> {
  constructor(db: Database) {
    super(db, strategyStatisticCodec, 'strategy statistic')
  }

  list(): StrategyStatistic[] {
    return this.query('ORDER BY context_key, strategy, kind')
  }

  /** The table is a cache of the last aggregation: it is rewritten as a whole. */
  replaceAll(rows: StrategyStatistic[]): void {
    guard(() => prepare(this.db, 'DELETE FROM strategy_statistics').run())
    for (const row of rows) this.insert(row)
  }
}

// ───────────────────────────── speculative execution ─────────────────────────────

const speculativeRunCodec: Codec<SpeculativeRun> = {
  table: 'speculative_runs',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    baseCommit: 'text',
    candidateCount: 'num',
    state: 'text',
    winnerCandidateId: 'text',
    createdAt: 'text',
    finishedAt: 'text',
  },
}

export class SpeculativeRunRepository extends Table<SpeculativeRun> {
  constructor(db: Database) {
    super(db, speculativeRunCodec, 'speculative run')
  }

  listByRun(runId: string): SpeculativeRun[] {
    return this.byRun(runId)
  }

  latestForTask(taskId: string): SpeculativeRun | null {
    return this.one('WHERE task_id = ? ORDER BY created_at DESC, rowid DESC', [taskId])
  }
}

const candidateResultCodec: Codec<CandidateResult> = {
  table: 'candidate_results',
  fields: {
    id: 'text',
    speculativeRunId: 'text',
    runId: 'text',
    taskId: 'text',
    label: 'text',
    agentId: 'text',
    sdkSessionId: 'text',
    branch: 'text',
    worktreePath: 'text',
    headCommit: 'text',
    evidence: 'json',
    diffPatch: 'text',
    rank: 'num',
    outcome: 'text',
    cleanedAt: 'text',
    createdAt: 'text',
  },
}

export class CandidateResultRepository extends Table<CandidateResult> {
  constructor(db: Database) {
    super(db, candidateResultCodec, 'candidate result')
  }

  listBySpeculativeRun(speculativeRunId: string): CandidateResult[] {
    return this.query('WHERE speculative_run_id = ? ORDER BY label', [speculativeRunId])
  }

  listByRun(runId: string): CandidateResult[] {
    return this.byRun(runId, 'created_at, label')
  }
}

const tournamentDecisionCodec: Codec<TournamentDecision> = {
  table: 'tournament_decisions',
  fields: {
    id: 'text',
    speculativeRunId: 'text',
    runId: 'text',
    taskId: 'text',
    winnerLabel: 'text',
    ranking: 'json',
    comparisons: 'json',
    confidence: 'text',
    reason: 'text',
    createdAt: 'text',
  },
}

export class TournamentDecisionRepository extends Table<TournamentDecision> {
  constructor(db: Database) {
    super(db, tournamentDecisionCodec, 'tournament decision')
  }

  getBySpeculativeRun(speculativeRunId: string): TournamentDecision | null {
    return this.one('WHERE speculative_run_id = ?', [speculativeRunId])
  }

  listByRun(runId: string): TournamentDecision[] {
    return this.byRun(runId)
  }
}
