import { existsSync } from 'node:fs'
import {
  ACTIVE_AGENT_STATES,
  MissionPlanSchema,
  TERMINAL_RUN_STATES,
  TERMINAL_TASK_STATES,
  VerifierOutputSchema,
  WRITING_ROLES,
  type AcceptanceCriterion,
  type Agent,
  type AgentRole,
  type ApprovalRequest,
  type Complexity,
  type Message,
  type MissionPlan,
  type PlannedTask,
  type Preset,
  type Run,
  type RunConfig,
  type RunMode,
  type RunState,
  type Task,
  type TaskKind,
  type Worktree,
} from '@shared/domain'
import type { RecoverableRun } from '@shared/ipc'
import { newId, nowIso } from '@shared/ids'
import { errorMessage, NexusError } from '@shared/result'
import { buildRunConfig } from '@shared/settings'
import {
  buildMissionVerifierPrompt,
  buildPlannerPrompt,
  missionPlanJsonSchema,
  verifierOutputJsonSchema,
} from '@main/modules/context/context-builder'
import {
  dependencyFailureCascade,
  findExpiredLeases,
  isRunFinished,
  selectRunnable,
} from '@main/modules/scheduler'
import { canPauseRun, deriveRunPhase, resumeTarget } from '@main/modules/state'
import { validatePlan, wouldCreateCycle } from '@main/modules/task-graph'
import { SessionControl } from './agent-runner'
import { Core } from './core'
import type { OrchestratorDeps } from './deps'
import { renderMessage } from './messaging'
import { TaskPipeline, type PipelineHost, type Stage } from './pipeline'

const ACTIVE_RUN_STATES: readonly RunState[] = ['executing', 'testing', 'reviewing', 'verifying', 'repairing']
const MAX_PLAN_ATTEMPTS = 3
const DEPENDENCY_BLOCK_PREFIX = 'dependency:'

export interface CreateRunInput {
  projectId: string
  mode: RunMode
  preset: Preset
  prompt: string
  overrides?: Partial<RunConfig>
}

export interface AddTaskInput {
  runId: string
  title: string
  description: string
  role: AgentRole
  dependsOn: string[]
  suggestedFiles: string[]
  acceptanceCriteria: string[]
  complexity: Complexity
}

interface ActivePipeline {
  runId: string
  control: SessionControl
  stage: Stage | 'repair' | 'merge'
  done: Promise<void>
}

function kindFor(mode: RunMode, task: PlannedTask): TaskKind {
  if (mode === 'audit') return task.dependencies.length > 0 ? 'synthesis' : 'audit'
  switch (task.role) {
    case 'worker':
      return 'implement'
    case 'debugger':
      return 'repair'
    case 'architect':
      return 'design'
    case 'reviewer':
    case 'security_reviewer':
    case 'verifier':
      return 'audit'
    case 'planner':
    case 'researcher':
      return 'research'
  }
}

/**
 * The control plane. All scheduling decisions are made here in deterministic code from durable
 * state; agents never hold orchestration state.
 */
export class Orchestrator implements PipelineHost {
  readonly core: Core
  private readonly pipeline: TaskPipeline
  private readonly active = new Map<string, ActivePipeline>()
  /** Controls for run-level agents (planner, mission verifier). */
  private readonly runControls = new Map<string, SessionControl>()
  private readonly runWork = new Map<string, Promise<void>>()
  private readonly ticks = new Map<string, { running: boolean; again: boolean }>()
  private readonly mergeLocks = new Map<string, Promise<unknown>>()
  private readonly integrations = new Map<string, Promise<Worktree>>()
  private readonly announced = new Set<string>()

  constructor(private readonly deps: OrchestratorDeps) {
    this.core = new Core(deps)
    this.pipeline = new TaskPipeline(this.core, this)
    this.core.messages.setLiveDelivery((taskId, message) => this.deliverLive(taskId, message))
    this.core.approvals.onResolved((approval) => this.onApprovalResolved(approval))
  }

  // ───────────────────────────── run creation and planning ─────────────────────────────

  async createRun(input: CreateRunInput): Promise<Run> {
    const { repos, bus, git } = this.deps
    const project = repos.projects.require(input.projectId)
    const settings = repos.settings.get()
    const readOnly = input.mode === 'ask' || input.mode === 'audit'

    const isRepo = await git.isRepository(project.rootPath)
    if (!isRepo && !readOnly) {
      throw new NexusError('not_a_repository', `${project.rootPath} is not a Git repository. ${input.mode.toUpperCase()} mode needs one for worktrees.`)
    }
    // The user's working tree is never modified: work happens in worktrees created from HEAD.
    const baseBranch = isRepo ? await git.currentBranch(project.rootPath) : null
    const baseCommit = isRepo ? await git.headCommit(project.rootPath).catch(() => null) : null
    if (!readOnly && !baseCommit) {
      throw new NexusError('invalid_state', 'The repository has no commits yet. Create an initial commit first.')
    }

    const checks = project.profile?.commands ?? { build: null, test: null, lint: null, typecheck: null }
    const config = buildRunConfig(settings, input.preset, checks, project.respectProjectClaudeConfig, input.overrides)
    const run = bus.transaction(() => {
      const row = repos.runs.insert({
        id: newId(),
        projectId: project.id,
        mode: input.mode,
        preset: input.preset,
        state: 'planning',
        resumeState: null,
        pauseReason: null,
        prompt: input.prompt,
        plan: null,
        baseBranch,
        baseCommit,
        integrationBranch: null,
        config,
        error: null,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
      })
      bus.emit({ runId: row.id, type: 'run.created', payload: { mode: row.mode, preset: row.preset } })
      return row
    })

    if (input.mode === 'ask') {
      this.materialize(run, {
        summary: input.prompt.slice(0, 200),
        assumptions: [],
        acceptanceCriteria: [],
        risks: [],
        tasks: [
          {
            id: 'ask',
            title: input.prompt.slice(0, 120),
            description: input.prompt,
            role: 'researcher',
            dependencies: [],
            parallelizable: true,
            suggestedFiles: [],
            acceptanceCriteria: [],
            complexity: 'small',
            risk: 'low',
            requiresApproval: false,
          },
        ],
      })
      this.background(run.id, () => this.startExecution(run.id))
    } else {
      this.background(run.id, () => this.plan(run.id))
    }
    return repos.runs.require(run.id)
  }

