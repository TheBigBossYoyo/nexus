import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Project, Run, Task } from '@shared/domain'
import type { DiffFile, DiffResult, RunSummary } from '@shared/ipc'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import type { DiffResult as GitDiff, GitService } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'
import { profileProject, type ProfilerGit } from '@main/modules/profile/project-profiler'

const EMPTY_DIFF = (scope: 'task' | 'run'): DiffResult => ({ scope, base: null, head: null, files: [], patch: '', truncated: false })

function toDiff(scope: 'task' | 'run', base: string | null, head: string | null, diff: GitDiff): DiffResult {
  const files: DiffFile[] = diff.files.map((f) => ({
    path: f.path,
    status: f.status === 'copied' ? 'added' : f.status === 'type_changed' ? 'modified' : f.status,
    additions: f.additions,
    deletions: f.deletions,
  }))
  return { scope, base, head, files, patch: diff.patch, truncated: diff.truncated }
}

/** Opening and profiling projects. Discovery is read-only. */
export class ProjectService {
  private readonly profilerGit: ProfilerGit

  constructor(
    private readonly repos: Repositories,
    private readonly git: GitService,
  ) {
    this.profilerGit = {
      isRepository: (p) => git.isRepository(p),
      repoRoot: (p) => git.repoRoot(p).catch(() => null),
      currentBranch: (p) => git.currentBranch(p).catch(() => null),
      headCommit: (p) => git.headCommit(p).catch(() => null),
      status: async (p) => ({ dirty: !(await git.status(p)).clean }),
    }
  }

  async open(path: string): Promise<Project> {
    const absolute = resolve(path)
    if (!existsSync(absolute)) throw new NexusError('not_found', `Folder does not exist: ${absolute}`)
    const isRepo = await this.git.isRepository(absolute)
    const rootPath = isRepo ? resolve(await this.git.repoRoot(absolute)) : absolute
    const profile = await profileProject(rootPath, this.profilerGit)
    const existing = this.repos.projects.getByRootPath(rootPath)
    if (existing) return this.repos.projects.update(existing.id, { profile, lastOpenedAt: nowIso() })
    return this.repos.projects.insert({
      id: newId(),
      name: basename(rootPath),
      rootPath,
      profile,
      respectProjectClaudeConfig: false,
      createdAt: nowIso(),
      lastOpenedAt: nowIso(),
    })
  }

  async reprofile(projectId: string): Promise<Project> {
    const project = this.repos.projects.require(projectId)
    const profile = await profileProject(project.rootPath, this.profilerGit)
    return this.repos.projects.update(projectId, { profile })
  }
}

/** Read models assembled from durable state for the UI. */
export class QueryService {
  constructor(
    private readonly repos: Repositories,
    private readonly git: GitService,
  ) {}

  async runSummary(runId: string): Promise<RunSummary> {
    const { repos } = this
    const run = repos.runs.require(runId)
    const tasks = repos.tasks.listByRun(runId)
    const reviews = repos.reviews.listByRun(runId)
    const verifications = repos.verifications.listByRun(runId)
    const agents = repos.agents.listByRun(runId)
    const repoRoot = repos.projects.get(run.projectId)?.rootPath

    let commits = 0
    let filesChanged = 0
    if (repoRoot && run.baseCommit && run.integrationBranch) {
      commits = await this.git.commitCount(repoRoot, run.baseCommit, run.integrationBranch).catch(() => 0)
      filesChanged = (await this.git.changedFiles(repoRoot, run.baseCommit, run.integrationBranch).catch(() => [])).length
    }
    const checks = verifications.filter((v) => v.kind === 'checks')
    const lastChecks = (checks.filter((v) => v.taskId === null).at(-1) ?? checks.at(-1))?.commands ?? []
    const costs = agents.map((a) => a.metrics.costUsd).filter((c): c is number => c !== null)
    const sessions = agents.reduce((n, a) => n + repos.sessions.listByAgent(a.id).length, 0)
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()

    return {
      runId,
      tasksTotal: tasks.length,
      tasksCompleted: tasks.filter((t) => t.state === 'completed').length,
      tasksFailed: tasks.filter((t) => t.state === 'failed').length,
      tasksCancelled: tasks.filter((t) => t.state === 'cancelled').length,
      reviewsTotal: reviews.length,
      reviewsApproved: reviews.filter((r) => r.verdict === 'approved').length,
      verificationsPassed: verifications.filter((v) => v.kind === 'verifier' && v.passed).length,
      verificationsFailed: verifications.filter((v) => v.kind === 'verifier' && !v.passed).length,
      filesChanged,
      commits,
      agentSessions: sessions,
      durationMs: run.startedAt ? end - Date.parse(run.startedAt) : null,
      lastChecks,
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    }
  }

  async runDiff(run: Run): Promise<DiffResult> {
    const repoRoot = this.repos.projects.get(run.projectId)?.rootPath
    if (!repoRoot || !run.baseCommit || !run.integrationBranch) return EMPTY_DIFF('run')
    const diff = await this.git.diff(repoRoot, run.baseCommit, run.integrationBranch)
    return toDiff('run', run.baseCommit, run.integrationBranch, diff)
  }

  async taskDiff(task: Task): Promise<DiffResult> {
    const { repos, git } = this
    // Repair tasks work in their parent's worktree.
    const worktree = task.worktreeId ? repos.worktrees.get(task.worktreeId) : null
    if (!worktree) return EMPTY_DIFF('task')
    const run = repos.runs.require(task.runId)
    if (worktree.state !== 'removed' && existsSync(worktree.path)) {
      const base =
        (run.integrationBranch ? await git.mergeBase(worktree.path, 'HEAD', run.integrationBranch).catch(() => null) : null) ??
        worktree.baseCommit
      return toDiff('task', base, worktree.branch, await git.diffWorkingTree(worktree.path, base))
    }
    const repoRoot = repos.projects.get(run.projectId)?.rootPath
    if (!repoRoot) return EMPTY_DIFF('task')
    return toDiff('task', worktree.baseCommit, worktree.branch, await git.diff(repoRoot, worktree.baseCommit, worktree.branch))
  }
}
