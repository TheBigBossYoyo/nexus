import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
  CheckCommands,
  MissionPlan,
  PlannedTask,
  Preset,
  Project,
  ReviewFinding,
  Run,
  RunConfig,
  RunMode,
  RunState,
  Task,
  Worktree,
} from '@shared/domain'
import type { EventType, PushMessage, RunEvent } from '@shared/events'
import { newId, nowIso } from '@shared/ids'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import {
  completeWith,
  FakeAgentRuntime,
  scriptsByRole,
  type FakeScript,
  type FakeSessionContext,
} from '@main/modules/agent-runtime/fake-runtime'
import { EventBus } from '@main/modules/events'
import { GitService, WorktreeManager } from '@main/modules/git'
import { Orchestrator } from '@main/modules/orchestrator'
import { createRepositories, openDatabase, type Database, type Repositories } from '@main/modules/persistence'
import { runProcess } from '@main/modules/process'

export interface Harness {
  dir: string
  repoDir: string
  dbPath: string
  worktreesDir: string
  db: Database
  repos: Repositories
  bus: EventBus
  git: GitService
  runtime: FakeAgentRuntime
  orchestrator: Orchestrator
  project: Project
  /** Every durable event emitted by this app instance (since it started). */
  events: RunEvent[]
  /** Ephemeral main → renderer pushes (streamed agent output) of this app instance. */
  pushes: PushMessage[]
  /** Wait until the run reaches one of the states (or throw after the timeout). */
  waitForState(runId: string, states: RunState | RunState[], timeoutMs?: number): Promise<Run>
  waitFor(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>
  /** Create a BUILD run (default) with the scenario project. */
  startRun(options?: { mode?: RunMode; preset?: Preset; prompt?: string; overrides?: Partial<RunConfig> }): Promise<Run>
  /** The task with the given planner key. */
  task(runId: string, key: string): Task
  /** Durable events of one type for a run. */
  eventsOfType<T extends EventType>(runId: string, type: T): RunEvent<T>[]
  /** The run's integration worktree row. */
  integration(runId: string): Worktree
  /**
   * Close this app instance and open a new one on the same database and repository. With `crash`
   * the new instance starts from a snapshot of the database taken while the old one was still
   * running, i.e. what a killed process leaves behind (active agents and sessions included).
   */
  restart(script?: FakeScript, options?: { crash?: boolean }): Promise<Harness>
  dispose(): Promise<void>
}

export interface HarnessOptions {
  script: FakeScript
  settings?: (s: Settings) => Settings
  /** Reuse an existing directory (restart). */
  existing?: { dir: string }
  /** Extra files committed to the scenario repository (fresh harness only). */
  files?: Record<string, string>
  /** Check commands stored in the project profile, and therefore in every run's config. */
  commands?: Partial<CheckCommands>
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess('git', args, { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`)
  return r.stdout.trim()
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const fresh = !options.existing
  const dir = options.existing?.dir ?? (await mkdtemp(join(tmpdir(), 'nexus-scn-')))
  const repoDir = join(dir, 'repo')
  const dbPath = join(dir, 'nexus.db')
  const worktreesDir = join(dir, 'worktrees')

  if (fresh) {
    await git(dir, 'init', '-b', 'main', repoDir)
    await git(repoDir, 'config', 'user.name', 'Test User')
    await git(repoDir, 'config', 'user.email', 'test@example.com')
    await writeFile(join(repoDir, 'README.md'), '# scenario repo\n')
    await writeFile(join(repoDir, 'shared.txt'), 'line 1\n')
    for (const [name, content] of Object.entries(options.files ?? {})) {
      await mkdir(dirname(join(repoDir, name)), { recursive: true })
      await writeFile(join(repoDir, name), content)
    }
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-m', 'initial')
  }

  const db = openDatabase(dbPath)
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const events: RunEvent[] = []
  const pushes: PushMessage[] = []
  bus.subscribe((e) => events.push(e))
  const gitService = new GitService()
  const runtime = new FakeAgentRuntime({ script: options.script })
  const orchestrator = new Orchestrator({
    repos,
    bus,
    runtime,
    git: gitService,
    worktrees: new WorktreeManager(gitService, worktreesDir),
    push: (message) => void pushes.push(message),
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
        commands: { build: null, test: null, lint: null, typecheck: null, ...options.commands },
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
    worktreesDir,
    db,
    repos,
    bus,
    git: gitService,
    runtime,
    orchestrator,
    project,
    events,
    pushes,
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
    startRun(opts = {}) {
      return orchestrator.createRun({
        projectId: project.id,
        mode: opts.mode ?? 'build',
        preset: opts.preset ?? 'balanced',
        prompt: opts.prompt ?? 'Build the thing',
        ...(opts.overrides ? { overrides: opts.overrides } : {}),
      })
    },
    task(runId, key) {
      const found = repos.tasks.listByRun(runId).find((t) => t.key === key)
      if (!found) throw new Error(`No task "${key}" in run (have: ${repos.tasks.listByRun(runId).map((t) => t.key).join(', ')})`)
      return found
    },
    eventsOfType<T extends EventType>(runId: string, type: T) {
      return repos.events.listByRun(runId, 0, 100_000).filter((e): e is RunEvent<T> => e.type === type)
    },
    integration(runId) {
      const found = repos.worktrees.listByRun(runId).find((w) => w.taskId === null)
      if (!found) throw new Error('Run has no integration worktree')
      return found
    },
    async restart(script, restartOptions) {
      const snapshot = join(dir, 'crash-snapshot.db')
      if (restartOptions?.crash) await db.backup(snapshot)
      await orchestrator.shutdown()
      db.close()
      if (restartOptions?.crash) {
        for (const suffix of ['', '-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true })
        await rename(snapshot, dbPath)
      }
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

// ───────────────────────────── plan and agent output builders ─────────────────────────────

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

export function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: 'Missing input validation',
    description: 'The new code does not validate its input.',
    evidence: 'No guard before use.',
    severity: 'high',
    category: 'correctness',
    file: null,
    lineStart: null,
    lineEnd: null,
    confidence: 'high',
    suggestedCorrection: null,
    ...overrides,
  }
}

export function rejectedReview(overrides: Partial<ReviewFinding> = {}): { summary: string; findings: ReviewFinding[] } {
  return { summary: 'Blocking issue found.', findings: [finding(overrides)] }
}

export function failedVerification(criterion = 'The behaviour works'): {
  summary: string
  criteria: { criterion: string; passed: boolean; evidence: string }[]
  failures: { criterion: string; evidence: string; likelyCause: string; relevantFiles: string[] }[]
} {
  return {
    summary: 'A criterion is not met.',
    criteria: [{ criterion, passed: false, evidence: 'Observed behaviour differs.' }],
    failures: [{ criterion, evidence: 'Observed behaviour differs.', likelyCause: 'Logic error', relevantFiles: [] }],
  }
}

// ───────────────────────────── scripts ─────────────────────────────

/** The task key a session works on: the worktree directory is named after it (repairs share their parent's). */
export function keyOf(spec: { cwd: string }): string {
  return basename(spec.cwd)
}

/** Writes `files` (default: `<task key>.txt`) in the session's worktree through the policy-checked Write tool. */
export async function writeFiles(
  spec: { cwd: string },
  ctx: FakeSessionContext,
  files: Record<string, string> = { [`${keyOf(spec)}.txt`]: keyOf(spec) },
): Promise<boolean> {
  let allowed = true
  for (const [name, content] of Object.entries(files)) {
    const target = join(spec.cwd, name)
    const ok = await ctx.useTool('Write', { file_path: target, content }, async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${content}\n`)
      return 'written'
    })
    allowed = allowed && ok
  }
  return allowed
}

