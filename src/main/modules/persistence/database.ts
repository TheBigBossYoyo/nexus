import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { NexusError, errorMessage } from '@shared/result'
import { nowIso } from '@shared/ids'
import { MIGRATIONS, type Migration } from './migrations'

export type Database = BetterSqlite3.Database

/** Applies pending migrations in one transaction. Exported so tests can supply their own migration list. */
export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
    const current = row.v ?? 0
    const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0)
    if (current > latest) {
      throw new NexusError(
        'database',
        `Database schema v${current} is newer than this app supports (v${latest}). Update NEXUS.`,
      )
    }
    const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= current) continue
      try {
        db.exec(m.sql)
        insert.run(m.version, m.name, nowIso())
      } catch (e) {
        throw new NexusError('database', `Migration ${m.version} (${m.name}) failed: ${errorMessage(e)}`, {
          version: m.version,
        })
      }
    }
  })()
}

/** Opens (creating if needed) the NEXUS database and brings it to the latest schema. Accepts ':memory:'. */
export function openDatabase(path: string): Database {
  let db: Database | null = null
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    db = new BetterSqlite3(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    runMigrations(db)
    return db
  } catch (e) {
    try {
      db?.close()
    } catch {
      // The handle is already unusable; the original error is the one worth reporting.
    }
    if (e instanceof NexusError) throw e
    throw new NexusError('database', `Cannot open database at ${path}: ${errorMessage(e)}`, { path })
  }
}
