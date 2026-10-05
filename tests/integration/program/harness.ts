import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Run } from '@shared/domain'
import { newId, nowIso, shortId } from '@shared/ids'
import { PROGRAM_POLICY_PRESETS, type MilestoneJudgment, type PlannedMilestone, type Program, type ProgramPlan, type ProgramPolicy, type ProgramSchedule, type Replan } from '@shared/program'
import { EventBus } from '@main/modules/events'
import { GitService } from '@main/modules/git'
import { createRepositories, openDatabase, type Database, type Repositories } from '@main/modules/persistence'
import { ProgramEngine, REASONING_MARKERS, type ProgramRunHost } from '@main/modules/program'
import { makeProject, makeTask, runConfig } from '../persistence/fixtures'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type MissionBehavior = 'complete' | 'fail' | 'quota' | 'hang' | 'nochange' | 'checks_fail'
export type AskKind = 'plan' | 'replan' | 'verify' | 'background'

export interface CreateInput {
  projectId: string
  mode: string
  preset: string
  prompt: string
  strategy?: string
  acceptanceCriteria?: string[]
  overrides?: Record<string, unknown>
  baseRef?: string
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function milestone(key: string, over: Partial<PlannedMilestone> = {}): PlannedMilestone {
  return { key, title: `Milestone ${key}`, objective: `Deliver ${key}.`, acceptanceCriteria: [`${key} works`], workstream: 'core', expertise: 'backend', dependsOn: [], complexity: 'small', risk: 'low', ...over }
}

export function planJson(milestones: PlannedMilestone[], over: Partial<ProgramPlan> = {}): string {
  const plan: ProgramPlan = { goal: 'The goal, restated.', successCriteria: ['Everything works'], milestones, risks: [], constraints: [], ...over }
  return `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`
}

export function judgmentJson(verdict: 'accepted' | 'rejected', over: Partial<MilestoneJudgment> = {}): string {
  const judgment: MilestoneJudgment = {
    verdict,
    criteria: [{ criterion: 'it works', met: verdict === 'accepted', evidence: verdict === 'accepted' ? 'The diff adds it and the checks pass.' : 'Nothing in the diff does this.' }],
    gaps: verdict === 'accepted' ? [] : ['The criterion is not met yet.'],
    backlog: [],
    memory: [],
    ...over,
  }
  return `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\``
}

export function replanJson(replan: Partial<Replan> = {}): string {
  const full: Replan = { action: 'keep', reason: 'The remaining plan still fits.', milestones: [], defer: [], strategyNote: null, ...replan }
  return `\`\`\`json\n${JSON.stringify(full)}\n\`\`\``
}

/**
 * Stands in for the orchestrator. A reasoning (`ask`) run is answered from a queue chosen by the marker in
 * its prompt; a mission run fabricates a commit on an integration branch in the real repository and a
 * check result, then ends the run with the event the real orchestrator emits.
 */
export class FakeProgramHost implements ProgramRunHost {
  readonly created: { input: CreateInput; run: Run; kind: AskKind | 'mission' }[] = []
  readonly cancelled: string[] = []
  readonly paused: string[] = []
  readonly resumed: string[] = []
  /** Answers per kind; the last one repeats when the queue runs out. */
  readonly answers: Record<AskKind, string[]> = { plan: [], replan: [replanJson()], verify: [judgmentJson('accepted')], background: [] }
  /** What happens to the n-th mission (0-based). */
  mission: (index: number, input: CreateInput) => MissionBehavior = () => 'complete'
  /** What happens to a reasoning run: answer it, or leave it running / limited. */
  ask: (kind: AskKind, index: number) => 'answer' | 'hang' | 'quota' | 'fail' = () => 'answer'
  /** The strategy a mission run reports having resolved to. */
  resolved: (index: number, input: CreateInput) => string = (_i, input) => (input.strategy === 'ADAPTIVE' || !input.strategy ? 'BUILD' : input.strategy)
  delayMs = 0
  /** Whether the project of a run has a check command that ran. Default: yes. */
  checksRan: (run: Run) => boolean = () => true
  /** The files a completing mission writes (path to content), given the repository it runs in. Default: one marker file. */
  files: ((run: Run, repoPath: string) => Record<string, string>) | null = null
  private missions = 0
  private readonly asks: Record<AskKind, number> = { plan: 0, replan: 0, verify: 0, background: 0 }

  constructor(
    private readonly repos: Repositories,
    private readonly bus: EventBus,
    private readonly git: GitService,
    private readonly root: string,
  ) {}

  missionsOf(): { input: CreateInput; run: Run }[] {
    return this.created.filter((c) => c.kind === 'mission')
  }

