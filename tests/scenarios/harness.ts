import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MissionPlan, PlannedTask, Project, Run, RunState } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import { newId, nowIso } from '@shared/ids'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { FakeAgentRuntime, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { EventBus } from '@main/modules/events'
import { GitService, WorktreeManager } from '@main/modules/git'
import { Orchestrator } from '@main/modules/orchestrator'
import { createRepositories, openDatabase, type Database, type Repositories } from '@main/modules/persistence'
import { runProcess } from '@main/modules/process'

export interface Harness {
  dir: string
  repoDir: string
  dbPath: string
  db: Database
  repos: Repositories
  bus: EventBus
  git: GitService
  runtime: FakeAgentRuntime
  orchestrator: Orchestrator
  project: Project
  events: RunEvent[]
  /** Wait until the run reaches one of the states (or throw after the timeout). */
  waitForState(runId: string, states: RunState | RunState[], timeoutMs?: number): Promise<Run>
  waitFor(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>
  /** Close this app instance and open a new one on the same database and repository. */
  restart(script?: FakeScript): Promise<Harness>
  dispose(): Promise<void>
}

export interface HarnessOptions {
  script: FakeScript
  settings?: (s: Settings) => Settings
  /** Reuse an existing directory (restart). */
  existing?: { dir: string }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess('git', args, { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`)
  return r.stdout.trim()
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const fresh = !options.existing
  const dir = options.existing?.dir ?? (await mkdtemp(join(tmpdir(), 'nexus-scn-')))
  const repoDir = join(dir, 'repo')
  const dbPath = join(dir, 'nexus.db')

  if (fresh) {
    await git(dir, 'init', '-b', 'main', repoDir)
    await git(repoDir, 'config', 'user.name', 'Test User')
    await git(repoDir, 'config', 'user.email', 'test@example.com')
    await writeFile(join(repoDir, 'README.md'), '# scenario repo\n')
    await writeFile(join(repoDir, 'shared.txt'), 'line 1\n')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-m', 'initial')
  }

  const db = openDatabase(dbPath)
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const events: RunEvent[] = []
  bus.subscribe((e) => events.push(e))
  const gitService = new GitService()
  const runtime = new FakeAgentRuntime({ script: options.script })
  const orchestrator = new Orchestrator({
    repos,
    bus,
    runtime,
    git: gitService,
    worktrees: new WorktreeManager(gitService, join(dir, 'worktrees')),
    push: () => undefined,
  })

  let project: Project
  if (fresh) {
    const base = { ...DEFAULT_SETTINGS, execution: { ...DEFAULT_SETTINGS.execution, requirePlanApproval: false } }
    repos.settings.set(options.settings ? options.settings(base) : base)
    project = repos.projects.insert({
      id: newId(),
      name: 'scenario',
      rootPath: repoDir,
      profile: {
        repoRoot: repoDir,
        isGitRepo: true,
        currentBranch: 'main',
        headCommit: await git(repoDir, 'rev-parse', 'HEAD'),
        dirty: false,
        packageManagers: [],
        languages: [],
        frameworks: [],
        scripts: {},
        commands: { build: null, test: null, lint: null, typecheck: null },
        docs: ['README.md'],
        hasClaudeMd: false,
        fileCount: 2,
        sizeBytes: 30,
        generatedPaths: [],
        profiledAt: nowIso(),
      },
      respectProjectClaudeConfig: false,
      createdAt: nowIso(),
      lastOpenedAt: nowIso(),
    })
  } else {
    project = repos.projects.list()[0] as Project
  }

  const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }

  const harness: Harness = {
    dir,
    repoDir,
    dbPath,
    db,
    repos,
    bus,
    git: gitService,
    runtime,
    orchestrator,
    project,
    events,
    async waitForState(runId, states, timeoutMs = 20_000) {
      const wanted = Array.isArray(states) ? states : [states]
      try {
        await waitFor(() => wanted.includes(repos.runs.require(runId).state), `run state ${wanted.join('|')}`, timeoutMs)
      } catch (e) {
        const run = repos.runs.require(runId)
        const tasks = repos.tasks.listByRun(runId).map((t) => `${t.key}=${t.state}${t.error ? `(${t.error.what}: ${t.error.why})` : ''}`)
        throw new Error(`${(e as Error).message}; run is ${run.state} (${run.error ?? 'no error'}); tasks: ${tasks.join(', ')}`, { cause: e })
      }
      await orchestrator.idle(runId)
      return repos.runs.require(runId)
    },
    waitFor,
    async restart(script) {
      await orchestrator.shutdown()
      db.close()
      return createHarness({ script: script ?? options.script, existing: { dir } })
    },
    async dispose() {
      await orchestrator.shutdown().catch(() => undefined)
      if (db.open) db.close()
      for (let i = 0; i < 10; i++) {
        try {
          await rm(dir, { recursive: true, force: true })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }
    },
  }
  return harness
}

export function plannedTask(id: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    role: 'worker',
    dependencies: [],
    parallelizable: true,
    suggestedFiles: [`${id}.txt`],
    acceptanceCriteria: [`${id}.txt exists`],
    complexity: 'small',
    risk: 'low',
    requiresApproval: false,
    ...overrides,
  }
}

export function plan(tasks: PlannedTask[]): MissionPlan {
  return {
    summary: 'Scenario plan',
    assumptions: [],
    acceptanceCriteria: ['All task files exist'],
    tasks,
    risks: [],
  }
}

export const approvedReview = { summary: 'No significant issues found.', findings: [] }
export const passedVerification = { summary: 'All criteria satisfied.', criteria: [], failures: [] }
