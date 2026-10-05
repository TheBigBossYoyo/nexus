import { describe, expect, it } from 'vitest'
import type { Project, Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { dependencyOrder, TERMINAL_WORKSPACE_MISSION_STATES, type PlannedCrossRepoTask, type WorkspaceMission } from '@shared/workspace'
import { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import type { ProgramRunHost } from '@main/modules/program'
import { WorkspaceEngine } from '@main/modules/workspace'
import { makeProject, makeTask, runConfig } from '../integration/persistence/fixtures'

/**
 * Seeded stress of the workspace engine. Git is an in-memory map of commits to file contents, the orchestrator
 * is a stub that only moves run rows and emits the events the real one emits, and the planner's answers are
 * drawn at random: valid plans, plans against the dependency order, plans in repositories that are not
 * allowed, garbage. Every seed draws a workspace (repositories, dependencies, a contract with consumers), a
 * policy and a sequence of task outcomes, usage limits, user actions and restarts, and checks the invariants
 * after every step.
 *
 * NEXUS_WORKSPACE_STRESS_RUNS / NEXUS_WORKSPACE_STRESS_START select the seeds.
 */
const RUNS = Number(process.env['NEXUS_WORKSPACE_STRESS_RUNS'] ?? process.env['NEXUS_STRESS_RUNS'] ?? 300)
const START = Number(process.env['NEXUS_WORKSPACE_STRESS_START'] ?? 1)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const schema = (fields: string[]): string => JSON.stringify({ title: 'Thing', type: 'object', required: ['id'], properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) })
const CONTRACT_PATH = 'contracts/thing.schema.json'
const COPY_PATH = 'vendor/thing.schema.json'

class World {
  readonly db = openDatabase(':memory:')
  readonly repos: Repositories = createRepositories(this.db)
  readonly bus = new EventBus(this.repos.events, this.repos.transaction)
  /** Per repository root: commit id to its files. Refs (HEAD, branches) point at commit ids. */
  readonly commits = new Map<string, Map<string, Record<string, string>>>()
  readonly refs = new Map<string, Map<string, string>>()
  next = 1
  gateOpen = true
  engine: WorkspaceEngine
  missionId = ''
  workspaceId = ''
  violations: string[] = []
  readonly created: { run: Run; kind: 'plan' | 'task'; root: string }[] = []
  /** What a completing task writes into its repository. */
  writer: (root: string, files: Record<string, string>) => Record<string, string> = (_root, files) => files

  readonly git = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        switch (prop) {
          case 'isRepository':
            return async (root: string) => this.refs.has(root)
          case 'currentBranch':
            return async () => 'main'
          case 'resolveCommit':
            return async (root: string, rev: string) => {
              const found = this.refs.get(root)?.get(rev) ?? (this.commits.get(root)?.has(rev) ? rev : null)
              if (!found) throw new Error(`unknown revision ${rev}`)
              return found
            }
          case 'run':
            return async (root: string, args: string[]) => {
              if (args[0] === 'show') {
                const [commit, ...rest] = (args[1] ?? '').split(':')
                const content = this.commits.get(root)?.get(commit ?? '')?.[rest.join(':')]
                if (content === undefined) throw new Error('no such path')
                return { exitCode: 0, stdout: content, stderr: '', output: content }
              }
              throw new Error(`git ${args[0]} is not available in the stress`)
            }
          default:
            return async () => {
              throw new Error(`git.${prop} is not available in the stress`)
            }
        }
      },
    },
  ) as unknown as GitService

  readonly host: ProgramRunHost = {
    createRun: async (input) => {
      const project = this.repos.projects.require(input.projectId)
      const kind = input.mode === 'ask' ? 'plan' : 'task'
      const mission = this.repos.workspaceMissions.require(this.missionId)
      if (kind === 'task' && mission.state !== 'ACTIVE') this.violations.push(`a task run was created while the mission was ${mission.state}`)
      if (kind === 'plan' && mission.state !== 'PLANNING') this.violations.push(`a planner run was created while the mission was ${mission.state}`)
      const baseCommit = this.refs.get(project.rootPath)?.get(input.baseRef ?? 'HEAD') ?? input.baseRef ?? null
      const run = this.repos.runs.insert({
        id: newId(),
        projectId: project.id,
        mode: kind === 'plan' ? 'ask' : 'mission',
        preset: 'balanced',
        state: 'executing',
        resumeState: null,
        pauseReason: null,
        prompt: input.prompt,
        plan: null,
        baseBranch: 'main',
        baseCommit,
        integrationBranch: null,
        config: runConfig() as Run['config'],
        error: null,
        createdAt: nowIso(),
        startedAt: nowIso(),
        finishedAt: null,
      })
      this.created.push({ run, kind, root: project.rootPath })
      return run
    },
    pauseRun: async (runId) => {
      if (this.repos.runs.require(runId).state === 'executing') {
        this.repos.runs.update(runId, { state: 'paused', resumeState: 'executing', pauseReason: 'user' })
        this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'user', cause: 'user' } })
      }
    },
    resumeRun: async (runId) => {
      if (this.repos.runs.require(runId).state === 'paused') {
        this.repos.runs.update(runId, { state: 'executing', resumeState: null, pauseReason: null })
        this.bus.emit({ runId, type: 'run.resumed', payload: {} })
      }
    },
    cancelRun: async (runId) => {
      if (!['completed', 'failed', 'cancelled'].includes(this.repos.runs.require(runId).state)) {
        this.repos.runs.update(runId, { state: 'cancelled', finishedAt: nowIso() })
        this.bus.emit({ runId, type: 'run.cancelled', payload: {} })
      }
    },
    recover: async (runId) => {
      await this.host.resumeRun(runId)
    },
  }

  constructor() {
    this.engine = this.build()
  }

  build(): WorkspaceEngine {
    return new WorkspaceEngine({
      repos: this.repos,
      bus: this.bus,
      git: this.git,
      host: this.host,
      projects: { open: async (path: string): Promise<Project> => this.repos.projects.list().find((p) => p.rootPath === path) ?? this.repos.projects.insert(makeProject({ name: path.split('/').pop() ?? 'repo', rootPath: path })) },
      usage: { canDispatch: () => this.gateOpen, onChange: () => () => undefined },
      tickIntervalMs: 0,
    })
  }

  addRepository(key: string, files: Record<string, string>): string {
    const root = `stress://${key}`
    this.commits.set(root, new Map([['c0', files]]))
    this.refs.set(root, new Map([['HEAD', 'c0']]))
    return root
  }

  mission(): WorkspaceMission {
    return this.repos.workspaceMissions.require(this.missionId)
  }

  working(kind: 'plan' | 'task'): { run: Run; root: string }[] {
    return this.created.filter((c) => c.kind === kind && this.repos.runs.require(c.run.id).state === 'executing').map((c) => ({ run: this.repos.runs.require(c.run.id), root: c.root }))
  }

  answer(runId: string, text: string): void {
    this.repos.tasks.insert(makeTask(runId, 'ask', { state: 'completed', resultSummary: text }))
    this.repos.runs.update(runId, { state: 'completed', finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'answered' } })
  }

  finishTask(runId: string, root: string, how: 'complete' | 'fail' | 'checks_fail'): void {
    if (how === 'fail') {
      this.repos.runs.update(runId, { state: 'failed', error: 'boom', finishedAt: nowIso() })
      this.bus.emit({ runId, type: 'run.failed', payload: { error: 'boom' } })
      return
    }
    const run = this.repos.runs.require(runId)
    const base = this.commits.get(root)?.get(run.baseCommit ?? 'c0') ?? {}
    const commit = `c${this.next++}`
    const branch = `nexus/integration-${runId.slice(0, 8)}`
    this.commits.get(root)?.set(commit, this.writer(root, { ...base }))
    this.refs.get(root)?.set(branch, commit)
    this.repos.tasks.insert(makeTask(runId, 'work', { state: 'completed', resultSummary: 'Done.' }))
    this.repos.verifications.insert({ id: newId(), runId, taskId: null, agentId: null, attempt: 1, kind: 'checks', passed: how === 'complete', summary: how, criteria: [], commands: [], failures: [], createdAt: nowIso() })
    this.repos.runs.update(runId, { state: 'completed', integrationBranch: branch, finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'done' } })
  }

  async restart(): Promise<void> {
    await this.engine.idle()
    this.engine.dispose()
    for (const c of this.created) {
      if (this.repos.runs.require(c.run.id).state === 'executing') this.repos.runs.update(c.run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'recovery' })
    }
    this.engine = this.build()
    await this.engine.recover()
  }

  close(): void {
    this.engine.dispose()
    this.db.close()
  }
}

