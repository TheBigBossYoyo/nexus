import type { MemoryEntry, MemoryScope, MemoryStatus } from '@shared/domain'
import type { Database } from '../database'
import { Table, decode, prepare, type Codec, type Row, type SqlValue } from '../table'

const memoryCodec: Codec<MemoryEntry> = {
  table: 'memory',
  fields: {
    id: 'text',
    scope: 'text',
    projectId: 'text',
    runId: 'text',
    taskId: 'text',
    agentId: 'text',
    kind: 'text',
    title: 'text',
    content: 'text',
    tags: 'json',
    filePaths: 'json',
    source: 'text',
    evidence: 'text',
    status: 'text',
    createdAt: 'text',
  },
}

export interface MemoryFilter {
  scope?: MemoryScope
  /** Matches entries of that project plus global entries. */
  projectId?: string
  /** Hides run-scoped entries that belong to other runs. */
  runId?: string
  kind?: string
  /** Defaults to 'any' for list() and 'approved' for search(). */
  status?: MemoryStatus | 'any'
  limit?: number
}

function whereClause(filter: MemoryFilter, defaultStatus: MemoryStatus | 'any', prefix: string): { sql: string; params: SqlValue[] } {
  const conds: string[] = []
  const params: SqlValue[] = []
  const status = filter.status ?? defaultStatus
  if (status !== 'any') {
    conds.push(`${prefix}status = ?`)
    params.push(status)
  }
  if (filter.scope) {
    conds.push(`${prefix}scope = ?`)
    params.push(filter.scope)
  }
  if (filter.projectId !== undefined) {
    conds.push(`(${prefix}scope = 'global' OR ${prefix}project_id = ?)`)
    params.push(filter.projectId)
  }
  if (filter.runId !== undefined) {
    conds.push(`(${prefix}scope <> 'run' OR ${prefix}run_id = ?)`)
    params.push(filter.runId)
  }
  if (filter.kind !== undefined) {
    conds.push(`${prefix}kind = ?`)
    params.push(filter.kind)
  }
  return { sql: conds.length ? conds.join(' AND ') : '1 = 1', params }
}

/**
 * Turns arbitrary user text into a safe FTS5 MATCH expression: every alphanumeric run becomes a quoted
 * literal term and terms are OR-ed, so FTS operators, quotes, colons and parentheses can never reach the parser.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text.match(/[\p{L}\p{N}]+/gu)
  if (!terms || terms.length === 0) return null
  return [...new Set(terms.map((t) => t.toLowerCase()))].map((t) => `"${t}"`).join(' OR ')
}

export class MemoryRepository extends Table<MemoryEntry> {
  constructor(db: Database) {
    super(db, memoryCodec, 'memory entry')
  }

  /** Newest first. */
  list(filter: MemoryFilter = {}): MemoryEntry[] {
    const { sql, params } = whereClause(filter, 'any', '')
    return this.query(`WHERE ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`, [...params, filter.limit ?? 200])
  }

  /** Full-text search (bm25, title weighted highest) over title/content/tags/file paths. Approved entries only by default. */
  search(query: string, filter: MemoryFilter = {}): MemoryEntry[] {
    const match = toFtsQuery(query)
    if (!match) return []
    const { sql, params } = whereClause(filter, 'approved', 'm.')
    const rows = prepare(
      this.db,
      `SELECT m.* FROM memory_fts JOIN memory m ON m.seq = memory_fts.rowid
       WHERE memory_fts MATCH ? AND ${sql}
       ORDER BY bm25(memory_fts, 5.0, 1.0, 2.0, 1.0), m.seq
       LIMIT ?`,
    ).all(match, ...params, filter.limit ?? 10) as Row[]
    return rows.map((r) => decode(memoryCodec, r))
  }
}
