import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Project, Run } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { ArenaEnvironment, ConcreteStrategy } from '@shared/v3'
import { ArenaService, type ArenaRunHost, type ArenaServiceDeps } from '@main/modules/arena'
import { EventBus } from '@main/modules/events'
import { GitService } from '@main/modules/git'
import { createRepositories, openDatabase, type Repositories } from '@main/modules/persistence'
import { makeProject, runConfig, makeAgent } from '../persistence/fixtures'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(15)
  }
}

export const environment = async (): Promise<ArenaEnvironment> => ({
  platform: 'test',
  osRelease: '1',
  nodeVersion: process.version,
  sdkVersion: null,
  gitVersion: null,
  modelTiers: {},
})

/** A tiny ESM case: the fixture exports x = 1, the hidden test wants 2. */
export function writeDemoCase(
  root: string,
  id = 'demo-case',
  over: Record<string, unknown> = {},
  evaluatorBody?: string,
): string {
  const dir = join(root, id)
  mkdirSync(join(dir, 'fixture', 'test'), { recursive: true })
  mkdirSync(join(dir, 'evaluator', 'hidden-tests'), { recursive: true })
  const definition = {
    id,
    version: 1,
    name: `Demo ${id}`,
    description: 'A demo case',
    category: 'bugfix',
    complexity: 'small',
    risk: 'low',
    languages: ['JavaScript'],
    frameworks: ['node:test'],
    taskPrompt: 'Make x equal 2.',
    visibleAcceptance: ['x is 2'],
    checks: { build: null, test: 'node --test', lint: null, typecheck: null },
    setup: [],
    hiddenEvaluation: { command: 'node --test hidden-tests/**/*.test.mjs', timeoutSeconds: 60 },
    budgets: { maxWallClockMinutes: 20, maxAgentSessions: 20, maxAgentsPerTrial: 2, maxTurnsPerAgent: 60 },
    allowedStrategies: ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE'],
    ...over,
  }
  writeFileSync(join(dir, 'case.json'), JSON.stringify(definition, null, 2))
  writeFileSync(join(dir, 'fixture', 'package.json'), '{ "type": "module", "scripts": { "test": "node --test" } }\n')
  writeFileSync(join(dir, 'fixture', 'index.js'), 'export const x = 1\n')
  writeFileSync(
    join(dir, 'fixture', 'test', 'visible.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert'\nimport { x } from '../index.js'\ntest('x is a number', () => assert.equal(typeof x, 'number'))\n",
  )
  writeFileSync(
    join(dir, 'evaluator', 'hidden-tests', `${id}.test.mjs`),
    evaluatorBody ??
      "import test from 'node:test'\nimport assert from 'node:assert'\nimport { x } from '../index.js'\ntest('x is 2', () => assert.equal(x, 2))\n",
  )
  return dir
}

export const SOLUTION = { 'index.js': 'export const x = 2\n' }
export const WRONG = { 'index.js': 'export const x = 3\n' }

export type Behavior = 'solve' | 'wrong' | 'fail' | 'hang' | 'quota' | 'nocommit'

export interface CreateInput {
  projectId: string
  mode: string
  preset: string
  prompt: string
  acceptanceCriteria: string[]
  strategy: ConcreteStrategy
  arenaTrialId: string
  overrides?: Record<string, unknown>
}

/**
 * Stands in for the orchestrator: fabricates a run row, and for `solve`/`wrong` a commit on an integration
 * branch inside the trial repository, then ends the run with the matching event.
 */
export class FakeHost implements ArenaRunHost {
  readonly created: CreateInput[] = []
  readonly cancelled: string[] = []
  readonly resumed: string[] = []
  readonly runs: Run[] = []
  /** Decides what happens to the n-th created run. */
  behavior: (index: number, input: CreateInput) => Behavior = () => 'solve'
  /** Delay before the behaviour is applied. */
  delayMs = 0
  /** Sessions fabricated per run (for session budgets and metrics). */
  sessionsPerRun = 1
  /** Extra hook run when a run is created (e.g. to seed review findings). */
  onCreated: ((run: Run, input: CreateInput) => void) | null = null
  /** Optional host cleanup of a run's worktrees (assigned by tests). */
  cleanupRun?: (runId: string) => Promise<unknown>

  constructor(
    private readonly repos: Repositories,
    private readonly bus: EventBus,
    private readonly git: GitService,
  ) {}

  async createRun(input: CreateInput): Promise<Run> {
    const index = this.created.length
    this.created.push(input)
    const project = this.repos.projects.require(input.projectId)
    const run = this.repos.runs.insert({
      id: newId(),
      projectId: project.id,
      mode: 'build',
      preset: 'balanced',
      state: 'executing',
      resumeState: null,
      pauseReason: null,
      prompt: input.prompt,
      plan: null,
      baseBranch: 'main',
      baseCommit: null,
      integrationBranch: null,
      config: { ...runConfig(), ...(input.overrides ?? {}) } as Run['config'],
      error: null,
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
    })
    this.runs.push(run)
    this.onCreated?.(run, input)
    const behavior = this.behavior(index, input)
    if (behavior !== 'hang') setTimeout(() => void this.apply(run.id, behavior).catch(() => undefined), this.delayMs)
    return run
  }

  async apply(runId: string, behavior: Behavior): Promise<void> {
    const run = this.repos.runs.require(runId)
    if (run.state === 'cancelled') return
    const project = this.repos.projects.require(run.projectId)
    const seedSessions = (): void => {
      const agent = this.repos.agents.insert(
        makeAgent(run.id, null, { state: 'stopped', metrics: { turns: 4, toolCalls: 6, filesRead: 0, filesChanged: 1, commands: 0, inputTokens: 1000, outputTokens: 400, cacheReadTokens: null, costUsd: null, contextWindow: null } }),
      )
      for (let i = 0; i < this.sessionsPerRun; i++) {
        this.repos.sessions.insert({ id: newId(), agentId: agent.id, sdkSessionId: null, model: null, state: 'ended', endReason: null, handoff: null, startedAt: nowIso(), endedAt: nowIso() })
      }
    }
    if (behavior === 'quota') {
      this.repos.runs.update(runId, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
      this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'quota' } })
      return
    }
    seedSessions()
    if (behavior === 'fail') {
      this.repos.runs.update(runId, { state: 'failed', error: 'planner gave up', finishedAt: nowIso() })
      this.bus.emit({ runId, type: 'run.failed', payload: { error: 'planner gave up' } })
      return
    }
    let integrationBranch: string | null = null
    if (behavior === 'solve' || behavior === 'wrong') {
      integrationBranch = `nexus/integration-${basename(dirname(project.rootPath))}`
      const files = behavior === 'solve' ? SOLUTION : WRONG
      await this.git.run(project.rootPath, ['checkout', '-q', '-b', integrationBranch])
      for (const [name, content] of Object.entries(files)) writeFileSync(join(project.rootPath, name), content)
      await this.git.commitAll(project.rootPath, 'integration', { name: 'Fake', email: 'fake@example.invalid' })
      await this.git.run(project.rootPath, ['checkout', '-q', 'main'])
    }
    this.repos.runs.update(runId, { state: 'completed', integrationBranch, finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'done' } })
  }

  async pauseRun(runId: string): Promise<void> {
    this.repos.runs.update(runId, { state: 'paused', pauseReason: 'user' })
  }

  async resumeRun(runId: string): Promise<void> {
    this.resumed.push(runId)
    this.repos.runs.update(runId, { state: 'executing', pauseReason: null, resumeState: null })
    this.bus.emit({ runId, type: 'run.resumed', payload: {} })
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId)
    const run = this.repos.runs.get(runId)
    if (!run || run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') return
    this.repos.runs.update(runId, { state: 'cancelled', finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.cancelled', payload: {} })
  }
}

export interface ArenaRig {
  root: string
  dataDir: string
  casesDir: string
  repos: Repositories
  bus: EventBus
  git: GitService
  host: FakeHost
  service: ArenaService
  /** A second service on the same database and directories (simulates an app restart). */
  restart(overrides?: Partial<ArenaServiceDeps>): ArenaService
  cleanup(): Promise<void>
}

export function makeRig(options: { overrides?: Partial<ArenaServiceDeps>; cases?: (casesDir: string) => void } = {}): ArenaRig {
  const root = mkdtempSync(join(tmpdir(), 'arena-it-'))
  const dataDir = join(root, 'data')
  const casesDir = join(root, 'cases')
  mkdirSync(casesDir, { recursive: true })
  if (options.cases) options.cases(casesDir)
  else writeDemoCase(casesDir)
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const git = new GitService()
  const host = new FakeHost(repos, bus, git)
  const projects = {
    open: async (path: string): Promise<Project> =>
      repos.projects.insert(makeProject({ id: newId(), name: basename(path), rootPath: path })),
  }
  const services: ArenaService[] = []
  const build = (overrides: Partial<ArenaServiceDeps> = {}): ArenaService => {
    const service = new ArenaService({
      repos,
      bus,
      git,
      dataDir,
      casesDir,
      host,
      projects,
      nexusVersion: '0.3.0-test',
      environment,
      pollMs: 0,
      agentSettleMs: 500,
      ...options.overrides,
      ...overrides,
    })
    services.push(service)
    return service
  }
  const service = build()
  return {
    root,
    dataDir,
    casesDir,
    repos,
    bus,
    git,
    host,
    service,
    restart: (overrides) => build(overrides),
    async cleanup() {
      for (const s of services) s.dispose()
      await Promise.race([Promise.allSettled(services.map((s) => s.idle())), sleep(3000)])
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}
