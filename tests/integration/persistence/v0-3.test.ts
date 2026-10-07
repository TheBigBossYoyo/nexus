import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import {
  ARENA_BUDGET_DEFAULTS,
  DEFAULT_POLICY_CONFIG,
  type ArenaCampaign,
  type ArenaTrial,
  type ArenaTrialMetrics,
  type MissionOutcome,
  type PolicySnapshot,
  type QuotaPause,
  type UsageEvent,
} from '@shared/v3'
import { MIGRATIONS, createRepositories, openDatabase, runMigrations, type Database, type Repositories } from '@main/modules/persistence'
import { makeProject, makeRun, makeTask, openMemory } from './fixtures'

const open: { close(): unknown }[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-v03-'))
  dirs.push(dir)
  return join(dir, 'nexus.db')
}

/** A database as an earlier release leaves it: migrations up to `version`, with a finished run in it. */
function createOldDatabase(path: string, version: number): { projectId: string; runId: string; taskId: string } {
  const old = new BetterSqlite3(path)
  old.pragma('journal_mode = WAL')
  old.pragma('foreign_keys = ON')
  runMigrations(old, MIGRATIONS.filter((m) => m.version <= version))
  const repos = createRepositories(old)
  const project = repos.projects.insert(makeProject())
  const run = repos.runs.insert(makeRun(project.id, { state: 'completed', prompt: `A schema-${version} mission` }))
  const task = repos.tasks.insert(makeTask(run.id, 'api'))
  repos.settings.setValue(`run-active:${run.id}`, { usedMs: 4321, since: null })
  old.close()
  return { projectId: project.id, runId: run.id, taskId: task.id }
}

const ddl = (db: Database): Map<string, string> =>
  new Map(
    (db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((r) => [
      r.name,
      r.sql,
    ]),
  )

const V3_TABLES = [
  'arena_campaigns',
  'arena_case_versions',
  'arena_cases',
  'arena_evaluations',
  'arena_trial_metrics',
  'arena_trials',
  'candidate_results',
  'mission_outcomes',
  'policy_candidates',
  'policy_decisions',
  'policy_promotions',
  'policy_snapshots',
  'quota_pauses',
  'quota_resumes',
  'speculative_runs',
  'strategy_statistics',
  'task_profiles',
  'tournament_decisions',
  'usage_events',
  'usage_windows',
]

function usageEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  const createdAt = over.createdAt ?? nowIso()
  return {
    id: newId(),
    createdAt,
    eventType: 'session',
    projectId: null,
    runId: null,
    taskId: null,
    agentId: null,
    sdkSessionId: null,
    role: 'worker',
    model: 'sonnet',
    strategy: 'BUILD',
    arenaCampaignId: null,
    day: createdAt.slice(0, 10),
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 5,
    durationMs: 60_000,
    costUsd: null,
    availability: 'AVAILABLE',
    limitType: null,
    utilization: null,
    utilizationUnit: null,
    resetAt: null,
    retryAfterMs: null,
    source: 'SDK_EVENT',
    confidence: 'OBSERVED',
    rawClassification: null,
    ...over,
  }
}

function campaign(over: Partial<ArenaCampaign> = {}): ArenaCampaign {
  return {
    id: newId(),
    name: 'campaign',
    state: 'draft',
    pauseReason: null,
    caseVersionIds: [],
    strategies: ['SINGLE', 'BUILD'],
    repetitions: 1,
    modelPreset: 'balanced',
    budgets: { preset: 'eco', ...ARENA_BUDGET_DEFAULTS.eco },
    overnight: false,
    policySnapshotId: null,
    nexusVersion: '0.3.0',
    environment: { platform: 'win32', osRelease: '10', nodeVersion: '24', sdkVersion: null, gitVersion: null, modelTiers: {} },
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    ...over,
  }
}