/** A worker that writes `<task key>.txt` in its worktree. */
export const fileWorker: FakeScript = async (spec, ctx) => {
  const key = keyOf(spec)
  const allowed = await writeFiles(spec, ctx)
  await ctx.completeTurn({ text: allowed ? `Created ${key}.txt` : 'Write was denied' })
}

export interface ScenarioScripts {
  /** Planner output; a function is called per planner session (0-based). */
  plan: MissionPlan | ((attempt: number) => unknown)
  worker?: FakeScript
  debugger?: FakeScript
  reviewer?: FakeScript
  verifier?: FakeScript
  researcher?: FakeScript
}

/** Role-dispatching script with sensible defaults: approving reviewer, passing verifier, file-writing worker and debugger. */
export function scenarioScript(s: ScenarioScripts): FakeScript {
  let plannerCalls = 0
  const planner: FakeScript = async (_spec, ctx) => {
    const output = typeof s.plan === 'function' ? s.plan(plannerCalls) : s.plan
    plannerCalls++
    await ctx.emitText('plan')
    await ctx.completeTurn({ text: 'plan', structuredOutput: output })
  }
  const fixer: FakeScript = async (spec, ctx) => {
    await writeFiles(spec, ctx, { [`${keyOf(spec)}-fix.txt`]: 'fixed' })
    await ctx.completeTurn({ text: 'Applied a fix' })
  }
  const reviewer = s.reviewer ?? completeWith({ text: 'review', structuredOutput: approvedReview })
  return scriptsByRole({
    planner,
    worker: s.worker ?? fileWorker,
    debugger: s.debugger ?? fixer,
    reviewer,
    // High-risk tasks are reviewed by the security reviewer role.
    security_reviewer: reviewer,
    verifier: s.verifier ?? completeWith({ text: 'verify', structuredOutput: passedVerification }),
    researcher: s.researcher ?? completeWith({ text: 'research notes' }),
  })
}

/** Sessions started by the fake runtime for a role. */
export function sessionsOf(h: Harness, role: string): Harness['runtime']['sessions'] {
  return h.runtime.sessions.filter((s) => s.role === role)
}
