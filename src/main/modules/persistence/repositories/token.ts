import type {
  ArtifactContextRef,
  CacheEvent,
  CompactionEvent,
  PromptComponent,
  PromptPrefix,
  RequestBreakdown,
  SessionEfficiencyRecord,
  TokenBenchmarkResult,
  TokenOptimizationDecision,
} from '@shared/token'
import type { Database } from '../database'
import { Table, prepare, type Codec, type Row } from '../table'

const componentCodec: Codec<PromptComponent> = {
  table: 'prompt_components',
  fields: { id: 'text', key: 'text', version: 'num', scope: 'text', priority: 'num', hash: 'text', chars: 'num', tokenEstimate: 'num', cacheability: 'text', createdAt: 'text' },
}

const prefixCodec: Codec<PromptPrefix> = {
  table: 'prompt_prefixes',
  fields: {
    id: 'text',
    hash: 'text',
    components: 'json',
    provider: 'text',
    model: 'text',
    role: 'text',
    toolSetHash: 'text',
    tokenEstimate: 'num',
    cacheable: 'bool',
    uses: 'num',
    firstSeenAt: 'text',
    lastSeenAt: 'text',
    lastCacheResult: 'text',
    lastCacheReadTokens: 'num',
    lastCacheWriteTokens: 'num',
  },
}

const breakdownCodec: Codec<RequestBreakdown> = {
  table: 'token_request_breakdowns',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', sdkSessionId: 'text', basis: 'text', model: 'text', totalTokens: 'num', maxTokens: 'num', components: 'json', createdAt: 'text' },
}

const cacheCodec: Codec<CacheEvent> = {
  table: 'cache_events',
  fields: {
    id: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    sdkSessionId: 'text',
    requestIndex: 'num',
    prefixHash: 'text',
    provider: 'text',
    model: 'text',
    role: 'text',
    inputTokens: 'num',
    cacheReadTokens: 'num',
    cacheWriteTokens: 'num',
    outputTokens: 'num',
    result: 'text',
    expectedWarm: 'bool',
    cause: 'text',
    causeBasis: 'text',
    reuseDistanceMs: 'num',
    createdAt: 'text',
  },
}

const decisionCodec: Codec<TokenOptimizationDecision> = {
  table: 'context_optimization_decisions',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', action: 'text', reason: 'text', detail: 'json', tokenEffect: 'num', basis: 'text', createdAt: 'text' },
}

const refCodec: Codec<ArtifactContextRef> = {
  table: 'artifact_context_refs',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', kind: 'text', ref: 'text', title: 'text', state: 'text', charsTotal: 'num', charsShown: 'num', createdAt: 'text' },
}

const compactionCodec: Codec<CompactionEvent> = {
  table: 'compaction_events',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', sdkSessionId: 'text', trigger: 'text', preTokens: 'num', postTokens: 'num', durationMs: 'num', createdAt: 'text' },
}

const efficiencyCodec: Codec<SessionEfficiencyRecord> = {
  table: 'session_efficiency',
  fields: { id: 'text', runId: 'text', taskId: 'text', agentId: 'text', sdkSessionId: 'text', turns: 'num', contextTokens: 'num', maxTokens: 'num', outputTokens: 'num', thinkingTokens: 'num', pressure: 'text', action: 'text', reason: 'text', createdAt: 'text' },
}

const benchmarkCodec: Codec<TokenBenchmarkResult> = {
  table: 'token_benchmark_results',
  fields: { id: 'text', benchmark: 'text', variant: 'text', caseKey: 'text', metrics: 'json', createdAt: 'text' },
}

const cap = (n: number | undefined, fallback: number, max = 1000): number => Math.max(1, Math.min(max, Math.floor(n ?? fallback)))

export class PromptComponentStore extends Table<PromptComponent> {
  constructor(db: Database) {
    super(db, componentCodec, 'prompt component')
  }

  byKeyAndHash(key: string, hash: string): PromptComponent | null {
    return this.one('WHERE key = ? AND hash = ?', [key, hash])
  }

  latestVersion(key: string): number {
    return (prepare(this.db, 'SELECT COALESCE(MAX(version), 0) AS v FROM prompt_components WHERE key = ?').get(key) as { v: number }).v
  }

  list(limit = 200): PromptComponent[] {
    return this.query('ORDER BY key, version DESC LIMIT ?', [cap(limit, 200)])
  }
}