function trial(campaignId: string, over: Partial<ArenaTrial> = {}): ArenaTrial {
  return {
    id: newId(),
    campaignId,
    caseId: 'case-a',
    caseVersionId: 'case-a@1',
    strategy: 'BUILD',
    repetition: 1,
    ordinal: 0,
    state: 'queued',
    projectId: null,
    runId: null,
    repoPath: null,
    baselineCommit: null,
    resultCommit: null,
    policySnapshotId: null,
    taskProfileId: null,
    models: {},
    detail: null,
    blockKind: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

describe('migration 004 (v0.3)', () => {
  it.each([
    [1, '0.1'],
    [2, '0.2.0'],
    [3, '0.2.1'],
  ])('upgrades a populated schema-%i (%s) database in place and keeps every existing row', (version) => {
    const path = tempDb()
    const seeded = createOldDatabase(path, version)

    const db = openDatabase(path)
    open.push(db)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 13 })
    const repos = createRepositories(db)
    expect(repos.runs.require(seeded.runId)).toMatchObject({ state: 'completed', prompt: `A schema-${version} mission` })
    expect(repos.tasks.listByRun(seeded.runId).map((t) => t.key)).toEqual(['api'])
    expect(repos.projects.list().map((p) => p.id)).toEqual([seeded.projectId])
    expect(repos.settings.getValue(`run-active:${seeded.runId}`)).toEqual({ usedMs: 4321, since: null })
    // An old run has no strategy; the new tables are empty and usable.
    expect(repos.runs.require(seeded.runId).config.strategy).toBeUndefined()
    expect(repos.usageEvents.count()).toBe(0)
    expect(repos.quotaPauses.listLive()).toEqual([])
    expect(repos.arenaCampaigns.list()).toEqual([])
    expect(repos.policySnapshots.list()).toEqual([])
    expect(repos.missionOutcomes.getByRun(seeded.runId)).toBeNull()

    // Idempotent on reopen.
    db.close()
    open.pop()
    const again = openDatabase(path)
    open.push(again)
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 13 })

    // The database as the older release left it was kept next to the upgraded one, complete and readable.
    const backup = `${path}.v${version}.bak`
    expect(existsSync(backup)).toBe(true)
    const old = new BetterSqlite3(backup, { readonly: true })
    open.push(old)
    expect(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: version })
    expect(old.prepare('SELECT prompt FROM runs WHERE id = ?').get(seeded.runId)).toEqual({ prompt: `A schema-${version} mission` })
  })

  it('makes no backup for a new database or one that is already current', () => {
    const path = tempDb()
    const db = openDatabase(path)
    db.close()
    const again = openDatabase(path)
    open.push(again)
    for (const v of [0, 1, 2, 3, 4, 5, 6, 7]) expect(existsSync(`${path}.v${v}.bak`)).toBe(false)
  })

  it('does not alter any table or index of the earlier schemas and adds exactly the 0.3 tables', () => {
    const before = new BetterSqlite3(':memory:')
    runMigrations(before, MIGRATIONS.filter((m) => m.version <= 3))
    // Migration 004 on its own: migration 005 rebuilds overnight_runs and has its own test.
    const after = new BetterSqlite3(':memory:')
    runMigrations(after, MIGRATIONS.filter((m) => m.version <= 4))
    open.push(before, after)
    const upgraded = ddl(after)
    for (const [name, sql] of ddl(before)) expect(upgraded.get(name), name).toBe(sql)
    const added = [...upgraded.keys()].filter((name) => !ddl(before).has(name))
    expect(added.filter((name) => !name.startsWith('idx_')).sort()).toEqual(V3_TABLES)
  })

  it('rolls back completely when a later migration fails, leaving a 0.2.1 database at schema 3', () => {
    const path = tempDb()
    const seeded = createOldDatabase(path, 3)
    const raw = new BetterSqlite3(path)
    expect(() => runMigrations(raw, [...MIGRATIONS, { version: 14, name: 'broken', sql: 'SELECT * FROM no_such_table_anywhere;' }])).toThrow(NexusError)
    expect(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 3 })
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'usage_events'").get()).toEqual({ n: 0 })
    expect(createRepositories(raw).runs.require(seeded.runId).prompt).toBe('A schema-3 mission')
    raw.close()
  })
})

