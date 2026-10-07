import type {
  ContextEdge,
  ContextEdgeType,
  ContextNode,
  ContextNodeHistory,
  ContextNodeSource,
  ContextNodeType,
  ContextNodeVersion,
  ContextRefreshJob,
  ContextSpace,
  ContextStatus,
} from '@shared/context-graph'
import type { Database } from '../database'
import { Table, decode, guard, prepare, type Codec, type Row, type SqlValue } from '../table'
import { toFtsQuery } from './memory'

const nodeCodec: Codec<ContextNode> = {
  table: 'context_nodes',
  fields: {
    id: 'text',
    spaceKind: 'text',
    spaceId: 'text',
    programId: 'text',
    type: 'text',
    path: 'text',
    parentId: 'text',
    depth: 'num',
    title: 'text',
    summary: 'text',
    body: 'text',
    originKind: 'text',
    originId: 'text',
    trust: 'text',
    status: 'text',
    confidence: 'text',
    subjectKey: 'text',
    contentHash: 'text',
    summaryHash: 'text',
    version: 'num',
    tokenEstimate: 'num',
    classification: 'text',
    provenance: 'json',
    createdAt: 'text',
    updatedAt: 'text',
    sourceUpdatedAt: 'text',
    refreshedAt: 'text',
  },
}

const edgeCodec: Codec<ContextEdge> = {
  table: 'context_edges',
  fields: { id: 'text', fromId: 'text', toId: 'text', type: 'text', trust: 'text', confidence: 'text', provenance: 'json', createdAt: 'text', updatedAt: 'text' },
}

const versionCodec: Codec<ContextNodeVersion> = {
  table: 'context_node_versions',
  fields: { id: 'text', nodeId: 'text', version: 'num', title: 'text', summary: 'text', body: 'text', trust: 'text', contentHash: 'text', createdAt: 'text' },
}

const historyCodec: Codec<ContextNodeHistory> = {
  table: 'context_node_history',
  fields: { id: 'text', nodeId: 'text', event: 'text', detail: 'text', createdAt: 'text' },
}

