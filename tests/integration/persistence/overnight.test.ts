import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { newId, nowIso } from '@shared/ids'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT, type OvernightRun } from '@shared/overnight'
import { createRepositories, openDatabase, type Database } from '@main/modules/persistence'
import { runMigrations } from '@main/modules/persistence/database'
import { MIGRATIONS } from '@main/modules/persistence/migrations'
import { makeProject, makeRun, makeTask } from './fixtures'

const dirs: string[] = []
const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-overnight-db-'))
  dirs.push(dir)
  return join(dir, 'nexus.db')
}

function overnightRecord(runId: string, projectId: string, over: Partial<OvernightRun> = {}): OvernightRun {
  const now = nowIso()
  return {
    id: runId,
    runId,
    projectId,
    state: 'RUNNING',
    policy: DEFAULT_OVERNIGHT_POLICY,
    authorization: { runId, authorizedAt: now, confirmation: OVERNIGHT_CONFIRMATION_TEXT, policy: DEFAULT_OVERNIGHT_POLICY },
    startedAt: now,
    deadlineAt: now,
    failsafe: null,
    terminalReason: null,
    terminalDetail: null,
    finalReport: null,
    reportPath: null,
    reportSavedAt: null,
    powerAction: null,
    quota: null,
    watchdog: [],
    amendments: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...over,
  }
}

describe('migration 003 (overnight) on a 0.2.0 database', () => {
  it('upgrades a populated schema-2 database in place and keeps every existing row', () => {
    const path = tempDb()
    // A database exactly as 0.2.0 leaves it: migrations 1 and 2 only, with data.
    const old = new BetterSqlite3(path)
    old.pragma('journal_mode = WAL')
    old.pragma('foreign_keys = ON')
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 2))
    expect(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 2 })
    const seeded = createRepositories(old)
    const project = seeded.projects.insert(makeProject())
    const run = seeded.runs.insert(makeRun(project.id, { state: 'completed', prompt: 'A 0.2.0 mission' }))
    const task = seeded.tasks.insert(makeTask(run.id, 'api'))
    seeded.graphRevisions.insert({ id: newId(), runId: run.id, version: 1, reason: 'Approved plan', proposalId: null, snapshot: { tasks: [], dependencies: [] }, createdAt: nowIso() })
    seeded.settings.setValue(`run-active:${run.id}`, { usedMs: 1234, since: null })
    old.close()

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'v0-2' },
      { version: 3, name: 'overnight' },
      { version: 4, name: 'v0-3' },
    ])
    const repos = createRepositories(db)
    expect(repos.runs.require(run.id)).toMatchObject({ prompt: 'A 0.2.0 mission', state: 'completed' })
    expect(repos.tasks.require(task.id).key).toBe('api')
    expect(repos.graphRevisions.listByRun(run.id)).toHaveLength(1)
    expect(repos.settings.getValue(`run-active:${run.id}`)).toEqual({ usedMs: 1234, since: null })
    // A run from before 0.2.1 is simply not an overnight run.
    expect(repos.overnight.getByRun(run.id)).toBeNull()
    expect(repos.overnight.listLive()).toEqual([])
    expect(repos.checkpoints.listByRun(run.id)).toEqual([])

    // The new tables work against the old rows.
    repos.overnight.insert(overnightRecord(run.id, project.id))
    expect(repos.overnight.getByRun(run.id)?.authorization.confirmation).toBe(OVERNIGHT_CONFIRMATION_TEXT)
    db.close()

    // Reopening changes nothing.
    const again = openDatabase(path)
    open.push(again)
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 4 })
    expect(createRepositories(again).overnight.getByRun(run.id)?.state).toBe('RUNNING')
  })

  it('does not alter any table of the earlier schemas', () => {
    const before = new BetterSqlite3(':memory:')
    runMigrations(before, MIGRATIONS.filter((m) => m.version <= 2))
    // Schema 3 exactly: later migrations have their own tests.
    const after = new BetterSqlite3(':memory:')
    runMigrations(after, MIGRATIONS.filter((m) => m.version <= 3))
    open.push(before, after)
    const ddl = (db: Database): Map<string, string> =>
      new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]))
    const upgraded = ddl(after)
    for (const [name, sql] of ddl(before)) expect(upgraded.get(name), name).toBe(sql)
    expect([...upgraded.keys()].filter((name) => !ddl(before).has(name)).sort()).toEqual([
      'idx_overnight_runs_state',
      'idx_power_audit_run',
      'idx_run_checkpoints_run',
      'overnight_runs',
      'power_audit',
      'run_checkpoints',
    ])
  })
})

