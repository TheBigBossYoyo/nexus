import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Run, Task, TaskError, Worktree } from '@shared/domain'
import { newId, nowIso, shortId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { MAX_SPECULATIVE_CANDIDATES, type CandidateEvidence, type CandidateResult, type SpeculativeRun } from '@shared/v3'
import type { ComposedContext } from '@main/modules/context/context-engine'
import { rankCandidates } from '@main/modules/strategy/tournament'
import type { AgentOutcome, AgentRunResult, SessionControl } from './agent-runner'
import { composeForTask } from './context-source'
import type { Core } from './core'
import type { PipelineHost } from './pipeline'
import { purposeFor } from './task-kind'

const LABELS = ['a', 'b', 'c'] as const
const RESUMABLE_END_REASONS = new Set(['paused', 'quota', 'auth', 'app_restart', 'shutdown', 'network'])
/** Losing candidates keep their diff for inspection after their repository is gone. */
const MAX_STORED_PATCH_CHARS = 200_000
const HEARTBEAT_MS = 30_000

/** What the task pipeline lends to the speculative stage. */
export interface SpeculationHooks {
  halted(runId: string, control: SessionControl): boolean
  /** True when the outcome stops the pipeline without failing the task (pause, quota, auth, stop). */
  haltOutcome(run: Run, outcome: AgentOutcome, control: SessionControl): boolean
  leaseExpiry(run: Run): string
}

const emptyEvidence = (): CandidateEvidence => ({
  implemented: false,
  checksPassed: null,
  checksFailedCount: null,
  acceptancePassed: null,
  criticalFindings: null,
  highFindings: null,
  filesChanged: null,
  linesChanged: null,
  durationMs: null,
  inputTokens: null,
  outputTokens: null,
})

/**
 * Speculative implement stage: N independent candidates implement the same task, the check commands
 * run for each, and a deterministic tournament picks one. The winner's commits are fetched and
 * fast-forwarded into the task's own worktree, which then goes through the unchanged checks, review,
 * verification and merge stages. Losing candidates' evidence is stored before their directories are removed.
 *
 * Isolation: every candidate works in its own clone of the repository, made at the task's base commit
 * before any candidate has written anything. A clone has its own object store and refs and no remote, so
 * no Git command inside it can show another candidate's commits (worktrees of one repository would share
 * every branch). The session's path boundary is its own directory, no message is routed between
 * candidates, and all are given the same prompt.
 *
 * Durable progress: `running` (candidates working) → `decided` (tournament stored) → `adopted` (winner in
 * the task worktree). A pause, a usage limit or a restart continues from the stored state; a `decided`
 * run only repeats the adoption, which is idempotent.
 */
export class SpeculativeStage {
  constructor(
    private readonly core: Core,
    private readonly host: PipelineHost,
    private readonly hooks: SpeculationHooks,
  ) {}

  /** Final text of each candidate's session, kept only until the winner is known. */
  private readonly resultText = new Map<string, string>()

  /** A speculative run of this task that still has to finish (candidates or adoption outstanding). */
  pending(taskId: string): SpeculativeRun | null {
    const latest = this.core.deps.repos.speculativeRuns.latestForTask(taskId)
    return latest && (latest.state === 'running' || latest.state === 'decided') ? latest : null
  }

  /** How many candidates this task's implement stage runs; 0 for the normal single implementation. */
  candidatesFor(run: Run, task: Task): number {
    const n = run.config.strategy?.speculativeCandidates ?? 0
    if (n < 2) return 0
    // Only the mission's own implementing task is speculative, and only on its first attempt: retries and
    // repairs work on the chosen candidate.
    if (task.role !== 'worker' || task.parentTaskId !== null) return 0
    const previous = this.core.deps.repos.speculativeRuns.latestForTask(task.id)
    if (previous) return this.pending(task.id) ? Math.min(Math.max(previous.candidateCount, 2), MAX_SPECULATIVE_CANDIDATES) : 0
    if (task.attempt > 0) return 0
    return Math.min(n, MAX_SPECULATIVE_CANDIDATES)
  }

  /**
   * Runs the candidates and the tournament. Resolves true when the task's worktree now holds the chosen
   * implementation and the pipeline should continue with checks; false when the pipeline must stop
   * (halted, or the task failed because no candidate produced a result).
   */
  async run(run: Run, initial: Task, worktree: Worktree, projectRoot: string, control: SessionControl, count: number): Promise<boolean> {
    const { repos, bus, git } = this.core.deps
    const resumed = this.pending(initial.id)
    const attempt = resumed && initial.attempt > 0 ? initial.attempt : initial.attempt + 1
    const task = this.core.setTaskState(initial.id, 'running', {
      attempt,
      startedAt: initial.startedAt ?? nowIso(),
      leaseOwner: newId(),
      leaseExpiresAt: this.hooks.leaseExpiry(run),
      error: null,
    })
    if (!resumed) bus.emit({ runId: run.id, taskId: task.id, type: 'task.started', payload: { attempt } })
    this.core.graph.clearYield(task.id)

    let spec = resumed ?? this.begin(run, task, await git.headCommit(worktree.path), count)
    if (spec.state === 'running') {
      const outcome = await this.compete(run, task, spec, projectRoot, control, count)
      if (outcome !== 'decided') return false
      spec = repos.speculativeRuns.require(spec.id)
    }

    const winner = spec.winnerCandidateId ? repos.candidateResults.get(spec.winnerCandidateId) : null
    if (!winner) {
      await this.cleanup(run, spec)
      return false
    }
    try {
      await this.adopt(run, task, spec, winner, worktree)
    } catch (e) {
      // The winner cannot be brought into the task worktree (its repository is gone, or Git refused). The
      // speculative stage is over without a result; the task fails as retryable and its retry is a normal
      // single implementation.
      this.core.log(`adopting candidate ${winner.label} of ${task.key} failed: ${errorMessage(e)}`)
      repos.speculativeRuns.update(spec.id, { state: 'failed', finishedAt: nowIso() })
      await this.cleanup(run, spec)
      const error: TaskError = { what: 'The selected candidate could not be adopted', where: `Worker/${task.key}`, why: errorMessage(e), retryable: true }
      if (this.core.tryTaskState(task.id, 'failed', { error })) {
        bus.emit({ runId: run.id, taskId: task.id, type: 'task.failed', payload: error })
      }
      return false
    }
    await this.cleanup(run, spec)
    return true
  }

  /** Candidates work, their checks run, the tournament is stored. */
  private async compete(run: Run, task: Task, spec: SpeculativeRun, projectRoot: string, control: SessionControl, count: number): Promise<'decided' | 'halt' | 'failed'> {
    const { repos, bus } = this.core.deps
    const existing = repos.candidateResults.listBySpeculativeRun(spec.id)
    // A crash while candidates were being provisioned leaves fewer than planned: provision the rest.
    let candidates = existing.length < count ? await this.provision(run, task, spec, count, existing) : existing
    if (existing.length === 0) {
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'speculative.started',
        payload: { speculativeRunId: spec.id, candidates: candidates.map((c) => c.label), baseCommit: spec.baseCommit },
      })
    }

    // The same context for every candidate, composed once (so routed messages reach all of them): each
    // prompt differs only in the candidate's own directory and branch. None is told the others exist.
    const purpose = purposeFor(task)
    const first = candidates[0]!
    let base: ComposedContext | null = null
    const contextFor = (candidate: CandidateResult): ComposedContext => {
      base ??= composeForTask(this.core, run, { ...task, branch: first.branch }, purpose, first.worktreePath, null)
      const prompt = base.prompt.split(first.worktreePath).join(candidate.worktreePath).split(first.branch).join(candidate.branch)
      const packId = newId()
      return { prompt, pack: { ...base.pack, id: packId, entries: base.pack.entries.map((e) => ({ ...e, id: newId(), packId })) } }
    }
    const results = await Promise.all(
      candidates.map((candidate) => this.runCandidate(run, task, spec, candidate, projectRoot, control, purpose, contextFor)),
    )
    if (this.hooks.halted(run.id, control) || results.some((r) => r === 'halt')) return 'halt'
    if (repos.tasks.require(task.id).state === 'cancelled') {
      repos.speculativeRuns.update(spec.id, { state: 'cancelled', finishedAt: nowIso() })
      await this.cleanup(run, spec)
      return 'halt'
    }

    candidates = repos.candidateResults.listBySpeculativeRun(spec.id)
    const result = rankCandidates(candidates.map((c) => ({ label: c.label, evidence: c.evidence })))
    const winner = candidates.find((c) => c.label === result.winner) ?? null
    bus.transaction(() => {
      for (const candidate of candidates) {
        repos.candidateResults.update(candidate.id, {
          rank: result.ranking.indexOf(candidate.label) + 1,
          outcome: candidate.label === result.winner ? 'winner' : candidate.evidence.implemented ? 'rejected' : 'failed',
        })
      }
      repos.tournamentDecisions.insert({
        id: newId(),
        speculativeRunId: spec.id,
        runId: run.id,
        taskId: task.id,
        winnerLabel: result.winner,
        ranking: result.ranking,
        comparisons: result.comparisons,
        confidence: result.confidence,
        reason: result.reason,
        createdAt: nowIso(),
      })
      repos.speculativeRuns.update(spec.id, {
        state: winner ? 'decided' : 'failed',
        winnerCandidateId: winner?.id ?? null,
        finishedAt: winner ? null : nowIso(),
      })
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'speculative.decided',
        payload: { speculativeRunId: spec.id, winner: result.winner, ranking: result.ranking, confidence: result.confidence },
      })
    })
    // What a rejected candidate recorded must not reach other agents as if the task had decided it.
    this.retractLoserRecords(run, candidates.filter((c) => c.label !== result.winner))

    if (winner) return 'decided'
    await this.cleanup(run, spec)
    const error: TaskError = {
      what: 'No speculative candidate produced a result',
      where: `Worker/${task.key}`,
      why: result.reason,
      retryable: true,
    }
    if (this.core.tryTaskState(task.id, 'failed', { error })) {
      bus.emit({ runId: run.id, taskId: task.id, type: 'task.failed', payload: error })
    }
    return 'failed'
  }

  /**
   * Brings the winner's commits into the task worktree. Same base commit, so it is a fast-forward: no merge
   * commit, no conflict. Safe to repeat after a crash: fetching and fast-forwarding to a commit the
   * worktree already has changes nothing.
   */
  private async adopt(run: Run, task: Task, spec: SpeculativeRun, winner: CandidateResult, worktree: Worktree): Promise<void> {
    const { repos, git } = this.core.deps
    const head = await git.headCommit(worktree.path)
    if (winner.headCommit && head !== winner.headCommit) {
      if (!existsSync(winner.worktreePath)) {
        throw new Error(`The winning candidate's repository is gone before its commits were adopted (${winner.worktreePath})`)
      }
      await this.host.withMergeLock(run.id, async () => {
        // Dependency setup may have touched tracked files; a fast-forward refuses a dirty tree.
        await this.core.cleanWorktree(worktree.path)
        // From the clone's Git directory, named and checked by NEXUS, and with every object verified as it
        // arrives: the clone was written by the candidate's code.
        await git.run(worktree.path, ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--quiet', await git.cloneGitDir(winner.worktreePath), winner.branch])
        await git.run(worktree.path, ['merge', '--ff-only', '--no-verify', 'FETCH_HEAD'])
      })
    }
    const text = this.resultText.get(winner.id)
    if (text) repos.tasks.update(task.id, { resultSummary: text })
    repos.speculativeRuns.update(spec.id, { state: 'adopted', finishedAt: nowIso() })
  }

  private begin(run: Run, task: Task, baseCommit: string, count: number): SpeculativeRun {
    return this.core.deps.repos.speculativeRuns.insert({
      id: newId(),
      runId: run.id,
      taskId: task.id,
      baseCommit,
      candidateCount: count,
      state: 'running',
      winnerCandidateId: null,
      createdAt: nowIso(),
      finishedAt: null,
    })
  }

  private async provision(run: Run, task: Task, spec: SpeculativeRun, count: number, existing: CandidateResult[]): Promise<CandidateResult[]> {
    const { repos, git, worktrees } = this.core.deps
    const repoRoot = this.core.project(run).rootPath
    const out = [...existing]
    for (const label of LABELS.slice(0, count)) {
      if (existing.some((c) => c.label === label)) continue
      let planned = worktrees.planPaths(run.id, `${task.key}-cand-${label}`)
      if (existsSync(planned.path)) planned = worktrees.planPaths(run.id, `${task.key}-cand-${label}-${shortId(newId())}`)
      // A clone, not a worktree: its own refs and objects, taken before any candidate has committed, and no
      // remote to fetch from. Git does not copy the hooks of the repository it clones.
      await mkdir(dirname(planned.path), { recursive: true })
      await git.run(repoRoot, ['clone', '--quiet', '--no-hardlinks', '--no-tags', '--no-checkout', repoRoot, planned.path])
      await git.run(planned.path, ['remote', 'remove', 'origin'])
      await git.run(planned.path, ['checkout', '--quiet', '-B', planned.branch, spec.baseCommit])
      await this.core.setupWorktree(run, task.id, planned.path)
      out.push(
        repos.candidateResults.insert({
          id: newId(),
          speculativeRunId: spec.id,
          runId: run.id,
          taskId: task.id,
          label,
          agentId: null,
          sdkSessionId: null,
          branch: planned.branch,
          worktreePath: planned.path,
          headCommit: null,
          evidence: emptyEvidence(),
          diffPatch: null,
          rank: null,
          outcome: 'pending',
          cleanedAt: null,
          createdAt: nowIso(),
        }),
      )
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }

  private async runCandidate(
    run: Run,
    task: Task,
    spec: SpeculativeRun,
    candidate: CandidateResult,
    projectRoot: string,
    control: SessionControl,
    purpose: ReturnType<typeof purposeFor>,
    contextFor: (candidate: CandidateResult) => ComposedContext,
  ): Promise<'done' | 'halt'> {
    const { repos, bus, git } = this.core.deps
    // Finished before a pause or restart (with or without a result): its evidence stands, it is not run again.
    if (candidate.headCommit !== null || candidate.outcome === 'failed') return 'done'
    if (!existsSync(candidate.worktreePath)) {
      repos.candidateResults.update(candidate.id, { outcome: 'failed' })
      return 'done'
    }

    const resumeId = this.resumableSession(candidate)
    const context = resumeId ? null : contextFor(candidate)
    const prompt = context?.prompt ?? 'Continue the task from where you stopped. Check `git status` and `git log` first to see what is already done.'

    const started = Date.now()
    let lastBeat = Date.now()
    let result: AgentRunResult
    try {
      result = await this.core.agents.run({
        run,
        task,
        role: task.role,
        purpose,
        label: `Worker/${task.key} · candidate ${candidate.label.toUpperCase()}`,
        cwd: candidate.worktreePath,
        worktreeRoot: candidate.worktreePath,
        projectRoot,
        prompt,
        ...(context ? { contextPack: context.pack } : {}),
        control,
        resumeSdkSessionId: resumeId,
        allowRotation: true,
        onActivity: () => {
          if (Date.now() - lastBeat < HEARTBEAT_MS) return
          lastBeat = Date.now()
          repos.tasks.update(task.id, { leaseExpiresAt: this.hooks.leaseExpiry(run) })
        },
      })
    } catch (e) {
      this.core.log(`candidate ${candidate.label} of ${task.key} failed to run: ${errorMessage(e)}`)
      repos.candidateResults.update(candidate.id, { outcome: 'failed' })
      return 'done'
    }
    repos.candidateResults.update(candidate.id, { agentId: result.agentId, sdkSessionId: result.sdkSessionId })
    if (result.outcome !== 'success') {
      if (this.hooks.haltOutcome(run, result.outcome, control)) return 'halt'
      repos.candidateResults.update(candidate.id, { outcome: 'failed' })
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'speculative.candidate',
        payload: { speculativeRunId: spec.id, label: candidate.label, implemented: false, checksPassed: null },
      })
      return 'done'
    }

    const implemented = !result.blocker
    this.resultText.set(candidate.id, result.text)
    const sha = await git.commitAll(candidate.worktreePath, `${task.key}: ${task.title} (candidate ${candidate.label})`, this.core.author())
    if (sha) {
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'git.commit.created',
        payload: { commit: sha, branch: candidate.branch, message: `${task.key}: candidate ${candidate.label}` },
      })
    }
    const evidence: CandidateEvidence = { ...emptyEvidence(), implemented, durationMs: Date.now() - started }
    if (implemented) {
      if (this.hooks.halted(run.id, control)) return 'halt'
      const checks = await this.core.runChecks(run, task.id, candidate.worktreePath, task.attempt)
      // Checks may leave build output behind; the candidate's commits are what is compared and adopted.
      await git.resetClean(candidate.worktreePath)
      evidence.checksPassed = checks.passed
      evidence.checksFailedCount = checks.commands.filter((c) => c.exitCode !== 0).length
    }
    const head = await git.headCommit(candidate.worktreePath)
    const diff = await git.diff(candidate.worktreePath, spec.baseCommit, head).catch(() => null)
    if (diff) {
      evidence.filesChanged = diff.files.length
      evidence.linesChanged = diff.files.reduce((n, f) => n + f.additions + f.deletions, 0)
    }
    const agent = repos.agents.get(result.agentId)
    evidence.inputTokens = agent?.metrics.inputTokens ?? null
    evidence.outputTokens = agent?.metrics.outputTokens ?? null
    repos.candidateResults.update(candidate.id, {
      headCommit: head,
      evidence,
      diffPatch: diff ? diff.patch.slice(0, MAX_STORED_PATCH_CHARS) : null,
    })
    bus.emit({
      runId: run.id,
      taskId: task.id,
      type: 'speculative.candidate',
      payload: { speculativeRunId: spec.id, label: candidate.label, implemented, checksPassed: evidence.checksPassed },
    })
    return 'done'
  }

  private resumableSession(candidate: CandidateResult): string | undefined {
    if (!candidate.agentId) return undefined
    const session = this.core.deps.repos.sessions.latestForAgent(candidate.agentId)
    if (!session?.sdkSessionId || !session.endReason) return undefined
    return RESUMABLE_END_REASONS.has(session.endReason) ? session.sdkSessionId : undefined
  }

  /**
   * Memory a losing candidate proposed is rejected and the decisions it recorded are removed, so neither is
   * promoted or shown to later agents as the task's own. The candidate's diff and evidence stay stored.
   */
  private retractLoserRecords(run: Run, losers: CandidateResult[]): void {
    const { repos } = this.core.deps
    const agentIds = new Set(losers.map((c) => c.agentId).filter((id): id is string => id !== null))
    if (agentIds.size === 0) return
    for (const entry of repos.memory.list({ projectId: run.projectId, runId: run.id, status: 'proposed' })) {
      if (entry.agentId && agentIds.has(entry.agentId)) repos.memory.update(entry.id, { status: 'rejected' })
    }
    for (const decision of repos.decisions.listByRun(run.id)) {
      if (decision.agentId && agentIds.has(decision.agentId)) repos.decisions.delete(decision.id)
    }
  }

  /**
   * Removes every candidate repository. The evidence (ranking, check results, diff) is already in the
   * database, and the winner's commits live in the task worktree by then.
   */
  private async cleanup(run: Run, spec: SpeculativeRun): Promise<void> {
    const { repos, bus, worktrees } = this.core.deps
    for (const candidate of repos.candidateResults.listBySpeculativeRun(spec.id)) {
      if (candidate.cleanedAt) continue
      try {
        await worktrees.removeDirectory(candidate.worktreePath)
        repos.candidateResults.update(candidate.id, { cleanedAt: nowIso() })
        bus.emit({ runId: run.id, taskId: spec.taskId, type: 'git.worktree.removed', payload: { path: candidate.worktreePath } })
      } catch (e) {
        this.core.log(`candidate cleanup skipped (${candidate.label}): ${errorMessage(e)}`)
      }
      this.resultText.delete(candidate.id)
    }
  }

  /**
   * Removes candidate repositories a cancelled or abandoned speculative run left behind. A decided run whose
   * winner was never adopted keeps its winner (the task can still be retried) unless `force`.
   */
  async cleanupRun(run: Run, options: { force?: boolean } = {}): Promise<void> {
    const { repos } = this.core.deps
    for (const spec of repos.speculativeRuns.listByRun(run.id)) {
      if (spec.state === 'decided' && !options.force) continue
      if (spec.state === 'running' || spec.state === 'decided') {
        repos.speculativeRuns.update(spec.id, { state: 'cancelled', finishedAt: nowIso() })
      }
      await this.cleanup(run, spec)
    }
  }
}
