import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Run } from '@shared/domain'
import { DEFAULT_WORKSPACE_POLICY, type PlannedCrossRepoTask, type Workspace, type WorkspaceMission } from '@shared/workspace'
import { EventBus } from '@main/modules/events'
import { GitService } from '@main/modules/git'
import BetterSqlite3 from 'better-sqlite3'
import { createRepositories, MIGRATIONS, openDatabase, runMigrations, type Database, type Repositories } from '@main/modules/persistence'
import { ipcInputs } from '@shared/ipc'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT, type OvernightRun } from '@shared/overnight'
import { OvernightSupervisor, WorkspaceMissionWorkload, type OvernightOrchestrator } from '@main/modules/overnight'
import { FakePowerController } from '@main/modules/power'
import { isReasoningRun, WORKSPACE_PLANNER_MARKER } from '@shared/program'
import { WorkspaceEngine } from '@main/modules/workspace'
import { extractSurface, stripBlockComments } from '@main/modules/workspace/contracts'
import { makeProject } from '../persistence/fixtures'
import { FakeProgramHost, sleep } from '../program/harness'

/**
 * The workspace engine on three real Git repositories (a shared SDK that owns a contract, a backend and a
 * desktop app that each keep a copy of it) with a stand-in for the orchestrator.
 */
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const schema = (properties: Record<string, unknown>, required = ['id']): string => `${JSON.stringify({ title: 'Order', type: 'object', required, properties }, null, 2)}\n`
const V1 = schema({ id: { type: 'string' }, total: { type: 'number' } })
const V2_COMPATIBLE = schema({ id: { type: 'string' }, total: { type: 'number' }, currency: { type: 'string' } })
const V2_BREAKING = schema({ id: { type: 'string' }, amount: { type: 'number' } })

interface Rig {
  root: string
  db: Database
  repos: Repositories
  bus: EventBus
  host: FakeProgramHost
  engine: WorkspaceEngine
  paths: Record<'sdk' | 'backend' | 'desktop' | 'docs', string>
  gate: { open: boolean; set(open: boolean): void }
  workspace(): Promise<Workspace>
  until(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>
  untilState(missionId: string, states: WorkspaceMission['state'][]): Promise<WorkspaceMission>
  restart(): WorkspaceEngine
  cleanup(): Promise<void>
}

function makeRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'nexus-workspace-it-'))
  const repo = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name)
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { windowsHide: true })
    sh(dir, 'config', 'user.name', 'Test User')
    sh(dir, 'config', 'user.email', 'test@example.com')
    sh(dir, 'config', 'commit.gpgsign', 'false')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '-m', 'initial')
    return dir
  }
  const pkg = (name: string, version: string, dependencies: Record<string, string> = {}): string => `${JSON.stringify({ name, version, type: 'module', scripts: { test: 'node --test' }, dependencies }, null, 2)}\n`
  const sdk = repo('shared-sdk', { 'package.json': pkg('@acme/sdk', '2.2.9'), 'contracts/order.schema.json': V1 })
  const backend = repo('backend', { 'package.json': pkg('backend', '1.8.4', { '@acme/sdk': '^2.2.0' }), 'contracts/order.schema.json': V1 })
  const desktop = repo('desktop', { 'package.json': pkg('desktop', '0.7.3', { backend: `file:${backend.replace(/\\/g, '/')}` }), 'vendor/order.schema.json': V1 })
  const docs = repo('docs', { 'README.md': '# docs\n' })
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const git = new GitService()
  const host = new FakeProgramHost(repos, bus, git, sdk)
  const listeners = new Set<() => void>()
  const gate = {
    open: true,
    set(open: boolean) {
      gate.open = open
      for (const l of listeners) l()
    },
  }
  const projects = {
    open: async (path: string): Promise<Project> => {
      const existing = repos.projects.list().find((p) => p.rootPath === path)
      if (existing) return existing
      const base = makeProject({ name: path.split(/[\\/]/).pop() ?? 'repo', rootPath: path })
      // Each repository has its own stack: the docs repository has no check command at all.
      const profile = base.profile ? { ...base.profile, languages: path === docs ? ['Markdown'] : ['JavaScript'], frameworks: [], commands: path === docs ? { build: null, test: null, lint: null, typecheck: null } : { build: null, test: 'node --test', lint: null, typecheck: null } } : null
      return repos.projects.insert({ ...base, profile })
    },
  }
  const engines: WorkspaceEngine[] = []
  const build = (): WorkspaceEngine => {
    const engine = new WorkspaceEngine({ repos, bus, git, host, projects, usage: { canDispatch: () => gate.open, onChange: (l) => (listeners.add(l), () => void listeners.delete(l)) }, tickIntervalMs: 0 })
    engines.push(engine)
    return engine
  }
  const rig: Rig = {
    root,
    db,
    repos,
    bus,
    host,
    engine: build(),
    paths: { sdk, backend, desktop, docs },
    gate,
    async workspace() {
      const ws = rig.engine.createWorkspace({ name: 'Acme platform', description: 'SDK, backend and desktop' })
      await rig.engine.enroll(ws.id, { path: sdk, role: 'library' })
      await rig.engine.enroll(ws.id, { path: backend, role: 'service' })
      await rig.engine.enroll(ws.id, { path: desktop, role: 'application' })
      const contract = await rig.engine.registerContract(ws.id, { key: 'order', name: 'Order schema', kind: 'json_schema', provider: 'shared-sdk', path: 'contracts/order.schema.json' })
      rig.engine.addConsumer(contract.id, { repository: 'backend', copyPath: 'contracts/order.schema.json' })
      rig.engine.addConsumer(contract.id, { repository: 'desktop', copyPath: 'vendor/order.schema.json' })
      return repos.workspaces.require(ws.id)
    },
    async until(predicate, what, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await rig.engine.idle()
        if (predicate()) return
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
        await rig.engine.tick()
        await sleep(15)
      }
    },
    async untilState(missionId, states) {
      await rig.until(() => states.includes(repos.workspaceMissions.require(missionId).state), `mission state ${states.join('|')}`).catch((e: unknown) => {
        const m = repos.workspaceMissions.require(missionId)
        throw new Error(`${e instanceof Error ? e.message : String(e)}; mission is ${m.state} (${m.blockedReason ?? ''}); tasks ${repos.workspaceTasks.listByMission(missionId).map((t) => `${t.key}:${t.state}`).join(' ')}; decisions ${repos.workspaceDecisions.listByMission(missionId).map((d) => d.kind).join(' > ')}`)
      })
      return repos.workspaceMissions.require(missionId)
    },
    restart() {
      rig.engine.dispose()
      host.simulateRestart()
      rig.engine = build()
      return rig.engine
    },
    async cleanup() {
      for (const e of engines) e.dispose()
      await Promise.race([Promise.allSettled(engines.map((e) => e.idle())), sleep(2000)])
      db.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
  return rig
}

