import { existsSync } from 'node:fs'
import { TERMINAL_RUN_STATES, type Run } from '@shared/domain'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'
import { buildCheckpoint, buildOvernightReport, type GitStateCapture } from './report'
import type { AutonomousWorkload, WorkloadDeadlineState, WorkloadPhase, WorkloadSummaryInput } from './workload'

/** The orchestrator calls a mission workload needs. */
export interface MissionHost {
  pauseRun(runId: string, reason?: 'user' | 'quota' | 'recovery', detail?: string, cause?: 'user'): Promise<unknown>
  resumeRun(runId: string): Promise<unknown>
  cancelRun(runId: string): Promise<unknown>
  recover(runId: string, action: 'resume' | 'inspect' | 'cancel'): Promise<unknown>
}

export interface MissionWorkloadDeps {
  repos: Repositories
  bus: EventBus
  git: GitService
  orchestrator: MissionHost
  now: () => number
  log: (line: string) => void
}

const MAX_CHECKPOINTS = 200
const iso = (ms: number): string => new Date(ms).toISOString()

/** An overnight mission: one run of the orchestrator. */
export class MissionWorkload implements AutonomousWorkload {
  readonly type = 'mission' as const

  constructor(
    readonly id: string,
    private readonly deps: MissionWorkloadDeps,
  ) {}

  private run(): Run | null {
    return this.deps.repos.runs.get(this.id)
  }

  get state(): WorkloadPhase {
    const run = this.run()
    if (!run) return 'missing'
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') return run.state
    if (run.state === 'paused') return run.pauseReason === 'quota' ? 'quota_wait' : 'paused'
    return 'working'
  }

  /** The run starts when the orchestrator creates it; the failsafe is armed in its `prepare` step. */
  async start(): Promise<void> {}

  async pause(detail: string): Promise<void> {
    const run = this.run()
    if (!run || TERMINAL_RUN_STATES.includes(run.state) || run.state === 'paused') return
    await this.deps.orchestrator.pauseRun(this.id, 'user', detail, 'user')
  }

  async resume(): Promise<void> {
    await this.deps.orchestrator.resumeRun(this.id)
  }

  async cancel(): Promise<void> {
    await this.deps.orchestrator.cancelRun(this.id)
  }

  checkpoint(reason: string): boolean {
    const { repos, bus } = this.deps
    try {
      const run = this.run()
      if (!run) return false
      const row = repos.checkpoints.insert({ id: newId(), runId: this.id, reason, snapshot: buildCheckpoint(repos, run), createdAt: iso(this.deps.now()) })
      if (repos.checkpoints.count(this.id) > MAX_CHECKPOINTS) repos.checkpoints.prune(this.id, MAX_CHECKPOINTS)
      bus.emit({ runId: this.id, type: 'checkpoint.saved', payload: { checkpointId: row.id, reason } })
      return true
    } catch (e) {
      this.deps.log(`checkpoint ${this.id}: ${errorMessage(e)}`)
      return false
    }
  }

  isTerminal(): boolean {
    const run = this.run()
    return !run || TERMINAL_RUN_STATES.includes(run.state)
  }

  getDeadlineState(): WorkloadDeadlineState {
    const run = this.run()
    const phase = this.state
    const outcome =
      phase === 'completed'
        ? { reason: 'SUCCESS' as const }
        : phase === 'failed'
          ? { reason: 'FAILED' as const, ...(run?.error ? { detail: run.error } : {}) }
          : phase === 'cancelled'
            ? { reason: 'USER_CANCELLED' as const }
            : phase === 'missing'
              ? { reason: 'FAILED' as const, detail: 'The run no longer exists.' }
              : null
    return { phase, outcome, quotaResetsAt: null }
  }

  summarize(input: WorkloadSummaryInput): string {
    return buildOvernightReport({
      repos: this.deps.repos,
      record: input.record,
      run: this.deps.repos.runs.require(this.id),
      reason: input.reason,
      detail: input.detail,
      finishedAt: input.finishedAt,
      git: (input.finalization as GitStateCapture | null) ?? null,
      powerPlan: input.powerPlan,
    })
  }

  projectRoot(): string | null {
    const run = this.run()
    const project = run ? this.deps.repos.projects.get(run.projectId) : null
    return project && existsSync(project.rootPath) ? project.rootPath : null
  }

  extend(minutes: number): void {
    const run = this.deps.repos.runs.require(this.id)
    this.deps.repos.runs.update(this.id, { config: { ...run.config, maxDurationMinutes: Math.min(24 * 60, run.config.maxDurationMinutes + minutes) } })
  }

  async recoverAfterRestart(): Promise<void> {
    const run = this.run()
    if (run?.state === 'paused' && run.pauseReason === 'recovery') {
      await this.deps.orchestrator.recover(this.id, 'resume')
      this.checkpoint('recovery')
    }
  }

  /** Commits unfinished task worktrees (when asked) and captures what Git looks like now. */
  async getFinalizationState(options: { commitWork: boolean }): Promise<GitStateCapture | null> {
    const { repos, git } = this.deps
    const run = repos.runs.require(this.id)
    const project = repos.projects.get(run.projectId)
    if (!project) return null
    const capture: GitStateCapture = {
      projectRoot: project.rootPath,
      branch: null,
      status: null,
      integrationBranch: run.integrationBranch,
      integrationHead: null,
      commits: [],
      filesChanged: [],
      checkpointCommits: [],
      error: null,
    }
    const problems: string[] = []
    const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        problems.push(`${what}: ${errorMessage(e)}`)
      }
    }
    if (options.commitWork) {
      const settings = repos.settings.get().git
      const author = { name: settings.commitAuthorName, email: settings.commitAuthorEmail }
      for (const worktree of repos.worktrees.listActive(run.id)) {
        if (worktree.taskId === null || !existsSync(worktree.path)) continue
        const task = repos.tasks.get(worktree.taskId)
        if (!task || task.state === 'completed' || task.state === 'cancelled') continue
        await attempt(`checkpoint commit ${task.key}`, async () => {
          // A half-finished merge would be committed with its conflict markers.
          if (await git.isMergeInProgress(worktree.path)) throw new Error('a merge is in progress; nothing was committed')
          const commit = await git.commitAll(worktree.path, `nexus: overnight checkpoint of unfinished work (${task.key})`, author)
          if (commit) capture.checkpointCommits.push({ task: task.key, branch: worktree.branch, commit })
        })
      }
    }
    await attempt('branch', async () => {
      capture.branch = await git.currentBranch(project.rootPath)
    })
    await attempt('status', async () => {
      capture.status = await git.status(project.rootPath)
    })
    if (run.baseCommit && run.integrationBranch) {
      const base = run.baseCommit
      const branch = run.integrationBranch
      await attempt('integration head', async () => {
        capture.integrationHead = await git.resolveCommit(project.rootPath, branch)
      })
      await attempt('commits', async () => {
        capture.commits = await git.log(project.rootPath, `${base}..${branch}`, 200)
      })
      await attempt('changed files', async () => {
        capture.filesChanged = await git.changedFiles(project.rootPath, base, branch)
      })
    }
    capture.error = problems.length > 0 ? problems.join('; ') : null
    return capture
  }
}
