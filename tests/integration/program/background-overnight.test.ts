import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { ipcInputs } from '@shared/ipc'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT, type OvernightPolicy, type OvernightRun } from '@shared/overnight'
import { PROGRAM_POLICY_PRESETS } from '@shared/program'
import { OvernightSupervisor, ProgramWorkload, type OvernightOrchestrator } from '@main/modules/overnight'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { runMigrations } from '@main/modules/persistence/database'
import { MIGRATIONS } from '@main/modules/persistence/migrations'
import { FakePowerController } from '@main/modules/power'
import { BackgroundEngineering } from '@main/modules/program'
import { makeProject, makeRun } from '../persistence/fixtures'
import { judgmentJson, makeProgramRig, milestone, planJson, sleep, type ProgramRig } from './harness'

const findings = (proposals: unknown[]): string => `\`\`\`json\n${JSON.stringify({ summary: 'Looked at the tests.', proposals })}\n\`\`\``
const proposal = (title: string): unknown => ({ title, description: 'd', category: 'test_gap', severity: 'medium', evidence: 'src/parse.js:10 legacyParse has no test', complexity: 'small', dependencies: [], recommendedMilestone: null })

describe('background engineering', () => {
  let rig: ProgramRig
  let background: BackgroundEngineering
  afterEach(async () => {
    background?.dispose()
    await rig.cleanup()
  })
  const make = (): BackgroundEngineering => {
    background = new BackgroundEngineering({ repos: rig.repos, bus: rig.bus, host: rig.host, addBacklog: (...args) => rig.engine.addBacklog(...args), repositoryFacts: (id) => rig.engine.repositoryFacts(id) })
    return background
  }
  const untilJob = async (jobId: string, states: string[]): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!states.includes(rig.repos.backgroundJobs.require(jobId).state)) {
      if (Date.now() > deadline) throw new Error(`job is ${rig.repos.backgroundJobs.require(jobId).state}`)
      await sleep(15)
    }
  }

  it('is off by default and refuses to start; only enabled kinds run', async () => {
    rig = makeProgramRig()
    make()
    expect(background.settings()).toEqual({ enabled: false, kinds: [] })
    await expect(background.start(rig.project.id, 'test_gap_analysis')).rejects.toThrow(/switched off/)
    background.setSettings({ enabled: true, kinds: ['dependency_audit'] })
    await expect(background.start(rig.project.id, 'test_gap_analysis')).rejects.toThrow(/not enabled/)
    expect(rig.host.created).toHaveLength(0)
    expect(() => background.setSettings({ enabled: true, kinds: ['format_disk'] } as never)).toThrow()
  })

  it('a job is a read-only run whose only output is backlog proposals', async () => {
    rig = makeProgramRig()
    make()
    const head = rig.head()
    background.setSettings({ enabled: true, kinds: ['test_gap_analysis'] })
    rig.host.answers.background = [findings([proposal('legacyParse has no test'), proposal('Error path of parse is untested')])]
    const job = await background.start(rig.project.id, 'test_gap_analysis')
    expect(job.state).toBe('running')
    // Read-only by construction: an `ask` run on the eco preset, with nothing to merge.
    const created = rig.host.created[0]!
    expect(created.input).toMatchObject({ mode: 'ask', preset: 'eco' })
    expect(created.input.prompt).toContain('PROPOSALS')
    await untilJob(job.id, ['completed'])
    expect(rig.repos.backgroundJobs.require(job.id)).toMatchObject({ state: 'completed', proposals: 2, summary: 'Looked at the tests.' })
    const items = rig.repos.backlog.list({ projectId: rig.project.id })
    expect(items.map((i) => [i.status, i.programId, i.provenance.source, i.provenance.jobId])).toEqual([
      ['proposed', null, 'background_job', job.id],
      ['proposed', null, 'background_job', job.id],
    ])
    // Nothing was changed and nothing became work: no mission run, no branch, the checkout as it was.
    expect(rig.host.created.filter((c) => c.kind === 'mission')).toHaveLength(0)
    expect(rig.head()).toBe(head)
    expect(rig.repos.runs.require(created.run.id).integrationBranch).toBeNull()

    // The same finding proposed again is not stored twice.
    rig.host.answers.background = [findings([proposal('legacyParse has no test')])]
    const again = await background.start(rig.project.id, 'test_gap_analysis')
    await untilJob(again.id, ['completed'])
    expect(rig.repos.backgroundJobs.require(again.id).proposals).toBe(0)
    expect(rig.repos.backlog.list({ projectId: rig.project.id })).toHaveLength(2)
  })

  it('an answer that is not findings fails the job and stores nothing; one job of a kind at a time; cancel; recover', async () => {
    rig = makeProgramRig()
    make()
    background.setSettings({ enabled: true, kinds: ['dead_code_analysis', 'architecture_audit'] })
    rig.host.answers.background = ['I deleted the unused files for you.']
    const bad = await background.start(rig.project.id, 'dead_code_analysis')
    await untilJob(bad.id, ['failed'])
    expect(rig.repos.backgroundJobs.require(bad.id).error).toContain('did not return a JSON object')
    expect(rig.repos.backlog.list({ projectId: rig.project.id })).toHaveLength(0)

    rig.host.ask = () => 'hang'
    const running = await background.start(rig.project.id, 'architecture_audit')
    await expect(background.start(rig.project.id, 'architecture_audit')).rejects.toThrow(/already running/)
    const cancelled = await background.cancel(running.id)
    expect(cancelled.state).toBe('cancelled')
    expect(rig.host.cancelled).toContain(running.runId)

    // A job whose run ended while NEXUS was closed is settled at the next start.
    const pending = await background.start(rig.project.id, 'architecture_audit')
    background.dispose()
    rig.host.answers.background = [findings([proposal('Cyclic import between a and b')])]
    rig.host.answer(pending.runId!)
    expect(rig.repos.backgroundJobs.require(pending.id).state).toBe('running')
    make().recover()
    expect(rig.repos.backgroundJobs.require(pending.id)).toMatchObject({ state: 'completed', proposals: 1 })
  })
})

