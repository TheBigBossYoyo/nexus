import { checkOutputMode } from '@shared/token'
import { existsSync } from 'node:fs'
import type { ZodType } from 'zod'
import {
  ReviewOutputSchema,
  SEVERITIES,
  TERMINAL_RUN_STATES,
  VerifierOutputSchema,
  WRITING_ROLES,
  type Agent,
  type AgentPurpose,
  type AgentRole,
  type CommandResult,
  type ReviewFinding,
  type Run,
  type Severity,
  type Task,
  type TaskError,
  type VerificationFailure,
  type Worktree,
} from '@shared/domain'
import { newId, nowIso, shortId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { ArbiterOutputSchema, type ArbiterOutput, type ContextSourceKind } from '@shared/v2'
import {
  arbiterOutputJsonSchema,
  buildArbiterPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  buildVerifierPrompt,
  reviewOutputJsonSchema,
  verifierOutputJsonSchema,
} from '@main/modules/context/context-builder'
import { packForPrompt, withBlock, type ComposedContext, type PromptBlock } from '@main/modules/context/context-engine'
import { oneLine } from '@main/modules/context/render'
import type { DiffResult } from '@main/modules/git'
import { applyArbitration, dedupeFindings } from '@main/modules/review'
import { nextAttemptPlan, type FailureKind } from '@main/modules/scheduler'
import { fingerprintFiles } from '@main/modules/intelligence'
import { dependenciesOf } from '@main/modules/task-graph'
import type { AgentOutcome, AgentRunResult, SessionControl } from './agent-runner'
import { ARBITRATION_ARTIFACT } from './arbitration'
import { composeForTask } from './context-source'
import type { Core } from './core'
import { buildTaskEvidence } from './evidence'
import { renderMessage } from './messaging'
import { recordTaskOutcome } from './outcomes'
import { SpeculativeStage } from './speculation'
import { purposeFor } from './task-kind'

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

type ReviewOutcome = { status: 'approved'; summary: string } | { status: 'changes'; failure: Failure } | { status: 'halt' }

type GateResult<T> = { status: 'ok'; value: T; agentId: string } | { status: 'halt' } | { status: 'failed'; error: string }

const RESUMABLE_END_REASONS = new Set(['paused', 'quota', 'auth', 'app_restart', 'shutdown'])
const SIGNIFICANT = new Set(['critical', 'high'])
const HEARTBEAT_MS = 30_000

/** Dual review: what each of the two reviewers concentrates on. */
const REVIEW_LENSES: Record<'reviewer' | 'security_reviewer', string> = {
  reviewer: 'Concentrate on correctness: does the change satisfy every requirement and acceptance criterion, are the logic and edge cases right, do the tests exercise real behaviour.',
  security_reviewer: 'Concentrate on security, concurrency and failure modes: injection and unsafe input handling, races and ordering, partial failure, error paths, resource leaks, and what happens when a dependency misbehaves.',
}

/** The most serious severity among findings, null for none. */
function topSeverity(findings: readonly ReviewFinding[] | undefined): Severity | null {
  let top: Severity | null = null
  for (const f of findings ?? []) {
    if (top === null || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(top)) top = f.severity
  }
  return top
}

/** How a repair prompt's sections map to context sources (the prompt itself is built by the stage prompt). */
const REPAIR_SECTIONS: Record<string, { kind: ContextSourceKind; reason: string }> = {
  'Repair request': { kind: 'failure', reason: 'States which gate the previous implementation failed.' },
  Task: { kind: 'task', reason: 'The task being repaired.' },
  'Acceptance criteria': { kind: 'criteria', reason: 'What the repair is judged against.' },
  Failure: { kind: 'failure', reason: 'The failure to fix.' },
  'Review findings': { kind: 'review_finding', reason: 'Significant review findings to address (accepted by the arbiter in a dual review).' },
  'Failed criteria': { kind: 'failure', reason: 'Criteria the verifier could not confirm.' },
  'Check results': { kind: 'failure', reason: 'Output of the failed or latest checks.' },
  'Orchestration evidence': { kind: 'message', reason: 'Messages, decisions and graph proposals from the NEXUS database; the repository cannot show them.' },
  Instructions: { kind: 'task', reason: 'How to carry out the repair.' },
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
  /** v0.3: the implement stage of a speculative run (several candidates, then a tournament). */
  readonly speculation: SpeculativeStage

  constructor(
    private readonly core: Core,
    private readonly host: PipelineHost,
  ) {
    this.speculation = new SpeculativeStage(core, host, {
      halted: (runId, control) => this.halted(runId, control),
      haltOutcome: (run, outcome, control) => this.haltOutcome(run, outcome, control),
      leaseExpiry: (run) => this.leaseExpiry(run),
    })
  }

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
        this.outcome(runId, taskId)
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
      // A task that yielded to a new prerequisite restarts here once the prerequisite has merged.
      const resume = await this.prepareResume(run, task, worktree)
      const candidates = worktree && !resume ? this.speculation.candidatesFor(run, task) : 0
      const proceed =
        candidates > 0 && worktree
          ? await this.speculation.run(run, task, worktree, project.rootPath, control, candidates)
          : await this.implement(run, task, cwd, project.rootPath, control, resume)
      if (!proceed) {
        // A speculative stage that ended without any result is a final failure of this attempt.
        if (candidates > 0 && repos.tasks.require(taskId).state === 'failed') this.outcome(runId, taskId)
        return
      }
      task = repos.tasks.require(taskId)
      // Cancelled by its own graph proposal (a split): the task ends here, it must not be checked or merged.
      if (task.state === 'cancelled') return
      if (await this.yieldIfWaiting(run, task, worktree)) return
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
      // A graph change approved after the agent's turn may have given the task a prerequisite.
      if (task.state === 'running' && (await this.yieldIfWaiting(run, task, worktree))) return
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
      await this.recordDecisionFacts(run, task, diff)

      // Verified: integrate. Merges are serialized; a conflict goes back through repair.
      this.host.setStage(taskId, 'merge')
      const branch = worktree.branch
      const merged = await this.host.withMergeLock(runId, async () => {
        // The task may have been cancelled or stopped while it waited for the lock: never merge it then.
        if (control.stopReason || repos.tasks.require(taskId).state !== 'verification') return null
        // Mission checks and dependency setup run in the integration worktree and can leave files behind;
        // git refuses to merge into a dirty tree. The worktree is NEXUS-owned: only merges are committed there.
        await this.core.cleanWorktree(integration.path)
        return git.merge(integration.path, branch, {
          message: `Merge ${task.key}: ${task.title}`,
          author: this.core.author(),
        })
      })
      if (merged === null) return
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
    resume: string | null,
  ): Promise<boolean> {
    const { repos, bus } = this.core.deps
    const resumeId = resume ? undefined : this.resumableSession(initial.id)
    // A resumed session continues the same attempt; so does a restart after a yield; a fresh one consumes a new attempt.
    const attempt = (resumeId || resume) && initial.attempt > 0 ? initial.attempt : initial.attempt + 1
    const leaseOwner = newId()
    let task = this.core.setTaskState(initial.id, 'running', {
      attempt,
      startedAt: initial.startedAt ?? nowIso(),
      leaseOwner,
      leaseExpiresAt: this.leaseExpiry(run),
      error: null,
    })
    bus.emit({ runId: run.id, taskId: task.id, type: 'task.started', payload: { attempt } })
    this.core.graph.clearYield(task.id)

    const purpose = purposeFor(task)
    let composed: ComposedContext
    if (resumeId) {
      // Messages (user instructions included) that arrived while no session could take them ride along on resume.
      const continueText = 'Continue the task from where you stopped. Check `git status` and `git log` first to see what is already done.'
      const messages = this.core.messages.takeForTask(task.id)
      const prompt = [continueText, ...messages.map(renderMessage)].join('\n\n')
      composed = {
        prompt,
        pack: packForPrompt({
          run,
          task,
          purpose,
          prompt,
          blocks: [
            { section: 'Continue', sourceKind: 'handoff', title: 'Resume the interrupted session', reason: 'The previous session ended in a resumable way (pause, quota, restart); its own history is kept.', chars: continueText.length },
            ...messages.map(
              (m): PromptBlock => ({
                section: 'Messages',
                sourceKind: m.type === 'user_instruction' ? 'user_instruction' : 'message',
                sourceId: m.id,
                title: m.subject,
                reason: 'Arrived while no session could take it.',
                chars: m.body.length,
              }),
            ),
          ],
        }),
      }
    } else {
      composed = composeForTask(this.core, run, task, purpose, cwd, initial.error)
      if (resume) {
        composed = withBlock(
          composed,
          { section: 'Resuming after a prerequisite', sourceKind: 'handoff', title: 'Prerequisite work merged', reason: 'The task yielded to a prerequisite it asked for; this is a fresh session after that merged.', chars: resume.length },
          [resume, composed.prompt].join('\n\n'),
        )
      }
    }

    let lastBeat = Date.now()
    const result = await this.core.agents.run({
      run,
      task,
      role: task.role,
      purpose,
      label: label(task.role, task.key),
      cwd,
      worktreeRoot: cwd,
      projectRoot,
      prompt: composed.prompt,
      contextPack: composed.pack,
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
    // Cancelled while the agent worked (by its own split proposal or another agent's approved one).
    if (task.state === 'cancelled') return false

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
          this.outcome(run.id, task.id)
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
    if (plan.action !== 'retry') this.outcome(run.id, task.id)
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
      this.core.pauseRun(run.id, 'user', 'Claude authentication required', 'auth')
      return true
    }
    return false
  }

  /** 'dual' runs two reviewers and an arbiter; 'auto' (the default) does so for high-risk tasks only. */
  private reviewIsDual(run: Run, task: Task): boolean {
    const mode = run.config.reviewMode ?? 'auto'
    return mode === 'dual' || (mode === 'auto' && task.risk === 'high')
  }

  private async review(
    run: Run,
    task: Task,
    worktree: Worktree,
    diff: DiffResult,
    checks: CommandResult[],
    attempt: number,
    control: SessionControl,
  ): Promise<ReviewOutcome> {
    const { repos, bus } = this.core.deps
    bus.emit({ runId: run.id, taskId: task.id, type: 'review.started', payload: { attempt } })
    // The reviewer sees requirements, the diff and test output: never the implementer's reasoning.
    const promptFor = (lens?: string): string =>
      buildReviewPrompt({
        task,
        missionCriteria: run.plan?.acceptanceCriteria ?? [],
        diffStat: diffStat(diff),
        patch: diff.patch,
        checkResults: checks,
        checkOutputMode: checkOutputMode(this.core.deps.repos.settings.get().tokens),
        attempt,
        evidence: buildTaskEvidence(repos, run.id, task, { changedFiles: diff.files }),
        ...(lens ? { lens } : {}),
      }).prompt
    if (this.reviewIsDual(run, task)) return this.reviewDual(run, task, worktree, diff, checks, attempt, control, promptFor)

    const security = task.risk === 'high'
    const role = security ? 'security_reviewer' : 'reviewer'
    const gate = await this.gate(run, task, worktree, control, {
      role,
      purpose: 'review',
      prompt: promptFor(),
      schema: ReviewOutputSchema,
      jsonSchema: reviewOutputJsonSchema,
    })
    if (gate.status === 'halt') return { status: 'halt' }
    if (gate.status === 'failed') throw new Error(`Review could not be completed: ${gate.error}`)

    const output = gate.value
    const significant = output.findings.filter((f) => SIGNIFICANT.has(f.severity))
    const verdict = significant.length > 0 ? 'changes_requested' : 'approved'
    this.persistReview(run, task, gate.agentId, output, attempt)
    this.sendFindingMessages(run, task, significant, gate.agentId, label(role, task.key))
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

  /** One review row with its finding and completion events; the verdict follows the significant findings. */
  private persistReview(run: Run, task: Task, agentId: string | null, output: { summary: string; findings: ReviewFinding[] }, attempt: number): string {
    const { repos, bus } = this.core.deps
    const verdict = output.findings.some((f) => SIGNIFICANT.has(f.severity)) ? 'changes_requested' : 'approved'
    return bus.transaction(() => {
      const row = repos.reviews.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        agentId,
        attempt,
        verdict,
        summary: output.summary,
        findings: output.findings,
        createdAt: nowIso(),
      })
      for (const f of output.findings) {
        bus.emit({ runId: run.id, taskId: task.id, agentId, type: 'review.finding', payload: { severity: f.severity, title: f.title, file: f.file } })
      }
      bus.emit({ runId: run.id, taskId: task.id, agentId, type: 'review.completed', payload: { verdict, findings: output.findings.length } })
      return row.id
    })
  }

  private sendFindingMessages(run: Run, task: Task, findings: readonly ReviewFinding[], agentId: string | null, fromLabel: string): void {
    for (const f of findings) {
      this.core.messages.send({
        runId: run.id,
        type: 'review_finding',
        severity: f.severity,
        subject: f.title,
        body: `${f.description}\n\nEvidence: ${f.evidence}${f.file ? `\nFile: ${f.file}` : ''}`,
        fromAgentId: agentId,
        fromTaskId: null,
        fromLabel,
        toTask: task.id,
        toRole: null,
      })
    }
  }

  /**
   * Dual review: a correctness reviewer and a security/failure-mode reviewer run concurrently on the same
   * inputs. Their findings are deduplicated; when any is significant, an arbiter checks each against the code
   * and only the findings it accepts can request changes. All three records are persisted; the arbiter's
   * decisions are kept as an 'arbitration' artifact (see arbitration.ts).
   */
  private async reviewDual(
    run: Run,
    task: Task,
    worktree: Worktree,
    diff: DiffResult,
    checks: CommandResult[],
    attempt: number,
    control: SessionControl,
    promptFor: (lens?: string) => string,
  ): Promise<ReviewOutcome> {
    const { repos, bus } = this.core.deps
    const roles = ['reviewer', 'security_reviewer'] as const
    const gates = await Promise.all(
      roles.map((role) =>
        this.gate(run, task, worktree, control, {
          role,
          purpose: 'review',
          prompt: promptFor(REVIEW_LENSES[role]),
          schema: ReviewOutputSchema,
          jsonSchema: reviewOutputJsonSchema,
        }),
      ),
    )
    if (gates.some((g) => g.status === 'halt')) return { status: 'halt' }
    const outputs: { role: AgentRole; agentId: string; summary: string; findings: ReviewFinding[] }[] = []
    for (const [index, g] of gates.entries()) {
      if (g.status === 'failed') throw new Error(`Review could not be completed: ${g.error}`)
      if (g.status === 'ok') outputs.push({ role: roles[index] ?? 'reviewer', agentId: g.agentId, ...g.value })
    }
    for (const o of outputs) this.persistReview(run, task, o.agentId, o, attempt)

    const deduped = dedupeFindings(outputs.map((o) => ({ reviewer: o.role, findings: o.findings })))
    const summaries = outputs.map((o) => o.summary).join(' ')
    if (!deduped.some((d) => SIGNIFICANT.has(d.finding.severity))) return { status: 'approved', summary: summaries }

    const arbiter = await this.gate(run, task, worktree, control, {
      role: 'reviewer',
      purpose: 'arbitrate',
      label: label('arbiter', task.key),
      prompt: buildArbiterPrompt({ task, findings: deduped, diffStat: diffStat(diff), patch: diff.patch }).prompt,
      schema: ArbiterOutputSchema,
      jsonSchema: arbiterOutputJsonSchema,
    })
    if (arbiter.status === 'halt') return { status: 'halt' }
    // Without a valid ruling applyArbitration's fail-safe decides: confident critical/high findings stay, the rest drop.
    const ruling: ArbiterOutput =
      arbiter.status === 'ok'
        ? arbiter.value
        : { summary: `The arbiter returned no valid decision (${arbiter.error}); the fail-safe rule applied: only high-confidence critical or high findings stand.`, decisions: [] }
    const arbiterAgentId = arbiter.status === 'ok' ? arbiter.agentId : null
    const { accepted, rejected } = applyArbitration(deduped, ruling.decisions)
    const blocking = accepted.filter((f) => SIGNIFICANT.has(f.severity))
    const verdict = blocking.length > 0 ? 'changes_requested' : 'approved'
    bus.transaction(() => {
      const row = repos.reviews.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        agentId: arbiterAgentId,
        attempt,
        verdict,
        summary: ruling.summary,
        findings: deduped.map((d) => d.finding),
        createdAt: nowIso(),
      })
      repos.artifacts.insert({
        id: newId(),
        runId: run.id,
        taskId: task.id,
        agentId: arbiterAgentId,
        kind: ARBITRATION_ARTIFACT,
        title: row.id,
        content: JSON.stringify(ruling),
        createdAt: nowIso(),
      })
      bus.emit({ runId: run.id, taskId: task.id, agentId: arbiterAgentId, type: 'review.arbitrated', payload: { accepted: accepted.length, rejected: rejected.length } })
      bus.emit({ runId: run.id, taskId: task.id, agentId: arbiterAgentId, type: 'review.completed', payload: { verdict, findings: deduped.length } })
    })
    this.sendFindingMessages(run, task, blocking, arbiterAgentId, label('reviewers', task.key))
    if (verdict === 'approved') return { status: 'approved', summary: ruling.summary }
    return {
      status: 'changes',
      failure: {
        kind: 'review',
        summary: `Review requested changes: ${blocking.length} significant finding(s) confirmed by the arbiter.`,
        details: ruling.summary,
        findings: blocking,
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
        checkOutputMode: checkOutputMode(this.core.deps.repos.settings.get().tokens),
        reviewSummary,
        evidence: buildTaskEvidence(repos, run.id, task, { changedFiles: diff.files }),
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
      /** Defaults to the role's label. */
      label?: string
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
        label: spec.label ?? label(spec.role, task.key),
        cwd: worktree.path,
        worktreeRoot: worktree.path,
        projectRoot: this.core.project(run).rootPath,
        prompt: spec.prompt,
        outputSchema: spec.jsonSchema,
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
      this.outcome(run.id, parent.id)
      return false
    }

    this.host.setStage(parent.id, 'repair')
    const n = cycles + 1
    // The router decides the escalation (a later repair is promoted, a serious finding forces the strongest policy).
    const severity = topSeverity(failure.findings)
    const tier = this.core.routing.repairTier(run, parent, n, severity)
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

    const built = buildRepairPrompt({
      task: parent,
      failure: { kind: failure.kind, summary: failure.summary, details: failure.details },
      findings: failure.findings,
      failures: failure.failures,
      checkResults: failure.checkResults,
      checkOutputMode: checkOutputMode(this.core.deps.repos.settings.get().tokens),
      evidence: buildTaskEvidence(repos, run.id, parent),
    })
    const instructions = this.core.messages.takeInstructions(parent.id)
    const prompt = instructions.length === 0 ? built.prompt : [built.prompt, '## Instructions from the user', ...instructions.map((m) => `- ${m.body}`)].join('\n\n')
    const blocks: PromptBlock[] = built.sections.map((section) => {
      const source = REPAIR_SECTIONS[section.name] ?? { kind: 'failure' as const, reason: 'Part of the repair request.' }
      return { section: section.name, sourceKind: source.kind, sourceId: parent.id, title: section.name, reason: source.reason, chars: section.chars }
    })
    for (const m of instructions) {
      blocks.push({ section: 'Instructions from the user', sourceKind: 'user_instruction', sourceId: m.id, title: m.subject, reason: 'Instruction from the user, not yet delivered.', chars: m.body.length })
    }
    const result = await this.core.agents.run({
      run,
      task: child,
      role: 'debugger',
      purpose: 'diagnose',
      label: label('debugger', child.key),
      cwd: worktree.path,
      worktreeRoot: worktree.path,
      projectRoot: this.core.project(run).rootPath,
      prompt,
      contextPack: packForPrompt({ run, task: child, purpose: 'diagnose', prompt, blocks }),
      routing: { repairCycle: n, triggeringSeverity: severity },
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
    this.outcome(run.id, parent.id)
    return false
  }

  // ───────────────────────────── yield and resume ─────────────────────────────

  /**
   * A task that waits for a new, uncompleted prerequisite (added by an applied graph proposal) does not
   * continue to checks or review: leftovers are committed, the worktree is kept and the task goes back to
   * 'queued', where the scheduler holds it until its dependencies completed. Its attempt is not consumed.
   */
  private async yieldIfWaiting(run: Run, task: Task, worktree: Worktree | null): Promise<boolean> {
    const waitingOn = this.core.graph.unmetPrerequisites(task)
    // A marker with nothing left to wait for (the prerequisite finished before the turn did) still yields:
    // the restart goes through the resume path, which merges the integration branch into the worktree.
    if (waitingOn.length === 0 && !this.core.graph.yieldMarker(task.id)) return false
    if (worktree) await this.commitLeftovers(run, task, worktree)
    const keys = waitingOn.map((t) => t.key).join(', ')
    this.core.graph.markYielded(task.id)
    const reason =
      waitingOn.length > 0
        ? `yielded: waiting for ${keys} (graph change); resumes once it is merged`
        : 'yielded: the prerequisite already merged; resumes on the updated integration branch'
    return this.core.tryTaskState(task.id, 'queued', { leaseOwner: null, leaseExpiresAt: null }, reason) !== null
  }

  /**
   * Restart of a yielded task: the integration branch (which now holds the prerequisites' merged work) is
   * merged into the task's worktree, then a FRESH session is told what happened. A conflicting merge is
   * aborted and left to the agent: the instruction names the command, and the later merge into the
   * integration branch still goes through the repair path if it conflicts. Null when the task did not yield.
   */
  private async prepareResume(run: Run, task: Task, worktree: Worktree | null): Promise<string | null> {
    const { repos, git } = this.core.deps
    if (!this.core.graph.yieldMarker(task.id)) return null
    const upstream = dependenciesOf(repos.dependencies.listByRun(run.id), task.id)
      .map((id) => repos.tasks.get(id))
      .filter((t): t is Task => t !== null)
    // The prerequisites a proposal added were created after this task first started.
    const added = upstream.filter((t) => task.startedAt !== null && t.createdAt >= task.startedAt)
    const prerequisites = added.length > 0 ? added : upstream

    let sync = 'This task has no worktree of its own.'
    if (worktree) {
      try {
        const integration = await this.host.ensureIntegration(run)
        await this.commitLeftovers(run, task, worktree)
        const merged = await this.host.withMergeLock(run.id, () =>
          git.merge(worktree.path, integration.branch, {
            message: `Sync ${task.key} with ${integration.branch}`,
            author: this.core.author(),
          }),
        )
        sync = merged.ok
          ? `The integration branch ${integration.branch} was merged into your worktree, so the prerequisites' work is present.`
          : `Merging the integration branch ${integration.branch} into your worktree conflicted in: ${merged.conflicts.join(', ')}. The merge was aborted. Run \`git merge ${integration.branch}\`, resolve the conflicts so that both changes keep working, and commit the merge before continuing.`
      } catch (e) {
        this.core.log(`resume sync for ${task.key} failed: ${errorMessage(e)}`)
        sync = `NEXUS could not merge the integration branch into your worktree (${errorMessage(e)}). Run \`git merge ${run.integrationBranch ?? 'the integration branch'}\` yourself before continuing.`
      }
    }
    return [
      '## Resuming after a prerequisite',
      `You stopped earlier because you proposed a graph change that added prerequisite task(s) your task needs. ${prerequisites.map((t) => t.key).join(', ')} completed and merged. This is a new session: continue the task from the current state of the worktree (check \`git log\` and \`git status\`), using the prerequisites' work.`,
      sync,
      ...prerequisites.map((t) => `### Prerequisite ${t.key}: ${t.title}\n${t.resultSummary ?? '(no summary)'}`),
      `### Your previous summary\n${task.resultSummary ?? '(none)'}`,
    ].join('\n\n')
  }

  /** Decisions agents recorded for a task that passed verification become 'decision' facts of the repository. */
  private async recordDecisionFacts(run: Run, task: Task, diff: DiffResult): Promise<void> {
    const { repos } = this.core.deps
    try {
      const ids = new Set([task.id, ...repos.tasks.listByParent(task.id).map((t) => t.id)])
      const decisions = repos.decisions.listByRun(run.id).filter((d) => d.taskId !== null && ids.has(d.taskId))
      if (decisions.length === 0) return
      const project = this.core.project(run)
      const changed = diff.files.map((f) => f.path)
      const files = (changed.length > 0 ? changed : task.suggestedFiles).slice(0, 20)
      const fingerprint = await fingerprintFiles(project.rootPath, files)
      const now = nowIso()
      for (const d of decisions) {
        repos.facts.upsert({
          id: newId(),
          projectId: project.id,
          kind: 'decision',
          subject: oneLine(d.title, 120),
          statement: `Agent-recorded decision (not independently verified): ${oneLine(`${d.decision} Rationale: ${d.rationale}`, 600)}`,
          source: 'agent',
          confidence: 'medium',
          files,
          fingerprint,
          stale: false,
          createdAt: now,
          verifiedAt: now,
        })
      }
    } catch (e) {
      this.core.log(`recording decision facts for ${task.key} failed: ${errorMessage(e)}`)
    }
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
    this.outcome(run.id, task.id)
  }

  /** Record the empirical outcome of an implementing task that reached a final state. */
  private outcome(runId: string, taskId: string): void {
    recordTaskOutcome(this.core.deps, this.core.deps.repos.runs.require(runId), taskId, (line) => this.core.log(line))
  }

  private leaseExpiry(run: Run): string {
    return new Date(Date.now() + run.config.leaseMinutes * 60_000).toISOString()
  }

  /**
   * The stage a task left in state 'running' resumes at. The state stays 'running' through checks (and
   * after a successful repair), so it cannot tell by itself: when the task's implementing agent already
   * finished its session successfully the work is done and only the checks onwards remain.
   */
  resumeStage(task: Pick<Task, 'id' | 'state'>): Stage {
    if (task.state !== 'running') return 'implement'
    // Candidates still working, or a winner not yet adopted: the speculative stage has to finish first. One
    // candidate's completed session says nothing about the task.
    if (this.speculation.pending(task.id)) return 'implement'
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
