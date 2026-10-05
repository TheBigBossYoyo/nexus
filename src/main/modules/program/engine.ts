import type { Preset, Run, RunConfig, RunMode } from '@shared/domain'
import type { PushMessage } from '@shared/events'
import { newId, shortId } from '@shared/ids'
import {
  canTransitionMilestone,
  canTransitionProgram,
  diffPlans,
  isEmptyDiff,
  LIVE_PROGRAM_STATES,
  programHealth,
  ProgramPolicySchema,
  ProgramScheduleSchema,
  TERMINAL_MILESTONE_STATES,
  TERMINAL_PROGRAM_STATES,
  windowStatus,
  type BacklogItem,
  type BacklogProposal,
  type BacklogProvenance,
  type BacklogStatus,
  type ExpertiseArea,
  type Milestone,
  type MilestoneEvidence,
  type MilestoneGate,
  type MilestoneState,
  type PlannedMilestone,
  type Program,
  type ProgramDecisionKind,
  type ProgramDetail,
  type ProgramGoal,
  type ProgramPauseReason,
  type ProgramPlanRevision,
  type ProgramPolicy,
  type ProgramSchedule,
  type ProgramState,
  type ProgramSummary,
} from '@shared/program'
import { errorMessage, NexusError } from '@shared/result'
import type { Strategy } from '@shared/v3'
import type { EventBus } from '@main/modules/events'
import type { GitService } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'
import { selectMemory, validateMemory } from './memory'
import { buildMissionPrompt, buildPlanPrompt, buildReplanPrompt, buildVerifyPrompt, parseJudgment, parsePlan, parseReplan, REASONING_MARKERS } from './reasoning'

/** What the engine needs from the orchestrator. Missions and reasoning sessions are ordinary runs. */
export interface ProgramRunHost {
  createRun(input: {
    projectId: string
    mode: RunMode
    preset: Preset
    prompt: string
    overrides?: Partial<RunConfig>
    strategy?: Strategy
    acceptanceCriteria?: string[]
    /** Start the run from this commit instead of the checkout's HEAD. */
    baseRef?: string
  }): Promise<Run>
  pauseRun(runId: string, reason?: 'user' | 'quota' | 'recovery', detail?: string): Promise<unknown>
  resumeRun(runId: string): Promise<unknown>
  cancelRun(runId: string): Promise<unknown>
  recover(runId: string, action: 'resume' | 'inspect' | 'cancel'): Promise<unknown>
}

export interface ProgramEngineDeps {
  repos: Repositories
  bus: EventBus
  git: GitService
  host: ProgramRunHost
  /** The usage dispatch gate: false while Claude is limited. */
  usage?: { canDispatch(): boolean; onChange(listener: () => void): () => void }
  /** One or two lines of Arena and policy evidence for the planner, or null. */
  evidence?: () => string | null
  push?: (message: PushMessage) => void
  now?: () => number
  logger?: (line: string) => void
  /** Milliseconds between passes over the open programs; 0 disables the timer (tests call tick()). */
  tickIntervalMs?: number
}

export interface CreateProgramInput {
  projectId: string
  name: string
  goal: string
  successCriteria?: string[]
  constraints?: string[]
  policy: ProgramPolicy
  schedule?: ProgramSchedule | null
  start?: boolean
}

const RUN_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.paused', 'run.resumed'])
const TERMINAL_RUN: readonly Run['state'][] = ['completed', 'failed', 'cancelled']
const MAX_CHECKPOINTS = 100
/** A reasoning session whose answer does not parse is asked again this many times before the program is blocked. */
const REASONING_RETRIES = 1
const WORKING: readonly ProgramState[] = ['PLANNING', 'ACTIVE', 'REPLANNING']
const OPEN_BACKLOG: readonly BacklogStatus[] = ['proposed', 'accepted', 'scheduled']

/**
 * The deterministic owner of a program. It decides what happens next from persisted state only: plan,
 * generate a mission for the next milestone, run it, verify the milestone, update backlog and memory,
 * reassess, and go on. Claude sessions propose plans and judgments; nothing they return is stored or acted
 * on before it passed its schema and the engine's own gates.
 */