async function runSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const world = new World()
  const log: string[] = []
  const fail = (message: string): never => {
    const m = world.repos.workspaceMissions.get(world.missionId)
    throw new Error(
      `seed ${seed}: ${message}\n  ops: ${log.join(' | ')}\n  mission: ${JSON.stringify(m ? { state: m.state, blocked: m.blockedReason, verified: m.verification?.passed ?? null } : null)}\n  tasks: ${world.repos.workspaceTasks.listByMission(world.missionId).map((t) => `${t.key}@${t.repository}:${t.state}`).join(', ')}\n  runs: ${world.created.map((c) => `${c.kind}:${world.repos.runs.require(c.run.id).state}`).join(', ')}`,
    )
  }

  try {
    // A workspace of 2 to 5 repositories in a random acyclic dependency structure; the first owns a contract.
    const count = 2 + Math.floor(rand() * 4)
    const keys = Array.from({ length: count }, (_, i) => `r${i}`)
    const ws = world.engine.createWorkspace({ name: 'stress' })
    world.workspaceId = ws.id
    const roots = new Map<string, string>()
    for (const key of keys) {
      const root = world.addRepository(key, key === 'r0' ? { [CONTRACT_PATH]: schema(['id', 'a']) } : { [COPY_PATH]: schema(['id', 'a']) })
      roots.set(key, root)
      await world.engine.enroll(ws.id, { path: root, key })
    }
    for (let i = 1; i < count; i++) {
      for (let j = 0; j < i; j++) if (rand() < 0.4) world.engine.addDependency(ws.id, { from: keys[i] as string, to: keys[j] as string, kind: 'package_dependency', detail: 'stress' })
    }
    const contract = await world.engine.registerContract(ws.id, { key: 'thing', name: 'Thing', kind: 'json_schema', provider: 'r0', path: CONTRACT_PATH })
    const consumers = keys.slice(1).filter(() => rand() < 0.6)
    for (const key of consumers) world.engine.addConsumer(contract.id, { repository: key, copyPath: COPY_PATH })
    const disallowed = keys.slice(1).filter(() => rand() < 0.15)
    const policy = { ...world.repos.workspaces.require(ws.id).policy, allowedRepositories: keys.filter((k) => !disallowed.includes(k)), maxParallelRepositories: pick([1, 1, 2, 3]), requireConsumerUpdateOnBreakingChange: rand() < 0.85 }
    world.engine.setPolicy(ws.id, policy)
    const edges = world.engine.edges(ws.id)

    // What tasks write: the provider changes the contract (compatibly or not); a consumer may or may not follow.
    const contractAfter = pick([schema(['id', 'a', 'b']), schema(['id', 'b']), schema(['id', 'a'])])
    const lagging = new Set(consumers.filter(() => rand() < 0.25))
    world.writer = (root, files) => {
      const key = [...roots.entries()].find(([, r]) => r === root)?.[0] ?? ''
      if (key === 'r0') return { ...files, [CONTRACT_PATH]: contractAfter }
      return lagging.has(key) ? { ...files, 'touched.txt': 'x' } : { ...files, [COPY_PATH]: contractAfter }
    }

    const validPlan = (): string => {
      const allowed = policy.allowedRepositories
      const order = dependencyOrder(allowed, edges)
      const chosen = (order.ok ? order.order : allowed).filter((k) => k === 'r0' || rand() < 0.75)
      const tasks: PlannedCrossRepoTask[] = chosen.map((repository) => ({
        key: `t-${repository}`,
        repository,
        title: repository,
        objective: `Change ${repository}`,
        acceptanceCriteria: ['done'],
        dependsOn: edges.filter((e) => e.from === repository && chosen.includes(e.to)).map((e) => `t-${e.to}`),
        contracts: repository === 'r0' || consumers.includes(repository) ? ['thing'] : [],
      }))
      // Sometimes two tasks in the same repository, the second after the first.
      if (rand() < 0.3 && tasks[0]) tasks.push({ ...tasks[0], key: `${tasks[0].key}-again`, dependsOn: [tasks[0].key] })
      return fence({ summary: 's', tasks, risks: [] })
    }
    const badPlan = (): string =>
      pick([
        'no plan today',
        fence({ summary: 's', tasks: [], risks: [] }),
        fence({ summary: 's', tasks: [{ key: 'x', repository: 'nowhere', title: 't', objective: 'o', acceptanceCriteria: ['c'], dependsOn: [], contracts: [] }], risks: [] }),
        fence({ summary: 's', tasks: [{ key: 'x', repository: disallowed[0] ?? 'ghost', title: 't', objective: 'o', acceptanceCriteria: ['c'], dependsOn: [], contracts: [] }], risks: [] }),
        fence({ summary: 's', tasks: [{ key: 'a', repository: 'r0', title: 't', objective: 'o', acceptanceCriteria: ['c'], dependsOn: ['b'], contracts: [] }, { key: 'b', repository: 'r0', title: 't', objective: 'o', acceptanceCriteria: ['c'], dependsOn: ['a'], contracts: [] }], risks: [] }),
      ])

    const check = (): void => {
      if (world.violations.length > 0) fail(world.violations.join('; '))
      const m = world.mission()
      const tasks = world.repos.workspaceTasks.listByMission(world.missionId)
      const running = tasks.filter((t) => t.state === 'RUNNING')
      // One writer per repository, and no more repositories at once than the policy allows.
      if (new Set(running.map((t) => t.repositoryId)).size !== running.length) fail('two tasks of the same repository are running at once')
      if (running.length > policy.maxParallelRepositories) fail(`${running.length} tasks are running, above the limit of ${policy.maxParallelRepositories}`)
      // Dependency order: a task that started has all its dependencies completed (or had them when it started).
      for (const t of tasks) {
        if (t.state === 'PLANNED' || t.state === 'READY' || t.state === 'CANCELLED') continue
        for (const d of t.dependsOn) {
          const dep = tasks.find((x) => x.key === d)
          if (!dep || (dep.state !== 'COMPLETED' && dep.state !== 'CANCELLED' && !(dep.finishedAt && t.startedAt && dep.finishedAt <= t.startedAt))) fail(`task ${t.key} started before its dependency ${d} completed`)
        }
        // Scope: nothing ever runs in a repository the policy does not allow.
        if (t.runId && !policy.allowedRepositories.includes(t.repository)) fail(`task ${t.key} ran in ${t.repository}, which the policy does not allow`)
      }
      // Every task run was created in the project of its own repository.
      for (const t of tasks) {
        if (!t.runId) continue
        const run = world.repos.runs.require(t.runId)
        if (run.projectId !== world.repos.enrolledRepositories.require(t.repositoryId).projectId) fail(`the run of ${t.key} belongs to another repository`)
      }
      if (m.state === 'COMPLETED') {
        if (!m.verification?.passed) fail('completed without a passed verification')
        if (tasks.some((t) => t.state !== 'COMPLETED')) fail('completed with a task that is not completed')
        if (!m.finishedAt) fail('completed without a finish time')
      }
      const trains = world.repos.releaseTrains.listByWorkspace(world.workspaceId)
      if (trains.length > 0 && m.state !== 'COMPLETED') fail('a release train exists for a mission that did not complete')
      if (trains.some((t) => t.publishAuthorized)) fail('a release train is marked as authorized for publishing')
      if (TERMINAL_WORKSPACE_MISSION_STATES.includes(m.state) && world.created.some((c) => world.repos.runs.require(c.run.id).state === 'executing' && world.repos.workspaceTasks.getByRun(c.run.id)?.missionId === m.id)) fail('a terminal mission still has a working run')
      if (m.state === 'AWAITING_APPROVAL' && world.created.some((c) => c.kind === 'task')) {
        // A rejected plan is planned again; tasks of an earlier accepted plan cannot exist before approval.
        if (tasks.some((t) => t.runId !== null)) fail('a task has a run while the plan awaits approval')
      }
      // Contract versions are recorded only for verified work.
      const versions = world.repos.contractVersions.listByContract(contract.id).length
      if (versions > 1 && m.state !== 'COMPLETED') fail('a contract version was recorded for work that did not verify')
    }

    const mission = await world.engine.createMission(ws.id, { goal: 'stress' })
    world.missionId = mission.id
    await world.engine.startMission(mission.id).catch(() => undefined)
    await world.engine.idle()
    check()

    const settle = async (): Promise<void> => {
      await world.engine.idle()
      await new Promise((resolve) => setImmediate(resolve))
      await world.engine.idle()
      check()
    }
    const act = async (op: string): Promise<void> => {
      const quiet = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined)
      switch (op) {
        case 'tick':
          await world.engine.tick()
          break
        case 'plan': {
          const planner = world.working('plan')[0]
          if (planner) world.answer(planner.run.id, rand() < 0.7 ? validPlan() : badPlan())
          break
        }
        case 'approve':
          if (world.mission().state === 'AWAITING_APPROVAL') await quiet(world.engine.decidePlan(world.missionId, rand() < 0.85))
          break
        case 'task': {
          const working = world.working('task')
          const one = working.length > 0 ? pick(working) : null
          if (one) world.finishTask(one.run.id, one.root, pick(['complete', 'complete', 'complete', 'complete', 'fail', 'checks_fail'] as const))
          break
        }
        case 'quota': {
          const working = [...world.working('task'), ...world.working('plan')]
          const one = working.length > 0 ? pick(working) : null
          if (one) {
            world.repos.runs.update(one.run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
            world.bus.emit({ runId: one.run.id, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
          }
          break
        }
        case 'quotaClear':
          for (const c of world.created) {
            const run = world.repos.runs.require(c.run.id)
            if (run.state === 'paused' && run.pauseReason === 'quota') await world.host.resumeRun(run.id)
          }
          break
        case 'gate':
          world.gateOpen = !world.gateOpen
          await world.engine.tick()
          break
        case 'pause':
          await quiet(world.engine.pauseMission(world.missionId))
          break
        case 'resume':
          await quiet(world.engine.resumeMission(world.missionId))
          break
        case 'restart':
          await world.restart()
          break
        case 'cancel':
          await quiet(world.engine.cancelMission(world.missionId))
          break
        case 'publish':
          for (const train of world.repos.releaseTrains.listByWorkspace(world.workspaceId)) {
            let refused = false
            try {
              world.engine.publishReleaseTrain(train.id)
            } catch {
              refused = true
            }
            if (!refused) fail('publishing a release train was not refused')
          }
          break
      }
      await settle()
    }

    const steps = 8 + Math.floor(rand() * 34)
    for (let i = 0; i < steps; i++) {
      const op = pick(['tick', 'plan', 'plan', 'approve', 'approve', 'task', 'task', 'task', 'task', 'quota', 'quotaClear', 'gate', 'pause', 'resume', 'restart', 'publish', rand() < 0.03 ? 'cancel' : 'tick'])
      log.push(op)
      await act(op)
    }

    // With Claude available, valid answers, successful tasks and a user who keeps resuming, the mission must
    // reach an end: completed, cancelled, or blocked by its global verification.
    log.push('drain')
    world.gateOpen = true
    let resumes = 0
    for (let i = 0; i < 300; i++) {
      const m = world.mission()
      if (TERMINAL_WORKSPACE_MISSION_STATES.includes(m.state)) break
      if (m.state === 'BLOCKED' && m.verification && !m.verification.passed && resumes >= 2) break
      if (m.state === 'DRAFT') break
      const limited = world.created.map((c) => world.repos.runs.require(c.run.id)).find((r) => r.state === 'paused' && r.pauseReason === 'quota')
      const planner = world.working('plan')[0]
      const working = world.working('task')[0]
      if (limited) await world.host.resumeRun(limited.id)
      else if (m.state === 'AWAITING_APPROVAL') await world.engine.decidePlan(world.missionId, true).catch(() => undefined)
      else if (m.state === 'PAUSED' || m.state === 'BLOCKED') {
        resumes++
        await world.engine.resumeMission(world.missionId).catch(() => undefined)
      } else if (planner) world.answer(planner.run.id, validPlan())
      else if (working) world.finishTask(working.run.id, working.root, 'complete')
      else await world.engine.tick()
      await settle()
    }
    const end = world.mission()
    if (!TERMINAL_WORKSPACE_MISSION_STATES.includes(end.state) && end.state !== 'BLOCKED' && end.state !== 'DRAFT') fail(`the mission is still ${end.state} after the drain`)
  } finally {
    world.close()
  }
}

describe('workspace engine stress', () => {
  it(`keeps its invariants over ${RUNS} seeded histories`, async () => {
    const failures: string[] = []
    for (let seed = START; seed < START + RUNS; seed++) {
      try {
        await runSeed(seed)
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
        if (failures.length >= 5) break
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([])
  })
})
