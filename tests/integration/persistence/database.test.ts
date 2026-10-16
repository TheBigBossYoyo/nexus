import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { NexusError } from '@shared/result'
import { MIGRATIONS, createRepositories, openDatabase, runMigrations, type Database } from '@main/modules/persistence'
import { makeProject, makeRun, makeTask, openMemory, seed } from './fixtures'

const dirs: string[] = []
const open: Database[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-db-'))
  dirs.push(dir)
  return join(dir, 'nested', 'nexus.db')
}
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('openDatabase', () => {
  it('sets WAL, foreign keys, busy timeout and synchronous NORMAL on a file database', () => {
    const db = openDatabase(tempDb())
    open.push(db)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
  })

  it('applies migrations once and is idempotent on reopen', () => {
    const path = tempDb()
    const first = openDatabase(path)
    const rows = first.prepare('SELECT version, name FROM schema_migrations').all()
    expect(rows).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'v0-2' },
      { version: 3, name: 'overnight' },
      { version: 4, name: 'v0-3' },
      { version: 5, name: 'overnight-workloads' },
      { version: 6, name: 'programs' },
      { version: 7, name: 'workspaces' },
      { version: 8, name: 'providers' },
      { version: 9, name: 'control-plane' },
      { version: 10, name: 'workers' },
      { version: 11, name: 'security' },
      { version: 12, name: 'context-graph' },
      { version: 13, name: 'intelligence' },
      { version: 14, name: 'canonical-intents' },
      { version: 15, name: 'capacity-director' },
      { version: 16, name: 'advice-outcomes' },
      { version: 17, name: 'autonomy' },
      { version: 18, name: 'research' },
      { version: 19, name: 'boundary-action-hash' },
      { version: 20, name: 'operational-autonomy' },
      { version: 21, name: 'voice-line' },
      { version: 22, name: 'voice-line-verification' },
      { version: 23, name: 'privilege-sessions' },
      { version: 24, name: 'user-disturbance' },
      { version: 25, name: 'privilege-receipt-chain' },
    ])
    first.close()

    const second = openDatabase(path)
    open.push(second)
    expect(second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 25 })
  })

  it('rolls the whole migration back when one fails', () => {
    const db = openDatabase(':memory:')
    open.push(db)
    const bad = [
      { version: 26, name: 'ok', sql: 'CREATE TABLE extra_a (x INTEGER);' },
      { version: 27, name: 'broken', sql: 'CREATE TABLE extra_b (x INTEGER); THIS IS NOT SQL;' },
    ]
    expect(() =>
      runMigrations(db, [
        { version: 1, name: 'initial', sql: '' },
        { version: 2, name: 'v0-2', sql: '' },
        { version: 3, name: 'overnight', sql: '' },
        { version: 4, name: 'v0-3', sql: '' },
        { version: 5, name: 'overnight-workloads', sql: '' },
        { version: 6, name: 'programs', sql: '' },
        { version: 7, name: 'workspaces', sql: '' },
        { version: 8, name: 'providers', sql: '' },
        { version: 9, name: 'control-plane', sql: '' },
        { version: 10, name: 'workers', sql: '' },
        { version: 11, name: 'security', sql: '' },
        { version: 12, name: 'context-graph', sql: '' },
        { version: 13, name: 'intelligence', sql: '' },
        { version: 14, name: 'canonical-intents', sql: '' },
        { version: 15, name: 'capacity-director', sql: '' },
        { version: 16, name: 'advice-outcomes', sql: '' },
        { version: 17, name: 'autonomy', sql: '' },
        { version: 18, name: 'research', sql: '' },
        { version: 19, name: 'boundary-action-hash', sql: '' },
        { version: 20, name: 'operational-autonomy', sql: '' },
        { version: 21, name: 'voice-line', sql: '' },
        { version: 22, name: 'voice-line-verification', sql: '' },
        { version: 23, name: 'privilege-sessions', sql: '' },
        { version: 24, name: 'user-disturbance', sql: '' },
        { version: 25, name: 'privilege-receipt-chain', sql: '' },
        ...bad,
      ]),
    ).toThrow()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'extra_%'").all()
    expect(tables).toEqual([])
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 25 })
  })

  it('counts receipts that existed before migration 25 as the legacy boundary and leaves their chain columns NULL', () => {
    const db = new BetterSqlite3(':memory:')
    open.push(db)
    runMigrations(db, MIGRATIONS.slice(0, 24))
    const insert = db.prepare(
      `INSERT INTO privileged_operations (id, requested_at, finished_at, capability, outcome, receipt_json)
       VALUES (?, 'now', 'now', 'PROJECT_TOOLCHAIN_INSTALL', 'EXECUTED', '{}')`,
    )
    insert.run('op-1')
    insert.run('op-2')
    const maxSeq = (db.prepare('SELECT MAX(seq) AS m FROM privileged_operations').get() as { m: number }).m
    runMigrations(db)
    expect(db.prepare('SELECT legacy_max_seq, legacy_count FROM privilege_chain_meta').all()).toEqual([
      { legacy_max_seq: maxSeq, legacy_count: 2 },
    ])
    expect(
      db.prepare('SELECT chain_seq, chain_prev, chain_hash, chain_hmac FROM privileged_operations ORDER BY seq').all(),
    ).toEqual([
      { chain_seq: null, chain_prev: null, chain_hash: null, chain_hmac: null },
      { chain_seq: null, chain_prev: null, chain_hash: null, chain_hmac: null },
    ])
  })

  it('refuses a database written by a newer schema', () => {
    const db = openDatabase(':memory:')
    open.push(db)
    db.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'now')").run()
    expect(() => runMigrations(db)).toThrow(/newer/)
  })

  it('surfaces a corrupt file as NexusError(database)', () => {
    const path = tempDb()
    openDatabase(path).close()
    writeFileSync(path, Buffer.alloc(4096, 0x41))
    try {
      openDatabase(path)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NexusError)
      expect((e as NexusError).code).toBe('database')
    }
  })

  it('surfaces an unopenable path as NexusError(database)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-db-'))
    dirs.push(dir)
    // A directory cannot be opened as a database file.
    expect(() => openDatabase(dir)).toThrow(NexusError)
  })

  it('keeps data across close and reopen of a file database', () => {
    const path = tempDb()
    const db1 = openDatabase(path)
    const repos1 = createRepositories(db1)
    const { run, t1 } = seed(repos1)
    repos1.tasks.update(t1.id, { state: 'running', attempt: 1 })
    repos1.events.insert({ runId: run.id, type: 'run.started', payload: {} })
    db1.close()

    const db2 = openDatabase(path)
    open.push(db2)
    const repos2 = createRepositories(db2)
    expect(repos2.runs.require(run.id).prompt).toBe('Add a settings page')
    expect(repos2.tasks.require(t1.id)).toMatchObject({ state: 'running', attempt: 1 })
    expect(repos2.events.listByRun(run.id)).toHaveLength(1)
  })
})