  private kindOf(prompt: string): AskKind {
    // The workspace planner (0.5) is answered from the same queue as the program planner.
    if (prompt.startsWith(REASONING_MARKERS.plan) || prompt.startsWith('NEXUS WORKSPACE PLANNER')) return 'plan'
    if (prompt.startsWith(REASONING_MARKERS.replan)) return 'replan'
    if (prompt.startsWith(REASONING_MARKERS.verify)) return 'verify'
    return 'background'
  }

  async createRun(input: CreateInput): Promise<Run> {
    const project = this.repos.projects.require(input.projectId)
    const baseCommit = sh(project.rootPath, 'rev-parse', input.baseRef ?? 'HEAD')
    const isAsk = input.mode === 'ask'
    const kind: AskKind | 'mission' = isAsk ? this.kindOf(input.prompt) : 'mission'
    const index = isAsk ? this.asks[kind as AskKind]++ : this.missions++
    const run = this.repos.runs.insert({
      id: newId(),
      projectId: project.id,
      mode: isAsk ? 'ask' : 'mission',
      preset: 'balanced',
      state: 'executing',
      resumeState: null,
      pauseReason: null,
      prompt: input.prompt,
      plan: null,
      baseBranch: input.baseRef ?? 'main',
      baseCommit,
      integrationBranch: null,
      config: { ...runConfig(), ...(input.overrides ?? {}), ...(isAsk ? {} : { strategy: { requested: input.strategy ?? 'BUILD', resolved: this.resolved(index, input) } }) } as Run['config'],
      error: null,
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
    })
    this.created.push({ input, run, kind })
    const act = (): void => {
      if (isAsk) {
        const what = this.ask(kind as AskKind, index)
        if (what === 'answer') this.answer(run.id)
        else if (what === 'quota') this.quota(run.id)
        else if (what === 'fail') this.fail(run.id, 'the session crashed')
      } else {
        const behavior = this.mission(index, input)
        if (behavior !== 'hang') void this.apply(run.id, behavior).catch(() => undefined)
      }
    }
    setTimeout(act, this.delayMs)
    return run
  }

  /** Answers a reasoning run from its queue and completes it. */
  answer(runId: string): void {
    const run = this.repos.runs.require(runId)
    if (run.state === 'cancelled' || run.state === 'completed') return
    const kind = this.kindOf(run.prompt)
    const queue = this.answers[kind]
    const text = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? 'I have no answer.')
    this.repos.tasks.insert(makeTask(runId, 'ask', { state: 'completed', resultSummary: text }))
    this.repos.runs.update(runId, { state: 'completed', finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'answered' } })
  }

  quota(runId: string): void {
    this.repos.runs.update(runId, { state: 'paused', resumeState: 'executing', pauseReason: 'quota' })
    this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'quota', cause: 'quota' } })
  }

  fail(runId: string, error: string): void {
    this.repos.runs.update(runId, { state: 'failed', error, finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.failed', payload: { error } })
  }

  async apply(runId: string, behavior: MissionBehavior): Promise<void> {
    const run = this.repos.runs.require(runId)
    if (run.state === 'cancelled' || run.state === 'completed' || run.state === 'failed') return
    if (behavior === 'quota') return this.quota(runId)
    if (behavior === 'fail') return this.fail(runId, 'the planner gave up')
    const branch = `nexus/integration-${shortId(runId)}`
    // The repository of the run's own project: a workspace has several.
    const root = this.repos.projects.get(run.projectId)?.rootPath ?? this.root
    if (behavior === 'nochange') {
      sh(root, 'branch', '--no-track', branch, run.baseCommit ?? 'HEAD')
    } else {
      // A commit on the integration branch, made in a throwaway worktree: the user's checkout is not touched.
      const dir = mkdtempSync(join(tmpdir(), 'nexus-program-wt-'))
      rmSync(dir, { recursive: true, force: true })
      sh(root, 'worktree', 'add', '-q', '-b', branch, dir, run.baseCommit ?? 'HEAD')
      const files = this.files?.(run, root) ?? { [`mission-${shortId(runId)}.txt`]: `work of ${runId}\n` }
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), content)
      }
      sh(dir, 'add', '-A')
      sh(dir, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', 'commit', '-q', '--allow-empty', '-m', `mission ${shortId(runId)}`)
      sh(root, 'worktree', 'remove', '--force', dir)
    }
    this.repos.tasks.insert(makeTask(runId, 'work', { state: 'completed', resultSummary: 'Implemented the milestone.' }))
    this.repos.verifications.insert({ id: newId(), runId, taskId: null, agentId: null, attempt: 1, kind: 'checks', passed: behavior !== 'checks_fail', summary: behavior === 'checks_fail' ? '1 of 2 commands failed' : 'All commands passed', criteria: [], commands: this.checksRan(run) ? [{ name: 'test', command: 'npm test', cwd: root, exitCode: behavior === 'checks_fail' ? 1 : 0, timedOut: false, durationMs: 1, output: '' }] : [], failures: [], createdAt: nowIso() })
    this.repos.runs.update(runId, { state: 'completed', integrationBranch: branch, finishedAt: nowIso() })
    this.bus.emit({ runId, type: 'run.completed', payload: { summary: 'done' } })
  }

  async pauseRun(runId: string): Promise<void> {
    this.paused.push(runId)
    const run = this.repos.runs.require(runId)
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled' || run.state === 'paused') return
    this.repos.runs.update(runId, { state: 'paused', resumeState: run.state, pauseReason: 'user' })
    this.bus.emit({ runId, type: 'run.paused', payload: { reason: 'user', cause: 'user' } })
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

  async recover(runId: string): Promise<void> {
    await this.resumeRun(runId)
  }

  /** What the orchestrator does at startup: runs that were working are paused for recovery. */
  simulateRestart(): void {
    for (const { run } of this.created) {
      const current = this.repos.runs.require(run.id)
      if (current.state === 'executing') this.repos.runs.update(run.id, { state: 'paused', resumeState: 'executing', pauseReason: 'recovery' })
    }
  }
}