  private async plan(runId: string, feedback?: string, previousPlan?: MissionPlan): Promise<void> {
    const { repos, bus } = this.deps
    let run = repos.runs.require(runId)
    const project = this.core.project(run)
    if (!project.profile) throw new NexusError('invalid_state', 'Project has not been profiled')
    const control = this.runControl(runId)
    let previousErrors: string[] | undefined

    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
      const prompt = buildPlannerPrompt({
        run,
        profile: project.profile,
        memory: this.core.memory.relevantFor(run, { title: run.prompt.slice(0, 200), description: run.prompt, suggestedFiles: [] }),
        feedback,
        previousErrors,
        previousPlan,
      }).prompt
      const result = await this.core.agents.run({
        run,
        task: null,
        role: 'planner',
        purpose: 'plan',
        label: 'Planner',
        cwd: project.rootPath,
        worktreeRoot: project.rootPath,
        projectRoot: project.rootPath,
        prompt,
        outputSchema: missionPlanJsonSchema,
        tier: run.config.modelPolicy.planner,
        control,
      })
      run = repos.runs.require(runId)
      if (control.stopReason || run.state !== 'planning') return
      if (result.outcome === 'quota') {
        this.core.pauseRun(runId, 'quota', 'Claude usage limit reached')
        return
      }
      if (result.outcome === 'auth') {
        this.core.pauseRun(runId, 'user', 'Claude authentication required')
        return
      }

      const errors = this.validatePlanOutput(run, result.outcome === 'success' ? result.structuredOutput : undefined, result.error)
      if (errors.plan) {
        this.materialize(run, errors.plan)
        bus.emit({ runId, type: 'plan.proposed', payload: { taskCount: errors.plan.tasks.length, attempt } })
        if (run.config.requirePlanApproval) {
          this.core.setRunState(runId, 'awaiting_approval')
          this.requestPlanApproval(repos.runs.require(runId))
        } else {
          await this.startExecution(runId)
        }
        return
      }
      // Invalid plans are rejected in code and handed back to the planner to repair.
      previousErrors = errors.errors
      bus.emit({ runId, type: 'plan.invalid', payload: { errors: errors.errors, attempt } })
    }
    this.failRun(runId, `The planner did not produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts: ${(previousErrors ?? []).join('; ')}`)
  }

  private validatePlanOutput(run: Run, output: unknown, agentError: string | null): { plan?: MissionPlan; errors: string[] } {
    if (output === undefined) return { errors: [agentError ?? 'The planner returned no structured plan.'] }
    const parsed = MissionPlanSchema.safeParse(output)
    if (!parsed.success) {
      return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
    }
    const validation = validatePlan(parsed.data)
    const errors = validation.ok ? [] : [...validation.errors]
    if (run.mode === 'audit') {
      for (const t of parsed.data.tasks) {
        if (WRITING_ROLES.includes(t.role)) errors.push(`Task "${t.id}": AUDIT mode is read-only; role ${t.role} is not allowed.`)
      }
    }
    return errors.length > 0 ? { errors } : { plan: parsed.data, errors: [] }
  }

  /** Turn a validated plan into task, dependency and criterion rows (tasks start in `draft`). */
  private materialize(run: Run, plan: MissionPlan): void {
    const { repos, bus } = this.deps
    bus.transaction(() => {
      repos.runs.update(run.id, { plan })
      const idByKey = new Map<string, string>()
      for (const planned of plan.tasks) {
        const task = repos.tasks.insert({
          id: newId(),
          runId: run.id,
          key: planned.id,
          title: planned.title,
          description: planned.description,
          role: planned.role,
          kind: run.mode === 'ask' ? 'ask' : kindFor(run.mode, planned),
          state: 'draft',
          priority: 0,
          complexity: planned.complexity,
          risk: planned.risk,
          parallelizable: planned.parallelizable,
          requiresApproval: planned.requiresApproval,
          approvalGranted: false,
          suggestedFiles: planned.suggestedFiles,
          acceptanceCriteria: planned.acceptanceCriteria,
          attempt: 0,
          repairCycles: 0,
          parentTaskId: null,
          modelTierOverride: null,
          branch: null,
          worktreeId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          resultSummary: null,
          blockedReason: null,
          error: null,
          createdAt: nowIso(),
          startedAt: null,
          finishedAt: null,
        })
        idByKey.set(planned.id, task.id)
        this.insertCriteria(run.id, task.id, planned.acceptanceCriteria)
        bus.emit({
          runId: run.id,
          taskId: task.id,
          type: 'task.created',
          payload: { key: task.key, title: task.title, role: task.role, kind: task.kind },
        })
      }
      for (const planned of plan.tasks) {
        for (const dep of planned.dependencies) {
          repos.dependencies.add(idByKey.get(planned.id) as string, idByKey.get(dep) as string)
        }
      }
      this.insertCriteria(run.id, null, plan.acceptanceCriteria)
    })
  }

  private insertCriteria(runId: string, taskId: string | null, texts: string[]): void {
    for (const text of texts) {
      this.deps.repos.criteria.insert({ id: newId(), runId, taskId, text, status: 'pending', evidence: null, updatedAt: nowIso() })
    }
  }

  private requestPlanApproval(run: Run): void {
    this.core.approvals.create({
      runId: run.id,
      taskId: null,
      agentId: null,
      kind: 'plan',
      action: 'Approve mission plan',
      reason: `${run.plan?.tasks.length ?? 0} task(s): ${run.plan?.summary ?? ''}`.slice(0, 500),
      command: null,
      requestedBy: 'Planner',
      risk: 'low',
    })
  }

  async approvePlan(runId: string): Promise<Run> {
    const run = this.deps.repos.runs.require(runId)
    if (run.state !== 'awaiting_approval') throw new NexusError('invalid_state', `Run is ${run.state}, not awaiting approval`)
    const pending = this.deps.repos.approvals.listPending(runId).find((a) => a.kind === 'plan')
    if (pending) {
      // Resolving the request re-enters through onApprovalResolved, which starts execution.
      this.core.approvals.resolve(pending.id, true)
    } else {
      this.deps.bus.emit({ runId, type: 'plan.approved', payload: {} })
      this.background(runId, () => this.startExecution(runId))
    }
    return this.deps.repos.runs.require(runId)
  }

  async replan(runId: string, feedback: string): Promise<Run> {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (run.state !== 'awaiting_approval') throw new NexusError('invalid_state', 'Only a plan awaiting approval can be replanned')
    const previousPlan = run.plan ?? undefined
    this.core.approvals.expire({ runId })
    bus.transaction(() => {
      for (const criterion of repos.criteria.listByRun(runId)) repos.criteria.delete(criterion.id)
      for (const task of repos.tasks.listByRun(runId)) repos.tasks.delete(task.id)
      this.core.setRunState(runId, 'planning', { plan: null })
      bus.emit({ runId, type: 'plan.rejected', payload: { feedback } })
      bus.emit({ runId, type: 'user.intervention', payload: { action: 'replan', detail: feedback } })
    })
    this.background(runId, () => this.plan(runId, feedback, previousPlan))
    return repos.runs.require(runId)
  }

  private async startExecution(runId: string): Promise<void> {
    const { repos, bus } = this.deps
    bus.transaction(() => {
      for (const task of repos.tasks.listByState(runId, 'draft')) {
        this.core.setTaskState(task.id, 'ready')
        bus.emit({ runId, taskId: task.id, type: 'task.ready', payload: {} })
      }
      this.core.setRunState(runId, 'executing', { startedAt: nowIso() })
      bus.emit({ runId, type: 'run.started', payload: {} })
    })
    this.requestTick(runId)
  }

  // ───────────────────────────── scheduling ─────────────────────────────

  /** Schedule a scheduler pass for the run. Passes for one run never overlap. */
  requestTick(runId: string): void {
    const slot = this.ticks.get(runId) ?? { running: false, again: false }
    this.ticks.set(runId, slot)
    if (slot.running) {
      slot.again = true
      return
    }
    slot.running = true
    void (async () => {
      try {
        do {
          slot.again = false
          await this.tick(runId)
        } while (slot.again)
      } catch (e) {
        this.core.log(`tick ${runId} failed: ${errorMessage(e)}`)
      } finally {
        slot.running = false
      }
    })()
  }

  private async tick(runId: string): Promise<void> {
    const { repos, bus } = this.deps
    const run = repos.runs.get(runId)
    if (!run || !ACTIVE_RUN_STATES.includes(run.state)) return

    if (run.startedAt && Date.now() - Date.parse(run.startedAt) > run.config.maxDurationMinutes * 60_000) {
      await this.pauseRun(runId, 'user', `Mission duration limit of ${run.config.maxDurationMinutes} minutes reached`)
      return
    }

    // Leases of tasks nobody is driving any more (crashed pipeline): give the task back.
    for (const task of findExpiredLeases(repos.tasks.listByRun(runId), nowIso())) {
      if (this.active.has(task.id)) continue
      bus.transaction(() => {
        repos.tasks.update(task.id, { leaseOwner: null, leaseExpiresAt: null })
        bus.emit({ runId, taskId: task.id, type: 'task.lease_expired', payload: { owner: task.leaseOwner } })
      })
    }

    this.restartOrphans(run)

    let tasks = repos.tasks.listByRun(runId)
    const dependencies = repos.dependencies.listByRun(runId)
    for (const block of dependencyFailureCascade(tasks, dependencies)) {
      const reason = `${DEPENDENCY_BLOCK_PREFIX} ${block.reason}`
      if (this.core.tryTaskState(block.taskId, 'blocked', { blockedReason: reason })) {
        bus.emit({ runId, taskId: block.taskId, type: 'task.blocked', payload: { reason } })
      }
    }

    tasks = repos.tasks.listByRun(runId)
    const activeTaskIds = [...this.active.entries()].filter(([, p]) => p.runId === runId).map(([id]) => id)
    const decision = selectRunnable({
      tasks,
      dependencies,
      activeTaskIds,
      maxParallelAgents: run.config.maxParallelAgents,
      now: nowIso(),
      paused: false,
    })
    for (const deferred of decision.deferred) this.announceDeferral(runId, deferred.taskId, deferred.reason)
    for (const taskId of decision.start) {
      bus.transaction(() => {
        this.core.setTaskState(taskId, 'assigned')
        bus.emit({ runId, taskId, type: 'task.assigned', payload: { agentId: '' } })
      })
      this.launch(runId, taskId, 'implement')
    }

    this.updatePhase(runId)

    const stillActive = [...this.active.values()].some((p) => p.runId === runId)
    if (stillActive || this.runWork.has(runId)) return
    tasks = repos.tasks.listByRun(runId)
    if (isRunFinished(tasks)) {
      this.background(runId, () => this.finalize(runId))
      return
    }
    // Nothing is running and nothing can start. Unless an approval can unblock it, a human must step in.
    const awaitingApproval = decision.deferred.some((d) => d.reason.kind === 'awaiting_approval')
    if (!awaitingApproval && decision.start.length === 0) {
      const stuck = tasks.filter((t) => t.state === 'failed' || t.state === 'blocked').map((t) => t.key)
      await this.pauseRun(runId, 'user', `Intervention required: ${stuck.length > 0 ? `tasks ${stuck.join(', ')} are failed or blocked` : 'no task can make progress'}`)
    }
  }

  /** Emit one event per (task, cause) so the UI can explain why a ready task is not running. */
  private announceDeferral(runId: string, taskId: string, reason: ReturnType<typeof selectRunnable>['deferred'][number]['reason']): void {
    const { repos, bus } = this.deps
    if (reason.kind === 'serialized_file_overlap') {
      const key = `${taskId}:overlap:${reason.behindTaskId}`
      if (this.announced.has(key)) return
      this.announced.add(key)
      bus.emit({ runId, taskId, type: 'task.serialized', payload: { conflictsWith: reason.behindTaskId, files: reason.files } })
    } else if (reason.kind === 'awaiting_approval') {
      const key = `${taskId}:approval`
      if (this.announced.has(key)) return
      this.announced.add(key)
      const task = repos.tasks.require(taskId)
      this.core.approvals.create({
        runId,
        taskId,
        agentId: null,
        kind: 'task',
        action: `Start task "${task.title}"`,
        reason: 'The planner marked this task as requiring approval before it starts.',
        command: null,
        requestedBy: 'Scheduler',
        risk: task.risk,
      })
    }
  }

  /** Tasks left mid-pipeline by a pause or restart resume at the stage their state records. */
  private restartOrphans(run: Run): void {
    const { repos } = this.deps
    const tasks = repos.tasks.listByRun(run.id)
    for (const task of tasks) {
      if (this.active.has(task.id) || task.parentTaskId) continue
      let stage: Stage | null = null
      switch (task.state) {
        case 'assigned':
        case 'running':
          stage = 'implement'
          break
        case 'review':
          stage = 'review'
          break
        case 'verification':
          stage = 'verification'
          break
        case 'waiting':
          // Its repair child died with the previous process; re-evaluate from the checks.
          for (const child of tasks.filter((t) => t.parentTaskId === task.id)) {
            this.core.tryTaskState(child.id, 'cancelled')
          }
          stage = 'checks'
          break
        default:
          break
      }
      if (stage) this.launch(run.id, task.id, stage)
    }
  }

  private launch(runId: string, taskId: string, stage: Stage): void {
    const control = new SessionControl()
    const done = this.pipeline
      .run(runId, taskId, stage, control)
      .catch((e: unknown) => this.core.log(`pipeline ${taskId}: ${errorMessage(e)}`))
      .finally(() => {
        this.active.delete(taskId)
        this.requestTick(runId)
      })
    this.active.set(taskId, { runId, control, stage, done })
  }

  setStage(taskId: string, stage: Stage | 'repair' | 'merge'): void {
    const pipeline = this.active.get(taskId)
    if (!pipeline) return
    pipeline.stage = stage
    this.updatePhase(pipeline.runId)
  }

  private updatePhase(runId: string): void {
    const run = this.deps.repos.runs.require(runId)
    if (!ACTIVE_RUN_STATES.includes(run.state)) return
    const stages = [...this.active.values()].filter((p) => p.runId === runId).map((p) => p.stage)
    if (stages.length === 0) return
    let phase = deriveRunPhase(this.deps.repos.tasks.listByRun(runId))
    if (phase === 'executing' && stages.every((s) => s === 'checks')) phase = 'testing'
    if (phase !== run.state) this.core.setRunState(runId, phase)
  }

  // ───────────────────────────── integration branch ─────────────────────────────

  ensureIntegration(run: Run): Promise<Worktree> {
    const existing = this.integrations.get(run.id)
    if (existing) return existing
    const created = this.createIntegration(run).catch((e: unknown) => {
      this.integrations.delete(run.id)
      throw e
    })
    this.integrations.set(run.id, created)
    return created
  }

  private async createIntegration(run: Run): Promise<Worktree> {
    const { repos, bus, worktrees } = this.deps
    const row = repos.worktrees.listByRun(run.id).find((w) => w.taskId === null && w.state === 'active')
    if (row && existsSync(row.path)) return row
    if (!run.baseCommit) throw new NexusError('invalid_state', 'Run has no base commit')
    const created = await worktrees.createIntegration({
      repoRoot: this.core.project(run).rootPath,
      runId: run.id,
      startPoint: run.baseCommit,
    })
    const worktree = bus.transaction(() => {
      const inserted = repos.worktrees.insert({
        id: newId(),
        runId: run.id,
        taskId: null,
        path: created.path,
        branch: created.branch,
        baseCommit: created.baseCommit,
        state: 'active',
        createdAt: nowIso(),
      })
      repos.runs.update(run.id, { integrationBranch: created.branch })
      bus.emit({ runId: run.id, type: 'git.worktree.created', payload: { path: created.path, branch: created.branch } })
      return inserted
    })
    await this.core.setupWorktree(run, null, created.path)
    return worktree
  }

  withMergeLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mergeLocks.get(runId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.mergeLocks.set(
      runId,
      next.catch(() => undefined),
    )
    return next
  }

  // ───────────────────────────── completion ─────────────────────────────

  /** All tasks are terminal: verify the mission as a whole before declaring it complete. */
  private async finalize(runId: string): Promise<void> {
    const { repos, bus, git } = this.deps
    let run = repos.runs.require(runId)
    if (!ACTIVE_RUN_STATES.includes(run.state)) return
    const tasks = repos.tasks.listByRun(runId)

    if (tasks.some((t) => t.state === 'failed')) {
      const failed = tasks.filter((t) => t.state === 'failed').map((t) => t.key)
      this.core.pauseRun(runId, 'user', `Intervention required: tasks ${failed.join(', ')} failed`)
      return
    }
    if (tasks.every((t) => t.state === 'cancelled')) {
      bus.transaction(() => {
        this.core.setRunState(runId, 'cancelled')
        bus.emit({ runId, type: 'run.cancelled', payload: {} })
      })
      return
    }

    run = this.core.setRunState(runId, 'verifying')
    const integration = repos.worktrees.listByRun(runId).find((w) => w.taskId === null && w.state === 'active')
    const criteria = repos.criteria.listByRun(runId).filter((c) => c.taskId === null)

    if (integration && run.baseCommit && existsSync(integration.path)) {
      const control = this.runControl(runId)
      const cycle = tasks.filter((t) => t.key.startsWith('mission-fix-')).length + 1
      const checks = await this.core.runChecks(run, null, integration.path, cycle)
      if (control.stopReason || repos.runs.require(runId).state !== 'verifying') return
      const diff = await git.diff(integration.path, run.baseCommit, 'HEAD')
      const stat = diff.files.map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join('\n')

      let failures = checks.passed ? [] : checks.failures
      let summary = checks.summary
      if (checks.passed && criteria.length > 0) {
        bus.emit({ runId, type: 'verification.started', payload: { attempt: cycle } })
        const result = await this.core.agents.run({
          run,
          task: null,
          role: 'verifier',
          purpose: 'verify',
          label: 'Verifier/mission',
          cwd: integration.path,
          worktreeRoot: integration.path,
          projectRoot: this.core.project(run).rootPath,
          prompt: buildMissionVerifierPrompt({
            run,
            missionCriteria: criteria.map((c) => c.text),
            diffStat: stat || '(no changes)',
            checkResults: checks.commands,
            planSummary: run.plan?.summary,
          }).prompt,
          outputSchema: verifierOutputJsonSchema,
          tier: run.config.modelPolicy.verifier,
          control,
        })
        if (control.stopReason || repos.runs.require(runId).state !== 'verifying') return
        if (result.outcome === 'quota') {
          this.core.pauseRun(runId, 'quota', 'Claude usage limit reached')
          return
        }
        const parsed = VerifierOutputSchema.safeParse(result.structuredOutput)
        if (result.outcome !== 'success' || !parsed.success) {
          this.core.pauseRun(runId, 'user', `Intervention required: mission verification could not be completed (${result.error ?? 'invalid verifier output'})`)
          return
        }
        const output = parsed.data
        const passed = output.failures.length === 0 && output.criteria.every((c) => c.passed)
        summary = output.summary
        failures = passed
          ? []
          : output.failures.length > 0
            ? output.failures
            : output.criteria.filter((c) => !c.passed).map((c) => ({ criterion: c.criterion, evidence: c.evidence, likelyCause: '', relevantFiles: [] }))
        bus.transaction(() => {
          repos.verifications.insert({
            id: newId(),
            runId,
            taskId: null,
            agentId: result.agentId,
            attempt: cycle,
            kind: 'verifier',
            passed,
            summary: output.summary,
            criteria: output.criteria,
            commands: [],
            failures: output.failures,
            createdAt: nowIso(),
          })
          for (const c of output.criteria) {
            const row = criteria.find((r) => r.text.trim() === c.criterion.trim())
            if (!row) continue
            const status = c.passed ? 'passed' : 'failed'
            repos.criteria.update(row.id, { status, evidence: c.evidence, updatedAt: nowIso() })
            bus.emit({ runId, type: 'criterion.updated', payload: { criterionId: row.id, status } })
          }
          if (passed) bus.emit({ runId, agentId: result.agentId, type: 'verification.passed', payload: { summary: output.summary } })
          else bus.emit({ runId, agentId: result.agentId, type: 'verification.failed', payload: { failures: failures.length, summary: output.summary } })
        })
      }

      if (failures.length > 0) {
        // Bounded mission-level repair loop: a failure becomes a new repair task in the DAG.
        if (cycle > run.config.maxIterations) {
          this.core.pauseRun(runId, 'user', `Intervention required: mission verification still failing after ${cycle - 1} repair iteration(s)`)
          return
        }
        bus.transaction(() => {
          const task = this.insertTask(run, {
            key: `mission-fix-${cycle}`,
            title: `Repair mission verification failure (${cycle})`,
            description: [
              `Mission verification failed: ${summary}`,
              ...failures.map((f) => `- ${f.criterion}\n  Evidence: ${f.evidence}${f.likelyCause ? `\n  Likely cause: ${f.likelyCause}` : ''}`),
            ].join('\n'),
            role: 'debugger',
            kind: 'repair',
            suggestedFiles: [...new Set(failures.flatMap((f) => f.relevantFiles))],
            acceptanceCriteria: failures.map((f) => f.criterion),
            complexity: 'medium',
            modelTierOverride: cycle >= 2 ? 'strongest' : null,
          })
          this.core.setTaskState(task.id, 'ready')
          this.core.setRunState(runId, 'repairing')
        })
        this.requestTick(runId)
        return
      }
    }

    const completed = tasks.filter((t) => t.state === 'completed').length
    bus.transaction(() => {
      this.core.setRunState(runId, 'completed')
      bus.emit({ runId, type: 'run.completed', payload: { summary: `${completed}/${tasks.length} tasks completed and verified.` } })
    })
  }

  private failRun(runId: string, error: string): void {
    const { bus } = this.deps
    bus.transaction(() => {
      this.core.setRunState(runId, 'failed', { error })
      bus.emit({ runId, type: 'run.failed', payload: { error } })
    })
  }

  // ───────────────────────────── human intervention ─────────────────────────────

  async pauseRun(runId: string, reason: 'user' | 'quota' | 'recovery' = 'user', detail?: string): Promise<Run> {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (!canPauseRun(run.state)) throw new NexusError('invalid_state', `A ${run.state} run cannot be paused`)
    this.core.pauseRun(runId, reason, detail)
    if (reason === 'user' && !detail) bus.emit({ runId, type: 'user.intervention', payload: { action: 'pause' } })
    await this.stopRunSessions(runId, 'paused')
    return repos.runs.require(runId)
  }

  async resumeRun(runId: string): Promise<Run> {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (run.state !== 'paused') throw new NexusError('invalid_state', `Run is ${run.state}, not paused`)
    await this.settle(runId)
    const target = resumeTarget(run)
    bus.transaction(() => {
      this.core.setRunState(runId, target, { resumeState: null, pauseReason: null })
      bus.emit({ runId, type: 'run.resumed', payload: {} })
    })
    this.runControls.delete(runId)
    if (target === 'planning') this.background(runId, () => this.plan(runId))
    else if (target === 'awaiting_approval') {
      if (!repos.approvals.listPending(runId).some((a) => a.kind === 'plan')) this.requestPlanApproval(repos.runs.require(runId))
    } else this.requestTick(runId)
    return repos.runs.require(runId)
  }

  async cancelRun(runId: string): Promise<Run> {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (TERMINAL_RUN_STATES.includes(run.state)) return run
    bus.transaction(() => {
      this.core.setRunState(runId, 'cancelled', { resumeState: null })
      bus.emit({ runId, type: 'run.cancelled', payload: {} })
      for (const task of repos.tasks.listByRun(runId)) {
        if (this.core.tryTaskState(task.id, 'cancelled')) {
          bus.emit({ runId, taskId: task.id, type: 'task.cancelled', payload: {} })
        }
      }
    })
    this.core.approvals.expire({ runId })
    await this.stopRunSessions(runId, 'cancelled')
    return repos.runs.require(runId)
  }

  async stopAgent(agentId: string): Promise<Agent> {
    const { repos, bus } = this.deps
    const agent = repos.agents.require(agentId)
    bus.emit({ runId: agent.runId, taskId: agent.taskId, agentId, type: 'user.intervention', payload: { action: 'stop_agent' } })
    const pipeline = agent.taskId ? (this.active.get(agent.taskId) ?? this.activeForChild(agent.taskId)) : undefined
    if (pipeline) await pipeline.control.stop('user_stop')
    else await this.runControls.get(agent.runId)?.stop('user_stop')
    return repos.agents.require(agentId)
  }

  async retryTask(taskId: string): Promise<Task> {
    const { repos, bus } = this.deps
    const task = repos.tasks.require(taskId)
    if (task.state !== 'failed' && task.state !== 'blocked') {
      throw new NexusError('invalid_state', `Only failed or blocked tasks can be retried (task is ${task.state})`)
    }
    bus.transaction(() => {
      this.core.setTaskState(taskId, 'ready', { attempt: 0, repairCycles: 0, error: null, blockedReason: null, finishedAt: null }, 'user retry')
      bus.emit({ runId: task.runId, taskId, type: 'user.intervention', payload: { action: 'retry_task' } })
      // Dependants that were blocked only because this task failed can run again.
      for (const other of repos.tasks.listByState(task.runId, 'blocked')) {
        if (other.blockedReason?.startsWith(DEPENDENCY_BLOCK_PREFIX)) {
          this.core.setTaskState(other.id, 'ready', { blockedReason: null })
        }
      }
    })
    this.requestTick(task.runId)
    return repos.tasks.require(taskId)
  }

  async cancelTask(taskId: string): Promise<Task> {
    const { repos, bus } = this.deps
    const task = repos.tasks.require(taskId)
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new NexusError('invalid_state', `Task is already ${task.state}`)
    bus.transaction(() => {
      this.core.setTaskState(taskId, 'cancelled')
      bus.emit({ runId: task.runId, taskId, type: 'task.cancelled', payload: {} })
      bus.emit({ runId: task.runId, taskId, type: 'user.intervention', payload: { action: 'cancel_task' } })
      for (const child of repos.tasks.listByParent(taskId)) this.core.tryTaskState(child.id, 'cancelled')
    })
    await this.active.get(taskId)?.control.stop('cancelled')
    this.requestTick(task.runId)
    return repos.tasks.require(taskId)
  }

  setPriority(taskId: string, priority: number): Task {
    const { repos, bus } = this.deps
    const task = bus.transaction(() => {
      const updated = repos.tasks.update(taskId, { priority })
      bus.emit({ runId: updated.runId, taskId, type: 'task.updated', payload: { fields: ['priority'] } })
      bus.emit({ runId: updated.runId, taskId, type: 'user.intervention', payload: { action: 'set_priority', detail: String(priority) } })
      return updated
    })
    this.requestTick(task.runId)
    return task
  }

  addTask(input: AddTaskInput): Task {
    const { repos, bus } = this.deps
    const run = repos.runs.require(input.runId)
    if (TERMINAL_RUN_STATES.includes(run.state)) throw new NexusError('invalid_state', `Run is ${run.state}`)
    if (run.mode === 'audit' && WRITING_ROLES.includes(input.role)) {
      throw new NexusError('invalid_input', 'AUDIT runs are read-only; a writing role cannot be added')
    }
    const tasks = repos.tasks.listByRun(run.id)
    for (const dep of input.dependsOn) {
      if (!tasks.some((t) => t.id === dep)) throw new NexusError('invalid_input', `Unknown dependency ${dep}`)
    }
    const task = bus.transaction(() => {
      const n = tasks.filter((t) => t.key.startsWith('user-task-')).length + 1
      const row = this.insertTask(run, {
        key: `user-task-${n}`,
        title: input.title,
        description: input.description,
        role: input.role,
        kind: WRITING_ROLES.includes(input.role) ? 'implement' : 'research',
        suggestedFiles: input.suggestedFiles,
        acceptanceCriteria: input.acceptanceCriteria,
        complexity: input.complexity,
        modelTierOverride: null,
      })
      const existing = repos.dependencies.listByRun(run.id)
      for (const dep of input.dependsOn) {
        if (wouldCreateCycle(existing, row.id, dep)) throw new NexusError('invalid_input', 'Dependency would create a cycle')
        repos.dependencies.add(row.id, dep)
      }
      bus.emit({ runId: run.id, taskId: row.id, type: 'user.intervention', payload: { action: 'add_task' } })
      // Tasks added before plan approval stay drafts and are released with the rest of the plan.
      if (run.state !== 'planning' && run.state !== 'awaiting_approval') this.core.setTaskState(row.id, 'ready')
      return repos.tasks.require(row.id)
    })
    this.requestTick(run.id)
    return task
  }

  private insertTask(
    run: Run,
    spec: Pick<Task, 'key' | 'title' | 'description' | 'role' | 'kind' | 'suggestedFiles' | 'acceptanceCriteria' | 'complexity' | 'modelTierOverride'>,
  ): Task {
    const { repos, bus } = this.deps
    const task = repos.tasks.insert({
      ...spec,
      id: newId(),
      runId: run.id,
      state: 'draft',
      priority: 0,
      risk: 'medium',
      parallelizable: true,
      requiresApproval: false,
      approvalGranted: false,
      attempt: 0,
      repairCycles: 0,
      parentTaskId: null,
      branch: null,
      worktreeId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      resultSummary: null,
      blockedReason: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    })
    this.insertCriteria(run.id, task.id, spec.acceptanceCriteria)
    bus.emit({ runId: run.id, taskId: task.id, type: 'task.created', payload: { key: task.key, title: task.title, role: task.role, kind: task.kind } })
    return task
  }

  /** Send a user instruction to a task: live if an agent is working on it, else on its next turn. */
  instruct(taskId: string, instruction: string): Message {
    const { repos, bus } = this.deps
    const task = repos.tasks.require(taskId)
    bus.emit({ runId: task.runId, taskId, type: 'user.intervention', payload: { action: 'instruct' } })
    return this.core.messages.send({
      runId: task.runId,
      type: 'user_instruction',
      severity: null,
      subject: 'Instruction from the user',
      body: instruction,
      fromAgentId: null,
      fromTaskId: null,
      fromLabel: 'User',
      toTask: task.id,
      toRole: null,
    }).message
  }

  resolveBlocker(taskId: string, note: string): Task {
    const { repos, bus } = this.deps
    const task = repos.tasks.require(taskId)
    if (task.state !== 'blocked') throw new NexusError('invalid_state', `Task is ${task.state}, not blocked`)
    if (note.trim()) this.instruct(taskId, `Blocker resolved by the user: ${note}`)
    const updated = bus.transaction(() => {
      bus.emit({ runId: task.runId, taskId, type: 'user.intervention', payload: { action: 'resolve_blocker', detail: note } })
      return this.core.setTaskState(taskId, 'ready', { blockedReason: null }, 'blocker resolved')
    })
    this.requestTick(task.runId)
    return updated
  }

  updateCriterion(criterionId: string, text: string): AcceptanceCriterion {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const before = repos.criteria.require(criterionId)
      const updated = repos.criteria.update(criterionId, { text, status: 'pending', evidence: null, updatedAt: nowIso() })
      if (before.taskId) {
        const task = repos.tasks.require(before.taskId)
        repos.tasks.update(task.id, { acceptanceCriteria: task.acceptanceCriteria.map((c) => (c === before.text ? text : c)) })
      } else {
        const run = repos.runs.require(before.runId)
        if (run.plan) {
          repos.runs.update(run.id, {
            plan: { ...run.plan, acceptanceCriteria: run.plan.acceptanceCriteria.map((c) => (c === before.text ? text : c)) },
          })
        }
      }
      bus.emit({ runId: before.runId, taskId: before.taskId, type: 'criterion.updated', payload: { criterionId, status: 'pending' } })
      bus.emit({ runId: before.runId, taskId: before.taskId, type: 'user.intervention', payload: { action: 'edit_criterion' } })
      return updated
    })
  }

  resolveApproval(approvalId: string, approve: boolean, note?: string): ApprovalRequest {
    return this.core.approvals.resolve(approvalId, approve, note ?? null)
  }

  private onApprovalResolved(approval: ApprovalRequest): void {
    const { repos, bus } = this.deps
    const approved = approval.status === 'approved'
    if (approval.kind === 'plan') {
      const run = repos.runs.require(approval.runId)
      if (run.state !== 'awaiting_approval') return
      if (approved) {
        bus.emit({ runId: run.id, type: 'plan.approved', payload: {} })
        this.background(run.id, () => this.startExecution(run.id))
      } else {
        void this.cancelRun(run.id)
      }
    } else if (approval.kind === 'task' && approval.taskId) {
      if (approved) repos.tasks.update(approval.taskId, { approvalGranted: true })
      else if (this.core.tryTaskState(approval.taskId, 'cancelled')) {
        bus.emit({ runId: approval.runId, taskId: approval.taskId, type: 'task.cancelled', payload: {} })
      }
      this.requestTick(approval.runId)
    }
  }

  private deliverLive(taskId: string, message: Message): boolean {
    const pipeline = this.active.get(taskId)
    return pipeline ? pipeline.control.send(renderMessage(message)) : false
  }

  private activeForChild(taskId: string): ActivePipeline | undefined {
    const parentId = this.deps.repos.tasks.get(taskId)?.parentTaskId
    return parentId ? this.active.get(parentId) : undefined
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /**
   * Called once at startup. Runs that were active when the app stopped are paused (never silently
   * resumed); their agents and sessions are marked stale; waiting approvals are expired.
   */
  recoverOnStartup(): RecoverableRun[] {
    const { repos, bus } = this.deps
    for (const run of repos.runs.listActive()) {
      if (run.state === 'paused' || run.state === 'awaiting_approval') {
        this.markStaleAgents(run.id)
        continue
      }
      const stale = this.markStaleAgents(run.id)
      bus.transaction(() => {
        this.core.setRunState(run.id, 'paused', { resumeState: run.state, pauseReason: 'recovery' }, 'application restarted')
        bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'recovery', detail: 'NEXUS was closed while this run was active' } })
        bus.emit({ runId: run.id, type: 'run.recovered', payload: { action: 'detected', staleAgents: stale } })
      })
    }
    // No agent survived the restart, so nothing is waiting on these any more.
    for (const approval of repos.approvals.listPending()) {
      if (approval.kind === 'tool') this.core.approvals.expire({ runId: approval.runId, agentId: approval.agentId ?? undefined })
    }
    return this.listRecoverable()
  }

  private markStaleAgents(runId: string): number {
    const { repos, bus } = this.deps
    const stale = repos.agents.listActive(runId)
    for (const agent of stale) {
      bus.transaction(() => {
        for (const session of repos.sessions.listByAgent(agent.id)) {
          if (session.state === 'active') repos.sessions.update(session.id, { state: 'ended', endReason: 'app_restart', endedAt: nowIso() })
        }
        repos.agents.update(agent.id, { state: 'stopped', activity: null, error: 'Stale: NEXUS stopped while this agent was running', stoppedAt: nowIso() })
        bus.emit({ runId, taskId: agent.taskId, agentId: agent.id, type: 'agent.stopped', payload: { reason: 'app_restart' } })
      })
    }
    return stale.length
  }

  listRecoverable(): RecoverableRun[] {
    const { repos } = this.deps
    return repos.runs
      .listByState('paused')
      .filter((run) => run.pauseReason === 'recovery')
      .map((run) => ({
        run,
        projectName: repos.projects.get(run.projectId)?.name ?? '(removed project)',
        staleAgents: repos.agents.listByRun(run.id).filter((a) => a.error?.startsWith('Stale')).length,
        activeTasks: repos.tasks.listByRun(run.id).filter((t) => ['assigned', 'running', 'review', 'verification', 'waiting'].includes(t.state)).length,
        worktrees: repos.worktrees.listActive(run.id).length,
      }))
  }

  async recover(runId: string, action: 'resume' | 'inspect' | 'cancel'): Promise<Run> {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    bus.emit({ runId, type: 'run.recovered', payload: { action, staleAgents: 0 } })
    if (action === 'inspect') {
      // Keep it paused but no longer flagged for recovery; the user resumes or cancels it later.
      return repos.runs.update(runId, { pauseReason: 'user' })
    }
    if (action === 'cancel') return this.cancelRun(runId)

    await this.reconcileWorktrees(run)
    return this.resumeRun(runId)
  }

  /** Worktrees that vanished from disk are dropped; their tasks get a fresh worktree on restart. */
  private async reconcileWorktrees(run: Run): Promise<void> {
    const { repos, bus, git } = this.deps
    for (const worktree of repos.worktrees.listActive(run.id)) {
      if (existsSync(worktree.path)) {
        // A merge interrupted by the shutdown would block every later merge.
        if (await git.isMergeInProgress(worktree.path).catch(() => false)) await git.abortMerge(worktree.path)
        continue
      }
      bus.transaction(() => {
        repos.worktrees.update(worktree.id, { state: 'orphaned' })
        bus.emit({ runId: run.id, taskId: worktree.taskId, type: 'git.worktree.removed', payload: { path: worktree.path } })
      })
    }
    await git.pruneWorktrees(this.core.project(run).rootPath).catch(() => undefined)
  }

  /** Remove the worktrees of a finished run. Branches are kept; dirty worktrees are not deleted. */
  async cleanupRun(runId: string): Promise<void> {
    const { repos, bus, worktrees } = this.deps
    const run = repos.runs.require(runId)
    if (!TERMINAL_RUN_STATES.includes(run.state)) throw new NexusError('invalid_state', 'Only finished runs can be cleaned up')
    const repoRoot = this.core.project(run).rootPath
    for (const worktree of repos.worktrees.listByRun(runId)) {
      if (worktree.state === 'removed') continue
      try {
        if (existsSync(worktree.path)) await worktrees.remove(repoRoot, worktree.path)
        repos.worktrees.update(worktree.id, { state: 'removed' })
        bus.emit({ runId, taskId: worktree.taskId, type: 'git.worktree.removed', payload: { path: worktree.path } })
      } catch (e) {
        this.core.log(`cleanup skipped ${worktree.path}: ${errorMessage(e)}`)
      }
    }
    this.integrations.delete(runId)
  }

  // ───────────────────────────── lifecycle plumbing ─────────────────────────────

  private runControl(runId: string): SessionControl {
    let control = this.runControls.get(runId)
    if (!control || control.stopReason) {
      control = new SessionControl()
      this.runControls.set(runId, control)
    }
    return control
  }

  /** Run-level background work (planning, finalization). Failures fail the run, not the app. */
  private background(runId: string, work: () => Promise<void>): void {
    const promise = work()
      .catch((e: unknown) => {
        this.core.log(`run ${runId} background work failed: ${errorMessage(e)}`)
        const run = this.deps.repos.runs.get(runId)
        if (run && !TERMINAL_RUN_STATES.includes(run.state) && run.state !== 'paused') {
          try {
            this.failRun(runId, errorMessage(e))
          } catch (inner) {
            this.core.log(`could not fail run ${runId}: ${errorMessage(inner)}`)
          }
        }
      })
      .finally(() => {
        if (this.runWork.get(runId) === promise) this.runWork.delete(runId)
        this.requestTick(runId)
      })
    this.runWork.set(runId, promise)
  }

  private async stopRunSessions(runId: string, reason: 'paused' | 'cancelled' | 'shutdown'): Promise<void> {
    const pipelines = [...this.active.values()].filter((p) => p.runId === runId)
    await Promise.allSettled([
      ...pipelines.map((p) => p.control.stop(reason)),
      this.runControls.get(runId)?.stop(reason),
    ])
    await this.settle(runId)
  }

  /** Wait until no pipeline or background work of the run is still unwinding. */
  private async settle(runId: string): Promise<void> {
    const pending = [...this.active.values()].filter((p) => p.runId === runId).map((p) => p.done)
    const work = this.runWork.get(runId)
    await Promise.allSettled(work ? [...pending, work] : pending)
  }

  /** Wait for a run to have no in-flight work (tests and shutdown). */
  async idle(runId: string): Promise<void> {
    for (;;) {
      await this.settle(runId)
      await new Promise((resolve) => setImmediate(resolve))
      const busy =
        [...this.active.values()].some((p) => p.runId === runId) ||
        this.runWork.has(runId) ||
        this.ticks.get(runId)?.running === true
      if (!busy) return
    }
  }

  async shutdown(): Promise<void> {
    const runIds = new Set([...this.active.values()].map((p) => p.runId))
    for (const runId of this.runControls.keys()) runIds.add(runId)
    await Promise.allSettled([...runIds].map((runId) => this.stopRunSessions(runId, 'shutdown')))
    await this.deps.runtime.shutdown()
  }

  activeAgentCount(): number {
    return this.deps.repos.agents.listActive().filter((a) => ACTIVE_AGENT_STATES.includes(a.state)).length
  }
}