describe('a program under the overnight supervisor (work window with a power action)', () => {
  let rig: ProgramRig
  let supervisor: OvernightSupervisor
  let power: FakePowerController
  afterEach(async () => {
    supervisor?.dispose()
    await rig.cleanup()
  })

  const attach = (): void => {
    power = new FakePowerController({ now: rig.now })
    const orchestrator = new Proxy({}, { get: (_t, prop) => (prop === 'pauseRun' ? async (id: string) => rig.host.pauseRun(id) : async () => undefined) }) as unknown as OvernightOrchestrator
    supervisor = new OvernightSupervisor({
      repos: rig.repos,
      bus: rig.bus,
      orchestrator,
      power,
      git: rig.git,
      push: () => undefined,
      flush: () => undefined,
      reportsDir: join(rig.root, 'reports'),
      now: rig.now,
      bootTime: () => 0,
      tickIntervalMs: 0,
      stopTimeoutMs: 5000,
      sealer: { sign: (payload) => createHmac('sha256', 'program-key').update(payload).digest('base64') },
    })
    supervisor.registerWorkload('program', (id) => new ProgramWorkload(id, { host: rig.engine, get: (pid) => rig.repos.programs.get(pid), quotaResetsAt: () => null }))
  }
  const policy = (over: Partial<OvernightPolicy> = {}): OvernightPolicy => ({ ...DEFAULT_OVERNIGHT_POLICY, forceCloseApplications: true, ...over })
  const start = (programId: string, over: Partial<OvernightPolicy> = {}): Promise<unknown> => supervisor.startProgram({ programId, policy: policy(over), confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
  const waitFor = async (id: string, states: OvernightRun['state'][]): Promise<OvernightRun> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      await supervisor.idle()
      await rig.engine.idle()
      const record = rig.repos.overnight.require(id)
      if (states.includes(record.state)) return record
      if (Date.now() > deadline) throw new Error(`overnight is ${record.state}; program ${rig.get(id).state}; ${record.error ?? ''}`)
      await rig.engine.tick()
      await supervisor.tick()
      await sleep(20)
    }
  }
  const operations = (): string[] => power.calls.map((c) => (c.request ? `${c.operation}:${c.request.purpose}` : c.operation))

  it('the window ends: dispatch stops, the mission is paused, the state is checkpointed and reported, then the power action', async () => {
    rig = makeProgramRig()
    attach()
    rig.host.answers.plan = [planJson([milestone('core'), milestone('api')])]
    rig.host.mission = (i) => (i === 0 ? 'complete' : 'hang')
    const program = await rig.program({ start: false })
    let armedBeforeStart: boolean | null = null
    const created = rig.host.createRun.bind(rig.host)
    rig.host.createRun = async (input) => {
      armedBeforeStart ??= power.calls.some((c) => c.request?.purpose === 'failsafe' && c.ok)
      return created(input)
    }
    await start(program.id, { maxDurationMinutes: 120, failsafeAfterMinutes: 150 })
    expect(armedBeforeStart).toBe(true)
    expect(rig.repos.overnight.require(program.id)).toMatchObject({ workloadType: 'program', runId: program.id, projectId: rig.project.id })
    await rig.until(() => rig.host.missionsOf().length === 2, 'the second mission')
    const run = rig.host.missionsOf()[1]!.run

    rig.advance(121 * 60_000)
    const record = await waitFor(program.id, ['POWER_ACTION_SCHEDULED'])
    expect(record.terminalReason).toBe('TIME_LIMIT')
    // The program is paused in a safe state, not ended: the first milestone stays accepted, the second resumes later.
    expect(rig.get(program.id)).toMatchObject({ state: 'PAUSED', pauseReason: 'user', resumeState: 'ACTIVE', currentRunId: run.id })
    expect(rig.repos.runs.require(run.id).state).toBe('paused')
    expect(rig.repos.milestones.getByKey(program.id, 'core')!.state).toBe('COMPLETED')
    expect(rig.repos.programCheckpoints.latest(program.id)).not.toBeNull()
    expect(record.finalReport).toContain('# NEXUS Overnight Program Window')
    expect(record.finalReport).toContain('`core` [COMPLETED]')
    expect(record.finalReport).toContain('not the end of the program')
    expect(record.reportPath && existsSync(record.reportPath)).toBe(true)
    expect(operations()).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
    expect(Date.parse(record.reportSavedAt!)).toBeLessThanOrEqual(Date.parse(record.powerAction!.scheduledAt))

    // The next window: the same program continues under a new authorization and completes.
    await supervisor.cancelPower(program.id)
    await start(program.id, { endAction: 'NONE' })
    expect(rig.get(program.id).state).toBe('ACTIVE')
    await rig.host.apply(run.id, 'complete')
    const second = await waitFor(program.id, ['DONE'])
    expect(second.terminalReason).toBe('SUCCESS')
    expect(rig.get(program.id).state).toBe('COMPLETED')
    expect(rig.host.missionsOf()).toHaveLength(2)
  })

  it('a program that needs a person ends the window as a blocker; a usage limit waits without moving the deadline', async () => {
    rig = makeProgramRig()
    attach()
    rig.host.answers.plan = [planJson([milestone('core')])]
    const needsApproval = await rig.program({ start: false, policy: { approvalPolicy: 'plan' } })
    await start(needsApproval.id, { shutdownOn: { ...DEFAULT_OVERNIGHT_POLICY.shutdownOn, blocker: false } })
    const blocked = await waitFor(needsApproval.id, ['DONE'])
    expect(blocked).toMatchObject({ terminalReason: 'BLOCKED', powerAction: null })
    expect(blocked.terminalDetail).toContain('waiting for approval')
    // The policy excluded blockers: nothing was scheduled and the failsafe did not stay behind.
    expect(operations()).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown'])

    rig.host.answers.plan = [planJson([milestone('solo')])]
    rig.host.answers.verify = [judgmentJson('accepted')]
    rig.host.mission = () => 'quota'
    const limited = await rig.program({ start: false })
    await start(limited.id)
    const paused = await waitFor(limited.id, ['QUOTA_PAUSED'])
    expect(rig.get(limited.id).state).toBe('WAITING_FOR_QUOTA')
    expect(paused.quota).toMatchObject({ waits: 1, resetsAt: null })
    const run = rig.host.missionsOf().at(-1)!.run
    await rig.host.resumeRun(run.id)
    const running = await waitFor(limited.id, ['RUNNING'])
    expect(running.deadlineAt).toBe(paused.deadlineAt)
    await rig.host.apply(run.id, 'complete')
    expect((await waitFor(limited.id, ['POWER_ACTION_SCHEDULED'])).terminalReason).toBe('SUCCESS')
  })

  it('needs the authorization, one workload at a time, and the channel accepts nothing else', async () => {
    rig = makeProgramRig()
    attach()
    rig.host.answers.plan = [planJson([milestone('core')])]
    rig.host.mission = () => 'hang'
    const program = await rig.program({ start: false })
    await expect(supervisor.startProgram({ programId: program.id, policy: policy(), confirmed: false, confirmation: OVERNIGHT_CONFIRMATION_TEXT })).rejects.toThrow(/authorization/)
    expect(rig.get(program.id).state).toBe('DRAFT')
    await start(program.id)
    const other = await rig.program({ start: false })
    await expect(start(other.id)).rejects.toThrow(/already active/)
    const status = await supervisor.cancelMission(program.id)
    expect(status.terminalReason).toBe('USER_CANCELLED')
    expect(rig.get(program.id).state).toBe('CANCELLED')
    await expect(start(program.id)).rejects.toThrow(/cannot run overnight/)

    const valid = { programId: 'p', policy: DEFAULT_OVERNIGHT_POLICY, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT }
    const schema = ipcInputs['overnight.startProgram']
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, command: 'shutdown /s' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, confirmed: false }).success).toBe(false)
    expect(ipcInputs['program.create'].safeParse({ projectId: 'p', name: 'n', goal: 'g', preset: 'autonomous', policy: { ...PROGRAM_POLICY_PRESETS.autonomous, endAction: 'SHUTDOWN' } }).success).toBe(false)
    expect(ipcInputs['program.create'].safeParse({ projectId: 'p', name: 'n', goal: 'g', preset: 'reckless' }).success).toBe(false)
  })
})