export class ProgramEngine {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly retries = new Map<string, number>()
  private readonly unsubscribes: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: ProgramEngineDeps) {
    this.unsubscribes.push(
      deps.bus.subscribe((event) => {
        if (this.disposed || !RUN_EVENTS.has(event.type)) return
        const program = deps.repos.programs.getByRun(event.runId)
        if (program) void this.advance(program.id)
      }),
    )
    if (deps.usage) this.unsubscribes.push(deps.usage.onChange(() => void this.tick()))
    const interval = deps.tickIntervalMs ?? 15_000
    if (interval > 0) {
      this.timer = setInterval(() => void this.tick(), interval)
      this.timer.unref?.()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const u of this.unsubscribes.splice(0)) u()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private iso(ms: number = this.now()): string {
    return new Date(ms).toISOString()
  }

  private log(line: string): void {
    this.deps.logger?.(`program: ${line}`)
  }

  private get repos(): Repositories {
    return this.deps.repos
  }

  // ───────────────────────────── queries ─────────────────────────────

  summary(program: Program): ProgramSummary {
    const milestones = this.repos.milestones.listByProgram(program.id)
    const active = milestones.find((m) => m.id === program.currentMilestoneId) ?? milestones.find((m) => m.state === 'ACTIVE' || m.state === 'VERIFYING')
    return {
      program,
      milestones: { total: milestones.filter((m) => m.state !== 'CANCELLED').length, completed: milestones.filter((m) => m.state === 'COMPLETED').length, active: active?.title ?? null },
      backlogOpen: this.repos.backlog.countOpen(program.id),
      window: windowStatus(program.policy.respectWorkWindows ? program.schedule : null, this.now()),
    }
  }

  list(options: { projectId?: string; limit?: number; offset?: number } = {}): { programs: ProgramSummary[]; total: number } {
    return { programs: this.repos.programs.list(options).map((p) => this.summary(p)), total: this.repos.programs.count(options.projectId) }
  }

  detail(programId: string): ProgramDetail {
    const program = this.repos.programs.require(programId)
    const summary = this.summary(program)
    return {
      ...summary,
      roadmap: this.repos.milestones.listByProgram(programId),
      workstreams: this.repos.workstreams.listByProgram(programId),
      missions: this.repos.programMissions.listByProgram(programId),
      revisions: this.repos.planRevisions.listByProgram(programId),
      decisions: this.repos.programDecisions.recent(programId, 100),
      memory: this.repos.programMemory.listActive(programId),
      backlog: this.repos.backlog.list({ programId, limit: 200 }),
      health: programHealth(program, summary.window),
    }
  }

  // ───────────────────────────── user actions ─────────────────────────────

  async create(input: CreateProgramInput): Promise<Program> {
    const policy = ProgramPolicySchema.parse(input.policy)
    const schedule = input.schedule ? ProgramScheduleSchema.parse(input.schedule) : null
    const project = this.repos.projects.require(input.projectId)
    if (!(await this.deps.git.isRepository(project.rootPath))) throw new NexusError('not_a_repository', 'A program needs a Git repository: its milestones accumulate on a branch.')
    const goal: ProgramGoal = { statement: input.goal.trim(), successCriteria: input.successCriteria ?? [], constraints: input.constraints ?? [], risks: [] }
    if (goal.statement === '') throw new NexusError('invalid_input', 'A program needs a goal.')
    const at = this.iso()
    const program = this.repos.programs.insert({
      id: newId(),
      projectId: project.id,
      name: input.name.trim() || goal.statement.slice(0, 60),
      goal,
      state: 'DRAFT',
      resumeState: null,
      pauseReason: null,
      blockedReason: null,
      policy,
      schedule,
      planVersion: 0,
      branch: null,
      baseCommit: null,
      currentMilestoneId: null,
      currentRunId: null,
      currentRunKind: null,
      activeMs: 0,
      activeSince: null,
      quotaWaitSince: null,
      missions: 0,
      replans: 0,
      outcome: null,
      error: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
    })
    this.decide(program.id, 'created', `Program created with the ${policy.preset} policy.`)
    this.announce(program.id)
    return input.start ? this.start(program.id) : program
  }

  start(programId: string): Promise<Program> {
    return this.serial(programId, async () => {
      const program = this.repos.programs.require(programId)
      if (program.state !== 'DRAFT') throw new NexusError('invalid_state', `The program is ${program.state}; only a draft can be started`)
      const project = this.repos.projects.require(program.projectId)
      const baseCommit = await this.deps.git.headCommit(project.rootPath).catch(() => null)
      if (!baseCommit) throw new NexusError('invalid_state', 'The repository has no commits yet. Create an initial commit first.')
      // Accepted milestones accumulate here. The branch is never checked out in the user's working tree.
      const branch = `nexus/program-${shortId(program.id)}`
      await this.deps.git.createBranch(project.rootPath, branch, baseCommit)
      this.patch(programId, { branch, baseCommit, startedAt: this.iso() })
      this.setState(programId, 'PLANNING')
      await this.step(programId)
      return this.repos.programs.require(programId)
    })
  }

  pause(programId: string, reason: ProgramPauseReason = 'user'): Promise<Program> {
    return this.serial(programId, async () => {
      const program = this.repos.programs.require(programId)
      if (program.state === 'PAUSED') {
        // Paused by the schedule, then by the user: the user's pause wins, so an opening window does not resume it.
        if (reason === 'user' && program.pauseReason === 'work_window') {
          this.patch(programId, { pauseReason: 'user' })
          this.decide(programId, 'paused', 'Paused by the user.')
          this.announce(programId)
        }
        return this.repos.programs.require(programId)
      }
      if (TERMINAL_PROGRAM_STATES.includes(program.state) || program.state === 'DRAFT' || program.state === 'BLOCKED') throw new NexusError('invalid_state', `The program is ${program.state}; it cannot be paused`)
      await this.enterPause(program, reason, reason === 'user' ? 'Paused by the user.' : `Paused (${reason}).`)
      return this.repos.programs.require(programId)
    })
  }

  resume(programId: string): Promise<Program> {
    return this.serial(programId, async () => {
      const program = this.repos.programs.require(programId)
      if (program.state !== 'PAUSED' && program.state !== 'BLOCKED') throw new NexusError('invalid_state', `The program is ${program.state}; only a paused or blocked program can be resumed`)
      if (program.pauseReason === 'approval' && this.repos.planRevisions.pending(programId)) {
        throw new NexusError('invalid_state', 'A plan is waiting for approval. Accept or reject it first.')
      }
      const back = program.resumeState && WORKING.includes(program.resumeState) ? program.resumeState : program.planVersion === 0 ? 'PLANNING' : 'ACTIVE'
      // A blocked milestone gets another chance when the user resumes: the block was the engine's, the decision is theirs.
      for (const m of this.repos.milestones.listByProgram(programId)) {
        if (m.state === 'BLOCKED') this.setMilestone(m.id, 'READY', { blockedReason: null, attempts: 0 })
      }
      this.retries.delete(programId)
      this.decide(programId, program.state === 'BLOCKED' ? 'unblocked' : 'resumed', `Resumed by the user (${back}).`)
      const run = program.currentRunId ? this.repos.runs.get(program.currentRunId) : null
      if (this.limited(run)) {
        // Resumed while Claude is still limited: the user chose to go on, so the program waits for the reset
        // (also under the `stop` policy, which only decides what happens when a limit is first met).
        this.patch(programId, { pauseReason: null, blockedReason: null, resumeState: back, quotaWaitSince: this.iso() })
        this.setState(programId, 'WAITING_FOR_QUOTA')
        return this.repos.programs.require(programId)
      }
      this.patch(programId, { pauseReason: null, blockedReason: null, quotaWaitSince: null })
      this.setState(programId, back)
      await this.resumeCurrentRun(programId)
      await this.step(programId)
      return this.repos.programs.require(programId)
    })
  }

  cancel(programId: string): Promise<Program> {
    return this.serial(programId, async () => {
      const program = this.repos.programs.require(programId)
      if (TERMINAL_PROGRAM_STATES.includes(program.state)) return program
      if (program.currentRunId) await Promise.resolve(this.deps.host.cancelRun(program.currentRunId)).catch((e: unknown) => this.log(`cancel run ${program.currentRunId}: ${errorMessage(e)}`))
      for (const m of this.repos.milestones.listByProgram(programId)) {
        if (!TERMINAL_MILESTONE_STATES.includes(m.state)) this.setMilestone(m.id, 'CANCELLED')
      }
      const pending = this.repos.planRevisions.pending(programId)
      if (pending) this.repos.planRevisions.update(pending.id, { status: 'rejected', decidedAt: this.iso() })
      this.finish(programId, 'CANCELLED', 'cancelled', 'Cancelled by the user.')
      return this.repos.programs.require(programId)
    })
  }

  /** The user's answer to a proposed plan or plan revision. */
  decidePlan(programId: string, revisionId: string, accept: boolean): Promise<Program> {
    return this.serial(programId, async () => {
      const program = this.repos.programs.require(programId)
      const revision = this.repos.planRevisions.require(revisionId)
      if (revision.programId !== programId || revision.status !== 'proposed') throw new NexusError('invalid_state', 'This plan revision is not waiting for a decision')
      if (accept) {
        this.acceptRevision(program, revision, 'user')
      } else {
        this.repos.planRevisions.update(revision.id, { status: 'rejected', decidedAt: this.iso() })
        this.decide(programId, 'plan_rejected', `Plan version ${revision.version} rejected by the user.`)
        if (revision.trigger === 'initial') {
          // Without a first plan there is nothing to work on: plan again when the user resumes.
          this.patch(programId, { pauseReason: 'user', resumeState: 'PLANNING' })
          this.announce(programId)
          return this.repos.programs.require(programId)
        }
      }
      // Only the pause that waited for this decision ends with it; a pause the user asked for stays.
      const current = this.repos.programs.require(programId)
      if (current.state === 'PAUSED' && current.pauseReason === 'approval') {
        this.patch(programId, { pauseReason: null })
        this.setState(programId, 'ACTIVE')
      }
      await this.step(programId)
      return this.repos.programs.require(programId)
    })
  }

  /**
   * The user asks for a reassessment of the plan, with a note. It happens at the next point where no run is
   * in flight (before the next mission), and counts against the reassessment budget like any other.
   */
  requestUserReplan(programId: string, note: string): Program {
    const program = this.repos.programs.require(programId)
    if (TERMINAL_PROGRAM_STATES.includes(program.state)) throw new NexusError('invalid_state', `The program is ${program.state}; its plan cannot be reassessed`)
    const text = note.trim().slice(0, 2000)
    if (text === '') throw new NexusError('invalid_input', 'Say what should change in the plan.')
    this.repos.settings.setValue(userReplanKey(programId), text)
    this.decide(programId, 'replan_requested', `The user asked for a reassessment: ${text.replace(/\s+/g, ' ').slice(0, 200)}`, { detail: { trigger: 'user' } })
    this.announce(programId)
    void this.advance(programId)
    return this.repos.programs.require(programId)
  }

  /** A person changes a backlog item's status. Nothing in the backlog becomes work by itself. */
  setBacklogStatus(itemId: string, status: BacklogStatus): BacklogItem {
    const item = this.repos.backlog.update(itemId, { status, updatedAt: this.iso() })
    if (item.programId) this.announce(item.programId)
    return item
  }

  /** Stores proposals as backlog items. An open item with the same title is not stored twice. */
  addBacklog(projectId: string, programId: string | null, proposals: readonly BacklogProposal[], provenance: BacklogProvenance): BacklogItem[] {
    const added: BacklogItem[] = []
    for (const proposal of proposals) {
      if (this.repos.backlog.findOpenByTitle(projectId, proposal.title)) continue
      const at = this.iso()
      added.push(this.repos.backlog.insert({ ...proposal, id: newId(), projectId, programId, provenance, status: 'proposed', createdAt: at, updatedAt: at }))
    }
    return added
  }

  // ───────────────────────────── the loop ─────────────────────────────

  /** One pass over every open program. Safe to call at any time. */
  async tick(): Promise<void> {
    if (this.disposed) return
    await Promise.allSettled(this.repos.programs.listOpen().map((p) => this.advance(p.id)))
  }

  advance(programId: string): Promise<void> {
    return this.serial(programId, async () => {
      try {
        await this.step(programId)
      } catch (e) {
        // An error inside the engine must never leave a program looking busy while nothing drives it.
        this.log(`${programId}: ${errorMessage(e)}`)
        const program = this.repos.programs.get(programId)
        if (program && !TERMINAL_PROGRAM_STATES.includes(program.state) && program.state !== 'BLOCKED' && program.state !== 'DRAFT') {
          await this.block(program, `The program engine stopped on an internal error: ${errorMessage(e).slice(0, 300)}`, 'blocked').catch((inner: unknown) => this.log(`${programId}: ${errorMessage(inner)}`))
        }
      }
    })
  }

  /**
   * Startup: runs that were active were paused by the orchestrator. A program on an autonomous policy
   * continues by itself; a conservative one (or one that asks for plan approval) waits for the user.
   */
  async recover(): Promise<void> {
    for (const program of this.repos.programs.listOpen()) {
      await this.serial(program.id, async () => {
        const current = this.repos.programs.require(program.id)
        await this.cancelUnrecordedRuns(current)
        if (!LIVE_PROGRAM_STATES.includes(current.state)) return
        // The clock did not run while NEXUS was closed.
        if (current.activeSince) this.patch(current.id, { activeSince: this.iso() })
        const cautious = current.policy.preset === 'conservative' || current.policy.approvalPolicy === 'plan'
        if (cautious) {
          await this.enterPause(current, 'restart', 'NEXUS restarted; this program waits for you to resume it.')
          return
        }
        this.decide(current.id, 'recovered', 'NEXUS restarted; the program continues from its last checkpoint.', { runId: current.currentRunId })
        const run = current.currentRunId ? this.repos.runs.get(current.currentRunId) : null
        if (run?.state === 'paused' && run.pauseReason === 'recovery') {
          await Promise.resolve(this.deps.host.recover(run.id, 'resume')).catch((e: unknown) => this.log(`recover run ${run.id}: ${errorMessage(e)}`))
        }
        this.checkpoint(current.id, 'recovery')
        await this.step(current.id)
      }).catch((e: unknown) => this.log(`recover ${program.id}: ${errorMessage(e)}`))
    }
  }

  /** True while Claude is limited: the current run is paused for a usage limit, or the dispatch gate is closed. */
  private limited(run: Run | null): boolean {
    return (run?.state === 'paused' && run.pauseReason === 'quota') || (this.deps.usage ? !this.deps.usage.canDispatch() : false)
  }

  private async step(programId: string): Promise<void> {
    // Each pass handles one transition; the loop ends when a pass changes nothing.
    for (let guard = 0; guard < 40; guard++) {
      if (this.disposed) return
      const before = this.fingerprint(programId)
      await this.stepOnce(programId)
      if (this.fingerprint(programId) === before) return
    }
    this.log(`${programId}: the engine did not settle after 40 passes`)
  }

  private fingerprint(programId: string): string {
    const p = this.repos.programs.require(programId)
    const milestones = this.repos.milestones.listByProgram(programId).map((m) => `${m.key}:${m.state}:${m.attempts}`)
    return [p.state, p.pauseReason, p.currentRunId, p.currentRunKind, p.planVersion, p.missions, p.replans, ...milestones].join('|')
  }

  private async stepOnce(programId: string): Promise<void> {
    const program = this.repos.programs.require(programId)
    if (TERMINAL_PROGRAM_STATES.includes(program.state) || program.state === 'DRAFT' || program.state === 'BLOCKED') return
    const now = this.now()
    const window = windowStatus(program.policy.respectWorkWindows ? program.schedule : null, now)

    if (program.state === 'PAUSED') {
      // A run that something else resumed (the quota controller after a reset) does not work for a paused program.
      await this.pauseCurrentRun(program, 'The program is paused.')
      if (program.pauseReason === 'work_window' && window.open) {
        this.decide(programId, 'window_opened', 'The work window opened; the program continues.')
        this.patch(programId, { pauseReason: null })
        this.setState(programId, program.resumeState && WORKING.includes(program.resumeState) ? program.resumeState : 'ACTIVE')
        await this.resumeCurrentRun(programId)
      }
      return
    }

    if (!window.open) {
      // End of the work window: no new dispatch, the mission in flight is paused, the state is checkpointed.
      await this.enterPause(program, 'work_window', `The work window closed${window.nextOpensAt ? `; the next one opens at ${this.iso(window.nextOpensAt)}` : ''}.`, 'window_closed')
      return
    }

    const elapsed = program.activeMs + (program.activeSince ? Math.max(0, now - Date.parse(program.activeSince)) : 0)
    if (WORKING.includes(program.state) && elapsed > program.policy.maxDurationMinutes * 60_000) {
      await this.block(program, `Budget: the program used its ${program.policy.maxDurationMinutes} minutes of active time.`, 'budget')
      return
    }

    const run = program.currentRunId ? this.repos.runs.get(program.currentRunId) : null
    const limited = this.limited(run)

    if (program.state === 'WAITING_FOR_QUOTA') {
      if (limited) {
        const since = program.quotaWaitSince ? Date.parse(program.quotaWaitSince) : now
        if (now - since > program.policy.quotaWaitMaxMinutes * 60_000) {
          await this.block(program, `The Claude usage limit did not reset within ${program.policy.quotaWaitMaxMinutes} minutes.`, 'blocked')
        }
        return
      }
      this.decide(programId, 'quota_resumed', 'Claude is available again; the program continues.', { runId: program.currentRunId })
      this.patch(programId, { quotaWaitSince: null })
      this.setState(programId, program.resumeState && WORKING.includes(program.resumeState) ? program.resumeState : 'ACTIVE')
      return
    }

    if (limited) {
      // A usage limit is a wait, not a failure. The run keeps its state and is resumed by quota recovery.
      this.checkpoint(programId, 'quota')
      if (program.policy.usageBehavior === 'stop') {
        await this.enterPause(program, 'usage_policy', 'Claude usage limit reached; the policy stops the program until you resume it.')
        return
      }
      this.decide(programId, 'quota_wait', 'Claude usage limit reached; waiting for it to reset.', { runId: program.currentRunId })
      this.patch(programId, { resumeState: program.state, quotaWaitSince: this.iso() })
      this.setState(programId, 'WAITING_FOR_QUOTA')
      return
    }

    if (program.currentRunId) {
      if (!run) return this.onRunEnded(program, null)
      if (TERMINAL_RUN.includes(run.state)) return this.onRunEnded(program, run)
      if (run.state === 'paused') {
        if (run.pauseReason === 'recovery') {
          await Promise.resolve(this.deps.host.recover(run.id, 'resume')).catch((e: unknown) => this.log(`recover run ${run.id}: ${errorMessage(e)}`))
          return
        }
        // Somebody paused the mission itself, or it needs a person (authentication, intervention).
        if (run.pauseReason === 'user') await this.enterPause(program, 'user', 'The current run was paused.')
        else await this.block(program, `The current run is paused and needs attention${run.error ? `: ${run.error}` : ''}.`, 'blocked')
      }
      return
    }

    switch (program.state) {
      case 'PLANNING':
        return this.startPlanner(program)
      case 'REPLANNING':
        return this.startReplanner(program)
      case 'ACTIVE':
        return this.continueActive(program)
      default:
        return
    }
  }

  // ───────────────────────────── planning ─────────────────────────────

  /** The project profile in a few lines, for a planning or analysis prompt. */
  repositoryFacts(projectId: string): string {
    const project = this.repos.projects.require(projectId)
    const p = project.profile
    if (!p) return `Project ${project.name}. No profile is recorded.`
    const commands = Object.entries(p.commands)
      .filter(([, c]) => c)
      .map(([k, c]) => `${k}: ${String(c)}`)
    return [
      `Project ${project.name}; ${p.fileCount} files.`,
      `Languages: ${p.languages.join(', ') || 'unknown'}. Frameworks: ${p.frameworks.join(', ') || 'none detected'}. Package managers: ${p.packageManagers.join(', ') || 'none'}.`,
      `Check commands: ${commands.join('; ') || 'none configured'}.`,
      `Docs: ${p.docs.slice(0, 8).join(', ') || 'none'}.`,
    ].join('\n')
  }

  private history(program: Program): string[] {
    const earlier = this.repos.programs
      .list({ projectId: program.projectId, limit: 6 })
      .filter((p) => p.id !== program.id)
      .map((p) => `Program "${p.name}" ${p.state}${p.outcome ? `: ${p.outcome.milestonesCompleted}/${p.outcome.milestonesTotal} milestones` : ''}`)
    // Newest first; the six most recent missions.
    const runs = this.repos.runs
      .listByProject(program.projectId)
      .filter((r) => r.mode !== 'ask')
      .slice(0, 6)
      .map((r) => `Mission ${r.state}: ${r.prompt.replace(/\s+/g, ' ').slice(0, 120)}`)
    return [...earlier, ...runs]
  }

  private async startReasoning(program: Program, kind: 'planner' | 'replanner' | 'verifier', prompt: string, baseRef?: string): Promise<void> {
    this.markStarting(program.id, kind)
    const run = await this.deps.host.createRun({
      projectId: program.projectId,
      mode: 'ask',
      preset: program.policy.missionPreset,
      prompt,
      overrides: { requirePlanApproval: false },
      ...(baseRef ? { baseRef } : {}),
    })
    this.patch(program.id, { currentRunId: run.id, currentRunKind: kind })
    this.repos.settings.deleteValue(startingKey(program.id))
    this.announce(program.id)
  }

  private async startPlanner(program: Program): Promise<void> {
    if (this.repos.planRevisions.pending(program.id)) return this.awaitApproval(program)
    const prompt = buildPlanPrompt({
      program,
      repository: this.repositoryFacts(program.projectId),
      history: this.history(program),
      evidence: this.deps.evidence?.() ?? null,
      backlog: this.repos.backlog.list({ projectId: program.projectId, statuses: OPEN_BACKLOG, limit: 20 }),
      memory: this.repos.programMemory.listActive(program.id),
    })
    await this.startReasoning(program, 'planner', prompt)
  }

  private async startReplanner(program: Program): Promise<void> {
    if (this.repos.planRevisions.pending(program.id)) return this.awaitApproval(program)
    const milestones = this.repos.milestones.listByProgram(program.id)
    const remaining = milestones.filter((m) => !TERMINAL_MILESTONE_STATES.includes(m.state))
    const last = this.repos.programDecisions.recent(program.id, 6).reverse()
    const userRequest = this.repos.settings.getValue<string>(userReplanKey(program.id)) ?? null
    // Recorded now so that the revision this session produces carries the trigger `user`.
    if (userRequest) this.decide(program.id, 'replan_requested', 'Reassessing the plan with the request of the user.', { detail: { trigger: 'user' } })
    const prompt = buildReplanPrompt({
      program,
      userRequest,
      trigger: this.replanTrigger(program.id),
      completed: milestones.filter((m) => m.state === 'COMPLETED'),
      remaining,
      situation: last.map((d) => `${d.kind}: ${d.summary}`).join('\n'),
      backlog: this.repos.backlog.list({ programId: program.id, statuses: OPEN_BACKLOG, limit: 20 }),
      memory: this.repos.programMemory.listActive(program.id),
    })
    await this.startReasoning(program, 'replanner', prompt, program.branch ?? undefined)
    // Counted, and the user's note consumed, only once the session exists.
    this.patch(program.id, { replans: program.replans + 1 })
    if (userRequest) this.repos.settings.deleteValue(userReplanKey(program.id))
  }

  private replanTrigger(programId: string): ProgramPlanRevision['trigger'] {
    const request = this.repos.programDecisions.recent(programId, 20).find((d) => d.kind === 'replan_requested')
    const trigger = request?.detail?.['trigger']
    return trigger === 'milestone_rejected' || trigger === 'mission_failed' || trigger === 'user' ? trigger : 'milestone_completed'
  }

  private async awaitApproval(program: Program): Promise<void> {
    if (program.state === 'PAUSED') return
    await this.enterPause(program, 'approval', 'A plan is waiting for your approval.')
  }

  /** Written just before a run is created and removed once the program row knows the run. */
  private markStarting(programId: string, kind: string): void {
    this.repos.settings.setValue(startingKey(programId), { kind, at: new Date().toISOString() })
  }

  /**
   * NEXUS stopped between creating a run and recording it: the run exists and the program does not know it.
   * Such a run is cancelled (it cannot be told apart from work the program never asked for), so a restart never
   * leaves two runs working for one program.
   */
  private async cancelUnrecordedRuns(program: Program): Promise<void> {
    const marker = this.repos.settings.getValue<{ kind: string; at: string }>(startingKey(program.id))
    if (!marker) return
    this.repos.settings.deleteValue(startingKey(program.id))
    const recorded = new Set(this.repos.programMissions.listByProgram(program.id).map((m) => m.runId))
    // Only a run this program would have started: a mission of this program, or one of its reasoning sessions.
    const mine = (run: Run): boolean =>
      marker.kind === 'mission' ? run.mode !== 'ask' && run.prompt.includes(`of the program "${program.name}".`) : run.mode === 'ask' && Object.values(REASONING_MARKERS).some((m) => run.prompt.startsWith(m))
    for (const run of this.repos.runs.listByProject(program.projectId)) {
      if (recorded.has(run.id) || run.id === program.currentRunId || TERMINAL_RUN.includes(run.state)) continue
      // Run rows are stamped with the wall clock, like the marker.
      if (run.createdAt < marker.at || !mine(run)) continue
      await Promise.resolve(this.deps.host.cancelRun(run.id)).catch((e: unknown) => this.log(`cancel unrecorded run ${run.id}: ${errorMessage(e)}`))
      this.decide(program.id, 'recovered', `A ${marker.kind} run that was started just before NEXUS stopped was cancelled; the program starts it again.`, { runId: run.id })
    }
  }

  /** The text a reasoning run produced: the result of its single task. */
  private answerOf(run: Run | null): string | null {
    if (!run) return null
    const task = this.repos.tasks.listByRun(run.id).find((t) => t.resultSummary)
    return task?.resultSummary ?? null
  }

  private async onRunEnded(program: Program, run: Run | null): Promise<void> {
    const kind = program.currentRunKind
    // A mission's result is recorded in the same transaction that forgets the run (onMissionEnded). The answer
    // of a reasoning run stays readable in the run itself, and its step is simply taken again after a crash.
    if (kind === 'mission') return this.onMissionEnded(program, run)
    this.patch(program.id, { currentRunId: null, currentRunKind: null })
    const fresh = this.repos.programs.require(program.id)
    switch (kind) {
      case 'planner':
        return this.onPlannerEnded(fresh, run)
      case 'replanner':
        return this.onReplannerEnded(fresh, run)
      case 'verifier':
        return this.onVerifierEnded(fresh, run)
      default:
        return
    }
  }

  /** True when the failed reasoning session may be tried again; false when the program must stop for it. */
  private retryReasoning(program: Program, what: string, error: string): boolean {
    const used = this.retries.get(program.id) ?? 0
    if (used < REASONING_RETRIES) {
      this.retries.set(program.id, used + 1)
      this.log(`${program.id}: ${what} failed (${error}); trying once more`)
      return true
    }
    this.retries.delete(program.id)
    return false
  }

  private async onPlannerEnded(program: Program, run: Run | null): Promise<void> {
    const parsed = run?.state === 'completed' ? parsePlan(this.answerOf(run)) : ({ ok: false, error: `The planner run ${run?.state ?? 'is missing'}${run?.error ? `: ${run.error}` : ''}` } as const)
    if (!parsed.ok) {
      if (this.retryReasoning(program, 'planning', parsed.error)) return
      return this.block(program, `No valid program plan: ${parsed.error}`, 'blocked')
    }
    this.retries.delete(program.id)
    const plan = parsed.value
    const revision = this.repos.planRevisions.insert({
      id: newId(),
      programId: program.id,
      version: program.planVersion + 1,
      trigger: 'initial',
      reason: 'Initial plan.',
      milestones: plan.milestones,
      deferred: [],
      diff: diffPlans([], plan.milestones),
      strategyNote: null,
      status: 'proposed',
      runId: run?.id ?? null,
      createdAt: this.iso(),
      decidedAt: null,
    })
    // The user's own criteria and constraints stay; the plan may add to them.
    const merge = (mine: string[], theirs: string[]): string[] => [...new Set([...mine, ...theirs])].slice(0, 12)
    this.patch(program.id, {
      goal: { ...program.goal, successCriteria: merge(program.goal.successCriteria, plan.successCriteria), constraints: merge(program.goal.constraints, plan.constraints), risks: plan.risks },
    })
    this.decide(program.id, 'plan_proposed', `Plan version ${revision.version} proposed: ${plan.milestones.length} milestone(s).`, { runId: run?.id ?? null, detail: { milestones: plan.milestones.map((m) => m.key) } })
    if (program.policy.approvalPolicy === 'none') this.acceptRevision(this.repos.programs.require(program.id), revision, 'policy')
    else await this.awaitApproval(this.repos.programs.require(program.id))
  }

  private async onReplannerEnded(program: Program, run: Run | null): Promise<void> {
    const milestones = this.repos.milestones.listByProgram(program.id)
    const completed = milestones.filter((m) => m.state === 'COMPLETED')
    const remaining = milestones.filter((m) => !TERMINAL_MILESTONE_STATES.includes(m.state))
    const parsed =
      run?.state === 'completed'
        ? parseReplan(
            this.answerOf(run),
            completed.map((m) => m.key),
            remaining.map((m) => m.key),
            milestones.filter((m) => m.state === 'CANCELLED').map((m) => m.key),
          )
        : ({ ok: false, error: `The reassessment run ${run?.state ?? 'is missing'}` } as const)
    const keep = (why: string): void => {
      this.decide(program.id, 'replan_kept', why, { runId: run?.id ?? null })
      this.setState(program.id, 'ACTIVE')
    }
    // A reassessment that cannot be read never blocks the program: the accepted plan stands.
    if (!parsed.ok) return keep(`The plan stands (the reassessment could not be used: ${parsed.error})`)
    const replan = parsed.value
    if (replan.action === 'keep') return keep(`The plan stands: ${replan.reason.slice(0, 300)}`)
    const diff = diffPlans(remaining.map(toPlanned), replan.milestones, replan.defer)
    if (isEmptyDiff(diff)) return keep('The plan stands: the proposed revision changes nothing.')
    const revision = this.repos.planRevisions.insert({
      id: newId(),
      programId: program.id,
      version: program.planVersion + 1,
      trigger: this.replanTrigger(program.id),
      reason: replan.reason,
      milestones: replan.milestones,
      deferred: replan.defer,
      diff,
      strategyNote: replan.strategyNote,
      status: 'proposed',
      runId: run?.id ?? null,
      createdAt: this.iso(),
      decidedAt: null,
    })
    this.decide(program.id, 'plan_proposed', `Plan version ${revision.version} proposed: ${describeDiff(diff)}.`, { runId: run?.id ?? null, detail: { diff } })
    if (program.policy.approvalPolicy === 'plan') await this.awaitApproval(program)
    else {
      this.acceptRevision(program, revision, 'policy')
      this.setState(program.id, 'ACTIVE')
    }
  }

  /** Applies a revision: completed milestones are untouched; the remaining roadmap becomes the revision's. */
  private acceptRevision(program: Program, revision: ProgramPlanRevision, by: 'user' | 'policy'): void {
    const { repos } = this
    repos.transaction(() => {
      const existing = repos.milestones.listByProgram(program.id)
      const fixed = existing.filter((m) => m.state === 'COMPLETED' || m.state === 'CANCELLED')
      const byKey = new Map(existing.map((m) => [m.key, m]))
      let ordinal = fixed.length
      const at = this.iso()
      const planned = new Set(revision.milestones.map((m) => m.key))
      for (const m of revision.milestones) {
        let workstream = repos.workstreams.getByKey(program.id, slug(m.workstream))
        if (!workstream) workstream = repos.workstreams.insert({ id: newId(), programId: program.id, key: slug(m.workstream), name: m.workstream, expertise: m.expertise, createdAt: at })
        const current = byKey.get(m.key)
        const fields = { title: m.title, objective: m.objective, acceptanceCriteria: m.acceptanceCriteria, workstreamId: workstream.id, expertise: m.expertise, dependsOn: m.dependsOn, complexity: m.complexity, risk: m.risk, ordinal: ordinal++ }
        if (current && current.state !== 'COMPLETED' && current.state !== 'CANCELLED') {
          const changed = revision.diff.changed.some((c) => c.key === m.key)
          const state: MilestoneState = current.state === 'DEFERRED' || current.state === 'BLOCKED' ? 'PLANNED' : current.state
          repos.milestones.update(current.id, { ...fields, state, blockedReason: null, ...(changed ? { planVersion: revision.version, attempts: 0 } : {}) })
        } else if (!current) {
          repos.milestones.insert({ id: newId(), programId: program.id, key: m.key, ...fields, state: 'PLANNED', attempts: 0, gaps: [], evidence: null, blockedReason: null, planVersion: revision.version, createdAt: at, startedAt: null, completedAt: null })
        }
      }
      for (const m of existing) {
        if (m.state === 'COMPLETED' || m.state === 'CANCELLED' || planned.has(m.key)) continue
        if (revision.deferred.includes(m.key)) repos.milestones.update(m.id, { state: 'DEFERRED', ordinal: ordinal++ })
        else repos.milestones.update(m.id, { state: 'CANCELLED', ordinal: ordinal++ })
      }
      repos.planRevisions.update(revision.id, { status: 'accepted', decidedAt: at })
      repos.programs.update(program.id, { planVersion: revision.version, updatedAt: at })
    })
    this.decide(program.id, 'plan_accepted', `Plan version ${revision.version} accepted (${by}).`, { detail: { diff: revision.diff } })
    this.checkpoint(program.id, 'plan')
    const current = this.repos.programs.require(program.id)
    if (current.state === 'PLANNING') this.setState(program.id, 'ACTIVE')
    else this.announce(program.id)
  }

  // ───────────────────────────── milestones and missions ─────────────────────────────

  private async continueActive(program: Program): Promise<void> {
    const milestones = this.repos.milestones.listByProgram(program.id)
    // A milestone left in VERIFYING without a run (a restart between two steps): verify it again.
    const verifying = milestones.find((m) => m.state === 'VERIFYING')
    if (verifying) return this.verifyMilestone(program, verifying)
    // A reassessment the user asked for happens before the next mission.
    if (this.repos.settings.getValue<string>(userReplanKey(program.id))) {
      if (program.replans < program.policy.maxReplans) return this.setState(program.id, 'REPLANNING')
      this.repos.settings.deleteValue(userReplanKey(program.id))
      this.decide(program.id, 'budget', `The plan is not reassessed: the program used its ${program.policy.maxReplans} reassessment(s).`)
    }
    const done = new Set(milestones.filter((m) => m.state === 'COMPLETED').map((m) => m.key))
    for (const m of milestones) {
      if (m.state === 'ACTIVE') {
        // ACTIVE without a current run. If its mission did run to an end that was never recorded (NEXUS stopped
        // in between), that end is processed now, so a finished mission is verified and not thrown away.
        const unrecorded = this.repos.programMissions.listByMilestone(m.id).find((x) => x.outcome === 'running')
        const run = unrecorded ? this.repos.runs.get(unrecorded.runId) : null
        if (unrecorded && (!run || TERMINAL_RUN.includes(run.state))) {
          this.patch(program.id, { currentMilestoneId: m.id })
          return this.onMissionEnded(this.repos.programs.require(program.id), run)
        }
        if (unrecorded && run) {
          // The mission is still running: the program simply lost track of it. Take it back.
          this.patch(program.id, { currentRunId: run.id, currentRunKind: 'mission', currentMilestoneId: m.id })
          return
        }
        this.setMilestone(m.id, 'READY')
      } else if (m.state === 'PLANNED' && m.dependsOn.every((d) => done.has(d) || !milestones.some((x) => x.key === d && x.state !== 'CANCELLED'))) this.setMilestone(m.id, 'READY')
    }
    const next = this.repos.milestones.listByProgram(program.id).find((m) => m.state === 'READY')
    if (!next) {
      const open = this.repos.milestones.listByProgram(program.id).filter((m) => !TERMINAL_MILESTONE_STATES.includes(m.state))
      if (open.length > 0) {
        return this.block(program, `No milestone can be worked on: ${open.map((m) => `${m.key} is ${m.state}${m.blockedReason ? ` (${m.blockedReason})` : ''}`).join('; ')}.`, 'blocked')
      }
      const completed = milestones.filter((m) => m.state === 'COMPLETED').length
      const dropped = milestones.length - completed
      if (completed === 0) return this.finish(program.id, 'FAILED', 'failed', 'No milestone was completed.')
      return this.finish(program.id, 'COMPLETED', 'completed', `${completed} of ${milestones.length} milestone(s) completed and verified${dropped > 0 ? `; ${dropped} cancelled or deferred by plan revisions` : ''}.`)
    }
    if (program.missions >= program.policy.maxTotalMissions) {
      return this.block(program, `Budget: the program used its ${program.policy.maxTotalMissions} missions.`, 'budget')
    }
    if (next.attempts >= program.policy.maxMissionsPerMilestone) {
      this.setMilestone(next.id, 'BLOCKED', { blockedReason: `Not accepted after ${next.attempts} mission(s).` })
      this.decide(program.id, 'milestone_blocked', `Milestone "${next.title}" was not accepted after ${next.attempts} mission(s).`, { milestoneId: next.id })
      return this.requestReplan(program, 'milestone_rejected', `Milestone "${next.title}" is blocked after ${next.attempts} mission(s).`)
    }
    await this.startMission(program, next)
  }

  private async startMission(program: Program, milestone: Milestone): Promise<void> {
    const { repos } = this
    const all = repos.milestones.listByProgram(program.id)
    const memory = selectMemory(repos.programMemory.listActive(program.id), milestone)
    const note = repos.planRevisions.listByProgram(program.id).filter((r) => r.status === 'accepted' && r.strategyNote).at(-1)?.strategyNote ?? null
    // A first attempt starts from the accepted work (the program branch). A retry continues from the previous
    // attempt's result, but only when that result contains everything accepted so far; if other milestones were
    // accepted in between, it starts from the accepted work instead, so its result can be fast-forwarded onto it.
    const project = repos.projects.require(program.projectId)
    const previous = repos.programMissions.listByMilestone(milestone.id).filter((m) => m.resultCommit).at(-1)
    let continues = false
    if (previous?.resultCommit && program.branch) {
      const tip = await this.deps.git.resolveCommit(project.rootPath, `refs/heads/${program.branch}`).catch(() => null)
      continues = tip !== null && (await this.deps.git.isAncestor(project.rootPath, tip, previous.resultCommit).catch(() => false))
    }
    const baseRef = continues ? (previous?.resultCommit ?? undefined) : (program.branch ?? undefined)
    const { prompt, acceptanceCriteria } = buildMissionPrompt({ program, milestone, completed: all.filter((m) => m.state === 'COMPLETED'), memory: memory.map((m) => m.entry), strategyNote: note, continuesPreviousAttempt: continues })
    this.markStarting(program.id, 'mission')
    const strategy: Strategy = program.policy.missionStrategy === 'SPECULATIVE' && !program.policy.speculation ? 'BUILD' : program.policy.missionStrategy
    const run = await this.deps.host.createRun({
      projectId: program.projectId,
      mode: 'mission',
      preset: program.policy.missionPreset,
      prompt,
      acceptanceCriteria,
      strategy,
      overrides: { requirePlanApproval: false, maxParallelAgents: program.policy.maxAgents },
      ...(baseRef ? { baseRef } : {}),
    })
    this.repos.settings.deleteValue(startingKey(program.id))
    repos.transaction(() => {
      const attempt = milestone.attempts + 1
      repos.programMissions.insert({ id: newId(), programId: program.id, milestoneId: milestone.id, runId: run.id, attempt, strategy: null, outcome: 'running', baseCommit: run.baseCommit, resultCommit: null, createdAt: this.iso(), finishedAt: null })
      repos.milestones.update(milestone.id, { state: 'ACTIVE', attempts: attempt, startedAt: milestone.startedAt ?? this.iso() })
      repos.programs.update(program.id, { currentRunId: run.id, currentRunKind: 'mission', currentMilestoneId: milestone.id, missions: program.missions + 1, updatedAt: this.iso() })
    })
    if (milestone.attempts === 0) this.decide(program.id, 'milestone_started', `Milestone "${milestone.title}" started.`, { milestoneId: milestone.id })
    this.decide(program.id, 'mission_generated', `Mission ${milestone.attempts + 1} for "${milestone.title}" (${strategy}${memory.length > 0 ? `, ${memory.length} memory entr${memory.length === 1 ? 'y' : 'ies'}` : ''}).`, {
      milestoneId: milestone.id,
      runId: run.id,
      detail: { strategy, baseRef: baseRef ?? null, memory: memory.map((m) => ({ id: m.entry.id, title: m.entry.title, matched: m.matched })) },
    })
    this.announce(program.id)
  }

  private async onMissionEnded(program: Program, run: Run | null): Promise<void> {
    const { repos } = this
    const milestone = program.currentMilestoneId ? repos.milestones.get(program.currentMilestoneId) : null
    const mission = run ? repos.programMissions.getByRun(run.id) : null
    const project = repos.projects.require(program.projectId)
    const resultCommit = run?.integrationBranch ? await this.deps.git.resolveCommit(project.rootPath, run.integrationBranch).catch(() => null) : null
    const outcome = run?.state === 'completed' ? 'completed' : run?.state === 'cancelled' ? 'cancelled' : 'failed'
    repos.transaction(() => {
      if (mission) repos.programMissions.update(mission.id, { outcome, strategy: run?.config.strategy?.resolved ?? null, resultCommit, finishedAt: this.iso() })
      if (repos.programs.require(program.id).currentRunId === (run?.id ?? program.currentRunId)) repos.programs.update(program.id, { currentRunId: null, currentRunKind: null, updatedAt: this.iso() })
    })
    this.decide(program.id, 'mission_ended', `Mission ${outcome}${run?.error ? `: ${run.error.replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`, { milestoneId: milestone?.id ?? null, runId: run?.id ?? null })
    if (!milestone) return
    if (outcome === 'completed') {
      this.setMilestone(milestone.id, 'VERIFYING')
      return this.verifyMilestone(program, repos.milestones.require(milestone.id))
    }
    // A failed mission is evidence, not the end: it goes to the backlog and the plan is reassessed.
    const why = run?.error?.replace(/\s+/g, ' ').slice(0, 400) ?? (run ? `The run was ${run.state}.` : 'The run no longer exists.')
    this.addBacklog(
      program.projectId,
      program.id,
      [{ title: `Mission failed on milestone "${milestone.title}"`.slice(0, 160), description: `Attempt ${milestone.attempts} of the milestone ended without a result. ${why}`, category: 'bug', severity: 'medium', evidence: why, complexity: 'medium', dependencies: [], recommendedMilestone: milestone.key }],
      { source: 'mission_failure', runId: run?.id ?? null, milestoneKey: milestone.key, jobId: null },
    )
    this.setMilestone(milestone.id, 'READY', { gaps: [`The previous mission ${outcome}: ${why}`.slice(0, 400)] })
    this.checkpoint(program.id, 'mission failed')
    await this.requestReplan(program, 'mission_failed', `The mission on "${milestone.title}" ${outcome}.`)
  }

  /** The deterministic part of milestone verification. Hard gates must pass before Claude is asked at all. */
  private async gates(program: Program, milestone: Milestone, run: Run): Promise<{ gates: MilestoneGate[]; resultCommit: string | null; hardFailure: MilestoneGate | null }> {
    const { repos } = this
    const project = repos.projects.require(program.projectId)
    const verifications = repos.verifications.listByRun(run.id)
    const integrationChecks = verifications.filter((v) => v.kind === 'checks' && v.taskId === null).at(-1) ?? verifications.filter((v) => v.kind === 'checks').at(-1)
    const missionVerifier = verifications.filter((v) => v.kind === 'verifier' && v.taskId === null).at(-1)
    const latestReview = new Map<string, 'approved' | 'changes_requested'>()
    for (const r of repos.reviews.listByRun(run.id)) latestReview.set(r.taskId, r.verdict)
    // A review that requested changes is open only while its task is not done: once the task completed, its
    // repair was reviewed or verified by the mission's own pipeline.
    const settled = new Set(repos.tasks.listByRun(run.id).filter((t) => t.state === 'completed' || t.state === 'cancelled').map((t) => t.id))
    const openReviews = [...latestReview.entries()].filter(([taskId, verdict]) => verdict === 'changes_requested' && !settled.has(taskId)).length
    const resultCommit = run.integrationBranch ? await this.deps.git.resolveCommit(project.rootPath, run.integrationBranch).catch(() => null) : null
    const changed = resultCommit && run.baseCommit ? await this.deps.git.changedFiles(project.rootPath, run.baseCommit, resultCommit).catch(() => []) : []
    const gates: MilestoneGate[] = [
      { name: 'mission_completed', passed: run.state === 'completed', detail: `The mission run is ${run.state}.` },
      {
        name: 'checks_passed',
        passed: integrationChecks ? integrationChecks.passed : true,
        detail: integrationChecks ? `${integrationChecks.passed ? 'Passed' : 'Failed'}: ${integrationChecks.summary.replace(/\s+/g, ' ').slice(0, 200)}` : 'No check command is configured for this project; nothing was run.',
      },
      { name: 'mission_verified', passed: missionVerifier ? missionVerifier.passed : true, detail: missionVerifier ? `The mission verifier ${missionVerifier.passed ? 'passed' : 'failed'}.` : 'The mission had no mission-level verifier.' },
      { name: 'no_blocking_findings', passed: openReviews === 0, detail: openReviews === 0 ? 'No review is left requesting changes.' : `${openReviews} task review(s) still request changes.` },
      { name: 'changes_present', passed: changed.length > 0, detail: changed.length > 0 ? `${changed.length} file(s) changed.` : 'The mission changed no file.' },
    ]
    // A mission with an integration branch whose commit cannot be read has a result nobody can verify or keep.
    if (run.integrationBranch && !resultCommit) gates.push({ name: 'result_readable', passed: false, detail: `The result branch ${run.integrationBranch} could not be read.` })
    // `changes_present` is recorded for the verifier and the user; a milestone may legitimately need no change.
    const hardFailure = gates.find((g) => !g.passed && g.name !== 'changes_present') ?? null
    return { gates, resultCommit, hardFailure }
  }

  private async verifyMilestone(program: Program, milestone: Milestone): Promise<void> {
    const { repos } = this
    const mission = repos.programMissions.listByMilestone(milestone.id).at(-1)
    const run = mission ? repos.runs.get(mission.runId) : null
    if (!mission || !run) return this.rejectMilestone(program, milestone, { runId: mission?.runId ?? '', verifierRunId: null, gates: [], judgment: null, verdict: 'rejected', reason: 'The mission of this milestone no longer exists.', resultCommit: null, createdAt: this.iso() })
    const { gates, resultCommit, hardFailure } = await this.gates(program, milestone, run)
    if (hardFailure) {
      // Mission success is not milestone success: a failed gate rejects without asking Claude.
      return this.rejectMilestone(program, milestone, { runId: run.id, verifierRunId: null, gates, judgment: null, verdict: 'rejected', reason: `Gate ${hardFailure.name} failed: ${hardFailure.detail}`, resultCommit, createdAt: this.iso() }, [hardFailure.detail])
    }
    const project = repos.projects.require(program.projectId)
    const diff = resultCommit && run.baseCommit ? await this.deps.git.diff(project.rootPath, run.baseCommit, resultCommit, { maxPatchBytes: 12_000 }).catch(() => null) : null
    const changes = diff ? `${diff.files.length} file(s) changed${diff.truncated ? ' (patch clipped)' : ''}:\n${diff.files.map((f) => `${f.path}`).join('\n')}\n\n${diff.patch}` : 'The diff could not be read.'
    const tasks = repos.tasks.listByRun(run.id)
    const verifications = repos.verifications.listByRun(run.id)
    const missionEvidence = [
      `Tasks: ${tasks.map((t) => `${t.key} [${t.state}]`).join(', ') || 'none'}.`,
      ...tasks.filter((t) => t.resultSummary).slice(0, 8).map((t) => `Result of ${t.key}: ${(t.resultSummary ?? '').replace(/\s+/g, ' ').slice(0, 500)}`),
      ...verifications.slice(-6).map((v) => `${v.kind} (${v.taskId === null ? 'mission' : 'task'}): ${v.passed ? 'passed' : 'FAILED'}. ${v.summary.replace(/\s+/g, ' ').slice(0, 300)}`),
    ].join('\n')
    repos.milestones.update(milestone.id, { evidence: { runId: run.id, verifierRunId: null, gates, judgment: null, verdict: 'rejected', reason: 'Verification in progress.', resultCommit, createdAt: this.iso() } })
    const prompt = buildVerifyPrompt({ program, milestone, gates, missionEvidence, changes, workingTreeIsResult: false })
    await this.startReasoning(program, 'verifier', prompt)
  }

  private async onVerifierEnded(program: Program, run: Run | null): Promise<void> {
    const { repos } = this
    const milestone = program.currentMilestoneId ? repos.milestones.get(program.currentMilestoneId) : null
    if (!milestone || milestone.state !== 'VERIFYING' || !milestone.evidence) return
    const parsed = run?.state === 'completed' ? parseJudgment(this.answerOf(run)) : ({ ok: false, error: `The verifier run ${run?.state ?? 'is missing'}${run?.error ? `: ${run.error}` : ''}` } as const)
    if (!parsed.ok) {
      // Never accepted without a judgment. The milestone stays in VERIFYING and is verified again.
      if (this.retryReasoning(program, 'milestone verification', parsed.error)) return
      return this.block(program, `Milestone "${milestone.title}" could not be verified: ${parsed.error}`, 'blocked')
    }
    this.retries.delete(program.id)
    let judgment = parsed.value
    // The verdict is about THIS milestone's criteria. A judgment that lists fewer criteria than the milestone has
    // (or others) did not judge them, whatever its verdict says.
    const wanted = milestone.acceptanceCriteria
    const covered = judgment.criteria.length >= wanted.length
    const gate: MilestoneGate = { name: 'criteria_judged', passed: covered, detail: `The judgment covers ${Math.min(judgment.criteria.length, wanted.length)} of ${wanted.length} acceptance criteria.` }
    if (!covered && judgment.verdict === 'accepted') {
      judgment = { ...judgment, verdict: 'rejected', gaps: [`The verification judged ${judgment.criteria.length} of ${wanted.length} acceptance criteria; every criterion must be judged.`, ...judgment.gaps].slice(0, 10) }
    }
    milestone.evidence.gates = [...milestone.evidence.gates.filter((g) => g.name !== 'criteria_judged'), gate]
    const evidence: MilestoneEvidence = { ...milestone.evidence, verifierRunId: run?.id ?? null, judgment, verdict: judgment.verdict, reason: judgment.verdict === 'accepted' ? 'Every acceptance criterion was judged met.' : `The verifier rejected the milestone: ${judgment.gaps[0] ?? 'criteria not met'}`, createdAt: this.iso() }
    const provenance: BacklogProvenance = { source: 'milestone_verifier', runId: evidence.runId, milestoneKey: milestone.key, jobId: null }
    const added = this.addBacklog(program.projectId, program.id, judgment.backlog, provenance)
    let remembered = 0
    for (const proposal of judgment.memory) {
      const rejection = validateMemory(proposal, repos.programMemory.listActive(program.id))
      if (rejection) {
        this.log(`${program.id}: memory proposal "${proposal.title}" refused (${rejection})`)
        continue
      }
      repos.programMemory.insert({ ...proposal, id: newId(), programId: program.id, projectId: program.projectId, milestoneKey: milestone.key, source: { kind: 'milestone_verifier', runId: evidence.runId }, status: 'active', createdAt: this.iso() })
      remembered++
    }
    if (judgment.verdict === 'rejected') return this.rejectMilestone(program, milestone, evidence, judgment.gaps, { backlog: added.length, memory: remembered })
    await this.acceptMilestone(program, milestone, evidence, { backlog: added.length, memory: remembered })
  }

  private async acceptMilestone(program: Program, milestone: Milestone, evidence: MilestoneEvidence, found: { backlog: number; memory: number }): Promise<void> {
    const { repos } = this
    const project = repos.projects.require(program.projectId)
    if (evidence.resultCommit && program.branch) {
      // The program branch moves forward to the accepted result, and only forward: the result must contain
      // everything accepted so far. A result that does not (it was built on an older tip) is not accepted work
      // of this program as a whole, and accepting it would silently drop the milestones accepted since.
      try {
        const tip = await this.deps.git.resolveCommit(project.rootPath, `refs/heads/${program.branch}`)
        await this.deps.git.fastForwardBranch(project.rootPath, program.branch, evidence.resultCommit, tip)
      } catch (e) {
        return this.block(program, `The accepted result of "${milestone.title}" could not be recorded on ${program.branch}: ${errorMessage(e).slice(0, 300)}`, 'blocked')
      }
    }
    this.setMilestone(milestone.id, 'COMPLETED', { evidence, gaps: [], completedAt: this.iso() })
    await this.updateExpertise(program, milestone, evidence, true)
    this.decide(program.id, 'milestone_accepted', `Milestone "${milestone.title}" verified and accepted (${found.backlog} backlog item(s), ${found.memory} memory entr${found.memory === 1 ? 'y' : 'ies'}).`, { milestoneId: milestone.id, runId: evidence.runId, detail: { resultCommit: evidence.resultCommit } })
    this.patch(program.id, { currentMilestoneId: null })
    this.checkpoint(program.id, 'milestone accepted')
    const remaining = repos.milestones.listByProgram(program.id).filter((m) => !TERMINAL_MILESTONE_STATES.includes(m.state))
    // Reassess before the next milestone; with nothing left there is nothing to reassess.
    if (remaining.length > 0) await this.requestReplan(program, 'milestone_completed', `Milestone "${milestone.title}" was accepted.`)
  }

  private async rejectMilestone(program: Program, milestone: Milestone, evidence: MilestoneEvidence, gaps: string[] = [], found: { backlog: number; memory: number } = { backlog: 0, memory: 0 }): Promise<void> {
    this.setMilestone(milestone.id, 'READY', { evidence, gaps: gaps.length > 0 ? gaps.slice(0, 10) : [evidence.reason.slice(0, 400)] })
    await this.updateExpertise(program, milestone, evidence, false)
    this.decide(program.id, 'milestone_rejected', `Milestone "${milestone.title}" rejected: ${evidence.reason.slice(0, 240)}`, { milestoneId: milestone.id, runId: evidence.runId || null, detail: { gaps, ...found } })
    this.checkpoint(program.id, 'milestone rejected')
    await this.requestReplan(program, 'milestone_rejected', `Milestone "${milestone.title}" was rejected.`)
  }

  /** Go to REPLANNING when the budget allows; otherwise continue with the plan as it is. */
  private async requestReplan(program: Program, trigger: ProgramPlanRevision['trigger'], why: string): Promise<void> {
    const current = this.repos.programs.require(program.id)
    if (current.state !== 'ACTIVE') return
    if (current.replans >= current.policy.maxReplans) {
      this.decide(program.id, 'budget', `${why} The plan is not reassessed: the program used its ${current.policy.maxReplans} reassessment(s).`)
      return
    }
    this.decide(program.id, 'replan_requested', `${why} Reassessing the plan.`, { detail: { trigger } })
    this.setState(program.id, 'REPLANNING')
  }

  /** Logical expertise: what an area did in this project, from accepted and rejected milestones. No chat is kept. */
  private async updateExpertise(program: Program, milestone: Milestone, evidence: MilestoneEvidence, accepted: boolean): Promise<void> {
    const { repos } = this
    try {
      const area: ExpertiseArea = milestone.expertise
      const run = evidence.runId ? repos.runs.get(evidence.runId) : null
      const project = repos.projects.require(program.projectId)
      const files = accepted && run?.baseCommit && evidence.resultCommit ? await this.deps.git.changedFiles(project.rootPath, run.baseCommit, evidence.resultCommit).catch(() => []) : []
      const areas = files.map((f) => f.split('/').slice(0, 2).join('/'))
      const memoryIds = repos.programMemory.listActive(program.id).filter((m) => m.milestoneKey === milestone.key).map((m) => m.id)
      const existing = repos.expertise.getByArea(program.projectId, area)
      const merged = (a: string[], b: string[], max: number): string[] => [...new Set([...a, ...b])].slice(-max)
      if (existing) {
        repos.expertise.update(existing.id, {
          projectAreas: merged(existing.projectAreas, areas, 40),
          milestonesAccepted: existing.milestonesAccepted + (accepted ? 1 : 0),
          milestonesRejected: existing.milestonesRejected + (accepted ? 0 : 1),
          missions: existing.missions + 1,
          memoryIds: merged(existing.memoryIds, memoryIds, 60),
          updatedAt: this.iso(),
        })
      } else {
        repos.expertise.insert({ id: newId(), projectId: program.projectId, area, projectAreas: merged([], areas, 40), milestonesAccepted: accepted ? 1 : 0, milestonesRejected: accepted ? 0 : 1, missions: 1, memoryIds, updatedAt: this.iso() })
      }
    } catch (e) {
      this.log(`expertise ${program.id}: ${errorMessage(e)}`)
    }
  }

  // ───────────────────────────── state plumbing ─────────────────────────────

  private async pauseCurrentRun(program: Program, detail: string): Promise<void> {
    const run = program.currentRunId ? this.repos.runs.get(program.currentRunId) : null
    if (!run || TERMINAL_RUN.includes(run.state) || run.state === 'paused') return
    await Promise.resolve(this.deps.host.pauseRun(run.id, 'user', detail)).catch((e: unknown) => this.log(`pause run ${run.id}: ${errorMessage(e)}`))
  }

  private async resumeCurrentRun(programId: string): Promise<void> {
    const program = this.repos.programs.require(programId)
    const run = program.currentRunId ? this.repos.runs.get(program.currentRunId) : null
    if (!run || run.state !== 'paused' || run.pauseReason === 'quota') return
    const resume = run.pauseReason === 'recovery' ? this.deps.host.recover(run.id, 'resume') : this.deps.host.resumeRun(run.id)
    await Promise.resolve(resume).catch((e: unknown) => this.log(`resume run ${run.id}: ${errorMessage(e)}`))
  }

  private async enterPause(program: Program, reason: ProgramPauseReason, summary: string, kind: ProgramDecisionKind = 'paused'): Promise<void> {
    const resumeState = WORKING.includes(program.state) ? program.state : program.resumeState
    this.patch(program.id, { pauseReason: reason, resumeState, quotaWaitSince: null })
    this.setState(program.id, 'PAUSED')
    this.decide(program.id, kind, summary, { runId: program.currentRunId })
    await this.pauseCurrentRun(program, summary)
    this.checkpoint(program.id, reason)
  }

  private async block(program: Program, reason: string, kind: ProgramDecisionKind): Promise<void> {
    const resumeState = WORKING.includes(program.state) ? program.state : program.resumeState
    this.patch(program.id, { blockedReason: reason, resumeState, quotaWaitSince: null })
    this.setState(program.id, 'BLOCKED')
    this.decide(program.id, kind === 'budget' ? 'budget' : 'blocked', reason, { runId: program.currentRunId })
    await this.pauseCurrentRun(program, reason)
    this.checkpoint(program.id, 'blocked')
  }

  private finish(programId: string, state: 'COMPLETED' | 'FAILED' | 'CANCELLED', result: 'completed' | 'failed' | 'cancelled', summary: string): void {
    const program = this.repos.programs.require(programId)
    const milestones = this.repos.milestones.listByProgram(programId)
    const at = this.iso()
    this.patch(programId, {
      outcome: { result, summary, milestonesCompleted: milestones.filter((m) => m.state === 'COMPLETED').length, milestonesTotal: milestones.length, missions: program.missions, replans: program.replans, finishedAt: at },
      finishedAt: at,
      currentRunId: null,
      currentRunKind: null,
      currentMilestoneId: null,
      pauseReason: null,
      error: state === 'FAILED' ? summary : null,
    })
    this.setState(programId, state)
    this.repos.settings.deleteValue(userReplanKey(programId))
    this.repos.settings.deleteValue(startingKey(programId))
    this.decide(programId, result, summary)
    this.checkpoint(programId, result)
  }

  private setState(programId: string, to: ProgramState): void {
    const program = this.repos.programs.require(programId)
    if (program.state === to) return
    if (!canTransitionProgram(program.state, to)) throw new NexusError('invalid_state', `A program cannot go from ${program.state} to ${to}`)
    const now = this.now()
    // The active clock runs only while the program is planning, working or reassessing.
    const wasWorking = WORKING.includes(program.state)
    const isWorking = WORKING.includes(to)
    const clock: Partial<Program> = {}
    if (wasWorking && !isWorking && program.activeSince) {
      clock.activeMs = program.activeMs + Math.max(0, now - Date.parse(program.activeSince))
      clock.activeSince = null
    } else if (!wasWorking && isWorking) clock.activeSince = this.iso(now)
    this.repos.programs.update(programId, { state: to, ...clock, updatedAt: this.iso(now) })
    this.announce(programId)
  }

  private setMilestone(milestoneId: string, to: MilestoneState, patch: Partial<Omit<Milestone, 'id' | 'state'>> = {}): void {
    const milestone = this.repos.milestones.require(milestoneId)
    if (milestone.state !== to && !canTransitionMilestone(milestone.state, to)) throw new NexusError('invalid_state', `A milestone cannot go from ${milestone.state} to ${to}`)
    this.repos.milestones.update(milestoneId, { ...patch, state: to })
    this.announce(milestone.programId)
  }

  private patch(programId: string, patch: Partial<Omit<Program, 'id' | 'state'>>): void {
    this.repos.programs.update(programId, { ...patch, updatedAt: this.iso() })
  }

  private decide(programId: string, kind: ProgramDecisionKind, summary: string, extra: { milestoneId?: string | null; runId?: string | null; detail?: Record<string, unknown> } = {}): void {
    this.repos.programDecisions.insert({ id: newId(), programId, kind, summary, milestoneId: extra.milestoneId ?? null, runId: extra.runId ?? null, detail: extra.detail ?? null, createdAt: this.iso() })
  }

  /** A checkpoint asked for from outside (the overnight supervisor). True when one was written. */
  checkpointNow(programId: string, reason: string): boolean {
    const before = this.repos.programCheckpoints.count(programId)
    this.checkpoint(programId, reason)
    return this.repos.programCheckpoints.count(programId) !== before || before >= MAX_CHECKPOINTS
  }

  /** A durable snapshot of where the program stands. Everything it lists is also in its own tables. */
  private checkpoint(programId: string, reason: string): void {
    try {
      const program = this.repos.programs.require(programId)
      const milestones = this.repos.milestones.listByProgram(programId)
      this.repos.programCheckpoints.insert({
        id: newId(),
        programId,
        reason,
        snapshot: {
          state: program.state,
          planVersion: program.planVersion,
          branch: program.branch,
          branchHead: milestones.filter((m) => m.state === 'COMPLETED' && m.evidence?.resultCommit).at(-1)?.evidence?.resultCommit ?? program.baseCommit,
          currentMilestone: milestones.find((m) => m.id === program.currentMilestoneId)?.key ?? null,
          currentRunId: program.currentRunId,
          milestones: milestones.map((m) => ({ key: m.key, state: m.state, attempts: m.attempts })),
          backlog: this.repos.backlog.countOpen(programId),
          memory: this.repos.programMemory.countActive(programId),
          missions: program.missions,
        },
        createdAt: this.iso(),
      })
      if (this.repos.programCheckpoints.count(programId) > MAX_CHECKPOINTS) this.repos.programCheckpoints.prune(programId, MAX_CHECKPOINTS)
    } catch (e) {
      this.log(`checkpoint ${programId}: ${errorMessage(e)}`)
    }
  }

  private announce(programId: string): void {
    try {
      this.deps.push?.({ kind: 'program', programId })
    } catch (e) {
      this.log(`push failed: ${errorMessage(e)}`)
    }
  }

  /** Operations on one program never interleave. */
  private serial<T>(programId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(programId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(programId, tail)
    void tail.then(() => {
      if (this.queues.get(programId) === tail) this.queues.delete(programId)
    })
    return next
  }

  /** Wait until no operation on any program is in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()])
  }
}

const userReplanKey = (programId: string): string => `program-user-replan:${programId}`
const startingKey = (programId: string): string => `program-starting:${programId}`

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'general'

function toPlanned(m: Milestone): PlannedMilestone {
  return { key: m.key, title: m.title, objective: m.objective, acceptanceCriteria: m.acceptanceCriteria, workstream: '', expertise: m.expertise, dependsOn: m.dependsOn, complexity: m.complexity, risk: m.risk }
}

export function describeDiff(diff: ReturnType<typeof diffPlans>): string {
  const parts: string[] = []
  if (diff.added.length > 0) parts.push(`added ${diff.added.join(', ')}`)
  if (diff.removed.length > 0) parts.push(`removed ${diff.removed.join(', ')}`)
  if (diff.deferred.length > 0) parts.push(`deferred ${diff.deferred.join(', ')}`)
  if (diff.changed.length > 0) parts.push(`changed ${diff.changed.map((c) => c.key).join(', ')}`)
  if (diff.reordered) parts.push('reordered')
  return parts.join('; ') || 'no change'
}