describe('constraints', () => {
  it('enforces foreign keys', () => {
    const { repos } = openMemory()
    expect(() => repos.runs.insert(makeRun('missing-project'))).toThrow(NexusError)
    try {
      repos.runs.insert(makeRun('missing-project'))
    } catch (e) {
      expect((e as NexusError).code).toBe('database')
    }
  })

  it('cascades deletes from project down to tasks, events and memory', () => {
    const { repos } = openMemory()
    const { project, run, t1 } = seed(repos)
    repos.events.insert({ runId: run.id, taskId: t1.id, type: 'task.ready', payload: {} })
    repos.projects.delete(project.id)
    expect(repos.runs.get(run.id)).toBeNull()
    expect(repos.tasks.get(t1.id)).toBeNull()
    expect(repos.events.listByRun(run.id)).toEqual([])
  })

  it('keeps a task key unique within a run but reusable across runs', () => {
    const { repos } = openMemory()
    const { project, run } = seed(repos)
    expect(() => repos.tasks.insert(makeTask(run.id, 'api'))).toThrow(NexusError)
    const other = repos.runs.insert(makeRun(project.id))
    expect(() => repos.tasks.insert(makeTask(other.id, 'api'))).not.toThrow()
  })

  it('compares project root paths case-insensitively', () => {
    const { repos } = openMemory()
    repos.projects.insert(makeProject({ rootPath: 'C:\\Repos\\App' }))
    expect(() => repos.projects.insert(makeProject({ rootPath: 'c:\\repos\\app' }))).toThrow(NexusError)
    expect(repos.projects.getByRootPath('c:\\REPOS\\app')).not.toBeNull()
  })

  it('rolls back every write in a failed transaction', () => {
    const { repos } = openMemory()
    const project = repos.projects.insert(makeProject())
    expect(() =>
      repos.transaction(() => {
        repos.runs.insert(makeRun(project.id))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(repos.runs.listByProject(project.id)).toEqual([])
  })

  it('does not allow a task to depend on itself', () => {
    const { repos } = openMemory()
    const { t1 } = seed(repos)
    expect(() => repos.dependencies.add(t1.id, t1.id)).toThrow(NexusError)
  })
})