describe('overnight repositories', () => {
  function setup(): { repos: ReturnType<typeof createRepositories>; runId: string; projectId: string } {
    const db = openDatabase(':memory:')
    open.push(db)
    const repos = createRepositories(db)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    return { repos, runId: run.id, projectId: project.id }
  }

  it('round-trips the record with its JSON fields and allows one record per run', () => {
    const { repos, runId, projectId } = setup()
    const record = overnightRecord(runId, projectId, {
      failsafe: { scheduledAt: nowIso(), deadline: nowIso(), result: { ok: true, exitCode: 0, output: '', executable: 'shutdown.exe', args: ['/s', '/t', '32400'], at: nowIso() }, cancelledAt: null, cancelResult: null, lostAt: null },
      watchdog: [{ at: nowIso(), stage: 'stalled', detail: 'd', lastEventAt: null, runState: 'executing', tasks: { running: 1 }, activeAgents: 1, pendingApprovals: 0 }],
      amendments: [{ at: nowIso(), by: 'user', change: 'end action SHUTDOWN -> NONE' }],
    })
    repos.overnight.insert(record)
    expect(repos.overnight.getByRun(runId)).toEqual(record)
    expect(() => repos.overnight.insert({ ...record, id: newId() })).toThrow()
  })

  it('listLive returns only the states the supervisor still owns', () => {
    const { repos, runId, projectId } = setup()
    repos.overnight.insert(overnightRecord(runId, projectId))
    for (const state of ['ARMING', 'RUNNING', 'QUOTA_PAUSED', 'FINALIZING', 'POWER_ACTION_SCHEDULED', 'CANCELLING'] as const) {
      repos.overnight.update(runId, { state })
      expect(repos.overnight.listLive().map((r) => r.runId), state).toEqual([runId])
    }
    for (const state of ['DONE', 'FINALIZATION_FAILED', 'POWER_ACTION_FAILED', 'IDLE'] as const) {
      repos.overnight.update(runId, { state })
      expect(repos.overnight.listLive(), state).toEqual([])
    }
  })

  it('removing the run removes its overnight record and checkpoints; the power audit log is kept', () => {
    const { repos, runId, projectId } = setup()
    repos.overnight.insert(overnightRecord(runId, projectId))
    repos.checkpoints.insert({ id: newId(), runId, reason: 'planning', snapshot: { runState: 'executing', graphVersion: 1, integrationBranch: null, tasks: [], worktrees: [], sessions: [], messages: 0, decisions: 0, lastChecks: [] }, createdAt: nowIso() })
    repos.powerAudit.insert({ id: newId(), runId, operation: 'arm_failsafe', action: 'SHUTDOWN', detail: 'Failsafe after 540 minutes', result: null, createdAt: nowIso() })
    repos.projects.delete(projectId)
    expect(repos.overnight.getByRun(runId)).toBeNull()
    expect(repos.checkpoints.listByRun(runId)).toEqual([])
    // What was asked of Windows stays on record even when the project is gone.
    expect(repos.powerAudit.listByRun(runId)).toHaveLength(1)
  })

  it('prunes checkpoints to the newest ones', () => {
    const { repos, runId } = setup()
    for (let i = 0; i < 12; i++) {
      repos.checkpoints.insert({ id: newId(), runId, reason: `r${i}`, snapshot: { runState: 'executing', graphVersion: 1, integrationBranch: null, tasks: [], worktrees: [], sessions: [], messages: 0, decisions: 0, lastChecks: [] }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
    }
    repos.checkpoints.prune(runId, 5)
    expect(repos.checkpoints.listByRun(runId).map((c) => c.reason)).toEqual(['r7', 'r8', 'r9', 'r10', 'r11'])
    expect(repos.checkpoints.latest(runId)?.reason).toBe('r11')
  })
})
