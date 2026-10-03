import type BetterSqlite3 from 'better-sqlite3'
import { NexusError, errorMessage } from '@shared/result'
import type { Database } from './database'

export type SqlValue = string | number | bigint | null
export type Row = Record<string, unknown>

/** How a TS field maps to a column. Column names are the snake_case of the field name. */
export type Kind = 'text' | 'num' | 'bool' | 'json'

export interface Codec<E> {
  table: string
  fields: { [K in keyof E]-?: Kind }
}

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const q = (ident: string): string => `"${ident}"`

const statements = new WeakMap<Database, Map<string, BetterSqlite3.Statement>>()

export function prepare(db: Database, sql: string): BetterSqlite3.Statement {
  let cache = statements.get(db)
  if (!cache) {
    cache = new Map()
    statements.set(db, cache)
  }
  let stmt = cache.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    cache.set(sql, stmt)
  }
  return stmt
}

/** Converts raw SQLite failures (constraint violations, I/O) into NexusError('database'). */
export function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof NexusError) throw e
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
    if (code.startsWith('SQLITE_')) throw new NexusError('database', errorMessage(e), { sqliteCode: code })
    throw e
  }
}

function encodeValue(kind: Kind, v: unknown): SqlValue {
  if (v === null || v === undefined) return null
  switch (kind) {
    case 'bool':
      return v ? 1 : 0
    case 'json':
      return JSON.stringify(v)
    case 'text':
    case 'num':
      return v as SqlValue
  }
}

function decodeValue(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return null
  switch (kind) {
    case 'bool':
      return v !== 0
    case 'json':
      return JSON.parse(v as string)
    case 'text':
    case 'num':
      return v
  }
}

export function decode<E>(codec: Codec<E>, row: Row): E {
  const out: Row = {}
  for (const [key, kind] of Object.entries(codec.fields) as [string, Kind][]) {
    out[key] = decodeValue(kind, row[snake(key)])
  }
  return out as E
}

function encode<E>(codec: Codec<E>, entity: Partial<E>): Record<string, SqlValue> {
  const source = entity as Row
  const out: Record<string, SqlValue> = {}
  for (const [key, kind] of Object.entries(codec.fields) as [string, Kind][]) {
    if (key in source && source[key] !== undefined) out[snake(key)] = encodeValue(kind, source[key])
  }
  return out
}

/** Row-level helpers shared by every repository: CRUD by id plus a tail-SQL list query. */
export class Table<E extends { id: string }> {
  private readonly columns: string
  private readonly label: string

  constructor(
    protected readonly db: Database,
    protected readonly codec: Codec<E>,
    label?: string,
  ) {
    this.columns = Object.keys(codec.fields).map((k) => q(snake(k))).join(', ')
    this.label = label ?? codec.table
  }

  insert(entity: E): E {
    const params = encode(this.codec, entity)
    const cols = Object.keys(params)
    const sql = `INSERT INTO ${q(this.codec.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
    guard(() => prepare(this.db, sql).run(params))
    return entity
  }

  get(id: string): E | null {
    return this.one('WHERE id = ?', [id])
  }

  require(id: string): E {
    const found = this.get(id)
    if (!found) throw new NexusError('not_found', `${this.label} not found: ${id}`, { id })
    return found
  }

  /** Applies a partial patch (undefined fields are left alone; null clears nullable ones). Returns the updated entity. */
  update(id: string, patch: Partial<Omit<E, 'id'>>): E {
    const params = encode(this.codec, patch as Partial<E>)
    delete params['id']
    const cols = Object.keys(params)
    if (cols.length === 0) return this.require(id)
    const sql = `UPDATE ${q(this.codec.table)} SET ${cols.map((c) => `${q(c)} = @${c}`).join(', ')} WHERE id = @__id`
    const info = guard(() => prepare(this.db, sql).run({ ...params, __id: id }))
    if (info.changes === 0) throw new NexusError('not_found', `${this.label} not found: ${id}`, { id })
    return this.require(id)
  }

  delete(id: string): boolean {
    return guard(() => prepare(this.db, `DELETE FROM ${q(this.codec.table)} WHERE id = ?`).run(id)).changes > 0
  }

  /** `tail` is everything after FROM <table>, e.g. "WHERE run_id = ? ORDER BY created_at, rowid". */
  protected query(tail: string, params: SqlValue[] = []): E[] {
    const rows = prepare(this.db, `SELECT ${this.columns} FROM ${q(this.codec.table)} ${tail}`).all(...params) as Row[]
    return rows.map((r) => decode(this.codec, r))
  }

  protected one(tail: string, params: SqlValue[] = []): E | null {
    return this.query(`${tail} LIMIT 1`, params)[0] ?? null
  }

  protected byRun(runId: string, order = 'created_at, rowid'): E[] {
    return this.query(`WHERE run_id = ? ORDER BY ${order}`, [runId])
  }
}
