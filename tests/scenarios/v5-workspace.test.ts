import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDemoScript } from '@main/modules/agent-runtime/demo-script'
import { ProjectService } from '@main/modules/ipc/services'
import { WorkspaceEngine } from '@main/modules/workspace'
import { createHarness, git, type Harness } from './harness'

/**
 * A cross-repository mission on the real orchestrator with the scripted runtime: three repositories, a
 * contract owned by one and copied by the other two. Every task is a real run with its own worktrees in its
 * own repository; the scripted agents extend the contract in the provider and update the copies in the
 * consumers.
 */
describe('v0.5 workspace mission on the real orchestrator', () => {
  let h: Harness
  let engine: WorkspaceEngine | null = null
  afterEach(async () => {
    engine?.dispose()
    await engine?.idle()
    engine = null
    await h?.dispose()
  })

  const schema = `${JSON.stringify({ title: 'Order', type: 'object', required: ['id'], properties: { id: { type: 'string' }, total: { type: 'number' } } }, null, 2)}\n`

  async function repository(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(h.dir, name)
    await git(h.dir, 'init', '-b', 'main', dir)
    await git(dir, 'config', 'user.name', 'Test User')
    await git(dir, 'config', 'user.email', 'test@example.com')
    await git(dir, 'config', 'commit.gpgsign', 'false')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'initial')
    return dir
  }

  const untilState = async (missionId: string, states: string[], timeoutMs = 200_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await engine!.idle()
      const mission = h.repos.workspaceMissions.require(missionId)
      if (states.includes(mission.state)) return
      if (Date.now() > deadline) throw new Error(`The mission is ${mission.state} (${mission.blockedReason ?? ''}); tasks ${h.repos.workspaceTasks.listByMission(missionId).map((t) => `${t.key}:${t.state}`).join(' ')}; decisions ${h.repos.workspaceDecisions.listByMission(missionId).map((d) => `${d.kind}: ${d.summary}`).join(' | ')}`)
      await engine!.tick()
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('changes a shared contract, its provider and two consumers in dependency order, verifies the whole, and leaves every checkout untouched', async () => {
    h = await createHarness({ script: createDemoScript() })
    const pkg = (name: string, version: string, dependencies: Record<string, string> = {}): string => `${JSON.stringify({ name, version, dependencies }, null, 2)}\n`
    const sdk = await repository('shared-sdk', { 'package.json': pkg('@acme/sdk', '2.2.9'), 'contracts/order.schema.json': schema })
    const backend = await repository('backend', { 'package.json': pkg('backend', '1.8.4', { '@acme/sdk': '^2.2.0' }), 'contracts/order.schema.json': schema })
    const desktop = await repository('desktop', { 'package.json': pkg('desktop', '0.7.3', { backend: '^1.8.0' }), 'vendor/order.schema.json': schema })
    const heads = { sdk: await git(sdk, 'rev-parse', 'HEAD'), backend: await git(backend, 'rev-parse', 'HEAD'), desktop: await git(desktop, 'rev-parse', 'HEAD') }

    engine = new WorkspaceEngine({ repos: h.repos, bus: h.bus, git: h.git, host: h.orchestrator, projects: new ProjectService(h.repos, h.git), tickIntervalMs: 0 })
    const ws = engine.createWorkspace({ name: 'Acme platform' })
    await engine.enroll(ws.id, { path: sdk, role: 'library' })
    await engine.enroll(ws.id, { path: backend, role: 'service' })
    await engine.enroll(ws.id, { path: desktop, role: 'application' })
    const contract = await engine.registerContract(ws.id, { key: 'order', name: 'Order', kind: 'json_schema', provider: 'shared-sdk', path: 'contracts/order.schema.json' })
    engine.addConsumer(contract.id, { repository: 'backend', copyPath: 'contracts/order.schema.json' })
    engine.addConsumer(contract.id, { repository: 'desktop', copyPath: 'vendor/order.schema.json' })
    // One worker per task keeps the scenario short; the strategy is the workspace's choice.
    engine.setPolicy(ws.id, { ...h.repos.workspaces.require(ws.id).policy, missionStrategy: 'SINGLE' })
    expect(engine.detail(ws.id).order).toMatchObject({ ok: true, order: ['shared-sdk', 'backend', 'desktop'] })

    const mission = await engine.createMission(ws.id, { goal: 'Add a field to the order contract and bring every consumer in step.', start: true })
    await untilState(mission.id, ['AWAITING_APPROVAL', 'BLOCKED'])
    expect(h.repos.workspaceMissions.require(mission.id).plan?.tasks.map((t) => [t.repository, t.dependsOn])).toEqual([
      ['shared-sdk', []],
      ['backend', ['change-shared-sdk']],
      ['desktop', ['change-backend', 'change-shared-sdk']],
    ])
    await engine.decidePlan(mission.id, true)
    await untilState(mission.id, ['COMPLETED', 'BLOCKED', 'FAILED'])
    const done = h.repos.workspaceMissions.require(mission.id)
    expect(done.state, done.blockedReason ?? '').toBe('COMPLETED')

    // Three real runs, one per repository, in dependency order, each with its own project and worktrees.
    const tasks = h.repos.workspaceTasks.listByMission(mission.id)
    expect(tasks.map((t) => [t.repository, t.state])).toEqual([['shared-sdk', 'COMPLETED'], ['backend', 'COMPLETED'], ['desktop', 'COMPLETED']])
    const runs = tasks.map((t) => h.repos.runs.require(t.runId!))
    expect(new Set(runs.map((r) => r.projectId)).size).toBe(3)
    expect(runs.every((r) => r.state === 'completed' && r.integrationBranch)).toBe(true)
    expect(Date.parse(runs[0]!.finishedAt!)).toBeLessThanOrEqual(Date.parse(runs[1]!.createdAt))
    expect(Date.parse(runs[1]!.finishedAt!)).toBeLessThanOrEqual(Date.parse(runs[2]!.createdAt))
    for (const run of runs) {
      const project = h.repos.projects.require(run.projectId)
      // Every worktree of a run belongs to that run's repository only.
      for (const worktree of h.repos.worktrees.listByRun(run.id)) expect(await git(worktree.path, 'rev-parse', '--git-common-dir').then((p) => p.replace(/\\/g, '/').toLowerCase())).toContain(project.rootPath.replace(/\\/g, '/').toLowerCase())
    }

    // The provider's contract changed compatibly; both consumers carry exactly the new content on their result branches.
    const provided = await git(sdk, 'show', `${tasks[0]!.resultCommit}:contracts/order.schema.json`)
    expect(provided).toContain('addedField')
    expect(await git(backend, 'show', `${tasks[1]!.resultCommit}:contracts/order.schema.json`)).toBe(provided)
    expect(await git(desktop, 'show', `${tasks[2]!.resultCommit}:vendor/order.schema.json`)).toBe(provided)
    expect(done.verification).toMatchObject({ passed: true })
    expect(done.verification!.contracts[0]).toMatchObject({ contract: 'order', fromVersion: 1, toVersion: 2, result: { level: 'compatible' }, consumersInSync: [{ repository: 'backend', inSync: true }, { repository: 'desktop', inSync: true }] })
    expect(h.repos.contractVersions.listByContract(contract.id).map((v) => v.version)).toEqual([1, 2])

    // The release train is prepared in order and nothing was published.
    const train = h.repos.releaseTrains.listByWorkspace(ws.id)[0]!
    expect(train.plan.steps.map((s) => [s.repository, s.nextVersion])).toEqual([['shared-sdk', '2.3.0'], ['backend', '1.8.5'], ['desktop', '0.7.4']])
    expect(train).toMatchObject({ state: 'PREPARED', publishAuthorized: false })

    // The original checkouts: same commit, same branch, clean, and without the change.
    for (const [name, path] of [['sdk', sdk], ['backend', backend], ['desktop', desktop]] as const) {
      expect(await git(path, 'rev-parse', 'HEAD'), name).toBe(heads[name])
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
      expect(await git(path, 'status', '--porcelain')).toBe('')
    }
    expect(await git(sdk, 'show', 'HEAD:contracts/order.schema.json')).not.toContain('addedField')
    expect(existsSync(join(backend, 'src'))).toBe(false)
  })
})