export interface ProgramRig {
  root: string
  repo: string
  db: Database
  repos: Repositories
  bus: EventBus
  git: GitService
  host: FakeProgramHost
  engine: ProgramEngine
  project: Project
  gate: { open: boolean; set(open: boolean): void }
  advance(ms: number): void
  now(): number
  /** Create and start a program with the given plan answers queued. */
  program(options?: { policy?: Partial<ProgramPolicy>; schedule?: ProgramSchedule | null; goal?: string; start?: boolean }): Promise<Program>
  get(id: string): Program
  /** Tick until the predicate holds. */
  until(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>
  untilState(id: string, states: Program['state'][], timeoutMs?: number): Promise<Program>
  /** A new engine on the same database (a restart of NEXUS). */
  restart(): ProgramEngine
  head(ref?: string): string
  cleanup(): Promise<void>
}

export function makeProgramRig(): ProgramRig {
  const root = mkdtempSync(join(tmpdir(), 'nexus-program-it-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
  sh(repo, 'config', 'user.name', 'Test User')
  sh(repo, 'config', 'user.email', 'test@example.com')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), '# scratch\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'initial')
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const git = new GitService()
  const project = repos.projects.insert(makeProject({ name: 'scratch', rootPath: repo }))
  const host = new FakeProgramHost(repos, bus, git, repo)
  let offset = 0
  const now = (): number => Date.now() + offset
  const listeners = new Set<() => void>()
  const gate = {
    open: true,
    set(open: boolean) {
      gate.open = open
      for (const l of listeners) l()
    },
  }
  const usage = { canDispatch: () => gate.open, onChange: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) }
  const engines: ProgramEngine[] = []
  const build = (): ProgramEngine => {
    const engine = new ProgramEngine({ repos, bus, git, host, usage, now, tickIntervalMs: 0 })
    engines.push(engine)
    return engine
  }
  const rig: ProgramRig = {
    root,
    repo,
    db,
    repos,
    bus,
    git,
    host,
    engine: build(),
    project,
    gate,
    advance: (ms) => void (offset += ms),
    now,
    async program(options = {}) {
      return rig.engine.create({
        projectId: project.id,
        name: 'Test program',
        goal: options.goal ?? 'Build the thing in milestones.',
        policy: { ...PROGRAM_POLICY_PRESETS.autonomous, ...options.policy },
        schedule: options.schedule ?? null,
        start: options.start ?? true,
      })
    },
    get: (id) => repos.programs.require(id),
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
    async untilState(id, states, timeoutMs = 30_000) {
      await rig.until(() => states.includes(repos.programs.require(id).state), `program state ${states.join('|')} (it is ${repos.programs.require(id).state}: ${repos.programs.require(id).blockedReason ?? ''})`, timeoutMs).catch((e: unknown) => {
        const p = repos.programs.require(id)
        throw new Error(`${e instanceof Error ? e.message : String(e)}; program is ${p.state} (${p.pauseReason ?? p.blockedReason ?? 'no reason'}); decisions: ${repos.programDecisions.listByProgram(id).map((d) => d.kind).join(' > ')}`)
      })
      return repos.programs.require(id)
    },
    restart() {
      rig.engine.dispose()
      host.simulateRestart()
      rig.engine = build()
      return rig.engine
    },
    head: (ref = 'HEAD') => sh(repo, 'rev-parse', ref),
    async cleanup() {
      for (const e of engines) e.dispose()
      await Promise.race([Promise.allSettled(engines.map((e) => e.idle())), sleep(2000)])
      db.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
  return rig
}