const task = (key: string, repository: string, over: Partial<PlannedCrossRepoTask> = {}): PlannedCrossRepoTask => ({ key, repository, title: `Task ${key}`, objective: `Change ${repository}.`, acceptanceCriteria: [`${key} done`], dependsOn: [], contracts: [], ...over })
const planJson = (tasks: PlannedCrossRepoTask[]): string => `\`\`\`json\n${JSON.stringify({ summary: 'Change the order contract and its users.', tasks, risks: [] })}\n\`\`\``
const CHAIN = [task('sdk', 'shared-sdk', { contracts: ['order'] }), task('api', 'backend', { dependsOn: ['sdk'], contracts: ['order'] }), task('ui', 'desktop', { dependsOn: ['api'], contracts: ['order'] })]

/** What a completing mission writes: the provider changes the contract, each consumer updates its copy. */
function writes(rig: Rig, content: string, options: { skip?: string[] } = {}): (run: Run, repoPath: string) => Record<string, string> {
  return (_run, repoPath): Record<string, string> => {
    if (repoPath === rig.paths.sdk) return { 'contracts/order.schema.json': content }
    if (repoPath === rig.paths.backend) return options.skip?.includes('backend') ? { 'src/api.js': 'export const api = 1\n' } : { 'contracts/order.schema.json': content, 'src/api.js': 'export const api = 1\n' }
    if (repoPath === rig.paths.desktop) return options.skip?.includes('desktop') ? { 'src/ui.js': 'export const ui = 1\n' } : { 'vendor/order.schema.json': content, 'src/ui.js': 'export const ui = 1\n' }
    return { 'note.txt': 'x\n' }
  }
}

