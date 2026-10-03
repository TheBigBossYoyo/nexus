import { existsSync } from 'node:fs'
import type { ZodType } from 'zod'
import {
  ReviewOutputSchema,
  TERMINAL_RUN_STATES,
  VerifierOutputSchema,
  WRITING_ROLES,
  type Agent,
  type AgentPurpose,
  type CommandResult,
  type ModelTier,
  type ReviewFinding,
  type Run,
  type Task,
  type TaskError,
  type VerificationFailure,
  type Worktree,
} from '@shared/domain'
import { newId, nowIso, shortId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import {
  buildContextPack,
  buildRepairPrompt,
  buildReviewPrompt,
  buildVerifierPrompt,
  reviewOutputJsonSchema,
  verifierOutputJsonSchema,
} from '@main/modules/context/context-builder'
import type { DiffResult } from '@main/modules/git'
import { nextAttemptPlan, type FailureKind } from '@main/modules/scheduler'
import { dependenciesOf } from '@main/modules/task-graph'
import type { AgentOutcome, AgentRunResult, SessionControl } from './agent-runner'
import type { Core } from './core'
import { renderMessage } from './messaging'

export type Stage = 'implement' | 'checks' | 'review' | 'verification'

export interface PipelineHost {
  /** The run's integration worktree, created on first use. */
  ensureIntegration(run: Run): Promise<Worktree>
  /** Serializes merges into the integration branch. */
  withMergeLock<T>(runId: string, fn: () => Promise<T>): Promise<T>
  /** Reports the stage a task pipeline is in (used to derive the run phase). */
  setStage(taskId: string, stage: Stage | 'repair' | 'merge'): void
}

interface Failure {
  kind: 'checks' | 'review' | 'verification'
  summary: string
  details: string
  findings?: ReviewFinding[]
  failures?: VerificationFailure[]
  checkResults?: CommandResult[]
}

type GateResult<T> = { status: 'ok'; value: T; agentId: string } | { status: 'halt' } | { status: 'failed'; error: string }

const RESUMABLE_END_REASONS = new Set(['paused', 'quota', 'auth', 'app_restart', 'shutdown'])
const SIGNIFICANT = new Set(['critical', 'high'])
const HEARTBEAT_MS = 30_000

export function purposeFor(task: Pick<Task, 'role' | 'kind'>): AgentPurpose {
  if (task.kind === 'ask') return 'ask'
  if (task.kind === 'synthesis') return 'synthesis'
  switch (task.role) {
    case 'worker':
      return 'implement'
    case 'debugger':
      return 'diagnose'
    case 'reviewer':
    case 'security_reviewer':
      return 'audit'
    case 'verifier':
      return 'verify'
    case 'planner':
    case 'architect':
    case 'researcher':
      return 'research'
  }
}

function label(role: string, key: string): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1).replace('_', ' ')}/${key}`
}

function diffStat(diff: DiffResult): string {
  if (diff.files.length === 0) return '(no changes)'
  return diff.files.map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join('\n')
}

/**
 * Drives one task through IMPLEMENT → CHECKS → REVIEW → VERIFICATION → merge. The task's persisted
 * state is the durable stage marker, so a pipeline can be restarted at the right stage after a
 * pause or an application restart.
 */
export class TaskPipeline {
  constructor(
    private readonly core: Core,
    private readonly host: PipelineHost,
  ) {}

  async run(runId: string, taskId: string, startStage: Stage, control: SessionControl): Promise<void> {
    const { repos, bus } = this.core.deps
    try {
      await this.execute(runId, taskId, startStage, control)
    } catch (e) {
      // A pipeline failure is confined to its task; it never takes the application down.
      this.core.log(`pipeline ${taskId} failed: ${errorMessage(e)}`)
      const error: TaskError = { what: 'Task pipeline error', where: 'orchestrator', why: errorMessage(e), retryable: true }
      if (this.core.tryTaskState(taskId, 'failed', { error })) {
        bus.emit({ runId, taskId, type: 'task.failed', payload: error })
      }
    } finally {
      const task = repos.tasks.get(taskId)
      if (task?.leaseOwner) repos.tasks.update(taskId, { leaseOwner: null, leaseExpiresAt: null })
    }
  }

  private halted(runId: string, control: SessionControl): boolean {
    if (control.stopReason) return true
    const state = this.core.deps.repos.runs.require(runId).state
    return state === 'paused' || TERMINAL_RUN_STATES.includes(state)
  }

  private async execute(runId: string, taskId: string, startStage: Stage, control: SessionControl): Promise<void> {
    const { repos, git, bus } = this.core.deps
    const run = repos.runs.require(runId)
    let task = repos.tasks.require(taskId)
    const writing = WRITING_ROLES.includes(task.role)
    const project = this.core.project(run)

    let worktree: Worktree | null = null
    if (writing) {
      worktree = await this.ensureWorktree(run, task)
      task = repos.tasks.require(taskId)
    }
    const cwd = worktree?.path ?? (await this.readOnlyCwd(run))

    let stage = startStage
    if (stage === 'implement') {
      this.host.setStage(taskId, 'implement')
      const proceed = await this.implement(run, task, cwd, project.rootPath, control)
      if (!proceed) return
      task = repos.tasks.require(taskId)
      if (!writing) {
        this.complete(run, task)
        return
      }
      stage = 'checks'
    } else if (task.state === 'waiting' || task.state === 'assigned') {
      task = this.core.setTaskState(taskId, 'running')
    }
    if (!writing || !worktree) {
      this.complete(run, task)
      return
    }

    let lastChecks: CommandResult[] = repos.verifications
      .listByTask(taskId)
      .filter((v) => v.kind === 'checks')
      .at(-1)?.commands ?? []
    let reviewSummary: string | undefined

    for (;;) {
      if (this.halted(runId, control)) return
      task = repos.tasks.require(taskId)
      const cycle = task.repairCycles + 1

      if (stage === 'checks') {
        this.host.setStage(taskId, 'checks')
        if (task.state !== 'running') task = this.core.setTaskState(taskId, 'running')
        await this.commitLeftovers(run, task, worktree)
        const checks = await this.core.runChecks(run, taskId, worktree.path, cycle)
        lastChecks = checks.commands
        if (this.halted(runId, control)) return
        if (!checks.passed) {
          const repaired = await this.repair(run, task, worktree, control, {
            kind: 'checks',
            summary: checks.summary,
            details: checks.failures.map((f) => `${f.criterion}\n${f.evidence}`).join('\n\n'),
            checkResults: checks.commands,
          })
          if (!repaired) return
          continue
        }
        stage = 'review'
      }

      // Checks may rewrite or create files (formatters, snapshots, build output). Everything the agent did
      // is committed by now, so what is dirty came from the checks: discard it, so the diff that is reviewed
      // and verified is exactly what gets merged, and build output never reaches the integration branch.
      await this.core.cleanWorktree(worktree.path)

      const integration = await this.host.ensureIntegration(run)
      const base = (await git.mergeBase(worktree.path, 'HEAD', integration.branch)) ?? worktree.baseCommit
      const diff = await git.diffWorkingTree(worktree.path, base)

      if (stage === 'review') {
        this.host.setStage(taskId, 'review')
        task = this.core.setTaskState(taskId, 'review')
        if (diff.files.length > 0) {
          const outcome = await this.review(run, task, worktree, diff, lastChecks, cycle, control)
          if (outcome.status === 'halt') return
          if (outcome.status === 'changes') {
            const repaired = await this.repair(run, task, worktree, control, outcome.failure)
            if (!repaired) return
            stage = 'checks'
            continue
          }
          reviewSummary = outcome.summary
        }
      }

      this.host.setStage(taskId, 'verification')
      task = this.core.setTaskState(taskId, 'verification')
      const verdict = await this.verify(run, task, worktree, diff, lastChecks, reviewSummary, cycle, control)
      if (verdict.status === 'halt') return
      if (verdict.status === 'failed') {
        const repaired = await this.repair(run, task, worktree, control, verdict.failure)
        if (!repaired) return
        stage = 'checks'
        continue
      }

      // Verified: integrate. Merges are serialized; a conflict goes back through repair.
      this.host.setStage(taskId, 'merge')
      const branch = worktree.branch
      const merged = await this.host.withMergeLock(runId, async () => {
        // Mission checks and dependency setup run in the integration worktree and can leave files behind;
        // git refuses to merge into a dirty tree. The worktree is NEXUS-owned: only merges are committed there.
        await this.core.cleanWorktree(integration.path)
        return git.merge(integration.path, branch, {
          message: `Merge ${task.key}: ${task.title}`,
          author: this.core.author(),
        })
      })
      if (!merged.ok) {
        bus.emit({
          runId,
          taskId,
          type: 'git.conflict',
          payload: { branch, into: integration.branch, files: merged.conflicts },
        })
        const repaired = await this.repair(run, task, worktree, control, {
          kind: 'checks',
          summary: `Merge conflict with the integration branch ${integration.branch}`,
          details: [
            `Conflicting files:\n${merged.conflicts.join('\n')}`,
            `Run \`git merge ${integration.branch}\` in this worktree, resolve the conflicts so that both changes keep working, run the tests, and commit the merge.`,
          ].join('\n\n'),
        })
        if (!repaired) return
        stage = 'checks'
        continue
      }
      bus.transaction(() => {
        repos.worktrees.update(worktree.id, { state: 'merged' })
        bus.emit({
          runId,
          taskId,
          type: 'git.merged',
          payload: { branch, into: integration.branch, commit: merged.commit },
        })
      })
      this.complete(run, repos.tasks.require(taskId))
      this.core.memory.promoteForTask(run, taskId)
      await this.maybeRemoveWorktree(run, worktree)
      return
    }
  }

  // ───────────────────────────── stages ─────────────────────────────

  private async implement(
    run: Run,
    initial: Task,
    cwd: string,
    projectRoot: string,
    control: SessionControl,
  ): Promise<boolean> {
    const { repos, bus } = this.core.deps
    const resumeId = this.resumableSession(initial.id)
    // A resumed session continues the same attempt; a fresh one consumes a new attempt.
    const attempt = resumeId && initial.attempt > 0 ? initial.attempt : initial.attempt + 1
    const leaseOwner = newId()
    let task = this.core.setTaskState(initial.id, 'running', {
      attempt,
      startedAt: initial.startedAt ?? nowIso(),
      leaseOwner,
      leaseExpiresAt: this.leaseExpiry(run),
      error: null,
    })
    bus.emit({ runId: run.id, taskId: task.id, type: 'task.started', payload: { attempt } })

    // Messages (user instructions included) that arrived while no session could take them ride along on resume.
    const prompt = resumeId
      ? [
          'Continue the task from where you stopped. Check `git status` and `git log` first to see what is already done.',
          ...this.core.messages.takeForTask(task.id).map(renderMessage),
        ].join('\n\n')
      : this.contextFor(run, task, cwd, initial.error)

    let lastBeat = Date.now()
    const result = await this.core.agents.run({
      run,
      task,
      role: task.role,
      purpose: purposeFor(task),
      label: label(task.role, task.key),
      cwd,
      worktreeRoot: cwd,
      projectRoot,
      prompt,
      tier: this.tier(run, task),
      control,
      resumeSdkSessionId: resumeId,
      allowRotation: true,
      onActivity: () => {
        if (Date.now() - lastBeat < HEARTBEAT_MS) return
        lastBeat = Date.now()
        repos.tasks.update(task.id, { leaseExpiresAt: this.leaseExpiry(run) })
      },
    })
    task = repos.tasks.require(task.id)

    if (result.outcome === 'success') {
      if (result.blocker) {
        this.core.setTaskState(task.id, 'blocked', { blockedReason: result.blocker.summary })
        bus.emit({ runId: run.id, taskId: task.id, type: 'task.blocked', payload: { reason: result.blocker.summary } })
        return false
      }
      repos.tasks.update(task.id, { resultSummary: result.text })
      if (purposeFor(task) !== 'implement' && purposeFor(task) !== 'diagnose') {
        repos.artifacts.insert({
          id: newId(),
          runId: run.id,
          taskId: task.id,
          agentId: result.agentId,
          kind: 'report',
          title: task.title,
          content: result.text,
          createdAt: nowIso(),
        })
      }
      return true
    }
    this.handleAgentFailure(run, task, result, control)
    return false
  }

  /** Shared handling for a non-successful agent outcome in the implement stage. */
  private handleAgentFailure(run: Run, task: Task, result: AgentRunResult, control: SessionControl): void {
    const { bus } = this.core.deps
    if (this.haltOutcome(run, result.outcome, control)) {
      if (control.stopReason === 'user_stop') {
        const error: TaskError = { what: 'Agent stopped by user', where: label(task.role, task.key), why: null, retryable: true }
        if (this.core.tryTaskState(task.id, 'failed', { error })) {
          bus.emit({ runId: run.id, taskId: task.id, type: 'task.failed', payload: error })
        }
      }
      return
    }
    const failureKind: FailureKind =
      result.outcome === 'max_turns' ? 'timeout' : result.outcome === 'crashed' ? 'crash' : 'agent_error'
    const error: TaskError = {
      what: `Agent ${result.outcome.replace('_', ' ')}`,
      where: label(task.role, task.key),
      why: result.error,
      retryable: true,
    }
    const plan = nextAttemptPlan({
      task,
      maxRetries: run.config.maxRetriesPerTask,
      failureKind,
      baseTier: run.config.modelPolicy[task.role],
    })
    bus.transaction(() => {
      this.core.setTaskState(task.id, 'failed', { error })
      if (plan.action === 'retry') {
        this.core.setTaskState(task.id, 'ready', { modelTierOverride: plan.modelTierOverride, finishedAt: null }, plan.reason)
        bus.emit({ runId: run.id, taskId: task.id, type: 'task.retry', payload: { attempt: task.attempt + 1, reason: plan.reason } })
        if (plan.modelTierOverride && plan.modelTierOverride !== task.modelTierOverride) {
          bus.emit({ runId: run.id, taskId: task.id, type: 'task.escalated', payload: { toTier: plan.modelTierOverride } })
        }
      } else {
        bus.emit({ runId: run.id, taskId: task.id, type: 'task.failed', payload: { ...error, retryable: false } })
      }
    })
  }

  /**
   * Outcomes that stop the pipeline without failing the task: user/pause stops, quota, and auth.
   * Quota and auth pause the whole run; the task keeps its state and resumes later.
   */
  private haltOutcome(run: Run, outcome: AgentOutcome, control: SessionControl): boolean {
    if (outcome === 'stopped' || control.stopReason) return true
    if (outcome === 'quota') {
      this.core.pauseRun(run.id, 'quota', 'Claude usage limit reached')
      return true
    }
    if (outcome === 'auth') {
      this.core.pauseRun(run.id, 'user', 'Claude authentication required')
      return true
    }
    return false
  }

  private async review(
    run: Run,
    task: Task,
    worktree: Worktree,
    diff: DiffResult,
    checks: CommandResult[],
    attempt: number,
    control: SessionControl,
  ): Promise<{ status: 'approved'; summary: string } | { status: 'changes'; failure: Failure } | { status: 'halt' }> {
    const { repos, bus } = this.core.deps
    bus.emit({ runId: run.id, taskId: task.id, type: 'review.started', payload: { attempt } })
    const security = task.risk === 'high'
    // The reviewer sees requirements, the diff and test output: never the implementer's reasoning.
    const gate = await this.gate(run, task, worktree, control, {
      role: security ? 'security_reviewer' : 'reviewer',
      purpose: 'review',
      prompt: buildReviewPrompt({
        task,
        missionCriteria: run.plan?.acceptanceCriteria ?? [],
        diffStat: diffStat(diff),
        patch: diff.patch,
        checkResults: checks,
        attempt,
      }).prompt,
      schema: ReviewOutputSchema,
      jsonSchema: reviewOutputJsonSchema,
    })
    if (gate.status === 'halt') return { status: 'halt' }
    if (gate.status === 'failed') throw new Error(`Review could not be completed: ${gate.error}`)

    const output = gate.value
    const significant = output.findings.filter((f) => SIGNIFICANT.has(f.severity))
    const verdict = significant.length > 0 ? 'changes_requested' : 'approved'
    bus.transaction(() => {
      repos.reviews.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        agentId: gate.agentId,
        attempt,
        verdict,
        summary: output.summary,
        findings: output.findings,
        createdAt: nowIso(),
      })
      for (const f of output.findings) {
        bus.emit({
          runId: run.id,
          taskId: task.id,
          agentId: gate.agentId,
          type: 'review.finding',
          payload: { severity: f.severity, title: f.title, file: f.file },
        })
      }
      bus.emit({
        runId: run.id,
        taskId: task.id,
        agentId: gate.agentId,
        type: 'review.completed',
        payload: { verdict, findings: output.findings.length },
      })
    })
    for (const f of significant) {
      this.core.messages.send({
        runId: run.id,
        type: 'review_finding',
        severity: f.severity,
        subject: f.title,
        body: `${f.description}\n\nEvidence: ${f.evidence}${f.file ? `\nFile: ${f.file}` : ''}`,
        fromAgentId: gate.agentId,
        fromTaskId: null,
        fromLabel: label(security ? 'security_reviewer' : 'reviewer', task.key),
        toTask: task.id,
        toRole: null,
      })
    }
    if (verdict === 'approved') return { status: 'approved', summary: output.summary }
    return {
      status: 'changes',
      failure: {
        kind: 'review',
        summary: `Review requested changes: ${significant.length} significant finding(s).`,
        details: output.summary,
        findings: significant,
        checkResults: checks,
      },
    }
  }

  private async verify(
    run: Run,
    task: Task,
    worktree: Worktree,
    diff: DiffResult,
    checks: CommandResult[],
    reviewSummary: string | undefined,
    attempt: number,
    control: SessionControl,
  ): Promise<{ status: 'passed' } | { status: 'failed'; failure: Failure } | { status: 'halt' }> {
    const { repos, bus } = this.core.deps
    bus.emit({ runId: run.id, taskId: task.id, type: 'verification.started', payload: { attempt } })
    const gate = await this.gate(run, task, worktree, control, {
      role: 'verifier',
      purpose: 'verify',
      prompt: buildVerifierPrompt({
        task,
        missionCriteria: run.plan?.acceptanceCriteria ?? [],
        diffStat: diffStat(diff),
        checkResults: checks,
        reviewSummary,
      }).prompt,
      schema: VerifierOutputSchema,
      jsonSchema: verifierOutputJsonSchema,
    })
    if (gate.status === 'halt') return { status: 'halt' }
    if (gate.status === 'failed') throw new Error(`Verification could not be completed: ${gate.error}`)

    const output = gate.value
    // The verifier has final authority: any failed criterion or reported failure blocks completion.
    const passed = output.failures.length === 0 && output.criteria.every((c) => c.passed)
    bus.transaction(() => {
      repos.verifications.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        agentId: gate.agentId,
        attempt,
        kind: 'verifier',
        passed,
        summary: output.summary,
        criteria: output.criteria,
        commands: [],
        failures: output.failures,
        createdAt: nowIso(),
      })
      const rows = repos.criteria.listByTask(task.id)
      for (const c of output.criteria) {
        const row = rows.find((r) => r.text.trim() === c.criterion.trim())
        if (!row) continue
        const status = c.passed ? 'passed' : 'failed'
        repos.criteria.update(row.id, { status, evidence: c.evidence, updatedAt: nowIso() })
        bus.emit({ runId: run.id, taskId: task.id, type: 'criterion.updated', payload: { criterionId: row.id, status } })
      }
      if (passed) {
        bus.emit({ runId: run.id, taskId: task.id, agentId: gate.agentId, type: 'verification.passed', payload: { summary: output.summary } })
      } else {
        bus.emit({
          runId: run.id,
          taskId: task.id,
          agentId: gate.agentId,
          type: 'verification.failed',
          payload: { failures: output.failures.length, summary: output.summary },
        })
      }
    })
    if (passed) return { status: 'passed' }
    const failures: VerificationFailure[] =
      output.failures.length > 0
        ? output.failures
        : output.criteria
            .filter((c) => !c.passed)
            .map((c) => ({ criterion: c.criterion, evidence: c.evidence, likelyCause: '', relevantFiles: [] }))
    return {
      status: 'failed',
      failure: { kind: 'verification', summary: output.summary, details: output.summary, failures, checkResults: checks },
    }
  }

  /** Run a read-only gate agent (reviewer/verifier) with validated structured output. One retry. */
  private async gate<T>(
    run: Run,
    task: Task,
    worktree: Worktree,
    control: SessionControl,
    spec: {
      role: 'reviewer' | 'security_reviewer' | 'verifier'
      purpose: AgentPurpose
      prompt: string
      schema: ZodType<T>
      jsonSchema: Record<string, unknown>
    },
  ): Promise<GateResult<T>> {
    let error = 'unknown'
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.core.agents.run({
        run,
        task,
        role: spec.role,
        purpose: spec.purpose,
        label: label(spec.role, task.key),
        cwd: worktree.path,
        worktreeRoot: worktree.path,
        projectRoot: this.core.project(run).rootPath,
        prompt: spec.prompt,
        outputSchema: spec.jsonSchema,
        tier: run.config.modelPolicy[spec.role],
        control,
      })
      if (this.haltOutcome(run, result.outcome, control)) return { status: 'halt' }
      if (result.outcome === 'success') {
        const parsed = spec.schema.safeParse(result.structuredOutput)
        if (parsed.success) return { status: 'ok', value: parsed.data, agentId: result.agentId }
        error = `invalid structured output: ${parsed.error.message}`
      } else {
        error = result.error ?? result.outcome
      }
    }
    return { status: 'failed', error }
  }

  /**
   * Route a failure through a repair task run by a debugger in the same worktree. Bounded by
   * maxIterations; returns false when the pipeline must stop (limit reached, halt, repair failed).
   */
  private async repair(run: Run, parent: Task, worktree: Worktree, control: SessionControl, failure: Failure): Promise<boolean> {
    const { repos, bus } = this.core.deps
    const cycles = parent.repairCycles
    if (cycles >= run.config.maxIterations) {
      const error: TaskError = {
        what: `${failure.kind} still failing after ${cycles} repair cycle(s)`,
        where: parent.key,
        why: failure.summary,
        retryable: true,
      }
      bus.transaction(() => {
        this.core.setTaskState(parent.id, 'failed', { error })
        bus.emit({ runId: run.id, taskId: parent.id, type: 'task.failed', payload: { ...error, retryable: false } })
      })
      return false
    }

    this.host.setStage(parent.id, 'repair')
    const n = cycles + 1
    // Second and later repairs escalate to the strongest model tier.
    const tier: ModelTier | null = n >= 2 ? 'strongest' : null
    const child = bus.transaction(() => {
      this.core.setTaskState(parent.id, 'waiting', { repairCycles: n }, `repair ${n}: ${failure.kind}`)
      // Keys are unique per run and earlier children are kept as history, so the suffix counts the
      // parent's existing repair children rather than its (retry-resettable) repairCycles.
      const suffix =
        Math.max(0, ...repos.tasks.listByParent(parent.id).map((c) => Number(/-fix(\d+)$/.exec(c.key)?.[1] ?? 0))) + 1
      const row = repos.tasks.insert({
        ...parent,
        id: newId(),
        key: `${parent.key}-fix${suffix}`,
        title: `Repair ${parent.key}: ${failure.kind} failure`,
        description: failure.summary,
        role: 'debugger',
        kind: 'repair',
        state: 'running',
        attempt: 1,
        repairCycles: 0,
        parentTaskId: parent.id,
        modelTierOverride: tier,
        leaseOwner: null,
        leaseExpiresAt: null,
        resultSummary: null,
        blockedReason: null,
        error: null,
        createdAt: nowIso(),
        startedAt: nowIso(),
        finishedAt: null,
      })
      bus.emit({
        runId: run.id,
        taskId: row.id,
        type: 'task.created',
        payload: { key: row.key, title: row.title, role: row.role, kind: row.kind },
      })
      if (tier) bus.emit({ runId: run.id, taskId: row.id, type: 'task.escalated', payload: { toTier: tier } })
      return row
    })

    const result = await this.core.agents.run({
      run,
      task: child,
      role: 'debugger',
      purpose: 'diagnose',
      label: label('debugger', child.key),
      cwd: worktree.path,
      worktreeRoot: worktree.path,
      projectRoot: this.core.project(run).rootPath,
      prompt: this.withInstructions(
        buildRepairPrompt({
          task: parent,
          failure: { kind: failure.kind, summary: failure.summary, details: failure.details },
          findings: failure.findings,
          failures: failure.failures,
          checkResults: failure.checkResults,
        }).prompt,
        parent.id,
      ),
      tier: tier ?? run.config.modelPolicy.debugger,
      control,
      allowRotation: true,
    })

    // The user cancelled this repair while it ran: cancelTask already settled the child and the parent.
    if (repos.tasks.require(child.id).state === 'cancelled') return false

    if (result.outcome === 'success' && !result.blocker) {
      bus.transaction(() => {
        this.core.setTaskState(child.id, 'completed', { resultSummary: result.text })
        bus.emit({ runId: run.id, taskId: child.id, type: 'task.completed', payload: { summary: result.text.slice(0, 500) } })
        this.core.setTaskState(parent.id, 'running')
      })
      return true
    }
    // Paused / quota: leave parent waiting and child running; the restart logic picks it up.
    if (this.haltOutcome(run, result.outcome, control) && control.stopReason !== 'user_stop') return false
    const why = result.blocker?.summary ?? result.error ?? result.outcome
    const error: TaskError = { what: 'Repair failed', where: child.key, why, retryable: true }
    bus.transaction(() => {
      this.core.setTaskState(child.id, 'failed', { error })
      bus.emit({ runId: run.id, taskId: child.id, type: 'task.failed', payload: error })
      this.core.setTaskState(parent.id, 'failed', { error })
      bus.emit({ runId: run.id, taskId: parent.id, type: 'task.failed', payload: error })
    })
    return false
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private complete(run: Run, task: Task): void {
    const { bus } = this.core.deps
    bus.transaction(() => {
      this.core.setTaskState(task.id, 'completed')
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'task.completed',
        payload: { summary: (task.resultSummary ?? '').slice(0, 500) },
      })
    })
  }

  private tier(run: Run, task: Task): ModelTier {
    return task.modelTierOverride ?? run.config.modelPolicy[task.role]
  }

  private leaseExpiry(run: Run): string {
    return new Date(Date.now() + run.config.leaseMinutes * 60_000).toISOString()
  }

  /** The user's pending instructions for a task, appended to a prompt (and marked delivered with it). */
  private withInstructions(prompt: string, taskId: string): string {
    const instructions = this.core.messages.takeInstructions(taskId)
    if (instructions.length === 0) return prompt
    return [prompt, '## Instructions from the user', ...instructions.map((m) => `- ${m.body}`)].join('\n\n')
  }

  /**
   * The stage a task left in state 'running' resumes at. The state stays 'running' through checks (and
   * after a successful repair), so it cannot tell by itself: when the task's implementing agent already
   * finished its session successfully the work is done and only the checks onwards remain.
   */
  resumeStage(task: Pick<Task, 'id' | 'state'>): Stage {
    if (task.state !== 'running') return 'implement'
    const agent = this.lastWorkerAgent(task.id)
    const session = agent ? this.core.deps.repos.sessions.latestForAgent(agent.id) : null
    return agent?.state === 'stopped' && session?.endReason === 'completed' ? 'checks' : 'implement'
  }

  private lastWorkerAgent(taskId: string): Agent | undefined {
    return this.core.deps.repos.agents
      .listByTask(taskId)
      .filter((a) => a.purpose !== 'review' && a.purpose !== 'verify')
      .at(-1)
  }

  /** SDK session of the task's last implementing agent, when it ended in a resumable way. */
  private resumableSession(taskId: string): string | undefined {
    const { repos } = this.core.deps
    const agent = this.lastWorkerAgent(taskId)
    if (!agent) return undefined
    const session = repos.sessions.latestForAgent(agent.id)
    if (!session?.sdkSessionId || !session.endReason) return undefined
    return RESUMABLE_END_REASONS.has(session.endReason) ? session.sdkSessionId : undefined
  }

  /** The context pack: only what this task needs. */
  private contextFor(run: Run, task: Task, cwd: string, previousError: TaskError | null): string {
    const { repos } = this.core.deps
    const tasks = repos.tasks.listByRun(run.id)
    const deps = repos.dependencies.listByRun(run.id)
    const upstreamIds = new Set(dependenciesOf(deps, task.id))
    const upstream = tasks.filter((t) => upstreamIds.has(t.id))
    const messages = this.core.messages.takeForTask(task.id)
    return buildContextPack({
      run,
      task,
      purpose: purposeFor(task),
      missionCriteria: run.plan?.acceptanceCriteria ?? [],
      dependencyOutputs: upstream
        .filter((t) => t.state === 'completed' && t.resultSummary)
        .map((t) => ({ key: t.key, title: t.title, summary: t.resultSummary ?? '' })),
      // Decisions from upstream tasks and from architects; not every decision in the run.
      decisions: repos.decisions
        .listByRun(run.id)
        .filter((d) => d.taskId === null || upstreamIds.has(d.taskId) || tasks.find((t) => t.id === d.taskId)?.role === 'architect'),
      memory: this.core.memory.relevantFor(run, task),
      messages: messages.filter((m) => m.type !== 'user_instruction'),
      repo: {
        worktreePath: cwd,
        branch: task.branch ?? run.integrationBranch ?? run.baseBranch ?? '',
        baseCommit: run.baseCommit ?? '',
        projectName: this.core.project(run).name,
        checks: run.config.checks,
      },
      extra: {
        attempt: task.attempt,
        userInstructions: messages.filter((m) => m.type === 'user_instruction').map((m) => m.body),
        ...(previousError
          ? {
              failure: {
                kind: 'checks' as const,
                summary: `The previous attempt failed: ${previousError.what}. Diagnose why before continuing.`,
                details: previousError.why ?? '',
              },
            }
          : {}),
      },
    }).prompt
  }

  private async readOnlyCwd(run: Run): Promise<string> {
    const { repos } = this.core.deps
    const integration = repos.worktrees
      .listByRun(run.id)
      .find((w) => w.taskId === null && w.state === 'active' && existsSync(w.path))
    return integration?.path ?? this.core.project(run).rootPath
  }

  private async ensureWorktree(run: Run, task: Task): Promise<Worktree> {
    const { repos, bus, git, worktrees } = this.core.deps
    const existing = task.worktreeId ? repos.worktrees.get(task.worktreeId) : null
    if (existing && existing.state === 'active' && existsSync(existing.path)) return existing

    const integration = await this.host.ensureIntegration(run)
    const repoRoot = this.core.project(run).rootPath
    // A lost worktree leaves its branch behind; take a fresh key rather than fail on the name clash.
    const planned = worktrees.planPaths(run.id, task.key)
    const taskKey = (await git.branchExists(repoRoot, planned.branch)) ? `${task.key}-${shortId(newId())}` : task.key
    // Serialized with merges: concurrent `git worktree add` and ref updates in one repository can
    // collide on git's lock files, and the start point must not move while the worktree is created.
    const created = await this.host.withMergeLock(run.id, () =>
      worktrees.createForTask({ repoRoot, runId: run.id, taskKey, startPoint: integration.branch }),
    )
    const worktree = bus.transaction(() => {
      const row = repos.worktrees.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        path: created.path,
        branch: created.branch,
        baseCommit: created.baseCommit,
        state: 'active',
        createdAt: nowIso(),
      })
      repos.tasks.update(task.id, { branch: created.branch, worktreeId: row.id })
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'git.worktree.created',
        payload: { path: created.path, branch: created.branch },
      })
      return row
    })
    await this.core.setupWorktree(run, task.id, created.path)
    return worktree
  }

  /** Commit anything the agent left uncommitted so the reviewed diff equals what gets merged. */
  private async commitLeftovers(run: Run, task: Task, worktree: Worktree): Promise<void> {
    const { git, bus } = this.core.deps
    const sha = await git.commitAll(worktree.path, `${task.key}: ${task.title}`, this.core.author())
    if (sha) {
      bus.emit({
        runId: run.id,
        taskId: task.id,
        type: 'git.commit.created',
        payload: { commit: sha, branch: worktree.branch, message: `${task.key}: ${task.title}` },
      })
    }
  }

  private async maybeRemoveWorktree(run: Run, worktree: Worktree): Promise<void> {
    const { repos, bus, worktrees } = this.core.deps
    if (!repos.settings.get().git.removeWorktreesOnSuccess) return
    try {
      await worktrees.remove(this.core.project(run).rootPath, worktree.path)
      repos.worktrees.update(worktree.id, { state: 'removed' })
      bus.emit({ runId: run.id, taskId: worktree.taskId, type: 'git.worktree.removed', payload: { path: worktree.path } })
    } catch (e) {
      this.core.log(`worktree removal skipped: ${errorMessage(e)}`)
    }
  }
}
