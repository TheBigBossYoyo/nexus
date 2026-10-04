import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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

/** Schema version of an open database; 0 for a new one. */
function schemaVersion(db: Database): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return 0
  return Number((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0)
}

/**
 * Before an existing database is upgraded, a copy is kept next to it (`nexus.db.v<old>.bak`). Migrations are
 * additive and transactional, so the copy is not needed to recover from a failed upgrade; it exists because an
 * upgraded database cannot be opened by the older version of NEXUS that wrote it. One copy per old version;
 * never overwritten. A failure to copy is not a reason to refuse the upgrade.
 */
function backupBeforeUpgrade(db: Database, path: string): void {
  if (path === ':memory:') return
  const current = schemaVersion(db)
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
  if (current === 0 || current >= latest) return
  const target = `${path}.v${current}.bak`
  if (existsSync(target)) return
  try {
    // Everything in the write-ahead log goes into the main file first, so the copy is complete on its own.
    db.pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(path, target)
  } catch (e) {
    console.error(`[nexus] database backup before upgrade failed: ${errorMessage(e)}`)
  }
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
    backupBeforeUpgrade(db, path)
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
