import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase, runMigrations, type Database } from '@main/modules/persistence'

const root = join(process.cwd(), 'test-results', 'director-line-wiring')
const dirs: string[] = []
const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const NEW_TABLES = [
  'director_line_identities', 'director_line_pairing_state', 'director_line_seen', 'director_line_outbox',
  'director_line_deliveries', 'director_line_policy', 'director_line_settings',
  'progress_predictions', 'progress_accuracy', 'network_outages',
]

function tables(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
}

describe('migration 020 (operational autonomy)', () => {
  it('a fresh database has every new table at schema 20', () => {
    const db = openDatabase(':memory:')
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 25 })
    for (const t of NEW_TABLES) expect(tables(db), t).toContain(t)
    const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('progress_predictions')).toEqual(['run_id', 'at', 'low_seconds', 'high_seconds', 'percent', 'confidence', 'wait'])
    expect(cols('progress_accuracy')).toEqual(['run_id', 'finished_at', 'samples', 'coverage', 'bias', 'mean_width_ratio'])
    expect(cols('network_outages')).toEqual(['id', 'started_at', 'ended_at', 'record_json'])
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_progress_predictions_run', 'idx_network_outages_started', 'director_line_seen_at', 'director_line_deliveries_at']))
  })

  it('a 0.8.0-shaped database (schema 19) upgrades to 20 with its data intact', () => {
    mkdirSync(root, { recursive: true })
    const dir = mkdtempSync(join(root, 'migrate-'))
    dirs.push(dir)
    const path = join(dir, 'nexus.db')
    const old = new BetterSqlite3(path)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 19))
    old.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('keep-me', '{\"a\":1}', '2026-10-01T00:00:00.000Z')").run()
    expect(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 19 })
    for (const t of NEW_TABLES) expect(tables(old)).not.toContain(t)
    old.close()

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 25 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 25 })
    expect(db.prepare("SELECT value FROM settings WHERE key = 'keep-me'").get()).toEqual({ value: '{"a":1}' })
    for (const t of NEW_TABLES) expect(tables(db), t).toContain(t)
    db.close()
    // Reopening is a no-op.
    const again = openDatabase(path)
    open.push(again)
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 25 })
  })
})

describe('migration 021 (the voice line)', () => {
  it('a database at schema 20 gains the voice tables and keeps its data', () => {
    mkdirSync(root, { recursive: true })
    const dir = mkdtempSync(join(root, 'migrate-021-'))
    dirs.push(dir)
    const path = join(dir, 'nexus.db')
    const old = new BetterSqlite3(path)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 20))
    old.prepare("INSERT INTO director_line_settings (id, enabled, message_provider, voice_provider) VALUES (1, 1, 'TELEGRAM', 'TWILIO_VOICE')").run()
    expect(tables(old)).not.toContain('director_line_voice')
    old.close()

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 25 })
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 21").get()).toEqual({ name: 'voice-line' })
    for (const t of ['director_line_voice', 'director_line_calls']) expect(tables(db), t).toContain(t)
    expect(db.prepare('SELECT enabled, voice_provider FROM director_line_settings WHERE id = 1').get()).toEqual({ enabled: 1, voice_provider: 'TWILIO_VOICE' })
  })
})

describe('migration 022 (what a call proved, and the calls NEXUS placed)', () => {
  it('a database at schema 21 gains the columns and table, and no old call is left claiming end to end', () => {
    mkdirSync(root, { recursive: true })
    const dir = mkdtempSync(join(root, 'migrate-022-'))
    dirs.push(dir)
    const path = join(dir, 'nexus.db')
    const old = new BetterSqlite3(path)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 21))
    old.prepare(
      "INSERT INTO director_line_calls (call_id, direction, started_at, ended_at, outcome, authenticated, signalling, media, end_to_end) VALUES ('c1', 'INBOUND', '2026-10-13T10:00:00.000Z', '2026-10-13T10:01:00.000Z', 'CONVERSATION', 1, 'TLS', 'ZRTP', 1)",
    ).run()
    old.close()

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 25 })
    expect(db.prepare('SELECT name FROM schema_migrations WHERE version = 22').get()).toEqual({ name: 'voice-line-verification' })
    expect(tables(db)).toContain('director_line_placed_calls')
    expect(db.prepare("SELECT call_id, end_to_end, peer_verified FROM director_line_calls WHERE call_id = 'c1'").get()).toEqual({ call_id: 'c1', end_to_end: 0, peer_verified: 0 })
  })
})
