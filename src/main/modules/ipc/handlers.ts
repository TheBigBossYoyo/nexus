import type { AuthStatus } from '@shared/auth'
import { TERMINAL_RUN_STATES } from '@shared/domain'
import type { PushMessage } from '@shared/events'
import {
  ipcInputs,
  isIpcChannel,
  type AppInfo,
  type IpcChannel,
  type IpcOutputs,
  type IpcResult,
} from '@shared/ipc'
import { newId, nowIso } from '@shared/ids'
import { MIN_ROUTING_SAMPLES } from '@shared/v2'
import { errorMessage, NexusError } from '@shared/result'
import type { z } from 'zod'
import type { AgentRuntime } from '@main/modules/agent-runtime/types'
import type { GitService } from '@main/modules/git'
import type { OvernightSupervisor } from '@main/modules/overnight'
import { attachArbitration, refreshProjectFacts, type Orchestrator } from '@main/modules/orchestrator'
import type { Repositories } from '@main/modules/persistence'
import { recommendPlanningMode } from '@main/modules/planning'
import { aggregatePerformance } from '@main/modules/routing'
import { ProjectService, QueryService } from './services'
import { unavailableV3Handlers, type V3Handlers } from './v3-handlers'

export interface IpcContext {
  repos: Repositories
  git: GitService
  runtime: AgentRuntime
  orchestrator: Orchestrator
  /**
   * Overnight Mode. The handlers reach power control only through the supervisor's typed operations;
   * the power controller itself is never part of this context.
   */
  overnight?: OvernightSupervisor
  appInfo: () => Promise<AppInfo>
  /**
   * Native confirmation shown by the main process before NEXUS is given authority over Windows power
   * state. The renderer's own dialog is a convenience; this one is the control, because a script running
   * in the renderer cannot click it.
   */
  confirmPower?: (message: string, detail: string) => Promise<boolean>
  /** Native folder picker; resolves null when cancelled. Lives in main, never in the renderer. */
  pickDirectory: () => Promise<string | null>
  openDataDir: () => Promise<void>
  push: (message: PushMessage) => void
  /** v0.3 channels (usage, arena, policy, speculative, home, activity). Absent: they answer `runtime_unavailable`. */
  v3?: V3Handlers
}

type Handlers = { [C in IpcChannel]: (input: z.output<(typeof ipcInputs)[C]>) => Promise<IpcOutputs[C]> | IpcOutputs[C] }

