import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

describe('toolchain', () => {
  it('loads better-sqlite3 with FTS5', () => {
    const db = new Database(':memory:')
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello nexus');")
    const row = db.prepare("SELECT body FROM t WHERE t MATCH 'nexus'").get() as { body: string }
    expect(row.body).toBe('hello nexus')
    db.close()
  })
})