describe('v0.3 repositories', () => {
  let repos: Repositories
  let db: Database
  const setup = (): void => {
    ;({ db, repos } = openMemory())
    open.push(db)
  }

  it('aggregates observed usage in SQL by run, model, strategy and day, and counts only sessions as usage', () => {
    setup()
    repos.usageEvents.insert(usageEvent({ runId: 'r1', model: 'sonnet', strategy: 'BUILD', createdAt: '2026-10-01T10:00:00.000Z' }))
    repos.usageEvents.insert(usageEvent({ runId: 'r1', model: 'opus', strategy: 'BUILD', inputTokens: 5000, outputTokens: 900, createdAt: '2026-10-01T11:00:00.000Z' }))
    repos.usageEvents.insert(usageEvent({ runId: 'r2', model: 'sonnet', strategy: 'SWARM', createdAt: '2026-10-02T10:00:00.000Z' }))
    // A limit event carries no tokens and is not a session.
    repos.usageEvents.insert(
      usageEvent({ runId: 'r2', eventType: 'limit_rejected', inputTokens: null, outputTokens: null, turns: null, durationMs: null, availability: 'QUOTA_EXHAUSTED', createdAt: '2026-10-02T10:05:00.000Z' }),
    )

    expect(repos.usageEvents.totals()).toMatchObject({ sessions: 3, inputTokens: 7000, outputTokens: 1300, turns: 15, limitEvents: 1 })
    expect(repos.usageEvents.totals({ runId: 'r1' })).toMatchObject({ sessions: 2, inputTokens: 6000, limitEvents: 0 })
    expect(repos.usageEvents.totals({ since: '2026-10-02T00:00:00.000Z' })).toMatchObject({ sessions: 1, limitEvents: 1 })
    expect(repos.usageEvents.totals({ runId: 'nobody' })).toMatchObject({ sessions: 0, inputTokens: 0, limitEvents: 0 })

    expect(repos.usageEvents.breakdown('model').map((r) => [r.key, r.sessions, r.inputTokens])).toEqual([
      ['opus', 1, 5000],
      ['sonnet', 2, 2000],
    ])
    expect(repos.usageEvents.breakdown('strategy').map((r) => [r.key, r.sessions])).toEqual([
      ['BUILD', 2],
      ['SWARM', 1],
    ])
    expect(repos.usageEvents.breakdown('day').map((r) => [r.key, r.sessions, r.limitEvents])).toEqual([
      ['2026-10-02', 1, 1],
      ['2026-10-01', 2, 0],
    ])
    expect(repos.usageEvents.listLimitEvents().map((e) => e.eventType)).toEqual(['limit_rejected'])
    expect(repos.usageEvents.latestOfType('limit_rejected')?.runId).toBe('r2')
  })

  it('uses an index for the usage aggregations (large histories are never scanned whole)', () => {
    setup()
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan("SELECT COUNT(*) FROM usage_events WHERE run_id = 'r'")).toContain('idx_usage_events_run')
    expect(plan("SELECT * FROM usage_events WHERE created_at >= '2026' ORDER BY created_at")).toContain('idx_usage_events_created')
    expect(plan("SELECT * FROM arena_trials WHERE campaign_id = 'c' ORDER BY ordinal")).toContain('idx_arena_trials_campaign')
    expect(plan("SELECT * FROM mission_outcomes WHERE context_key = 'k' AND strategy = 'BUILD'")).toContain('idx_mission_outcomes_context')
  })

  it('keeps one usage window per limit type', () => {
    setup()
    const base = { status: 'allowed' as const, utilizationPercent: 40, resetAt: null, source: 'RUNTIME' as const, confidence: 'EXACT' as const, observedAt: nowIso(), updatedAt: nowIso() }
    repos.usageWindows.upsert({ id: newId(), limitType: 'five_hour', ...base })
    repos.usageWindows.upsert({ id: newId(), limitType: 'five_hour', ...base, status: 'rejected', utilizationPercent: 100 })
    repos.usageWindows.upsert({ id: newId(), limitType: 'seven_day', ...base })
    expect(repos.usageWindows.list().map((w) => [w.limitType, w.status, w.utilizationPercent])).toEqual([
      ['five_hour', 'rejected', 100],
      ['seven_day', 'allowed', 40],
    ])
  })

  it('closes a quota wait exactly once', () => {
    setup()
    const now = nowIso()
    const pause: QuotaPause = {
      id: newId(),
      runId: 'r1',
      scope: 'run',
      state: 'waiting',
      pausedAt: now,
      limitType: 'five_hour',
      resetAt: null,
      resetConfidence: 'UNKNOWN',
      nextCheckAt: now,
      probes: 0,
      checkpointId: null,
      resumeState: 'executing',
      endedAt: null,
      endReason: null,
      createdAt: now,
      updatedAt: now,
    }
    repos.quotaPauses.insert(pause)
    repos.quotaPauses.insert({ ...pause, id: newId(), runId: null, scope: 'global' })
    expect(repos.quotaPauses.listLive()).toHaveLength(2)
    expect(repos.quotaPauses.liveGlobal()?.scope).toBe('global')
    expect(repos.quotaPauses.liveForRun('r1')?.id).toBe(pause.id)

    expect(repos.quotaPauses.close(pause.id, 'resumed', nowIso(), null)).toBe(true)
    // A second resume attempt claims nothing.
    expect(repos.quotaPauses.close(pause.id, 'resumed', nowIso(), null)).toBe(false)
    expect(repos.quotaPauses.close(pause.id, 'ended', nowIso(), 'late')).toBe(false)
    expect(repos.quotaPauses.require(pause.id)).toMatchObject({ state: 'resumed', endReason: null, nextCheckAt: null })
    expect(repos.quotaPauses.liveForRun('r1')).toBeNull()

    repos.quotaResumes.insert({ id: newId(), pauseId: pause.id, runId: 'r1', attemptedAt: now, kind: 'probe', result: 'available', method: 'usage_report', detail: null, waitedMs: 1000, createdAt: now })
    expect(repos.quotaResumes.listByPause(pause.id).map((r) => r.result)).toEqual(['available'])
    expect(repos.quotaResumes.listByPauses([pause.id, 'other'])).toHaveLength(1)
  })

  it('hides the project of an Arena trial from the project list and keeps trials in queue order', () => {
    setup()
    const mine = repos.projects.insert(makeProject({ rootPath: 'C:\\mine' }))
    const hidden = repos.projects.insert(makeProject({ rootPath: 'C:\\arena\\trial-1\\repo', name: 'arena trial' }))
    const c = repos.arenaCampaigns.insert(campaign())
    const second = repos.arenaTrials.insert(trial(c.id, { ordinal: 1, strategy: 'SINGLE' }))
    const first = repos.arenaTrials.insert(trial(c.id, { ordinal: 0, projectId: hidden.id, state: 'running', runId: 'run-1' }))

    expect(repos.projects.list().map((p) => p.id)).toEqual([mine.id])
    expect(repos.projects.listArena().map((p) => p.id)).toEqual([hidden.id])
    expect(repos.projects.isArena(hidden.id)).toBe(true)
    expect(repos.projects.isArena(mine.id)).toBe(false)

    expect(repos.arenaTrials.listByCampaign(c.id).map((t) => t.id)).toEqual([first.id, second.id])
    expect(repos.arenaTrials.getByRun('run-1')?.id).toBe(first.id)
    expect(repos.arenaTrials.countsByCampaign(c.id).sort((a, b) => a.state.localeCompare(b.state))).toEqual([
      { state: 'queued', n: 1 },
      { state: 'running', n: 1 },
    ])
    // The same case, strategy and repetition cannot be queued twice in one campaign.
    expect(() => repos.arenaTrials.insert(trial(c.id, { ordinal: 2, strategy: 'SINGLE' }))).toThrow(NexusError)
    // Deleting a campaign removes its trials.
    repos.arenaCampaigns.delete(c.id)
    expect(repos.arenaTrials.count()).toBe(0)
  })

  it('keeps the runs and events of Arena trials out of the user feeds in SQL, before the limit applies', () => {
    setup()
    const mine = repos.projects.insert(makeProject({ rootPath: 'C:/mine' }))
    const hidden = repos.projects.insert(makeProject({ rootPath: 'C:/arena/t/repo' }))
    const myRun = repos.runs.insert(makeRun(mine.id, { createdAt: '2026-01-01T00:00:00.000Z' }))
    repos.events.insert({ runId: myRun.id, type: 'run.started', payload: {} })
    const c = repos.arenaCampaigns.insert(campaign())
    // Far more trial runs than any feed limit, all newer than the user's run.
    for (let i = 0; i < 70; i++) {
      const run = repos.runs.insert(makeRun(hidden.id, { createdAt: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString() }))
      repos.arenaTrials.insert(trial(c.id, { ordinal: i, repetition: i, projectId: hidden.id, runId: run.id }))
      repos.events.insert({ runId: run.id, type: 'run.started', payload: {} })
    }
    expect(repos.runs.listRecent(60).some((r) => r.id === myRun.id)).toBe(false)
    expect(repos.runs.listRecentUser(60).map((r) => r.id)).toEqual([myRun.id])
    expect(repos.events.listRecent(50).map((e) => e.runId)).toEqual([myRun.id])
    // The newest finished trials are the ones kept when a window holds more than the limit.
    for (const t of repos.arenaTrials.listByCampaign(c.id)) {
      repos.arenaTrials.update(t.id, { state: 'passed', finishedAt: new Date(Date.UTC(2026, 5, 2, 0, t.ordinal)).toISOString() })
    }
    expect(repos.arenaTrials.listFinishedSince('2000-01-01T00:00:00.000Z', 3).map((t) => t.ordinal)).toEqual([67, 68, 69])
  })

  it('keeps one metrics row per trial and the newest evaluation', () => {
    setup()
    const c = repos.arenaCampaigns.insert(campaign())
    const t = repos.arenaTrials.insert(trial(c.id))
    const metrics = (over: Partial<ArenaTrialMetrics>): ArenaTrialMetrics => ({
      id: newId(),
      trialId: t.id,
      buildPassed: null,
      typecheckPassed: null,
      testsPassed: true,
      hiddenPassed: false,
      acceptanceTotal: null,
      acceptancePassed: null,
      verifierPassed: null,
      criticalFindings: 0,
      highFindings: 0,
      mediumFindings: 0,
      repairs: 0,
      wallClockMs: 1000,
      sessions: 3,
      turns: null,
      inputTokens: null,
      outputTokens: null,
      toolCalls: null,
      humanInterventions: 0,
      approvals: 0,
      manualRetries: 0,
      blockers: 0,
      crashedAgents: 0,
      recoveredSessions: 0,
      schedulerFailures: 0,
      unfinishedTasks: 0,
      quotaPauses: 0,
      quotaWaitMs: 0,
      autoResumeSuccesses: 0,
      throttleEvents: 0,
      createdAt: nowIso(),
      ...over,
    })
    repos.arenaMetrics.replaceForTrial(metrics({}))
    repos.arenaMetrics.replaceForTrial(metrics({ hiddenPassed: true, sessions: 4 }))
    expect(repos.arenaMetrics.listByCampaign(c.id)).toHaveLength(1)
    // Unmeasured values stay null rather than becoming zero or false.
    expect(repos.arenaMetrics.getByTrial(t.id)).toMatchObject({ hiddenPassed: true, sessions: 4, buildPassed: null, inputTokens: null })

    const evaluation = (score: number, createdAt: string) =>
      repos.arenaEvaluations.insert({
        id: newId(),
        trialId: t.id,
        kind: 'hidden',
        command: 'node --test',
        exitCode: score > 0 ? 0 : 1,
        timedOut: false,
        durationMs: 10,
        output: '',
        passed: score > 0,
        skippedReason: null,
        evaluatorHash: 'h',
        scoreVersion: 'score-v1',
        score,
        scoreBreakdown: { base: score },
        createdAt,
      })
    evaluation(0, '2026-10-01T00:00:00.000Z')
    evaluation(80, '2026-10-02T00:00:00.000Z')
    expect(repos.arenaEvaluations.latestForTrial(t.id)).toMatchObject({ score: 80, passed: true })
  })

  it('stores policy snapshots immutably and one mission outcome per run', () => {
    setup()
    const snapshot: PolicySnapshot = {
      id: newId(),
      version: 1,
      createdAt: nowIso(),
      origin: 'default',
      parentId: null,
      preferences: [],
      config: DEFAULT_POLICY_CONFIG,
      routing: { strongest: 'opus' },
      note: null,
    }
    repos.policySnapshots.insert(snapshot)
    expect(repos.policySnapshots.require(snapshot.id)).toEqual(snapshot)
    expect(repos.policySnapshots.latestVersion()).toBe(1)
    // There is no way to change a stored snapshot through the repository.
    expect('update' in repos.policySnapshots).toBe(false)
    expect('delete' in repos.policySnapshots).toBe(false)
    expect(() => repos.policySnapshots.insert({ ...snapshot, id: newId() })).toThrow(NexusError)

    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    const outcome = (over: Partial<MissionOutcome>): MissionOutcome => ({
      id: newId(),
      runId: run.id,
      projectId: project.id,
      taskProfileId: null,
      contextKey: 'bugfix|small|low',
      strategy: 'BUILD',
      requestedStrategy: 'ADAPTIVE',
      planningMode: 'single',
      reviewMode: 'auto',
      policyDecisionId: null,
      policySnapshotId: snapshot.id,
      models: { worker: 'sonnet' },
      agents: 3,
      sessions: 3,
      tasks: 2,
      tasksCompleted: 1,
      repairs: 0,
      reviews: 1,
      reviewRejections: 0,
      verificationPassed: null,
      elapsedMs: 1000,
      inputTokens: null,
      outputTokens: null,
      quotaPauses: 0,
      quotaWaitMs: 0,
      humanInterventions: 0,
      terminal: 'blocked',
      success: false,
      isArena: false,
      nexusVersion: '0.3.0',
      createdAt: nowIso(),
      ...over,
    })
    const first = repos.missionOutcomes.upsertForRun(outcome({}))
    const second = repos.missionOutcomes.upsertForRun(outcome({ terminal: 'completed', success: true, tasksCompleted: 2, verificationPassed: true }))
    expect(second.id).toBe(first.id)
    expect(repos.missionOutcomes.countMissions()).toBe(1)
    expect(repos.missionOutcomes.getByRun(run.id)).toMatchObject({ terminal: 'completed', success: true, tasksCompleted: 2, inputTokens: null })
    // Arena runs are not mission evidence.
    const arenaRun = repos.runs.insert(makeRun(project.id))
    repos.missionOutcomes.upsertForRun(outcome({ id: newId(), runId: arenaRun.id, isArena: true }))
    expect(repos.missionOutcomes.countMissions()).toBe(1)
    expect(repos.missionOutcomes.listMissionsSince('2000-01-01T00:00:00.000Z').map((o) => o.runId)).toEqual([run.id])
  })

  it('pages campaigns and trials instead of loading the whole history', () => {
    setup()
    for (let i = 0; i < 30; i++) repos.arenaCampaigns.insert(campaign({ name: `c${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }))
    expect(repos.arenaCampaigns.count()).toBe(30)
    expect(repos.arenaCampaigns.list({ limit: 10 }).map((c) => c.name)).toEqual(['c29', 'c28', 'c27', 'c26', 'c25', 'c24', 'c23', 'c22', 'c21', 'c20'])
    expect(repos.arenaCampaigns.list({ limit: 10, offset: 25 }).map((c) => c.name)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0'])
  })
})