describe('workspace engine', () => {
  let rig: Rig
  afterEach(async () => {
    await rig.cleanup()
  })

  it('onboarding: explicit enrollment, facts per repository, the organization graph with provenance', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    const detail = rig.engine.detail(ws.id)
    expect(detail.repositories.map((r) => [r.key, r.role, r.packageName, r.packageVersion, r.branch, r.manifest])).toEqual([
      ['shared-sdk', 'library', '@acme/sdk', '2.2.9', 'main', 'package.json'],
      ['backend', 'service', 'backend', '1.8.4', 'main', 'package.json'],
      ['desktop', 'application', 'desktop', '0.7.3', 'main', 'package.json'],
    ])
    // Enrolling makes a repository an allowed one; nothing else is.
    expect(detail.workspace.policy.allowedRepositories).toEqual(['shared-sdk', 'backend', 'desktop'])
    // Edges from the manifests and from the declared contract consumers, each with where it comes from.
    const byId = new Map(detail.repositories.map((r) => [r.id, r.key]))
    const edges = detail.dependencies.map((e) => [byId.get(e.fromRepositoryId), byId.get(e.toRepositoryId), e.kind, e.provenance.source])
    expect(edges).toEqual(
      expect.arrayContaining([
        ['backend', 'shared-sdk', 'package_dependency', 'manifest'],
        ['desktop', 'backend', 'package_dependency', 'manifest'],
        ['backend', 'shared-sdk', 'schema', 'contract'],
        ['desktop', 'shared-sdk', 'schema', 'contract'],
      ]),
    )
    expect(detail.dependencies.every((e) => e.provenance.detail.length > 0)).toBe(true)
    expect(detail.order).toEqual({ ok: true, order: ['shared-sdk', 'backend', 'desktop'], levels: [['shared-sdk'], ['backend'], ['desktop']] })

    // A different stack is not assumed: the docs repository has no manifest and no check command, and says so.
    const docs = await rig.engine.enroll(ws.id, { path: rig.paths.docs, role: 'documentation' })
    expect(docs).toMatchObject({ key: 'docs', packageName: null, packageVersion: null, manifest: null, languages: ['Markdown'], commands: { build: null, test: null } })
    expect(rig.engine.detail(ws.id).repositories.find((r) => r.key === 'docs')?.health).toMatchObject({ level: 'unknown' })

    await expect(rig.engine.enroll(ws.id, { path: rig.paths.docs })).rejects.toThrow(/already enrolled/)
    await expect(rig.engine.enroll(ws.id, { path: rig.root })).rejects.toThrow(/not a Git repository/)
    // A user-stated dependency needs a reason and cannot close a cycle.
    expect(() => rig.engine.addDependency(ws.id, { from: 'docs', to: 'desktop', kind: 'documentation', detail: '' })).toThrow(/what shows/)
    rig.engine.addDependency(ws.id, { from: 'docs', to: 'desktop', kind: 'documentation', detail: 'The docs describe the desktop app.' })
    expect(() => rig.engine.addDependency(ws.id, { from: 'shared-sdk', to: 'docs', kind: 'documentation', detail: 'x' })).toThrow(/cycle/)
    rig.engine.unenroll(docs.id)
    expect(rig.engine.detail(ws.id).workspace.policy.allowedRepositories).toEqual(['shared-sdk', 'backend', 'desktop'])
  })

  it('contracts: versions by content, compatibility against the one before, paths confined to the repository', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    const contract = rig.repos.workspaceContracts.getByKey(ws.id, 'order')!
    expect(rig.repos.contractVersions.listByContract(contract.id).map((v) => [v.version, v.surface.length, v.parseError])).toEqual([[1, 2, null]])
    // Nothing changed: no new version.
    expect((await rig.engine.captureContract(contract.id, null)).created).toBe(false)

    writeFileSync(join(rig.paths.sdk, 'contracts/order.schema.json'), V2_COMPATIBLE)
    sh(rig.paths.sdk, 'commit', '-qam', 'add currency')
    const compatible = await rig.engine.captureContract(contract.id, null)
    expect(compatible).toMatchObject({ created: true, version: { version: 2 }, result: { compatible: true, level: 'compatible' } })
    writeFileSync(join(rig.paths.sdk, 'contracts/order.schema.json'), V2_BREAKING)
    sh(rig.paths.sdk, 'commit', '-qam', 'rename total')
    const breaking = await rig.engine.captureContract(contract.id, null)
    expect(breaking.result).toMatchObject({ compatible: false, level: 'breaking' })
    expect(breaking.result.changes.map((c) => [c.path, c.change])).toEqual(expect.arrayContaining([['Order.total', 'removed'], ['Order.currency', 'removed'], ['Order.amount', 'added']]))
    // An earlier commit can be read too: versions are by content, so it is a fourth version.
    expect((await rig.engine.captureContract(contract.id, 'HEAD~2')).version.hash).toBe(rig.repos.contractVersions.listByContract(contract.id)[0]!.hash)

    for (const path of ['../backend/package.json', 'C:\\Windows\\win.ini', '/etc/passwd', '-rf', 'a/../../b']) {
      await expect(rig.engine.registerContract(ws.id, { key: 'bad', name: 'bad', kind: 'json_schema', provider: 'shared-sdk', path }), path).rejects.toThrow(/Not a path inside the repository/)
    }
    await expect(rig.engine.registerContract(ws.id, { key: 'missing', name: 'x', kind: 'json_schema', provider: 'shared-sdk', path: 'contracts/none.json' })).rejects.toThrow(/does not exist/)
    expect(() => rig.engine.addConsumer(contract.id, { repository: 'shared-sdk' })).toThrow(/provider/)
    expect(() => rig.engine.addConsumer(contract.id, { repository: 'backend', copyPath: '../../x' })).toThrow()
  })

  it('a cross-repository mission: plan shown first, tasks in dependency order in their own repositories, global verification, a prepared release train', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    const heads = { sdk: sh(rig.paths.sdk, 'rev-parse', 'HEAD'), backend: sh(rig.paths.backend, 'rev-parse', 'HEAD'), desktop: sh(rig.paths.desktop, 'rev-parse', 'HEAD') }
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency to orders everywhere.', start: true })
    const waiting = await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    // Nothing runs before the user has seen the plan.
    expect(waiting.plan?.tasks.map((t) => t.key)).toEqual(['sdk', 'api', 'ui'])
    expect(rig.host.created.filter((c) => c.kind === 'mission')).toHaveLength(0)
    await rig.engine.decidePlan(mission.id, true)
    const done = await rig.untilState(mission.id, ['COMPLETED', 'BLOCKED'])
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')

    // Provider first, then each consumer; one run per task, each in its own repository.
    const tasks = rig.repos.workspaceTasks.listByMission(mission.id)
    const runs = rig.host.created.filter((c) => c.kind === 'mission')
    expect(tasks.map((t) => [t.key, t.repository, t.state])).toEqual([['sdk', 'shared-sdk', 'COMPLETED'], ['api', 'backend', 'COMPLETED'], ['ui', 'desktop', 'COMPLETED']])
    const projectOf = (key: string): string => rig.repos.enrolledRepositories.getByKey(ws.id, key)!.projectId
    expect(runs.map((r) => r.input.projectId)).toEqual([projectOf('shared-sdk'), projectOf('backend'), projectOf('desktop')])
    expect(tasks.every((t) => t.resultCommit && t.resultBranch?.startsWith('nexus/integration-'))).toBe(true)
    // Messaging: a consumer's task gets the provider's NEW contract and is told where its own copy is.
    expect(runs[0]!.input.prompt).toContain('PROVIDES the contract "order"')
    expect(runs[1]!.input.prompt).toContain('CONSUMES the contract "order"')
    expect(runs[1]!.input.prompt).toContain('"currency"')
    expect(runs[1]!.input.prompt).toContain('keeps its own copy of the contract at contracts/order.schema.json')
    expect(runs[2]!.input.prompt).toContain('vendor/order.schema.json')
    expect(runs[2]!.input.prompt).toContain('What the tasks this one depends on reported')
    expect(runs[1]!.input.prompt).toContain('do not try to reach or edit them')

    // Global verification: every repository's task and checks, the contract, every consumer.
    const verification = done.verification!
    expect(verification.passed).toBe(true)
    expect(verification.contracts).toEqual([
      expect.objectContaining({ contract: 'order', fromVersion: 1, toVersion: 2, result: expect.objectContaining({ level: 'compatible', compatible: true }), consumersInSync: [expect.objectContaining({ repository: 'backend', inSync: true }), expect.objectContaining({ repository: 'desktop', inSync: true })] }),
    ])
    expect(verification.checks.filter((c) => c.name.startsWith('checks of')).map((c) => [c.repository, c.passed])).toEqual([['shared-sdk', true], ['backend', true], ['desktop', true]])

    // A release train is prepared in dependency order with versions; it is not published and cannot be.
    const train = rig.repos.releaseTrains.listByWorkspace(ws.id)[0]!
    expect(train).toMatchObject({ state: 'PREPARED', publishAuthorized: false, missionId: mission.id })
    expect(train.plan.steps.map((s) => [s.repository, s.currentVersion, s.nextVersion, s.bump, s.after])).toEqual([
      ['shared-sdk', '2.2.9', '2.3.0', 'minor', []],
      ['backend', '1.8.4', '1.8.5', 'patch', ['shared-sdk']],
      ['desktop', '0.7.3', '0.7.4', 'patch', ['backend', 'shared-sdk']],
    ])
    expect(() => rig.engine.publishReleaseTrain(train.id)).toThrow(/does not publish/)
    expect(rig.repos.workspaceDecisions.recent(ws.id).some((d) => d.kind === 'publish_refused')).toBe(true)
    // Cross-repository memory was recorded for the contract change.
    expect(rig.repos.workspaceMemory.listByWorkspace(ws.id)[0]).toMatchObject({ kind: 'contract', repositories: ['shared-sdk', 'backend', 'desktop'], source: { kind: 'verification' } })

    // The original checkouts are exactly as they were: same HEAD, same branch, clean.
    for (const [name, path] of [['sdk', rig.paths.sdk], ['backend', rig.paths.backend], ['desktop', rig.paths.desktop]] as const) {
      expect(sh(path, 'rev-parse', 'HEAD'), name).toBe(heads[name])
      expect(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
      expect(sh(path, 'status', '--porcelain')).toBe('')
    }
  })

  it('a breaking contract change with a consumer left behind fails global verification', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_BREAKING, { skip: ['desktop'] })
    const mission = await rig.engine.createMission(ws.id, { goal: 'Rename total to amount.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    const blocked = await rig.untilState(mission.id, ['BLOCKED', 'COMPLETED'])
    expect(blocked.state).toBe('BLOCKED')
    expect(blocked.blockedReason).toContain('desktop is in step with contract order')
    expect(blocked.verification).toMatchObject({ passed: false })
    expect(blocked.verification!.contracts[0]).toMatchObject({ result: { level: 'breaking' }, consumersInSync: [{ repository: 'backend', inSync: true }, { repository: 'desktop', inSync: false }] })
    // No release train is prepared for a change that did not verify.
    expect(rig.repos.releaseTrains.listByWorkspace(ws.id)).toHaveLength(0)

    // A compatible change with the same consumer left behind passes, and says the consumer is behind.
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE, { skip: ['desktop'] })
    const second = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(second.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(second.id, true)
    const done = await rig.untilState(second.id, ['BLOCKED', 'COMPLETED'])
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')
    expect(done.verification!.checks.find((c) => c.name === 'desktop is in step with contract order')).toMatchObject({ passed: true, detail: expect.stringContaining('older, compatible') })
  })

  it('refuses a plan outside the workspace policy or against the dependency order', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.engine.setPolicy(ws.id, { ...rig.repos.workspaces.require(ws.id).policy, allowedRepositories: ['shared-sdk', 'backend'] })
    // First answer: work in a repository that is not allowed. Second: a consumer before its provider.
    rig.host.answers.plan = [planJson(CHAIN), planJson([task('api', 'backend'), task('sdk', 'shared-sdk', { dependsOn: ['api'] })]), planJson([task('sdk', 'shared-sdk'), task('api', 'backend', { dependsOn: ['sdk'] })])]
    const mission = await rig.engine.createMission(ws.id, { goal: 'Change things.', start: true })
    const blocked = await rig.untilState(mission.id, ['BLOCKED', 'AWAITING_APPROVAL'])
    expect(blocked.state).toBe('BLOCKED')
    expect(blocked.blockedReason).toContain('No valid cross-repository plan')
    expect(rig.repos.workspaceTasks.listByMission(mission.id)).toHaveLength(0)
    expect(rig.host.created.filter((c) => c.kind === 'mission')).toHaveLength(0)
    // The user resumes: a valid plan is accepted.
    await rig.engine.resumeMission(mission.id)
    expect((await rig.untilState(mission.id, ['AWAITING_APPROVAL'])).plan?.tasks.map((t) => t.repository)).toEqual(['shared-sdk', 'backend'])
    expect(() => rig.engine.setPolicy(ws.id, { ...DEFAULT_WORKSPACE_POLICY, allowedRepositories: ['somewhere-else'] })).toThrow(/Not enrolled/)

    // With no allowed repository nothing can start.
    const empty = rig.engine.createWorkspace({ name: 'Empty' })
    const idle = await rig.engine.createMission(empty.id, { goal: 'x' })
    await expect(rig.engine.startMission(idle.id)).rejects.toThrow(/allows no repository/)
  })

  it('a failed task blocks the mission before anything that depends on it starts; resume runs it again', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    rig.host.mission = (i) => (i === 1 ? 'fail' : 'complete')
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    const blocked = await rig.untilState(mission.id, ['BLOCKED'])
    expect(blocked.blockedReason).toContain('Task api (backend) failed')
    expect(rig.repos.workspaceTasks.listByMission(mission.id).map((t) => t.state)).toEqual(['COMPLETED', 'FAILED', 'PLANNED'])
    expect(rig.host.created.filter((c) => c.kind === 'mission')).toHaveLength(2)
    await rig.engine.resumeMission(mission.id)
    const done = await rig.untilState(mission.id, ['COMPLETED', 'BLOCKED'])
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')
    expect(rig.host.created.filter((c) => c.kind === 'mission').map((c) => rig.repos.projects.require(c.input.projectId).name)).toEqual(['shared-sdk', 'backend', 'backend', 'desktop'])
  })

  it('a usage limit is a wait; a restart continues the same runs', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    rig.host.mission = (i) => (i === 0 ? 'quota' : i === 1 ? 'hang' : 'complete')
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    const waiting = await rig.untilState(mission.id, ['WAITING_FOR_QUOTA'])
    expect(waiting).toMatchObject({ resumeState: 'ACTIVE', blockedReason: null, error: null })
    const first = rig.host.created.filter((c) => c.kind === 'mission')[0]!.run
    await rig.host.resumeRun(first.id)
    await rig.untilState(mission.id, ['ACTIVE'])
    await rig.host.apply(first.id, 'complete')
    await rig.until(() => rig.host.created.filter((c) => c.kind === 'mission').length === 2, 'the second task')
    const second = rig.host.created.filter((c) => c.kind === 'mission')[1]!.run

    const engine = rig.restart()
    expect(rig.repos.runs.require(second.id)).toMatchObject({ state: 'paused', pauseReason: 'recovery' })
    await engine.recover()
    expect(rig.host.resumed).toContain(second.id)
    expect(rig.repos.workspaceTasks.getByRun(second.id)).toMatchObject({ key: 'api', state: 'RUNNING' })
    await rig.host.apply(second.id, 'complete')
    const done = await rig.untilState(mission.id, ['COMPLETED', 'BLOCKED'])
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')
    // Three tasks, three runs: nothing was started twice.
    expect(rig.host.created.filter((c) => c.kind === 'mission')).toHaveLength(3)
  })

  it('independent repositories may run at the same time; one repository never has two writers', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    await rig.engine.enroll(ws.id, { path: rig.paths.docs, role: 'documentation' })
    rig.engine.setPolicy(ws.id, { ...rig.repos.workspaces.require(ws.id).policy, maxParallelRepositories: 2 })
    // docs and shared-sdk are independent; two tasks are in shared-sdk.
    rig.host.answers.plan = [planJson([task('sdk-a', 'shared-sdk'), task('sdk-b', 'shared-sdk'), task('notes', 'docs')])]
    rig.host.mission = () => 'hang'
    const mission = await rig.engine.createMission(ws.id, { goal: 'Tidy up.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    await rig.until(() => rig.repos.workspaceTasks.listByMission(mission.id).filter((t) => t.state === 'RUNNING').length === 2, 'two running tasks')
    const running = rig.repos.workspaceTasks.listByMission(mission.id).filter((t) => t.state === 'RUNNING')
    expect(running.map((t) => t.repository).sort()).toEqual(['docs', 'shared-sdk'])
    await rig.engine.tick()
    expect(rig.repos.workspaceTasks.listByMission(mission.id).filter((t) => t.state === 'RUNNING')).toHaveLength(2)
    // The second task of the same repository starts only after the first, and from its result.
    const sdkA = running.find((t) => t.repository === 'shared-sdk')!
    await rig.host.apply(sdkA.runId!, 'complete')
    await rig.until(() => rig.repos.workspaceTasks.listByMission(mission.id).some((t) => t.key === 'sdk-b' && t.state === 'RUNNING'), 'the second task of the same repository')
    const sdkB = rig.repos.workspaceTasks.listByMission(mission.id).find((t) => t.key === 'sdk-b')!
    expect(sdkB.baseCommit).toBe(rig.repos.workspaceTasks.listByMission(mission.id).find((t) => t.key === 'sdk-a')!.resultCommit)

    const cancelled = await rig.engine.cancelMission(mission.id)
    expect(cancelled.state).toBe('CANCELLED')
    expect(rig.host.cancelled.length).toBeGreaterThanOrEqual(2)
  })

  it('workspace memory is for what lies between repositories', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    expect(() => rig.engine.addMemory(ws.id, { kind: 'architecture', title: 'Backend uses Express', content: 'x', evidence: 'package.json', repositories: ['backend'] })).toThrow(/at least two repositories/)
    const entry = rig.engine.addMemory(ws.id, { kind: 'release_convention', title: 'SDK first', content: 'The SDK is released before the backend.', evidence: 'backend/package.json depends on @acme/sdk', repositories: ['shared-sdk', 'backend', 'ghost'] })
    expect(entry.repositories).toEqual(['shared-sdk', 'backend'])
  })
})

