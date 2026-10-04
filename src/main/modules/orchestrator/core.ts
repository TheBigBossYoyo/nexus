import {
  TERMINAL_RUN_STATES,
  type CommandResult,
  type PauseReason,
  type Project,
  type Run,
  type RunState,
  type Task,
  type TaskState,
  type Verification,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { runCommandLine } from '@main/modules/process'
import { assertTransition, canPauseRun, canTransition } from '@main/modules/state'
import { AgentRunner } from './agent-runner'
import { ApprovalService } from './approvals'
import { GraphService } from './graph-service'
import type { OrchestratorDeps } from './deps'
import { MemoryService } from './memory'
import { MessageService } from './messaging'
import { ModelRoutingService } from './routing'

/** Active (non-paused) time of a run, which the mission duration limit is measured against. */
interface ActiveTime {
  usedMs: number
  /** Start of the interval the run is currently active in; null while paused. */
  since: string | null
}

const activeKey = (runId: string): string => `run-active:${runId}`

const CHECK_ORDER = ['typecheck', 'lint', 'build', 'test'] as const
const CHECK_OUTPUT_BYTES = 48 * 1024

/** Dependency install command for a fresh worktree, by lockfile-derived package manager. */
function setupCommand(project: Project): string | null {
  const managers = project.profile?.packageManagers ?? []
  if (managers.includes('pnpm')) return 'pnpm install --frozen-lockfile --prefer-offline'
  if (managers.includes('yarn')) return 'yarn install --frozen-lockfile'
  if (managers.includes('bun')) return 'bun install --frozen-lockfile'
  if (managers.includes('npm')) return 'npm ci'
  return null
}

/** Shared services and state-transition helpers used by the orchestrator and the task pipeline. */
export class Core {
  readonly approvals: ApprovalService
  readonly messages: MessageService
  readonly memory: MemoryService
  readonly graph: GraphService
  readonly agents: AgentRunner
  readonly routing: ModelRoutingService

  constructor(readonly deps: OrchestratorDeps) {
    this.approvals = new ApprovalService(deps)
    this.messages = new MessageService(deps)
    this.memory = new MemoryService(deps)
    this.graph = new GraphService(deps, this.approvals)
    this.routing = new ModelRoutingService(deps)
    this.agents = new AgentRunner(deps, this.approvals, this.messages, this.memory, this.graph, this.routing)
  }

  log(line: string): void {
    this.deps.logger?.(line)
  }

  project(run: Run): Project {
    return this.deps.repos.projects.require(run.projectId)
  }

  author(): { name: string; email: string } {
    const git = this.deps.repos.settings.get().git
    return { name: git.commitAuthorName, email: git.commitAuthorEmail }
  }

  /** Validated task transition, persisted together with its event. No-op when already in `to`. */
  setTaskState(taskId: string, to: TaskState, patch: Partial<Omit<Task, 'id'>> = {}, reason?: string): Task {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const task = repos.tasks.require(taskId)
      if (task.state === to) return Object.keys(patch).length > 0 ? repos.tasks.update(taskId, patch) : task
      assertTransition('task', task.state, to)
      const finished = to === 'completed' || to === 'failed' || to === 'cancelled'
      const updated = repos.tasks.update(taskId, {
        ...patch,
        state: to,
        ...(finished ? { finishedAt: nowIso(), leaseOwner: null, leaseExpiresAt: null } : {}),
      })
      // A finished task never resumes: its yield marker must not outlive it.
      if (finished) this.graph.clearYield(taskId)
      bus.emit({
        runId: task.runId,
        taskId,
        type: 'task.state_changed',
        payload: { from: task.state, to, ...(reason ? { reason } : {}) },
      })
      return updated
    })
  }

  /** Like setTaskState but returns null instead of throwing when the transition is not legal. */
  tryTaskState(taskId: string, to: TaskState, patch: Partial<Omit<Task, 'id'>> = {}, reason?: string): Task | null {
    const task = this.deps.repos.tasks.get(taskId)
    if (!task) return null
    if (task.state !== to && !canTransition('task', task.state, to)) return null
    return this.setTaskState(taskId, to, patch, reason)
  }

  setRunState(runId: string, to: RunState, patch: Partial<Omit<Run, 'id'>> = {}, reason?: string): Run {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const run = repos.runs.require(runId)
      if (run.state === to) return Object.keys(patch).length > 0 ? repos.runs.update(runId, patch) : run
      assertTransition('run', run.state, to)
      const finished = TERMINAL_RUN_STATES.includes(to)
      const updated = repos.runs.update(runId, { ...patch, state: to, ...(finished ? { finishedAt: nowIso() } : {}) })
      bus.emit({
        runId,
        type: 'run.state_changed',
        payload: { from: run.state, to, ...(reason ? { reason } : {}) },
      })
      return updated
    })
  }

  // ───────────────────────────── active time (duration limit) ─────────────────────────────

  private activeTime(runId: string): ActiveTime | null {
    return this.deps.repos.settings.getValue<ActiveTime>(activeKey(runId))
  }

  /** Milliseconds the run has been active: paused intervals do not count. */
  runActiveMs(run: Run, now: number = Date.now()): number {
    const record = this.activeTime(run.id)
    if (!record) return run.startedAt ? Math.max(0, now - Date.parse(run.startedAt)) : 0
    return record.usedMs + (record.since ? Math.max(0, now - Date.parse(record.since)) : 0)
  }

  /** The run starts or resumes being active. `fresh` grants a new duration window. */
  markRunActive(runId: string, fresh = false): void {
    const record = this.activeTime(runId)
    this.deps.repos.settings.setValue(activeKey(runId), { usedMs: fresh || !record ? 0 : record.usedMs, since: nowIso() })
  }

  /** The run stops being active: fold the running interval (up to `at`) into the accumulated time. */
  markRunInactive(runId: string, at: number = Date.now()): void {
    const record = this.activeTime(runId)
    if (!record?.since) return
    const usedMs = record.usedMs + Math.max(0, at - Date.parse(record.since))
    this.deps.repos.settings.setValue(activeKey(runId), { usedMs, since: null })
  }

  /** The duration limit was hit: the next resume starts a fresh window. */
  resetRunActive(runId: string): void {
    this.deps.repos.settings.setValue(activeKey(runId), { usedMs: 0, since: null })
  }

  /**
   * Discard what check and setup commands left in a NEXUS-owned worktree: restore tracked files and
   * remove untracked files that are not ignored. Refuses paths outside the worktrees root, so the
   * user's own checkout can never be touched.
   */
  async cleanWorktree(path: string): Promise<void> {
    await this.deps.worktrees.resetClean(path)
  }

  /** Pause a run, remembering the state to return to. Returns null when it cannot be paused. */
  pauseRun(runId: string, reason: PauseReason, detail?: string): Run | null {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (!canPauseRun(run.state)) return null
    return bus.transaction(() => {
      const paused = this.setRunState(runId, 'paused', { resumeState: run.state, pauseReason: reason }, detail)
      this.markRunInactive(runId)
      bus.emit({ runId, type: 'run.paused', payload: { reason, ...(detail ? { detail } : {}) } })
      return paused
    })
  }

  /** Install dependencies in a freshly created worktree so check commands can run there. */
  async setupWorktree(run: Run, taskId: string | null, cwd: string): Promise<void> {
    const command = setupCommand(this.project(run))
    if (!command) return
    const result = await this.runOne('setup', command, cwd)
    this.deps.repos.artifacts.insert({
      id: newId(),
      runId: run.id,
      taskId,
      agentId: null,
      kind: 'setup-log',
      title: `${command} (exit ${result.exitCode ?? 'n/a'})`,
      content: result.output,
      createdAt: nowIso(),
    })
  }

  /** Run the configured check commands and store every command with its result. */
  async runChecks(run: Run, taskId: string | null, cwd: string, attempt: number): Promise<Verification> {
    const { repos, bus } = this.deps
    const commands = CHECK_ORDER.flatMap((name) => {
      const command = run.config.checks[name]
      return command ? [{ name, command }] : []
    })
    bus.emit({ runId: run.id, taskId, type: 'checks.started', payload: { commands: commands.map((c) => c.command) } })

    const results: CommandResult[] = []
    for (const { name, command } of commands) {
      results.push(await this.runOne(name, command, cwd))
    }
    const failed = results.filter((r) => r.exitCode !== 0 || r.timedOut)
    const passed = failed.length === 0
    const summary =
      commands.length === 0
        ? 'No check commands are configured for this project; nothing was run.'
        : passed
          ? `${results.length} check command(s) passed.`
          : `Failed: ${failed.map((r) => r.name).join(', ')}`

    return bus.transaction(() => {
      const verification = repos.verifications.insert({
        id: newId(),
        runId: run.id,
        taskId,
        agentId: null,
        attempt,
        kind: 'checks',
        passed,
        summary,
        criteria: [],
        commands: results,
        failures: failed.map((r) => ({
          criterion: `Check "${r.name}" passes`,
          evidence: r.output.slice(-4000),
          likelyCause: r.timedOut ? 'Command timed out' : `Exit code ${r.exitCode ?? 'n/a'}`,
          relevantFiles: [],
        })),
        createdAt: nowIso(),
      })
      bus.emit({
        runId: run.id,
        taskId,
        type: 'checks.completed',
        payload: { passed, failed: failed.map((r) => r.name) },
      })
      return verification
    })
  }

  private async runOne(name: string, command: string, cwd: string): Promise<CommandResult> {
    const timeoutMs = this.deps.repos.settings.get().execution.checkTimeoutMinutes * 60_000
    const started = Date.now()
    try {
      const r = await runCommandLine(command, { cwd, timeoutMs, maxOutputBytes: CHECK_OUTPUT_BYTES })
      return { name, command, cwd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: r.output }
    } catch (e) {
      // Unresolvable executable or a command line NEXUS refuses to interpret: recorded as a failed check.
      return { name, command, cwd, exitCode: null, timedOut: false, durationMs: Date.now() - started, output: errorMessage(e) }
    }
  }
}