export class PromptPrefixStore extends Table<PromptPrefix> {
  constructor(db: Database) {
    super(db, prefixCodec, 'prompt prefix')
  }

  byHash(hash: string): PromptPrefix | null {
    return this.one('WHERE hash = ?', [hash])
  }

  /** The prefix a role last used before `hash` appeared: what a changed prefix is compared against. */
  previousForRole(role: string, provider: string, exceptHash: string): PromptPrefix | null {
    return this.one('WHERE role = ? AND provider = ? AND hash <> ? ORDER BY last_seen_at DESC, rowid DESC', [role, provider, exceptHash])
  }

  list(limit = 100): PromptPrefix[] {
    return this.query('ORDER BY last_seen_at DESC LIMIT ?', [cap(limit, 100)])
  }
}

export class RequestBreakdownStore extends Table<RequestBreakdown> {
  constructor(db: Database) {
    super(db, breakdownCodec, 'request breakdown')
  }

  latestForAgent(agentId: string): RequestBreakdown | null {
    return this.one('WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC', [agentId])
  }

  listByAgent(agentId: string, limit = 20): RequestBreakdown[] {
    return this.query('WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [agentId, cap(limit, 20)])
  }

  listByRun(runId: string, limit = 200): RequestBreakdown[] {
    return this.query('WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [runId, cap(limit, 200)])
  }

  recent(sinceIso: string, limit = 500): RequestBreakdown[] {
    return this.query('WHERE created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [sinceIso, cap(limit, 500, 5000)])
  }
}

export interface CacheTotals {
  key: string
  requests: number
  sessions: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** First requests of sessions that read their prefix from cache. */
  warmStarts: number
  /** First requests of sessions that wrote their prefix. */
  coldStarts: number
  /** Cold starts that were expected to be warm. */
  unexpectedMisses: number
}

const TOTAL_COLUMNS = `COUNT(*) AS requests, COUNT(DISTINCT COALESCE(sdk_session_id, agent_id)) AS sessions,
  COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN request_index = 0 AND result = 'read' THEN 1 ELSE 0 END), 0) AS warm_starts,
  COALESCE(SUM(CASE WHEN request_index = 0 AND result IN ('write', 'partial') THEN 1 ELSE 0 END), 0) AS cold_starts,
  COALESCE(SUM(CASE WHEN cause IS NOT NULL AND cause <> 'FIRST_USE' THEN 1 ELSE 0 END), 0) AS unexpected_misses`

function toTotals(key: string, r: Row): CacheTotals {
  return {
    key,
    requests: Number(r['requests'] ?? 0),
    sessions: Number(r['sessions'] ?? 0),
    inputTokens: Number(r['input_tokens'] ?? 0),
    cacheReadTokens: Number(r['cache_read_tokens'] ?? 0),
    cacheWriteTokens: Number(r['cache_write_tokens'] ?? 0),
    warmStarts: Number(r['warm_starts'] ?? 0),
    coldStarts: Number(r['cold_starts'] ?? 0),
    unexpectedMisses: Number(r['unexpected_misses'] ?? 0),
  }
}

/** Columns the cache figures may be grouped by. A fixed list: the name is put into SQL. */
export type CacheGroup = 'role' | 'model' | 'provider' | 'run_id' | 'agent_id'
const GROUPS: ReadonlySet<string> = new Set(['role', 'model', 'provider', 'run_id', 'agent_id'])

export class CacheEventStore extends Table<CacheEvent> {
  constructor(db: Database) {
    super(db, cacheCodec, 'cache event')
  }

  listByAgent(agentId: string, limit = 200): CacheEvent[] {
    return this.query('WHERE agent_id = ? ORDER BY request_index, rowid LIMIT ?', [agentId, cap(limit, 200)])
  }

  listByRun(runId: string, limit = 1000): CacheEvent[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?', [runId, cap(limit, 1000, 5000)])
  }

  /** The latest request made with a prefix up to `beforeIso`: what a new session is compared with. */
  lastUseOfPrefix(prefixHash: string, beforeIso: string, exceptAgentId: string | null): CacheEvent | null {
    return this.one('WHERE prefix_hash = ? AND created_at <= ? AND (? IS NULL OR agent_id IS NULL OR agent_id <> ?) ORDER BY created_at DESC, rowid DESC', [prefixHash, beforeIso, exceptAgentId, exceptAgentId])
  }

  misses(sinceIso: string, limit = 50): CacheEvent[] {
    return this.query("WHERE created_at >= ? AND cause IS NOT NULL AND cause <> 'FIRST_USE' ORDER BY created_at DESC, rowid DESC LIMIT ?", [sinceIso, cap(limit, 50)])
  }

  totals(sinceIso: string, runId?: string): CacheTotals {
    const row = runId
      ? (prepare(this.db, `SELECT ${TOTAL_COLUMNS} FROM cache_events WHERE created_at >= ? AND run_id = ?`).get(sinceIso, runId) as Row)
      : (prepare(this.db, `SELECT ${TOTAL_COLUMNS} FROM cache_events WHERE created_at >= ?`).get(sinceIso) as Row)
    return toTotals('all', row)
  }

  totalsBy(group: CacheGroup, sinceIso: string, limit = 50): CacheTotals[] {
    if (!GROUPS.has(group)) return []
    const rows = prepare(this.db, `SELECT COALESCE(${group}, 'unknown') AS k, ${TOTAL_COLUMNS} FROM cache_events WHERE created_at >= ? GROUP BY k ORDER BY cache_read_tokens + cache_write_tokens + input_tokens DESC LIMIT ?`).all(sinceIso, cap(limit, 50)) as Row[]
    return rows.map((r) => toTotals(String(r['k']), r))
  }
}

export class OptimizationDecisionStore extends Table<TokenOptimizationDecision> {
  constructor(db: Database) {
    super(db, decisionCodec, 'optimization decision')
  }

  listByRun(runId: string, limit = 500): TokenOptimizationDecision[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?', [runId, cap(limit, 500, 5000)])
  }

  listByAgent(agentId: string, limit = 100): TokenOptimizationDecision[] {
    return this.query('WHERE agent_id = ? ORDER BY created_at, rowid LIMIT ?', [agentId, cap(limit, 100)])
  }

  countByAction(sinceIso: string): { action: string; n: number }[] {
    return prepare(this.db, 'SELECT action, COUNT(*) AS n FROM context_optimization_decisions WHERE created_at >= ? GROUP BY action ORDER BY n DESC').all(sinceIso) as { action: string; n: number }[]
  }
}

export class ArtifactContextRefStore extends Table<ArtifactContextRef> {
  constructor(db: Database) {
    super(db, refCodec, 'artifact context reference')
  }

  listByRun(runId: string, limit = 500): ArtifactContextRef[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?', [runId, cap(limit, 500, 5000)])
  }

  listByTask(taskId: string, limit = 200): ArtifactContextRef[] {
    return this.query('WHERE task_id = ? ORDER BY created_at, rowid LIMIT ?', [taskId, cap(limit, 200)])
  }
}

export class CompactionEventStore extends Table<CompactionEvent> {
  constructor(db: Database) {
    super(db, compactionCodec, 'compaction event')
  }

  listByRun(runId: string): CompactionEvent[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid LIMIT 1000', [runId])
  }

  listByAgent(agentId: string): CompactionEvent[] {
    return this.query('WHERE agent_id = ? ORDER BY created_at, rowid LIMIT 200', [agentId])
  }

  count(sinceIso: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM compaction_events WHERE created_at >= ?').get(sinceIso) as { n: number }).n
  }
}

export class SessionEfficiencyStore extends Table<SessionEfficiencyRecord> {
  constructor(db: Database) {
    super(db, efficiencyCodec, 'session efficiency record')
  }

  listByAgent(agentId: string, limit = 100): SessionEfficiencyRecord[] {
    return this.query('WHERE agent_id = ? ORDER BY created_at, rowid LIMIT ?', [agentId, cap(limit, 100)])
  }

  countByAction(sinceIso: string): { action: string; n: number }[] {
    return prepare(this.db, 'SELECT action, COUNT(*) AS n FROM session_efficiency WHERE created_at >= ? GROUP BY action ORDER BY n DESC').all(sinceIso) as { action: string; n: number }[]
  }
}

export class TokenBenchmarkStore extends Table<TokenBenchmarkResult> {
  constructor(db: Database) {
    super(db, benchmarkCodec, 'token benchmark result')
  }

  list(benchmark: string, limit = 500): TokenBenchmarkResult[] {
    return this.query('WHERE benchmark = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [benchmark, cap(limit, 500, 5000)])
  }
}
