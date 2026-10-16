import { failedTestFiles, rerunTestsCommand, scopeFinalChecks, scopeTaskChecks } from './check-scope'
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
import type { PauseCause } from '@shared/events'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { projectCommandEnv, runCommandLine } from '@main/modules/process'
import { assertTransition, canPauseRun, canTransition } from '@main/modules/state'
import { AgentRunner } from './agent-runner'
import { ApprovalService } from './approvals'
import { GraphService } from './graph-service'
import { ContextGraphService } from '@main/modules/context-graph'
import { TokenIntelligenceEngine, filterOutput, resultState, summarizeOutput } from '@main/modules/token'
import { SECTION_LIMITS } from '@main/modules/context/render'
import { checkOutputMode } from '@shared/token'
import { contextToolHandler, graphEnabled } from './context-graph'
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
/** The lines of a test run that say a file or a test failed (vitest, jest, node --test, pytest, cargo, go). */
const FAILURE_LINE = /^\s*(?:FAIL\b|×|✗|not ok\b|FAILED\b|--- FAIL)|\(\d+ tests? \| \d+ failed\)|^\s*❯ \S+\.(?:test|spec)\./

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
  /** v0.7.1: the knowledge index over the project's stores, and the accounting of what sessions' contexts hold. */
  readonly contextGraph: ContextGraphService
  readonly tokens: TokenIntelligenceEngine

  constructor(readonly deps: OrchestratorDeps) {
    this.contextGraph = deps.contextGraph ?? new ContextGraphService({ repos: deps.repos })
    this.tokens = deps.tokens ?? new TokenIntelligenceEngine({ repos: deps.repos, log: (line) => deps.logger?.(line) })
    this.approvals = new ApprovalService(deps)
    this.messages = new MessageService(deps)
    this.memory = new MemoryService(deps)
    this.graph = new GraphService(deps, this.approvals)
    this.routing = new ModelRoutingService(deps)
    this.agents = new AgentRunner(deps, this.approvals, this.messages, this.memory, this.graph, this.routing)
    this.agents.attachContext({
      tokens: this.tokens,
      contextTool: (session) => (graphEnabled(this) ? contextToolHandler(this, session) : null),
    })
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
  pauseRun(runId: string, reason: PauseReason, detail?: string, cause?: PauseCause): Run | null {
    const { repos, bus } = this.deps
    const run = repos.runs.require(runId)
    if (!canPauseRun(run.state)) return null
    return bus.transaction(() => {
      const paused = this.setRunState(runId, 'paused', { resumeState: run.state, pauseReason: reason }, detail)
      this.markRunInactive(runId)
      // Without an explicit cause: a 'user' pause that carries a detail was raised by NEXUS itself (an intervention).
      const why: PauseCause = cause ?? (reason === 'user' ? (detail ? 'intervention' : 'user') : reason)
      bus.emit({ runId, type: 'run.paused', payload: { reason, cause: why, ...(detail ? { detail } : {}) } })
      return paused
    })
  }

  /** Install dependencies in a freshly created worktree so check commands can run there. */
  async setupWorktree(run: Run, taskId: string | null, cwd: string): Promise<void> {
    const command = setupCommand(this.project(run))
    if (!command) return
    const result = await this.runOne('setup', command, cwd, run, taskId)
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
  async runChecks(run: Run, taskId: string | null, cwd: string, attempt: number, scope?: { changedFiles: readonly string[] }): Promise<Verification> {
    const { repos, bus } = this.deps
    // 0.9.1: a task's checks are about its own changes (check-scope.ts); the integration runs every command whole,
    // unless the owner chose the affected tests only for it (a scope is then given for the integration too).
    const commands =
      scope !== undefined && taskId !== null
        ? scopeTaskChecks({ checks: run.config.checks, order: CHECK_ORDER, cwd, changedFiles: scope.changedFiles })
        : scope !== undefined
          ? scopeFinalChecks({ checks: run.config.checks, order: CHECK_ORDER, cwd, changedFiles: scope.changedFiles })
          : CHECK_ORDER.flatMap((name) => {
            const command = run.config.checks[name]
            return command ? [{ name, command, scope: 'FULL' as const, skip: false, note: null }] : []
          })
    bus.emit({ runId: run.id, taskId, type: 'checks.started', payload: { commands: commands.filter((c) => !c.skip).map((c) => c.command) } })

    const results: CommandResult[] = []
    const flaky: string[] = []
    for (const check of commands) {
      if (check.skip) {
        results.push({ name: check.name, command: check.command, cwd, exitCode: 0, timedOut: false, durationMs: 0, output: check.note ?? 'Not run for this task.' })
        continue
      }
      let result = await this.runOne(check.name, check.command, cwd, run, taskId)
      // 0.9.1: a test run whose failures are a few named files runs those files once more. Passing then, the check
      // passes and says so (a test that fails once in a full run is told apart in seconds from a defect, where a
      // repair and the whole suite again took half an hour); failing again, it fails as before.
      if (check.name === 'test' && result.exitCode !== 0 && !result.timedOut) {
        const files = failedTestFiles(result.output)
        const rerun = files === null ? null : rerunTestsCommand(cwd, check.command, files)
        if (files !== null && rerun !== null) {
          const again = await this.runOne('test', rerun, cwd, run, taskId)
          if (again.exitCode === 0 && !again.timedOut) {
            result = {
              ...result,
              exitCode: 0,
              durationMs: result.durationMs + again.durationMs,
              output: `[Failed in this run, then passed when run again alone: ${files.join(', ')}. Possibly flaky: a test that fails only sometimes.]\n${again.output}\n--- the first run ---\n${result.output.slice(-6000)}`,
            }
            flaky.push(...files)
            this.deps.bus.emit({ runId: run.id, taskId, type: 'checks.flaky', payload: { files } })
          }
        }
      }
      results.push(check.note !== null ? { ...result, output: `[${check.note}]\n${result.output}` } : result)
    }
    const failed = results.filter((r) => r.exitCode !== 0 || r.timedOut)
    const passed = failed.length === 0
    const partial = taskId === null && commands.some((c) => c.scope === 'CHANGED')
    const summary =
      commands.length === 0
        ? 'No check commands are configured for this project; nothing was run.'
        : passed
          ? `${results.length} check command(s) passed${partial ? ' (tests: only those affected by the mission, as the owner set it; the whole suite was not run)' : ''}${flaky.length > 0 ? `; failed once and passed when run again alone: ${flaky.join(', ')}` : ''}.`
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
          likelyCause: r.timedOut ? `Command timed out after ${this.deps.repos.settings.get().execution.checkTimeoutMinutes} min (the check could not complete; this says nothing about the task's code)` : `Exit code ${r.exitCode ?? 'n/a'}`,
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
      this.recordOutputRefs(run, taskId, verification.id, results)
      return verification
    })
  }

  /**
   * A check output that is longer than what a prompt shows of it is recorded with what was shown and where the
   * complete output is stored (the verification row). A failed check is PINNED: it stays in prompts until it
   * is resolved. Never fails the checks: this is bookkeeping.
   */
  private recordOutputRefs(run: Run, taskId: string | null, verificationId: string, results: readonly CommandResult[]): void {
    try {
      const mode = checkOutputMode(this.deps.repos.settings.get().tokens)
      let earlyFailures = 0
      for (const r of results) {
        const failed = r.exitCode !== 0 || r.timedOut
        const shown = filterOutput(r.output, { failed, tailChars: SECTION_LIMITS.checkItem, mode })
        if (!shown.truncated) continue
        const tail = filterOutput(r.output, { failed, tailChars: SECTION_LIMITS.checkItem, mode: 'tail' })
        earlyFailures += Math.max(0, shown.failureLinesShown - tail.failureLinesShown)
        this.deps.repos.artifactContextRefs.insert({
          id: newId(),
          runId: run.id,
          taskId,
          agentId: null,
          kind: 'check_output',
          ref: `verification:${verificationId}#${r.name}`,
          title: `${r.name}: ${summarizeOutput(r.output, r.exitCode, r.timedOut)}`.slice(0, 300),
          state: resultState({ unresolved: failed, superseded: false, stored: true, age: 0 }),
          charsTotal: shown.totalChars,
          charsShown: shown.shownChars,
          createdAt: nowIso(),
        })
      }
      if (earlyFailures > 0) {
        this.tokens.decide({ runId: run.id, taskId, agentId: null }, 'FILTER_OUTPUT', `${earlyFailures} failure line(s) lie before the tail of the check output; they are shown to the agents that receive it.`, { verificationId, mode }, null, 'exact')
      }
    } catch (e) {
      this.log(`check output references could not be recorded: ${errorMessage(e)}`)
    }
  }

  private async runOne(name: string, command: string, cwd: string, run: Run, taskId: string | null): Promise<CommandResult> {
    // A task's checks are scoped to its changes; the integration runs every command whole, the full test suite
    // included, once: it gets three times the limit (45 to 120 minutes), so that a large suite is not cut off.
    const minutes = this.deps.repos.settings.get().execution.checkTimeoutMinutes
    const timeoutMs = (taskId === null ? Math.min(120, Math.max(minutes * 3, 45)) : minutes) * 60_000
    const started = Date.now()
    // 0.9.1: the end of a long output is what is kept; a test run's failed files are printed as they fail, so they
    // are kept apart and put first when the output was cut (a contained full suite with 25 failed files kept 8 of them).
    const keepLines = name === 'test' ? FAILURE_LINE : undefined
    const withFailures = (r: { output: string; truncated: boolean; keptLines?: string[] }): string =>
      r.truncated && (r.keptLines?.length ?? 0) > 0 ? `[The output is longer than what is kept; the failures it reported:]\n${(r.keptLines ?? []).join('\n')}\n[...]\n${r.output}` : r.output
    try {
      // 0.8: in an enrolled project these commands run inside its containment. They are project code: an install
      // hook, a test. A containment that cannot be made is a failed command, never an uncontained run.
      const contained = await this.deps.execution?.runProjectCommand({ projectId: run.projectId, sessionKey: `${run.id}:${taskId ?? 'run'}`, worktree: cwd, commandLine: command }, { timeoutMs, maxOutputBytes: CHECK_OUTPUT_BYTES, ...(keepLines ? { keepLines } : {}) })
      if (contained) return { name, command, cwd, exitCode: contained.exitCode, timedOut: contained.timedOut, durationMs: contained.durationMs, output: withFailures(contained) }
      // Setup and check commands run code the agents wrote: they get no Claude credentials.
      const r = await runCommandLine(command, { cwd, timeoutMs, maxOutputBytes: CHECK_OUTPUT_BYTES, env: projectCommandEnv(), ...(keepLines ? { keepLines } : {}) })
      return { name, command, cwd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: withFailures(r) }
    } catch (e) {
      // Unresolvable executable or a command line NEXUS refuses to interpret: recorded as a failed check.
      return { name, command, cwd, exitCode: null, timedOut: false, durationMs: Date.now() - started, output: errorMessage(e) }
    }
  }
}