describe('workspace programs and overnight workspace missions', () => {
  let rig: Rig
  let supervisor: OvernightSupervisor | null = null
  afterEach(async () => {
    supervisor?.dispose()
    supervisor = null
    await rig.cleanup()
  })

  /** Accepts every plan that comes up for approval until the predicate holds. */
  const drive = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 60_000
    for (;;) {
      await rig.engine.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await rig.engine.idle()
      if (predicate()) return
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      for (const m of rig.repos.workspaceMissions.listOpen()) if (m.state === 'AWAITING_APPROVAL') await rig.engine.decidePlan(m.id, true)
      await rig.engine.tick()
      await sleep(15)
    }
  }

  it('a workspace program runs one cross-repository mission per milestone, each building on the one before', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    let step = 0
    rig.host.files = (run, repoPath) => {
      // The first milestone adds a field, the second another: every repository changes in both.
      const fields: Record<string, unknown> = { id: { type: 'string' }, total: { type: 'number' }, currency: { type: 'string' } }
      if (step >= 3) fields['tax'] = { type: 'number' }
      step++
      return writes(rig, schema(fields))(run, repoPath)
    }
    const program = await rig.engine.createProgram(ws.id, {
      name: 'Money', goal: 'Orders carry currency and tax everywhere.', milestones: [{ title: 'Currency', goal: 'Add the currency field.' }, { title: 'Tax', goal: 'Add the tax field.' }],
    })
    expect(program).toMatchObject({ state: 'DRAFT', milestones: [{ state: 'PLANNED', missionId: null }, { state: 'PLANNED', missionId: null }] })
    await rig.engine.startProgram(program.id)
    await drive(() => rig.repos.workspacePrograms.require(program.id).state === 'COMPLETED', 'the workspace program to complete')

    const done = rig.repos.workspacePrograms.require(program.id)
    expect(done.milestones.map((m) => m.state)).toEqual(['COMPLETED', 'COMPLETED'])
    const missions = rig.repos.workspaceMissions.listByProgram(program.id)
    expect(missions.map((m) => [m.state, m.verification?.passed])).toEqual([['COMPLETED', true], ['COMPLETED', true]])
    expect(missions[1]!.goal).toContain('milestone 2 of 2')
    // One mission at a time: the second started after the first was verified.
    expect(Date.parse(missions[0]!.finishedAt!)).toBeLessThanOrEqual(Date.parse(missions[1]!.startedAt!))
    // In every repository the second milestone's task starts from the first milestone's result.
    const first = rig.repos.workspaceTasks.listByMission(missions[0]!.id)
    const second = rig.repos.workspaceTasks.listByMission(missions[1]!.id)
    for (const task of second) expect(task.baseCommit, task.repository).toBe(first.find((t) => t.repositoryId === task.repositoryId)!.resultCommit)
    // The contract went through two verified versions after the first.
    const contract = rig.repos.workspaceContracts.getByKey(ws.id, 'order')!
    expect(rig.repos.contractVersions.listByContract(contract.id).map((v) => v.version)).toEqual([1, 2, 3])
    expect(rig.engine.detail(ws.id).programs.map((p) => p.state)).toEqual(['COMPLETED'])
    expect(rig.engine.list()[0]).toMatchObject({ activePrograms: 0, activeMissions: 0 })
  })

  it('a blocked mission blocks its workspace program; resuming the program resumes the mission', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    rig.host.mission = (i) => (i === 0 ? 'fail' : 'complete')
    const program = await rig.engine.createProgram(ws.id, {
      name: 'Money',
      goal: 'g', milestones: [{ title: 'Currency', goal: 'Add the currency field.' }],
    })
    await rig.engine.startProgram(program.id)
    await drive(() => rig.repos.workspacePrograms.require(program.id).state === 'BLOCKED', 'the workspace program to block')
    const blocked = rig.repos.workspacePrograms.require(program.id)
    expect(blocked.blockedReason).toContain('failed')
    expect(blocked.milestones[0]).toMatchObject({ state: 'BLOCKED' })
    expect(rig.engine.list()[0]).toMatchObject({ activePrograms: 1 })
    await rig.engine.resumeProgram(program.id)
    await drive(() => rig.repos.workspacePrograms.require(program.id).state === 'COMPLETED', 'the workspace program to complete after the resume')
    // Still one mission for the milestone: the blocked one was resumed, not replaced.
    expect(rig.repos.workspaceMissions.listByProgram(program.id)).toHaveLength(1)

    const cancelled = await rig.engine.createProgram(ws.id, {
      name: 'Other',
      goal: 'g', milestones: [{ title: 'One', goal: 'x' }, { title: 'Two', goal: 'y' }],
    })
    rig.host.mission = () => 'hang'
    await rig.engine.startProgram(cancelled.id)
    await drive(() => rig.repos.workspaceMissions.listByProgram(cancelled.id).some((m) => m.state === 'ACTIVE'), 'the mission to be active')
    const after = await rig.engine.cancelProgram(cancelled.id)
    expect(after).toMatchObject({ state: 'CANCELLED', milestones: [{ state: 'CANCELLED' }, { state: 'CANCELLED' }] })
    expect(rig.repos.workspaceMissions.listByProgram(cancelled.id).map((m) => m.state)).toEqual(['CANCELLED'])
    await expect(
      rig.engine.createProgram(ws.id, { name: 'x', goal: 'g', milestones: [] }),
    ).rejects.toThrow()
  })

  it('a workspace mission under the overnight supervisor: failsafe first, global verification, report, power action', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    const power = new FakePowerController()
    const orchestrator = new Proxy({}, { get: () => async () => undefined }) as unknown as OvernightOrchestrator
    supervisor = new OvernightSupervisor({ repos: rig.repos, bus: rig.bus, orchestrator, power, git: new GitService(), push: () => undefined, flush: () => undefined, reportsDir: join(rig.root, 'reports'), bootTime: () => 0, tickIntervalMs: 0, stopTimeoutMs: 5000 })
    supervisor.registerWorkload('workspace_mission', (id) => new WorkspaceMissionWorkload(id, { host: rig.engine, get: (missionId) => rig.repos.workspaceMissions.get(missionId), quotaResetsAt: () => null }))
    const waitFor = async (id: string, states: string[]): Promise<OvernightRun> => {
      const deadline = Date.now() + 30_000
      for (;;) {
        await supervisor!.idle()
        await rig.engine.idle()
        const record = rig.repos.overnight.require(id)
        if (states.includes(record.state)) return record
        if (Date.now() > deadline) throw new Error(`overnight is ${record.state}; mission ${rig.repos.workspaceMissions.require(id).state}`)
        await rig.engine.tick()
        await supervisor!.tick()
        await sleep(20)
      }
    }
    const policy = { ...DEFAULT_OVERNIGHT_POLICY, forceCloseApplications: true }

    // A plan nobody is there to approve ends the night as a blocker.
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    const unapproved = await rig.engine.createMission(ws.id, { goal: 'Add a currency.' })
    await expect(supervisor.startWorkspaceMission({ missionId: unapproved.id, policy, confirmed: false, confirmation: OVERNIGHT_CONFIRMATION_TEXT })).rejects.toThrow(/authorization/)
    await supervisor.startWorkspaceMission({ missionId: unapproved.id, policy: { ...policy, shutdownOn: { ...policy.shutdownOn, blocker: false } }, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
    expect(power.calls[0]).toMatchObject({ operation: 'scheduleShutdown', request: { purpose: 'failsafe' } })
    expect(rig.repos.overnight.require(unapproved.id)).toMatchObject({ workloadType: 'workspace_mission', projectId: 'workspace' })
    const blocked = await waitFor(unapproved.id, ['DONE'])
    expect(blocked).toMatchObject({ terminalReason: 'BLOCKED', powerAction: null })
    expect(blocked.terminalDetail).toContain('waiting for approval')

    // Approved beforehand, the same mission runs through the night and ends with the power action.
    await rig.engine.decidePlan(unapproved.id, true)
    await rig.engine.pauseMission(unapproved.id)
    await supervisor.startWorkspaceMission({ missionId: unapproved.id, policy, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
    const done = await waitFor(unapproved.id, ['POWER_ACTION_SCHEDULED'])
    expect(done.terminalReason).toBe('SUCCESS')
    expect(rig.repos.workspaceMissions.require(unapproved.id)).toMatchObject({ state: 'COMPLETED', verification: { passed: true } })
    expect(done.finalReport).toContain('# NEXUS Overnight Workspace Mission')
    expect(done.finalReport).toContain('Nothing was published')
    expect(done.finalReport).toContain('`sdk` in shared-sdk [COMPLETED]')
    expect(power.calls.map((c) => (c.request ? `${c.operation}:${c.request.purpose}` : c.operation)).slice(-3)).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
    expect(ipcInputs['overnight.startWorkspaceMission'].safeParse({ missionId: 'm', policy, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT, command: 'x' }).success).toBe(false)
  })
})

describe('workspace engine: audit regressions', () => {
  let rig: Rig
  afterEach(async () => {
    await rig.cleanup()
  })

  const drive = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 60_000
    for (;;) {
      await rig.engine.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await rig.engine.idle()
      if (predicate()) return
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      for (const m of rig.repos.workspaceMissions.listOpen()) if (m.state === 'AWAITING_APPROVAL') await rig.engine.decidePlan(m.id, true)
      await rig.engine.tick()
      await sleep(15)
    }
  }

  it('a later milestone that changes only consumers reads the contract from the earlier milestone, not from the checkout', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    // Milestone 1 changes the provider only; milestone 2 brings the consumers in step.
    rig.host.answers.plan = [planJson([task('sdk', 'shared-sdk', { contracts: ['order'] })]), planJson([task('api', 'backend', { contracts: ['order'] }), task('ui', 'desktop', { dependsOn: ['api'], contracts: ['order'] })])]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    const program = await rig.engine.createProgram(ws.id, {
      name: 'Currency',
      goal: 'g', milestones: [{ title: 'Provider', goal: 'Add the field to the contract.' }, { title: 'Consumers', goal: 'Adapt the consumers.' }],
    })
    await rig.engine.startProgram(program.id)
    await drive(() => ['COMPLETED', 'BLOCKED'].includes(rig.repos.workspacePrograms.require(program.id).state), 'the program to end')
    expect(rig.repos.workspacePrograms.require(program.id)).toMatchObject({ state: 'COMPLETED' })
    const [, second] = rig.repos.workspaceMissions.listByProgram(program.id)
    const tasks = rig.repos.workspaceTasks.listByMission(second!.id)
    expect(tasks.map((t) => t.key)).toEqual(['api', 'ui'])
    // The consumers were shown the contract with the new field, which exists only on milestone 1's result branch.
    for (const t of tasks) expect(rig.repos.runs.require(t.runId!).prompt, t.key).toContain('currency')
    // And they were verified against it: the copies equal the provider's contract as milestone 1 left it.
    const checked = second!.verification!.contracts.find((c) => c.contract === 'order')!
    expect(checked.result.level).toBe('identical')
    expect(checked.consumersInSync.map((c) => [c.repository, c.inSync])).toEqual([['backend', true], ['desktop', true]])
    // The provider's checkout itself still has the first version.
    expect(readFileSync(join(rig.paths.sdk, 'contracts/order.schema.json'), 'utf8')).toBe(V1)
  })

  it('a run created just before a crash and never recorded is cancelled on recovery; recorded runs continue', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    rig.host.mission = () => 'hang'
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    await rig.until(() => rig.repos.workspaceTasks.listByMission(mission.id).some((t) => t.state === 'RUNNING'), 'the first task to run')
    const recorded = rig.repos.workspaceTasks.listByMission(mission.id).find((t) => t.state === 'RUNNING')!
    // The crash window: the marker is written, a run is created, and NEXUS stops before the task knows it.
    const at = new Date(Date.now() - 1).toISOString()
    const sdk = rig.repos.enrolledRepositories.listByWorkspace(ws.id).find((r) => r.key === 'shared-sdk')!
    const orphan = await rig.host.createRun({ projectId: sdk.projectId, mode: 'mission', preset: 'balanced', prompt: 'Task "x" in the repository "shared-sdk" (library), part of a change across several repositories.' })
    const unrelated = await rig.host.createRun({ projectId: sdk.projectId, mode: 'mission', preset: 'balanced', prompt: 'A mission the user started.' })
    rig.repos.settings.setValue(`workspace-starting:${mission.id}`, { at })

    const engine = rig.restart()
    await engine.recover()
    await engine.idle()
    expect(rig.host.cancelled).toContain(orphan.id)
    expect(rig.host.cancelled).not.toContain(unrelated.id)
    expect(rig.host.cancelled).not.toContain(recorded.runId)
    expect(rig.repos.settings.getValue(`workspace-starting:${mission.id}`)).toBeNull()
    expect(rig.repos.workspaceTasks.getByRun(recorded.runId!)).toMatchObject({ state: 'RUNNING' })
    // In ordinary operation the marker never outlives the start of a run.
    expect(rig.host.created.filter((c) => c.kind === 'mission').length).toBeGreaterThan(0)
  })

  it('checks that did not run are not passed checks: a repository without a check command fails verification, a documentation repository is excused', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    rig.host.files = writes(rig, V2_COMPATIBLE)
    // The backend's run completes and its checks "pass", but no command ran there.
    rig.host.checksRan = (run) => rig.repos.projects.require(run.projectId).rootPath !== rig.paths.backend
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(mission.id, true)
    const ended = await rig.untilState(mission.id, ['COMPLETED', 'BLOCKED'])
    expect(ended.state).toBe('BLOCKED')
    const check = ended.verification!.checks.find((c) => c.name === 'checks of api')!
    expect(check).toMatchObject({ passed: false, repository: 'backend' })
    expect(check.detail).toContain('No build or test command ran')
    expect(ended.verification!.checks.find((c) => c.name === 'checks of sdk')).toMatchObject({ passed: true })
    // Nothing is recorded or prepared for work that did not verify.
    expect(rig.engine.detail(ws.id).releaseTrains).toEqual([])
    // A documentation repository has nothing to build or test, and says so.
    const docsRepo = rig.repos.enrolledRepositories.listByWorkspace(ws.id).find((r) => r.rootPath === rig.paths.docs) ?? (await rig.engine.enroll(ws.id, { path: rig.paths.docs, key: 'docs' }))
    rig.engine.setRole(docsRepo.id, 'documentation')
    rig.host.answers.plan = [planJson([task('docs', docsRepo.key)])]
    rig.host.checksRan = () => false
    rig.host.files = () => ({ 'guide.md': '# Guide\n' })
    const second = await rig.engine.createMission(ws.id, { goal: 'Write the guide.', start: true })
    await rig.untilState(second.id, ['AWAITING_APPROVAL'])
    await rig.engine.decidePlan(second.id, true)
    const done = await rig.untilState(second.id, ['COMPLETED', 'BLOCKED'])
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')
    expect(done.verification!.checks.find((c) => c.name === 'checks of docs')?.detail).toContain('a documentation repository')
  })

  it('a contract that could not be read before the mission is unknown, not new; a hostile contract file is read in linear time', async () => {
    const big = `${'/* '.repeat(120_000)}export const x: number`
    const started = Date.now()
    expect(extractSurface('typescript_api', big).surface.map((e) => e.path)).toEqual([])
    expect(extractSurface('typescript_api', `${'/* open '.repeat(40_000)}`).parseError).not.toBeNull()
    expect(extractSurface('database_schema', 'create table t ('.repeat(30_000)).parseError).not.toBeNull()
    expect(extractSurface('protobuf', `message M { int32 a = 1; } ${'x'.repeat(600_000)}`).parseError).toContain('larger than 512 KB')
    expect(Date.now() - started).toBeLessThan(5000)
    // The schema case alone took 4.8 s of those five: its pattern looked from every unterminated statement to
    // the end of the text. It is one pass now, and the same input with twice the statements is not four times slower.
    const sql = (n: number): number => {
      const t0 = performance.now()
      expect(extractSurface('database_schema', 'create table t ('.repeat(n)).parseError).not.toBeNull()
      return performance.now() - t0
    }
    expect(sql(30_000)).toBeLessThan(500)
    expect(sql(30_000 + 1)).toBeLessThan(500)
    // The statements a schema is read as did not change: the body ends at the first parenthesis that ends the
    // statement, types keep their own parentheses, and what follows an unterminated statement is not read.
    const paths = (text: string): string[] => extractSurface('database_schema', text).surface.map((e) => `${e.path}:${e.shape}`)
    expect(paths('create table a (id integer primary key, price numeric(10, 2) not null); CREATE TABLE IF NOT EXISTS "b" (x text) without rowid; create table c (y int)')).toEqual(['a:table', 'a.id:integer', 'a.price:numeric(10, 2)', 'b:table', 'b.x:text', 'c:table', 'c.y:int'])
    expect(paths('create table a (id int); create table broken (x int, y numeric(3')).toEqual(['a:table', 'a.id:int'])
    expect(paths('create table a (id int) engine=innodb; create table b (z int) strict;')).toEqual(['a:table', 'a.id:int', 'b:table', 'b.z:int'])
    expect(stripBlockComments('a /* b */ c /* d')).toBe('a  c ')
    expect(stripBlockComments('no comments')).toBe('no comments')
  })

  it('the planner session is an internal run: lists of missions leave it out', async () => {
    rig = makeRig()
    const ws = await rig.workspace()
    rig.host.answers.plan = [planJson(CHAIN)]
    const mission = await rig.engine.createMission(ws.id, { goal: 'Add a currency.', start: true })
    await rig.untilState(mission.id, ['AWAITING_APPROVAL'])
    const planner = rig.host.created.find((c) => c.input.mode === 'ask')!.run
    expect(planner.prompt.startsWith(WORKSPACE_PLANNER_MARKER)).toBe(true)
    expect(isReasoningRun(planner)).toBe(true)
    expect(rig.repos.runs.listRecentUser(50).map((r) => r.id)).not.toContain(planner.id)
    expect(rig.repos.settings.getValue(`workspace-starting:${mission.id}`)).toBeNull()
  })
})

describe('migration 007 (workspaces)', () => {
  it('is additive: a schema-6 database keeps every row and its tables, and gains the workspace tables', () => {
    const old = new BetterSqlite3(':memory:')
    old.pragma('foreign_keys = ON')
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 6))
    const before = createRepositories(old)
    const project = before.projects.insert(makeProject())
    const ddl = (db: BetterSqlite3.Database): Map<string, string> => new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]))
    const earlier = ddl(old)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 7))
    const after = ddl(old)
    for (const [name, sql] of earlier) expect(after.get(name), name).toBe(sql)
    const added = [...after.keys()].filter((name) => !earlier.has(name) && !name.startsWith('idx_') && !name.startsWith('sqlite_autoindex'))
    expect(added.length).toBeGreaterThanOrEqual(10)
    for (const name of added) expect(name.startsWith('workspace') || ['enrolled_repositories', 'contract_versions', 'contract_consumers', 'release_trains', 'cross_repo_dependencies', 'workspace_services'].includes(name) || /contract|release|repo|service/.test(name), name).toBe(true)
    const repos = createRepositories(old)
    expect(repos.projects.require(project.id).id).toBe(project.id)
    expect(repos.workspaces.list()).toEqual([])
    old.close()
  })
})