export function createIpcHandlers(ctx: IpcContext): Handlers {
  const { repos, orchestrator, runtime } = ctx
  const projects = new ProjectService(repos, ctx.git)
  const queries = new QueryService(repos, ctx.git)
  let authCache: AuthStatus | null = null
  const overnight = (): OvernightSupervisor => {
    if (!ctx.overnight) throw new NexusError('runtime_unavailable', 'Overnight Mode is not available in this process')
    return ctx.overnight
  }

  return {
    'app.info': () => ctx.appInfo(),
    'app.openDataDir': async () => {
      await ctx.openDataDir()
      return null
    },

    'auth.status': async ({ refresh }) => {
      if (!authCache || refresh) {
        authCache = await runtime.getAccountInfo({ subscriptionMode: repos.settings.get().claude.subscriptionMode })
      }
      return authCache
    },
    'auth.models': async () => (await runtime.getCapabilities().catch(() => ({ models: [] }))).models,

    'settings.get': () => repos.settings.get(),
    'settings.update': ({ settings }) => {
      const before = repos.settings.get()
      const saved = repos.settings.set(settings)
      if (before.claude.subscriptionMode !== saved.claude.subscriptionMode) {
        authCache = null
        ctx.push({ kind: 'auth.changed' })
      }
      return saved
    },

    'projects.list': () => repos.projects.list(),
    'projects.open': async ({ path }) => {
      const target = path ?? (await ctx.pickDirectory())
      return target ? projects.open(target) : null
    },
    'projects.get': ({ projectId }) => repos.projects.require(projectId),
    'projects.reprofile': ({ projectId }) => projects.reprofile(projectId),
    'projects.update': ({ projectId, respectProjectClaudeConfig }) =>
      repos.projects.update(projectId, { respectProjectClaudeConfig }),
    'projects.remove': ({ projectId }) => {
      const active = repos.runs.listByProject(projectId).filter((r) => !TERMINAL_RUN_STATES.includes(r.state))
      if (active.length > 0) {
        throw new NexusError('invalid_state', 'Cancel the active runs of this project before removing it')
      }
      // The overnight record is the only thing that knows about an armed Windows shutdown timer or a
      // pending power action; it must not disappear with the project.
      for (const run of repos.runs.listByProject(projectId)) {
        const overnightRun = repos.overnight.getByRun(run.id)
        if (!overnightRun) continue
        const armed = overnightRun.failsafe !== null && overnightRun.failsafe.result.ok && !overnightRun.failsafe.cancelledAt && !overnightRun.failsafe.lostAt
        const pending = overnightRun.powerAction !== null && !overnightRun.powerAction.cancelledAt && !overnightRun.powerAction.executedAt
        const live = ['ARMING', 'RUNNING', 'QUOTA_PAUSED', 'FINALIZING', 'POWER_ACTION_SCHEDULED', 'CANCELLING'].includes(overnightRun.state)
        if (live || armed || pending) {
          throw new NexusError('invalid_state', 'This project has an overnight run with a shutdown timer or power action still pending. Cancel the shutdown first.')
        }
      }
      // Removes NEXUS records only; the repository on disk is not touched.
      // Per-run and per-session bookkeeping lives in settings keys that no foreign key cascades to.
      for (const run of repos.runs.listByProject(projectId)) {
        repos.settings.deleteValue(`run-active:${run.id}`)
        repos.settings.deleteValue(`overnight-heartbeat:${run.id}`)
        for (const task of repos.tasks.listByRun(run.id)) repos.settings.deleteValue(`graph-yield:${task.id}`)
        for (const approval of repos.approvals.listByRun(run.id)) repos.settings.deleteValue(`graph-approval:${approval.id}`)
        for (const agent of repos.agents.listByRun(run.id)) {
          for (const session of repos.sessions.listByAgent(agent.id)) {
            if (session.sdkSessionId) repos.settings.deleteValue(`usage-cumulative:${session.sdkSessionId}`)
          }
        }
      }
      repos.projects.delete(projectId)
      return null
    },

    'runs.list': ({ projectId }) =>
      projectId ? repos.runs.listByProject(projectId) : repos.projects.list().flatMap((p) => repos.runs.listByProject(p.id)),
    'runs.get': ({ runId }) => ({
      run: repos.runs.require(runId),
      tasks: repos.tasks.listByRun(runId),
      dependencies: repos.dependencies.listByRun(runId),
      agents: repos.agents.listByRun(runId),
      criteria: repos.criteria.listByRun(runId),
      worktrees: repos.worktrees.listByRun(runId),
      pendingApprovals: repos.approvals.listPending(runId),
    }),
    'runs.create': ({ projectId, mode, preset, prompt, strategy, speculativeCandidates, ...overrides }) => {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined))
      return orchestrator.createRun({
        projectId,
        mode,
        preset,
        prompt,
        overrides: defined,
        ...(strategy ? { strategy } : {}),
        ...(speculativeCandidates !== undefined ? { speculativeCandidates } : {}),
      })
    },
    'runs.approvePlan': ({ runId }) => orchestrator.approvePlan(runId),
    'runs.replan': ({ runId, feedback }) => orchestrator.replan(runId, feedback),
    'runs.pause': ({ runId }) => orchestrator.pauseRun(runId),
    'runs.resume': ({ runId }) => orchestrator.resumeRun(runId),
    'runs.cancel': ({ runId }) => orchestrator.cancelRun(runId),
    'runs.summary': ({ runId }) => queries.runSummary(runId),
    'runs.diff': ({ runId }) => queries.runDiff(repos.runs.require(runId)),
    // A live overnight run is recovered by its supervisor without anyone clicking; it is not offered in the dialog.
    'runs.recoverable': () => {
      const overnightRuns = new Set((ctx.overnight?.active() ?? []).map((o) => o.runId))
      return orchestrator.listRecoverable().filter((r) => !overnightRuns.has(r.run.id))
    },
    'runs.recover': ({ runId, action }) => orchestrator.recover(runId, action),
    'runs.cleanup': async ({ runId }) => {
      await orchestrator.cleanupRun(runId)
      return null
    },

    'tasks.retry': ({ taskId }) => orchestrator.retryTask(taskId),
    'tasks.cancel': ({ taskId }) => orchestrator.cancelTask(taskId),
    'tasks.setPriority': ({ taskId, priority }) => orchestrator.setPriority(taskId, priority),
    'tasks.add': (input) => orchestrator.addTask(input),
    'tasks.instruct': ({ taskId, instruction }) => orchestrator.instruct(taskId, instruction),
    'tasks.resolveBlocker': ({ taskId, note }) => orchestrator.resolveBlocker(taskId, note),
    'tasks.diff': ({ taskId }) => queries.taskDiff(repos.tasks.require(taskId)),
    // The arbiter's decisions live in an 'arbitration' artifact (the reviews table has no column for them).
    'tasks.reviews': ({ taskId }) => attachArbitration(repos.reviews.listByTask(taskId), repos.artifacts.listByTask(taskId)),
    'tasks.verifications': ({ taskId }) => repos.verifications.listByTask(taskId),

    'criteria.update': ({ criterionId, text }) => orchestrator.updateCriterion(criterionId, text),

    'agents.get': ({ agentId }) => {
      const agent = repos.agents.require(agentId)
      return {
        agent,
        sessions: repos.sessions.listByAgent(agentId),
        task: agent.taskId ? repos.tasks.get(agent.taskId) : null,
      }
    },
    'agents.stop': ({ agentId }) => orchestrator.stopAgent(agentId),
    'agents.output': ({ agentId, afterSeq, limit }) => repos.outputs.listByAgent(agentId, afterSeq ?? 0, limit ?? 1000),
    'agents.tools': ({ agentId }) => repos.toolEvents.listByAgent(agentId),

    'messages.list': ({ runId, taskId }) => {
      const all = repos.messages.listByRun(runId)
      if (!taskId) return all
      return all.filter(
        (m) => m.fromTaskId === taskId || m.toTaskId === taskId || repos.messages.listRecipients(m.id).some((r) => r.taskId === taskId),
      )
    },
    'events.list': ({ runId, afterSeq, limit }) => repos.events.listByRun(runId, afterSeq ?? 0, limit ?? 1000),
    'reviews.list': ({ runId }) => attachArbitration(repos.reviews.listByRun(runId), repos.artifacts.listByRun(runId)),
    'verifications.list': ({ runId }) => repos.verifications.listByRun(runId),
    'decisions.list': ({ runId }) => repos.decisions.listByRun(runId),

    'approvals.pending': () => repos.approvals.listPending(),
    'approvals.resolve': ({ approvalId, approve, note }) => orchestrator.resolveApproval(approvalId, approve, note),

    'memory.list': ({ projectId, scope, query }) =>
      query?.trim()
        ? repos.memory.search(query, { projectId, scope, status: 'any', limit: 50 })
        : repos.memory.list({ projectId, scope }),
    'memory.add': ({ scope, projectId, title, content, tags }) => {
      if (scope === 'project' && !projectId) throw new NexusError('invalid_input', 'A project memory entry needs a project')
      return repos.memory.insert({
        id: newId(),
        scope,
        projectId: scope === 'project' ? (projectId ?? null) : null,
        runId: null,
        taskId: null,
        agentId: null,
        kind: 'note',
        title,
        content,
        tags,
        filePaths: [],
        source: 'user',
        evidence: null,
        status: 'approved',
        createdAt: nowIso(),
      })
    },
    'memory.setStatus': ({ memoryId, status }) => repos.memory.update(memoryId, { status }),
    'memory.delete': ({ memoryId }) => {
      repos.memory.delete(memoryId)
      return null
    },

    'graph.revisions': ({ runId }) => repos.graphRevisions.listByRun(runId),
    'graph.proposals': ({ runId }) => repos.graphProposals.listByRun(runId),
    'planning.candidates': ({ runId }) => ({
      candidates: repos.planningCandidates.listByRun(runId),
      critiques: repos.planningCritiques.listByRun(runId),
    }),
    'planning.recommend': ({ projectId, prompt }) => recommendPlanningMode(prompt, repos.projects.require(projectId).profile),
    'routing.list': ({ runId }) => repos.routingDecisions.listByRun(runId),
    'performance.summary': ({ projectId }) => {
      const outcomes = projectId ? repos.taskOutcomes.listByProject(projectId) : repos.taskOutcomes.listAll()
      return { stats: aggregatePerformance(outcomes), totalOutcomes: outcomes.length, minSamples: MIN_ROUTING_SAMPLES }
    },
    'intelligence.list': ({ projectId, query, includeStale }) =>
      query?.trim()
        ? repos.facts.search(projectId, query, { includeStale: includeStale ?? false, limit: 50 })
        : repos.facts.listByProject(projectId, { includeStale: includeStale ?? false }),
    'intelligence.refresh': async ({ projectId }) => {
      const project = repos.projects.require(projectId)
      const result = await refreshProjectFacts({ repos, git: ctx.git }, project)
      if (!result) throw new NexusError('internal', 'Repository analysis failed; the previous facts are unchanged')
      return result
    },
    'context.packs': ({ taskId, agentId }) => {
      if (!taskId && !agentId) throw new NexusError('invalid_input', 'context.packs needs a taskId or an agentId')
      const packs = [...(taskId ? repos.contextPacks.listByTask(taskId) : []), ...(agentId ? repos.contextPacks.listByAgent(agentId) : [])]
      const seen = new Set<string>()
      return packs.filter((p) => !seen.has(p.id) && seen.add(p.id))
    },

    'overnight.start': async ({ confirmed, confirmation, ...input }) => {
      const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input
      const supervisor = overnight()
      const p = input.policy
      if (ctx.confirmPower) {
        const conditions = Object.entries(p.shutdownOn).filter(([, on]) => on).map(([name]) => name).join(', ') || 'never'
        const detail = [
          `Project: ${repos.projects.require(input.projectId).name}`,
          `Maximum duration: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
          `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the mission ends`,
          `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
          p.endAction !== 'NONE' && p.failsafeEnabled
            ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
            : 'Failsafe: none',
        ].join('\n')
        const ok = await ctx.confirmPower(p.endAction === 'NONE' ? 'Start an unattended overnight run?' : 'Authorize NEXUS to control Windows power state for this run?', detail)
        if (!ok) throw new NexusError('invalid_state', 'The overnight run was not authorized.')
      }
      return supervisor.start({ ...defined, confirmed, confirmation })
    },
    'overnight.startArena': async ({ campaign, policy: p, confirmed, confirmation }) => {
      const supervisor = overnight()
      if (ctx.confirmPower) {
        const conditions = Object.entries(p.shutdownOn).filter(([, on]) => on).map(([name]) => name).join(', ') || 'never'
        const detail = [
          `Arena campaign: ${campaign.name}`,
          `Maximum duration: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
          `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the campaign ends`,
          `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
          p.endAction !== 'NONE' && p.failsafeEnabled
            ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
            : 'Failsafe: none',
        ].join('\n')
        const ok = await ctx.confirmPower(p.endAction === 'NONE' ? 'Start an unattended overnight Arena campaign?' : 'Authorize NEXUS to control Windows power state for this campaign?', detail)
        if (!ok) throw new NexusError('invalid_state', 'The overnight campaign was not authorized.')
      }
      const defined = Object.fromEntries(Object.entries(campaign).filter(([, v]) => v !== undefined)) as typeof campaign
      return supervisor.startArena({ campaign: defined, policy: p, confirmed, confirmation })
    },
    'overnight.get': ({ runId }) => ctx.overnight?.status(runId) ?? null,
    'overnight.active': () => ctx.overnight?.active() ?? [],
    'overnight.cancelPower': ({ runId }) => overnight().cancelPower(runId),
    'overnight.changeEndAction': async ({ runId, ...change }) => {
      const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined))
      const supervisor = overnight()
      const current = supervisor.status(runId)
      // Anything that gives NEXUS more power than was authorized needs the native confirmation again.
      const escalates =
        current !== null &&
        ((change.endAction !== undefined && change.endAction !== 'NONE' && change.endAction !== current.policy.endAction) ||
          (change.forceCloseApplications === true && !current.policy.forceCloseApplications) ||
          (change.shutdownOn !== undefined && Object.entries(change.shutdownOn).some(([name, on]) => on && !current.policy.shutdownOn[name as keyof typeof current.policy.shutdownOn])))
      if (escalates && ctx.confirmPower) {
        const ok = await ctx.confirmPower('Change what NEXUS may do to Windows at the end of this run?', `New end action: ${change.endAction ?? current.policy.endAction}${change.forceCloseApplications ? ', force close applications' : ''}`)
        if (!ok) throw new NexusError('invalid_state', 'The change was not authorized.')
      }
      return supervisor.changeEndPolicy(runId, defined)
    },
    'overnight.extend': ({ runId, minutes }) => overnight().extend(runId, minutes),
    'overnight.cancelMission': ({ runId }) => overnight().cancelMission(runId),
    'overnight.report': ({ runId }) => overnight().report(runId),
    'overnight.audit': ({ runId }) => repos.powerAudit.listByRun(runId),
    'overnight.checkpoints': ({ runId }) => repos.checkpoints.listByRun(runId).slice(-50),

    ...(ctx.v3 ?? unavailableV3Handlers()),
  }
}

/**
 * Single entry point for renderer requests. The channel must be part of the contract and the
 * input must pass its zod schema before any handler runs; errors become typed results.
 */
export async function dispatchIpc(handlers: Handlers, channel: unknown, input: unknown): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    return { ok: false, error: { code: 'invalid_input', message: 'Unknown IPC channel' } }
  }
  const parsed = ipcInputs[channel].safeParse(input ?? {})
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    return { ok: false, error: { code: 'invalid_input', message } }
  }
  try {
    const handler = handlers[channel] as (value: unknown) => unknown
    return { ok: true, value: await handler(parsed.data) }
  } catch (e) {
    const code = e instanceof NexusError ? e.code : 'internal'
    return { ok: false, error: { code, message: errorMessage(e) } }
  }
}