describe('migration 006 (programs)', () => {
  it('is additive: a schema-5 database keeps every row and gains the program tables', () => {
    const old = new BetterSqlite3(':memory:')
    old.pragma('foreign_keys = ON')
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 5))
    const before = createRepositories(old)
    const project = before.projects.insert(makeProject())
    const run = before.runs.insert(makeRun(project.id, { state: 'completed', prompt: 'A 0.3 mission' }))
    const ddl = (db: BetterSqlite3.Database): Map<string, string> => new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]))
    const earlier = ddl(old)
    // Migration 006 on its own: later migrations have their own tests.
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 6))
    const after = ddl(old)
    for (const [name, sql] of earlier) expect(after.get(name), name).toBe(sql)
    const added = [...after.keys()].filter((name) => !earlier.has(name) && !name.startsWith('idx_') && !name.startsWith('sqlite_autoindex'))
    expect(added.sort()).toEqual(['background_jobs', 'backlog_items', 'expertise_profiles', 'program_checkpoints', 'program_decisions', 'program_memory', 'program_milestones', 'program_missions', 'program_plan_revisions', 'program_workstreams', 'programs'])
    const repos = createRepositories(old)
    expect(repos.runs.require(run.id).prompt).toBe('A 0.3 mission')
    expect(repos.programs.list()).toEqual([])
    expect(repos.backlog.list({ projectId: project.id })).toEqual([])
    // Removing a project removes its programs and their rows.
    const db = openDatabase(':memory:')
    const fresh = createRepositories(db)
    const p = fresh.projects.insert(makeProject())
    const at = new Date().toISOString()
    fresh.programs.insert({ id: 'pg', projectId: p.id, name: 'n', goal: { statement: 'g', successCriteria: [], constraints: [], risks: [] }, state: 'DRAFT', resumeState: null, pauseReason: null, blockedReason: null, policy: PROGRAM_POLICY_PRESETS.balanced, schedule: null, planVersion: 0, branch: null, baseCommit: null, currentMilestoneId: null, currentRunId: null, currentRunKind: null, activeMs: 0, activeSince: null, quotaWaitSince: null, missions: 0, replans: 0, outcome: null, error: null, createdAt: at, startedAt: null, updatedAt: at, finishedAt: null })
    fresh.programDecisions.insert({ id: 'd', programId: 'pg', kind: 'created', summary: 's', milestoneId: null, runId: null, detail: null, createdAt: at })
    expect(fresh.programs.require('pg').policy).toEqual(PROGRAM_POLICY_PRESETS.balanced)
    fresh.projects.delete(p.id)
    expect(fresh.programs.get('pg')).toBeNull()
    expect(fresh.programDecisions.listByProgram('pg')).toEqual([])
    db.close()
    old.close()
  })
})
