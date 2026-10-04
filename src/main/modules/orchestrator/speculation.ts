import { existsSync } from 'node:fs'
import type { Run, Task, TaskError, Worktree } from '@shared/domain'
import { newId, nowIso, shortId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { MAX_SPECULATIVE_CANDIDATES, type CandidateEvidence, type CandidateResult, type SpeculativeRun } from '@shared/v3'
import { rankCandidates } from '@main/modules/strategy/tournament'
import type { AgentOutcome, AgentRunResult, SessionControl } from './agent-runner'
import type { ComposedContext } from '@main/modules/context/context-engine'
import { composeForTask } from './context-source'
import type { Core } from './core'
import type { PipelineHost } from './pipeline'
import { purposeFor } from './task-kind'

const LABELS = ['a', 'b', 'c'] as const
const RESUMABLE_END_REASONS = new Set(['paused', 'quota', 'auth', 'app_restart', 'shutdown'])
/** Losing candidates keep their diff for inspection after the worktree is gone. */
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
 * Speculative implement stage: N independent candidates implement the same task in separate worktrees
 * created from the same commit, the check commands run in each, and a deterministic tournament picks
 * one. The winner's commits are fast-forwarded into the task's own worktree, which then goes through the
 * unchanged checks, review, verification and merge stages. Losing candidates' evidence is stored before
 * their worktrees and branches are removed.
 *
 * Candidates cannot see one another: each session's path boundary is its own worktree, no message is
 * routed between them, and they are given the same prompt.
 */
export class SpeculativeStage {
  constructor(
    private readonly core: Core,
    private readonly host: PipelineHost,
    private readonly hooks: SpeculationHooks,
  ) {}

  /** How many candidates this task's implement stage runs; 0 for the normal single implementation. */
  candidatesFor(run: Run, task: Task): number {
    const n = run.config.strategy?.speculativeCandidates ?? 0
    if (n < 2) return 0
    // Only the mission's own implementing task is speculative, and only on its first attempt: retries and
    // repairs work on the chosen candidate.
    if (task.role !== 'worker' || task.parentTaskId !== null) return 0
    const { repos } = this.core.deps
    const previous = repos.speculativeRuns.latestForTask(task.id)
    if (previous && previous.state !== 'running') return 0
    if (!previous && task.attempt > 0) return 0
    return Math.min(n, MAX_SPECULATIVE_CANDIDATES)
  }

  /**
   * Runs the candidates and the tournament. Resolves true when the task's worktree now holds the chosen
   * implementation and the pipeline should continue with checks; false when the pipeline must stop
   * (halted, or the task failed because no candidate produced a result).
   */
  async run(run: Run, initial: Task, worktree: Worktree, projectRoot: string, control: SessionControl, count: number): Promise<boolean> {
    const { repos, bus, git } = this.core.deps
    const resumed = repos.speculativeRuns.latestForTask(initial.id)
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

    const baseCommit = await git.headCommit(worktree.path)
    const spec = resumed ?? this.begin(run, task, baseCommit, count)
    let candidates = repos.candidateResults.listBySpeculativeRun(spec.id)
    if (candidates.length === 0) {
      candidates = await this.provision(run, task, spec, count)
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'speculative.started',
        payload: { speculativeRunId: spec.id, candidates: candidates.map((c) => c.label), baseCommit: spec.baseCommit },
      })
    }

    // The same context for every candidate, composed once (so routed messages reach all of them): each
    // prompt differs only in the candidate's own worktree path and branch. None is told the others exist.
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
    if (this.hooks.halted(run.id, control) || results.some((r) => r === 'halt')) return false
    const stillThere = repos.tasks.require(task.id)
    if (stillThere.state === 'cancelled') {
      await this.cleanup(run, spec)
      return false
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
        finishedAt: nowIso(),
      })
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'speculative.decided',
        payload: { speculativeRunId: spec.id, winner: result.winner, ranking: result.ranking, confidence: result.confidence },
      })
    })

    if (!winner) {
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
      return false
    }

    // Same base commit, so the task branch fast-forwards to the winner: no merge commit, no conflict.
    await this.host.withMergeLock(run.id, () => git.run(worktree.path, ['merge', '--ff-only', winner.branch]))
    repos.tasks.update(task.id, { resultSummary: this.resultText.get(winner.id) ?? task.resultSummary })
    await this.cleanup(run, spec)
    return true
  }

  /** Final text of each candidate's session, kept only until the winner is known. */
  private readonly resultText = new Map<string, string>()

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

  private async provision(run: Run, task: Task, spec: SpeculativeRun, count: number): Promise<CandidateResult[]> {
    const { repos, git, worktrees } = this.core.deps
    const repoRoot = this.core.project(run).rootPath
    const out: CandidateResult[] = []
    for (const label of LABELS.slice(0, count)) {
      const planned = worktrees.planPaths(run.id, `${task.key}-cand-${label}`)
      const key = (await git.branchExists(repoRoot, planned.branch)) ? `${task.key}-cand-${label}-${shortId(newId())}` : `${task.key}-cand-${label}`
      // Every candidate starts from the commit the task's own worktree is at: an identical baseline.
      const created = await this.host.withMergeLock(run.id, () =>
        worktrees.createForTask({ repoRoot, runId: run.id, taskKey: key, startPoint: spec.baseCommit }),
      )
      await this.core.setupWorktree(run, task.id, created.path)
      out.push(
        repos.candidateResults.insert({
          id: newId(),
          speculativeRunId: spec.id,
          runId: run.id,
          taskId: task.id,
          label,
          agentId: null,
          sdkSessionId: null,
          branch: created.branch,
          worktreePath: created.path,
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
    return out
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
    // Finished before a pause or restart: its evidence stands.
    if (candidate.headCommit && candidate.evidence.implemented) return 'done'
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
      await this.core.cleanWorktree(candidate.worktreePath)
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
   * Removes every candidate worktree and branch. The evidence (ranking, check results, diff) is already
   * in the database, and the winner's commits live on the task branch by then.
   */
  private async cleanup(run: Run, spec: SpeculativeRun): Promise<void> {
    const { repos, bus, git, worktrees } = this.core.deps
    const repoRoot = this.core.project(run).rootPath
    for (const candidate of repos.candidateResults.listBySpeculativeRun(spec.id)) {
      if (candidate.cleanedAt) continue
      try {
        await worktrees.remove(repoRoot, candidate.worktreePath, { force: true })
        // Candidate branches are NEXUS-owned and their content is either adopted (winner) or stored as a
        // patch (losers), so the unmerged branch is deleted outright.
        if (candidate.branch.startsWith('nexus/')) await git.run(repoRoot, ['branch', '-D', '--', candidate.branch])
        repos.candidateResults.update(candidate.id, { cleanedAt: nowIso() })
        bus.emit({ runId: run.id, taskId: spec.taskId, type: 'git.worktree.removed', payload: { path: candidate.worktreePath } })
      } catch (e) {
        this.core.log(`candidate cleanup skipped (${candidate.label}): ${errorMessage(e)}`)
      }
      this.resultText.delete(candidate.id)
    }
  }

  /** Removes candidate worktrees that a cancelled or abandoned speculative run left behind. */
  async cleanupRun(run: Run): Promise<void> {
    for (const spec of this.core.deps.repos.speculativeRuns.listByRun(run.id)) {
      if (spec.state === 'running') {
        this.core.deps.repos.speculativeRuns.update(spec.id, { state: 'cancelled', finishedAt: nowIso() })
      }
      await this.cleanup(run, spec)
    }
  }
}