const jobCodec: Codec<ContextRefreshJob> = {
  table: 'context_refresh_jobs',
  fields: {
    id: 'text',
    spaceKind: 'text',
    spaceId: 'text',
    trigger: 'text',
    fromCommit: 'text',
    toCommit: 'text',
    changedFiles: 'num',
    nodesChecked: 'num',
    nodesStale: 'num',
    nodesRefreshed: 'num',
    state: 'text',
    error: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

/** Longest page any listing returns: the graph is never loaded whole into the renderer or a prompt. */
export const CONTEXT_PAGE_MAX = 500
const page = (n: number | undefined, fallback: number): number => Math.max(1, Math.min(CONTEXT_PAGE_MAX, Math.floor(n ?? fallback)))

const ACTIVE: readonly ContextStatus[] = ['CURRENT', 'STALE', 'CONFLICTED']
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

export interface NodeListOptions {
  /** Statuses to return. Default: CURRENT, STALE and CONFLICTED (everything that is not history). */
  statuses?: readonly ContextStatus[]
  types?: readonly ContextNodeType[]
  limit?: number
  offset?: number
}

export interface FtsHit {
  node: ContextNode
  /** bm25 rank: lower is a better match. */
  rank: number
}

export class ContextNodeStore extends Table<ContextNode> {
  constructor(db: Database) {
    super(db, nodeCodec, 'context node')
  }

  byPath(space: ContextSpace, path: string): ContextNode | null {
    return this.one('WHERE space_kind = ? AND space_id = ? AND path = ?', [space.kind, space.id, path])
  }

  byOrigin(originKind: string, originId: string): ContextNode[] {
    return this.query('WHERE origin_kind = ? AND origin_id = ? ORDER BY seq', [originKind, originId])
  }

  root(space: ContextSpace): ContextNode | null {
    return this.byPath(space, '')
  }

  children(parentId: string, options: NodeListOptions = {}): ContextNode[] {
    const statuses = options.statuses ?? ACTIVE
    const conds = ['parent_id = ?', `status IN (${marks(statuses.length)})`]
    const params: SqlValue[] = [parentId, ...statuses]
    if (options.types && options.types.length > 0) {
      conds.push(`type IN (${marks(options.types.length)})`)
      params.push(...options.types)
    }
    return this.query(`WHERE ${conds.join(' AND ')} ORDER BY type, title, seq LIMIT ? OFFSET ?`, [...params, page(options.limit, 100), Math.max(0, options.offset ?? 0)])
  }

  countChildren(parentId: string, statuses: readonly ContextStatus[] = ACTIVE): number {
    const row = prepare(this.db, `SELECT COUNT(*) AS n FROM context_nodes WHERE parent_id = ? AND status IN (${marks(statuses.length)})`).get(parentId, ...statuses) as { n: number }
    return row.n
  }

  /** Every node of a subtree, by path prefix. Bounded: callers page through large branches. */
  subtree(space: ContextSpace, pathPrefix: string, options: NodeListOptions = {}): ContextNode[] {
    const statuses = options.statuses ?? ACTIVE
    const like = pathPrefix === '' ? '%' : `${pathPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`
    return this.query(
      `WHERE space_kind = ? AND space_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\') AND status IN (${marks(statuses.length)}) ORDER BY path LIMIT ? OFFSET ?`,
      [space.kind, space.id, pathPrefix, like, ...statuses, page(options.limit, CONTEXT_PAGE_MAX), Math.max(0, options.offset ?? 0)],
    )
  }

  listBySpace(space: ContextSpace, options: NodeListOptions = {}): ContextNode[] {
    const statuses = options.statuses ?? ACTIVE
    const conds = ['space_kind = ?', 'space_id = ?', `status IN (${marks(statuses.length)})`]
    const params: SqlValue[] = [space.kind, space.id, ...statuses]
    if (options.types && options.types.length > 0) {
      conds.push(`type IN (${marks(options.types.length)})`)
      params.push(...options.types)
    }
    return this.query(`WHERE ${conds.join(' AND ')} ORDER BY path LIMIT ? OFFSET ?`, [...params, page(options.limit, CONTEXT_PAGE_MAX), Math.max(0, options.offset ?? 0)])
  }

  /** Projected nodes of a space, for reconciliation with their origin records. Paged by the caller. */
  listProjected(space: ContextSpace, originKinds: readonly string[], limit: number, offset: number): ContextNode[] {
    if (originKinds.length === 0) return []
    return this.query(`WHERE space_kind = ? AND space_id = ? AND origin_kind IN (${marks(originKinds.length)}) ORDER BY seq LIMIT ? OFFSET ?`, [space.kind, space.id, ...originKinds, Math.max(1, limit), Math.max(0, offset)])
  }

  bySubject(space: ContextSpace, subjectKey: string, statuses: readonly ContextStatus[] = ['CURRENT', 'CONFLICTED']): ContextNode[] {
    return this.query(`WHERE space_kind = ? AND space_id = ? AND subject_key = ? AND status IN (${marks(statuses.length)}) ORDER BY seq`, [space.kind, space.id, subjectKey, ...statuses])
  }

  getMany(ids: readonly string[]): ContextNode[] {
    const out: ContextNode[] = []
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      out.push(...this.query(`WHERE id IN (${marks(chunk.length)})`, [...chunk]))
    }
    return out
  }

  /** Full-text search inside the given spaces. Text is turned into quoted OR terms, so no FTS operator reaches the parser. */
  search(spaces: readonly ContextSpace[], text: string, options: NodeListOptions = {}): FtsHit[] {
    const match = toFtsQuery(text)
    if (!match || spaces.length === 0) return []
    const statuses = options.statuses ?? ACTIVE
    const spaceCond = spaces.map(() => '(n.space_kind = ? AND n.space_id = ?)').join(' OR ')
    const params: SqlValue[] = [match, ...spaces.flatMap((s) => [s.kind, s.id]), ...statuses]
    let typeCond = ''
    if (options.types && options.types.length > 0) {
      typeCond = ` AND n.type IN (${marks(options.types.length)})`
      params.push(...options.types)
    }
    const rows = guard(
      () =>
        prepare(
          this.db,
          `SELECT n.*, bm25(context_nodes_fts, 6.0, 1.0, 3.0) AS rank
           FROM context_nodes_fts JOIN context_nodes n ON n.seq = context_nodes_fts.rowid
           WHERE context_nodes_fts MATCH ? AND (${spaceCond}) AND n.status IN (${marks(statuses.length)})${typeCond}
           ORDER BY rank, n.seq LIMIT ?`,
        ).all(...params, page(options.limit, 40)) as Row[],
    )
    return rows.map((r) => ({ node: decode(nodeCodec, r), rank: Number(r['rank']) }))
  }

  /** Subject keys claimed by more than one current node with different content: candidates for a conflict. */
  conflictingSubjects(space: ContextSpace): string[] {
    const rows = prepare(
      this.db,
      `SELECT subject_key FROM context_nodes WHERE space_kind = ? AND space_id = ? AND subject_key IS NOT NULL AND status IN ('CURRENT', 'CONFLICTED')
       GROUP BY subject_key HAVING COUNT(DISTINCT content_hash) > 1 ORDER BY subject_key LIMIT 5000`,
    ).all(space.kind, space.id) as { subject_key: string }[]
    return rows.map((r) => r.subject_key)
  }

  listByStatus(space: ContextSpace, status: ContextStatus, limit = CONTEXT_PAGE_MAX, offset = 0): ContextNode[] {
    return this.query('WHERE space_kind = ? AND space_id = ? AND status = ? ORDER BY seq LIMIT ? OFFSET ?', [space.kind, space.id, status, Math.max(1, limit), Math.max(0, offset)])
  }

  /** Nodes whose summary is derived from their children, deepest first, paged. */
  listDerived(space: ContextSpace, limit: number, offset: number): ContextNode[] {
    return this.query("WHERE space_kind = ? AND space_id = ? AND trust = 'GENERATED_SUMMARY' AND (origin_kind = 'graph' OR path = '') AND type NOT IN ('NOTE', 'CUSTOM') AND status <> 'ARCHIVED' ORDER BY depth DESC, seq LIMIT ? OFFSET ?", [space.kind, space.id, Math.max(1, limit), Math.max(0, offset)])
  }

  countByStatus(space: ContextSpace): { status: string; n: number }[] {
    return prepare(this.db, 'SELECT status, COUNT(*) AS n FROM context_nodes WHERE space_kind = ? AND space_id = ? GROUP BY status').all(space.kind, space.id) as { status: string; n: number }[]
  }

  countByTrust(space: ContextSpace): { trust: string; n: number }[] {
    return prepare(this.db, 'SELECT trust, COUNT(*) AS n FROM context_nodes WHERE space_kind = ? AND space_id = ? GROUP BY trust').all(space.kind, space.id) as { trust: string; n: number }[]
  }

  countByType(space: ContextSpace): { type: string; n: number }[] {
    return prepare(this.db, 'SELECT type, COUNT(*) AS n FROM context_nodes WHERE space_kind = ? AND space_id = ? GROUP BY type').all(space.kind, space.id) as { type: string; n: number }[]
  }

  activeTokenEstimate(space: ContextSpace): number {
    const row = prepare(this.db, "SELECT COALESCE(SUM(token_estimate), 0) AS n FROM context_nodes WHERE space_kind = ? AND space_id = ? AND status = 'CURRENT'").get(space.kind, space.id) as { n: number }
    return row.n
  }

  countEdges(space: ContextSpace): number {
    const row = prepare(this.db, 'SELECT COUNT(*) AS n FROM context_edges e JOIN context_nodes n ON n.id = e.from_id WHERE n.space_kind = ? AND n.space_id = ?').get(space.kind, space.id) as { n: number }
    return row.n
  }
}

export class ContextEdgeStore extends Table<ContextEdge> {
  constructor(db: Database) {
    super(db, edgeCodec, 'context edge')
  }

  find(fromId: string, toId: string, type: ContextEdgeType): ContextEdge | null {
    return this.one('WHERE from_id = ? AND to_id = ? AND type = ?', [fromId, toId, type])
  }

  outgoing(nodeId: string, types?: readonly ContextEdgeType[], limit = 100): ContextEdge[] {
    if (types && types.length > 0) return this.query(`WHERE from_id = ? AND type IN (${marks(types.length)}) ORDER BY type, rowid LIMIT ?`, [nodeId, ...types, page(limit, 100)])
    return this.query('WHERE from_id = ? ORDER BY type, rowid LIMIT ?', [nodeId, page(limit, 100)])
  }

  incoming(nodeId: string, types?: readonly ContextEdgeType[], limit = 100): ContextEdge[] {
    if (types && types.length > 0) return this.query(`WHERE to_id = ? AND type IN (${marks(types.length)}) ORDER BY type, rowid LIMIT ?`, [nodeId, ...types, page(limit, 100)])
    return this.query('WHERE to_id = ? ORDER BY type, rowid LIMIT ?', [nodeId, page(limit, 100)])
  }

  /** Edges touching any of the nodes, in either direction. Bounded per call. */
  touching(nodeIds: readonly string[], limit = CONTEXT_PAGE_MAX): ContextEdge[] {
    if (nodeIds.length === 0) return []
    const ids = nodeIds.slice(0, 200)
    return this.query(`WHERE from_id IN (${marks(ids.length)}) OR to_id IN (${marks(ids.length)}) ORDER BY rowid LIMIT ?`, [...ids, ...ids, page(limit, CONTEXT_PAGE_MAX)])
  }

  /** Every edge that starts in a space, paged, with the paths of both ends: what a projection is reconciled against. */
  ofSpace(space: ContextSpace, limit: number, offset: number): ContextEdge[] {
    const rows = prepare(
      this.db,
      `SELECT e.* FROM context_edges e JOIN context_nodes n ON n.id = e.from_id WHERE n.space_kind = ? AND n.space_id = ? ORDER BY e.rowid LIMIT ? OFFSET ?`,
    ).all(space.kind, space.id, Math.max(1, limit), Math.max(0, offset)) as Row[]
    return rows.map((r) => decode(edgeCodec, r))
  }

  /** Edges a projection created from one origin record (`provenance.source` + evidence carry the record id). */
  deleteFrom(fromId: string, types: readonly ContextEdgeType[]): number {
    if (types.length === 0) return 0
    return guard(() => prepare(this.db, `DELETE FROM context_edges WHERE from_id = ? AND type IN (${marks(types.length)})`).run(fromId, ...types)).changes
  }
}

export class ContextSourceStore {
  constructor(private readonly db: Database) {}

  replace(nodeId: string, spaceId: string, sources: readonly Omit<ContextNodeSource, 'nodeId' | 'spaceId'>[]): void {
    guard(() => prepare(this.db, 'DELETE FROM context_node_sources WHERE node_id = ?').run(nodeId))
    const insert = prepare(this.db, 'INSERT OR REPLACE INTO context_node_sources (node_id, space_id, kind, ref, hash) VALUES (?, ?, ?, ?, ?)')
    for (const s of sources) guard(() => insert.run(nodeId, spaceId, s.kind, s.ref, s.hash))
  }

  setHash(nodeId: string, kind: string, ref: string, hash: string | null): void {
    guard(() => prepare(this.db, 'UPDATE context_node_sources SET hash = ? WHERE node_id = ? AND kind = ? AND ref = ?').run(hash, nodeId, kind, ref))
  }

  ofNode(nodeId: string): ContextNodeSource[] {
    const rows = prepare(this.db, 'SELECT node_id, space_id, kind, ref, hash FROM context_node_sources WHERE node_id = ? ORDER BY kind, ref').all(nodeId) as Row[]
    return rows.map(toSource)
  }

  /** Nodes whose evidence includes one of the files. The index makes this a lookup, not a scan. */
  nodesForFiles(spaceId: string, files: readonly string[]): { nodeId: string; ref: string; hash: string | null }[] {
    const out: { nodeId: string; ref: string; hash: string | null }[] = []
    for (let i = 0; i < files.length; i += 400) {
      const chunk = files.slice(i, i + 400)
      const rows = prepare(this.db, `SELECT node_id, ref, hash FROM context_node_sources WHERE space_id = ? AND kind = 'file' AND ref IN (${marks(chunk.length)})`).all(spaceId, ...chunk) as Row[]
      for (const r of rows) out.push({ nodeId: String(r['node_id']), ref: String(r['ref']), hash: (r['hash'] as string | null) ?? null })
    }
    return out
  }

  /** File sources of a space, paged, for a full fingerprint check. */
  fileSources(spaceId: string, limit: number, offset: number): ContextNodeSource[] {
    const rows = prepare(this.db, "SELECT node_id, space_id, kind, ref, hash FROM context_node_sources WHERE space_id = ? AND kind = 'file' ORDER BY ref, node_id LIMIT ? OFFSET ?").all(spaceId, Math.max(1, limit), Math.max(0, offset)) as Row[]
    return rows.map(toSource)
  }
}

function toSource(r: Row): ContextNodeSource {
  return { nodeId: String(r['node_id']), spaceId: String(r['space_id']), kind: r['kind'] as ContextNodeSource['kind'], ref: String(r['ref']), hash: (r['hash'] as string | null) ?? null }
}

export class ContextVersionStore extends Table<ContextNodeVersion> {
  constructor(db: Database) {
    super(db, versionCodec, 'context node version')
  }

  ofNode(nodeId: string, limit = 20): ContextNodeVersion[] {
    return this.query('WHERE node_id = ? ORDER BY version DESC LIMIT ?', [nodeId, page(limit, 20)])
  }
}

export class ContextHistoryStore extends Table<ContextNodeHistory> {
  constructor(db: Database) {
    super(db, historyCodec, 'context node history entry')
  }

  ofNode(nodeId: string, limit = 50): ContextNodeHistory[] {
    return this.query('WHERE node_id = ? ORDER BY seq DESC LIMIT ?', [nodeId, page(limit, 50)])
  }
}

export class ContextRefreshJobStore extends Table<ContextRefreshJob> {
  constructor(db: Database) {
    super(db, jobCodec, 'context refresh job')
  }

  latest(space: ContextSpace, trigger?: ContextRefreshJob['trigger']): ContextRefreshJob | null {
    if (trigger) return this.one("WHERE space_kind = ? AND space_id = ? AND \"trigger\" = ? AND state = 'completed' ORDER BY finished_at DESC, rowid DESC", [space.kind, space.id, trigger])
    return this.one("WHERE space_kind = ? AND space_id = ? AND state = 'completed' ORDER BY finished_at DESC, rowid DESC", [space.kind, space.id])
  }

  /** The last job that recorded a commit: where an incremental refresh starts from. */
  latestWithCommit(space: ContextSpace): ContextRefreshJob | null {
    return this.one("WHERE space_kind = ? AND space_id = ? AND state = 'completed' AND to_commit IS NOT NULL ORDER BY finished_at DESC, rowid DESC", [space.kind, space.id])
  }

  list(space: ContextSpace, limit = 20): ContextRefreshJob[] {
    return this.query('WHERE space_kind = ? AND space_id = ? ORDER BY finished_at DESC, rowid DESC LIMIT ?', [space.kind, space.id, page(limit, 20)])
  }
}

/** The graph's tables behind one handle, as the service takes them. */
export interface ContextGraphStores {
  nodes: ContextNodeStore
  edges: ContextEdgeStore
  sources: ContextSourceStore
  versions: ContextVersionStore
  history: ContextHistoryStore
  jobs: ContextRefreshJobStore
}

export function contextGraphStores(db: Database): ContextGraphStores {
  return {
    nodes: new ContextNodeStore(db),
    edges: new ContextEdgeStore(db),
    sources: new ContextSourceStore(db),
    versions: new ContextVersionStore(db),
    history: new ContextHistoryStore(db),
    jobs: new ContextRefreshJobStore(db),
  }
}
