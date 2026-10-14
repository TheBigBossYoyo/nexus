import type { ProgressSnapshot } from '@shared/progress'
import type { AuthStatus } from '@shared/auth'
import { TERMINAL_RUN_STATES, type RunConfig } from '@shared/domain'
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
import { sensitiveSettingsChanges } from '@shared/settings'
import { errorMessage, NexusError } from '@shared/result'
import type { z } from 'zod'
import type { AgentRuntime } from '@main/modules/agent-runtime/types'
import type { GitService } from '@main/modules/git'
import type { OvernightSupervisor } from '@main/modules/overnight'
import {
  attachArbitration,
  refreshProjectFacts,
  type Orchestrator,
} from '@main/modules/orchestrator'
import type { Repositories } from '@main/modules/persistence'
import { recommendPlanningMode } from '@main/modules/planning'
import { aggregatePerformance } from '@main/modules/routing'
import { ProjectService, QueryService } from './services'
import { isReasoningRun } from '@shared/program'
import { unavailableV3Handlers, type V3Handlers } from './v3-handlers'
import { unavailableV4Handlers, type V4Handlers } from './v4-handlers'
import { unavailableV5Handlers, type V5Handlers } from './v5-handlers'
import { unavailableV6Handlers, type V6Handlers } from './v6-handlers'
import { unavailableV7Handlers, type V7Handlers } from './v7-handlers'
import { createSecurityHandlers } from './v7-security-handlers'
import { createAutonomyHandlers, createIsolationHandlers, type IsolationHandlerContext } from './v8-handlers'
import { createDirectorLineHandlers, type DirectorLineHandlerContext } from './v9-handlers'
import { AutonomyService } from '@main/modules/autonomy/service'
import { createV71Handlers } from './v71-handlers'
import { createV72Handlers } from './v72-handlers'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { IntelligenceOperations } from '@main/modules/intelligence/operations'
import { TaskAdmissionService } from '@main/modules/intelligence/admission'
import type { AdvisoryRoutingService } from '@main/modules/intelligence/routing'
import {
  defaultIntentMetadata,
  type CompilationSelection,
  type UserIntentMetadata,
  type CompiledTaskSpec,
} from '@shared/intelligence'
import { withAdmittedIntent } from '@main/modules/intelligence/admission-prompt'
import { createPrivilegeHandlers, type PrivilegeHandlerContext } from './privilege-handlers'
import type { UserDisturbanceMetrics } from '@shared/presentation'

export interface IpcContext {
  /** 0.9: progress and time remaining of missions. Absent: the channel answers null. */
  progress?: { snapshot: (runId: string) => ProgressSnapshot | null }
  chatgpt?: ChatGPTConnection
  intelligenceOperations?: IntelligenceOperations
  taskAdmission?: TaskAdmissionService
  advisoryRouting?: AdvisoryRoutingService
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
  /**
   * Native confirmation before a settings change that lets NEXUS start another program or widens what agents
   * may do unasked (see `sensitiveSettingsChanges`). Absent: such a change is stored without a question, as
   * before 0.7 (tests of the handlers).
   */
  confirmSettings?: (changes: string[]) => Promise<boolean>
  /** Native folder picker; resolves null when cancelled. Lives in main, never in the renderer. */
  pickDirectory: () => Promise<string | null>
  openDataDir: () => Promise<void>
  push: (message: PushMessage) => void
  /** v0.3 channels (usage, arena, policy, speculative, home, activity). Absent: they answer `runtime_unavailable`. */
  v3?: V3Handlers
  /** v0.4 handlers (programs, backlog, background engineering). */
  v4?: V4Handlers
  /** v0.5 handlers (workspaces). */
  v5?: V5Handlers
  /** v0.6 handlers (providers). */
  v6?: V6Handlers
  /** v0.7 handlers (the control plane). */
  v7?: V7Handlers
  /** 0.8: enrolled projects, grants and boundary requests. Absent: one is made over the repositories, with nothing to notify. */
  autonomy?: AutonomyService
  /** 0.8: the native confirmation before lasting authority is given (enrolling, allowing for a whole project). Absent: no question. */
  confirmAutonomy?: (title: string, message: string, detail: string, accept: string) => Promise<boolean>
  /** 0.9: the remote operator channel. Its channels that open it to the outside or give a phone authority are confirmed natively. */
  directorLine?: DirectorLineHandlerContext['directorLine']
  /** 0.8: the containment as the runtime holds it. Absent (tests of other handlers): no containment exists and none can be set up. */
  isolation?: Omit<IsolationHandlerContext, 'confirm'>
  /** 0.9.1: privilege sessions. Absent: none can be prepared. */
  privilege?: PrivilegeHandlerContext
  /** 0.9.1: the disturbance metrics. Absent: nothing was measured. */
  presentation?: { metrics: (runId: string) => UserDisturbanceMetrics }
}

type Handlers = {
  [C in IpcChannel]: (
    input: z.output<(typeof ipcInputs)[C]>,
  ) => Promise<IpcOutputs[C]> | IpcOutputs[C]
}

export function createIpcHandlers(ctx: IpcContext): Handlers {
  const { repos, orchestrator, runtime } = ctx
  const projects = new ProjectService(repos, ctx.git)
  const queries = new QueryService(repos, ctx.git)
  const intelligenceOperations = ctx.intelligenceOperations ?? new IntelligenceOperations()
  const taskAdmission =
    ctx.taskAdmission ??
    new TaskAdmissionService(repos, ctx.git, ctx.chatgpt, intelligenceOperations)
  const v72 = createV72Handlers(
    repos,
    ctx.chatgpt,
    ctx.git,
    intelligenceOperations,
    taskAdmission,
    ctx.advisoryRouting,
  )
  const taskRequest = async (
    runId: string,
    raw: string,
    selection: CompilationSelection,
    metadata: UserIntentMetadata,
    taskId?: string,
  ) => {
    const run = repos.runs.require(runId)
    const input = {
      projectId: run.projectId,
      raw,
      mode: selection.compilationMode ?? taskAdmission.defaultMode(run.projectId),
      metadata,
      executionScope: { runId, ...(taskId ? { taskId } : {}) },
    }
    const id = selection.compiledSpecId ?? (await taskAdmission.preview(input)).id
    return taskAdmission.validate(input, id)
  }
  let authCache: AuthStatus | null = null
  const admitResumedRun = async (runId: string, selection: CompilationSelection) => {
    if (!selection.compilationMode && !selection.compiledSpecId) return
    const run = repos.runs.require(runId)
    if (run.state !== 'paused')
      throw new NexusError('invalid_state', 'Only a paused mission can be admitted for recovery.')
    if (
      run.config.engineeringOwner ||
      repos.programMissions.getByRun(runId) ||
      repos.workspaceTasks.getByRun(runId) ||
      repos.arenaTrials.getByRun(runId)
    )
      throw new NexusError('invalid_state', 'Resume this internal workload from its parent page.')
    const raw = run.config.compiledTaskSpec?.rawIntent ?? run.prompt
    const metadata = run.config.compiledTaskSpec?.userMetadata ?? defaultIntentMetadata(raw)
    const spec = await taskRequest(runId, raw, selection, metadata)
    repos.runs.update(runId, { config: { ...run.config, compiledTaskSpec: spec } })
  }
  const overnight = (): OvernightSupervisor => {
    if (!ctx.overnight)
      throw new NexusError('runtime_unavailable', 'Overnight Mode is not available in this process')
    return ctx.overnight
  }

  return {
    ...v72,
    'app.info': () => ctx.appInfo(),
    'app.openDataDir': async () => {
      await ctx.openDataDir()
      return null
    },

    'auth.status': async ({ refresh }) => {
      if (!authCache || refresh) {
        authCache = await runtime.getAccountInfo({
          subscriptionMode: repos.settings.get().claude.subscriptionMode,
        })
      }
      return authCache
    },
    'auth.models': async () =>
      (await runtime.getCapabilities().catch(() => ({ models: [] }))).models,

    'settings.get': () => repos.settings.get(),
    'settings.update': async ({ settings }) => {
      const before = repos.settings.get()
      const changes = sensitiveSettingsChanges(before, settings)
      if (changes.length > 0 && ctx.confirmSettings && !(await ctx.confirmSettings(changes)))
        throw new NexusError(
          'invalid_state',
          'The change was not confirmed, so the settings are as they were.',
        )
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
    'projects.update': async ({ projectId, respectProjectClaudeConfig }) => {
      const project = repos.projects.require(projectId)
      // Loading a repository's own Claude configuration lets that repository run its hooks and set the session's
      // environment, outside NEXUS's policy. Switching it on is confirmed like a program in the settings.
      if (
        respectProjectClaudeConfig &&
        !project.respectProjectClaudeConfig &&
        ctx.confirmSettings
      ) {
        const ok = await ctx.confirmSettings([
          `Load the Claude configuration of the repository "${project.name}" (.claude/settings.json, CLAUDE.md). Its hooks are programs that run on this computer outside NEXUS's policy, and it can set the environment of the agent sessions, including where they send their credentials. Do this only for a repository you trust.`,
        ])
        if (!ok)
          throw new NexusError(
            'invalid_state',
            'The change was not confirmed, so the project is as it was.',
          )
      }
      return repos.projects.update(projectId, { respectProjectClaudeConfig })
    },
    'projects.remove': ({ projectId }) => {
      const active = repos.runs
        .listByProject(projectId)
        .filter((r) => !TERMINAL_RUN_STATES.includes(r.state))
      if (active.length > 0) {
        throw new NexusError(
          'invalid_state',
          'Cancel the active runs of this project before removing it',
        )
      }
      // The overnight record is the only thing that knows about an armed Windows shutdown timer or a
      // pending power action; it must not disappear with the project.
      for (const run of repos.runs.listByProject(projectId)) {
        const overnightRun = repos.overnight.getByRun(run.id)
        if (!overnightRun) continue
        const armed =
          overnightRun.failsafe !== null &&
          overnightRun.failsafe.result.ok &&
          !overnightRun.failsafe.cancelledAt &&
          !overnightRun.failsafe.lostAt
        const pending =
          overnightRun.powerAction !== null &&
          !overnightRun.powerAction.cancelledAt &&
          !overnightRun.powerAction.executedAt
        const live = [
          'ARMING',
          'RUNNING',
          'QUOTA_PAUSED',
          'FINALIZING',
          'POWER_ACTION_SCHEDULED',
          'CANCELLING',
        ].includes(overnightRun.state)
        if (live || armed || pending) {
          throw new NexusError(
            'invalid_state',
            'This project has an overnight run with a shutdown timer or power action still pending. Cancel the shutdown first.',
          )
        }
      }
      // Removes NEXUS records only; the repository on disk is not touched.
      // Per-run and per-session bookkeeping lives in settings keys that no foreign key cascades to.
      for (const run of repos.runs.listByProject(projectId)) {
        repos.settings.deleteValue(`run-active:${run.id}`)
        repos.settings.deleteValue(`overnight-heartbeat:${run.id}`)
        for (const task of repos.tasks.listByRun(run.id))
          repos.settings.deleteValue(`graph-yield:${task.id}`)
        for (const approval of repos.approvals.listByRun(run.id))
          repos.settings.deleteValue(`graph-approval:${approval.id}`)
        for (const agent of repos.agents.listByRun(run.id)) {
          for (const session of repos.sessions.listByAgent(agent.id)) {
            if (session.sdkSessionId)
              repos.settings.deleteValue(`usage-cumulative:${session.sdkSessionId}`)
          }
        }
      }
      repos.projects.delete(projectId)
      return null
    },

    'runs.list': ({ projectId, includeInternal }) => {
      const runs = projectId
        ? repos.runs.listByProject(projectId)
        : repos.projects.list().flatMap((p) => repos.runs.listByProject(p.id))
      // A program's planning, verification and reassessment sessions are its own; they are not missions of the user.
      return includeInternal ? runs : runs.filter((r) => !isReasoningRun(r))
    },
    'progress.get': ({ runId }) => ctx.progress?.snapshot(runId) ?? null,
    'runs.get': ({ runId }) => ({
      run: repos.runs.require(runId),
      tasks: repos.tasks.listByRun(runId),
      dependencies: repos.dependencies.listByRun(runId),
      agents: repos.agents.listByRun(runId),
      criteria: repos.criteria.listByRun(runId),
      worktrees: repos.worktrees.listByRun(runId),
      pendingApprovals: repos.approvals.listPending(runId),
    }),
    'runs.create': ({
      projectId,
      mode,
      preset,
      prompt,
      strategy,
      speculativeCandidates,
      compilationMode,
      compiledTaskSpecId,
      ...overrides
    }) =>
      intelligenceOperations.run(async () => {
        const defined: Partial<RunConfig> = Object.fromEntries(
          Object.entries(overrides).filter(([, v]) => v !== undefined),
        )
        let compiledHead: string | undefined
        if (mode !== 'ask') {
          const selectedMode = compilationMode ?? taskAdmission.defaultMode(projectId)
          const specId =
            compiledTaskSpecId ??
            (await v72['compilation.preview']({ projectId, raw: prompt, mode: selectedMode })).id
          const spec = await v72['compilation.validate']({
            projectId,
            specId,
            raw: prompt,
            mode: selectedMode,
          })
          defined.compiledTaskSpec = spec
          const snapshot = spec.dependencies
            .find((d) => d.id === `repository:${projectId}`)
            ?.version.split(':')[0]
          if (snapshot && snapshot !== 'no-head') compiledHead = snapshot
        }
        return orchestrator.createRun({
          projectId,
          mode,
          preset,
          prompt,
          overrides: defined,
          ...(compiledHead ? { expectedHead: compiledHead } : {}),
          ...(strategy ? { strategy } : {}),
          ...(speculativeCandidates !== undefined ? { speculativeCandidates } : {}),
        })
      }),
    'runs.approvePlan': ({ runId }) => orchestrator.approvePlan(runId),
    'runs.replan': ({ runId, feedback, ...selection }) =>
      intelligenceOperations.serial(`run:${runId}`, async () => {
        const run = repos.runs.require(runId)
        if (run.state !== 'awaiting_approval')
          throw new NexusError('invalid_state', 'Only a plan awaiting approval can be replanned')
        if (!feedback.trim()) return orchestrator.replan(runId, feedback)
        const spec = await taskRequest(
          runId,
          feedback,
          selection,
          defaultIntentMetadata(feedback, 'MISSION_REPLAN'),
        )
        // The compilation took time: the plan may have been approved or the run ended meanwhile. An instruction
        // is put on record only when it is about to apply; one that was refused never becomes history.
        if (repos.runs.require(runId).state !== 'awaiting_approval')
          throw new NexusError('invalid_state', 'The plan is no longer awaiting approval. Nothing was changed.')
        repos.intelligenceArtifacts.bindAdmission('RUN_INSTRUCTION', runId, spec)
        return orchestrator.replan(
          runId,
          spec.mode === 'EXACT' ? feedback : withAdmittedIntent(feedback, spec),
        )
      }),
    'runs.pause': ({ runId }) => orchestrator.pauseRun(runId),
    'runs.resume': async ({ runId, ...selection }) => {
      await admitResumedRun(runId, selection)
      return orchestrator.resumeRun(runId)
    },
    'runs.cancel': ({ runId }) => orchestrator.cancelRun(runId),
    'runs.summary': ({ runId }) => queries.runSummary(runId),
    'runs.diff': ({ runId }) => queries.runDiff(repos.runs.require(runId)),
    // A live overnight run is recovered by its supervisor without anyone clicking; it is not offered in the dialog.
    'runs.recoverable': () => {
      const overnightRuns = new Set((ctx.overnight?.active() ?? []).map((o) => o.runId))
      return orchestrator.listRecoverable().filter((r) => !overnightRuns.has(r.run.id))
    },
    'runs.recover': async ({ runId, action, ...selection }) => {
      if (action === 'resume') await admitResumedRun(runId, selection)
      return orchestrator.recover(runId, action)
    },
    'runs.cleanup': async ({ runId }) => {
      await orchestrator.cleanupRun(runId)
      return null
    },

    'tasks.retry': ({ taskId }) => orchestrator.retryTask(taskId),
    'tasks.cancel': ({ taskId }) => orchestrator.cancelTask(taskId),
    'tasks.setPriority': ({ taskId, priority }) => orchestrator.setPriority(taskId, priority),
    'tasks.add': ({ compilationMode, compiledSpecId, ...input }) =>
      intelligenceOperations.run(async () => {
        const spec = await taskRequest(
          input.runId,
          input.description,
          {
            ...(compilationMode ? { compilationMode } : {}),
            ...(compiledSpecId ? { compiledSpecId } : {}),
          },
          {
            entryPoint: 'TASK_ADDITION',
            goals: [input.title, input.description],
            constraints: [],
            acceptanceCriteria: input.acceptanceCriteria,
          },
        )
        return repos.transaction(() => {
          const task = orchestrator.addTask(input)
          repos.intelligenceArtifacts.bindAdmission('TASK_ADDITION', task.id, spec)
          return task
        })
      }),
    'tasks.instruct': ({ taskId, instruction, ...selection }) =>
      intelligenceOperations.serial(`task:${taskId}`, async () => {
        const task = repos.tasks.require(taskId)
        const spec = await taskRequest(
          task.runId,
          instruction,
          selection,
          defaultIntentMetadata(instruction, 'TASK_INSTRUCTION'),
          taskId,
        )
        // Recorded and delivered together: if the delivery is refused, the history does not keep the instruction.
        return repos.transaction(() => {
          repos.intelligenceArtifacts.bindAdmission('TASK_INSTRUCTION', taskId, spec)
          return orchestrator.instruct(
            taskId,
            spec.mode === 'EXACT' ? instruction : withAdmittedIntent(instruction, spec),
          )
        })
      }),
    'tasks.resolveBlocker': ({ taskId, note, ...selection }) =>
      intelligenceOperations.serial(`task:${taskId}`, async () => {
        const current = repos.tasks.require(taskId)
        if (current.state !== 'blocked')
          throw new NexusError('invalid_state', `Task is ${current.state}, not blocked`)
        let spec: CompiledTaskSpec | undefined
        if (note.trim()) {
          const task = repos.tasks.require(taskId)
          spec = await taskRequest(
            task.runId,
            note,
            selection,
            defaultIntentMetadata(note, 'TASK_INSTRUCTION'),
            taskId,
          )
        }
        return repos.transaction(() => {
          const task = repos.tasks.require(taskId)
          if (task.state !== 'blocked')
            throw new NexusError('invalid_state', `Task is ${task.state}, not blocked`)
          if (spec) repos.intelligenceArtifacts.bindAdmission('TASK_INSTRUCTION', taskId, spec)
          return orchestrator.resolveBlocker(taskId, note)
        })
      }),
    'tasks.diff': ({ taskId }) => queries.taskDiff(repos.tasks.require(taskId)),
    // The arbiter's decisions live in an 'arbitration' artifact (the reviews table has no column for them).
    'tasks.reviews': ({ taskId }) =>
      attachArbitration(repos.reviews.listByTask(taskId), repos.artifacts.listByTask(taskId)),
    'tasks.verifications': ({ taskId }) => repos.verifications.listByTask(taskId),

    'criteria.update': ({ criterionId, text, ...selection }) => {
      const criterion = repos.criteria.require(criterionId)
      return intelligenceOperations.serial(
        criterion.taskId ? `task:${criterion.taskId}` : `run:${criterion.runId}`,
        async () => {
          const before = repos.criteria.require(criterionId)
          const spec = await taskRequest(
            before.runId,
            text,
            selection,
            {
              ...defaultIntentMetadata(text, 'CRITERION_UPDATE'),
              acceptanceCriteria: [text],
            },
            before.taskId ?? undefined,
          )
          return repos.transaction(() => {
            const current = repos.criteria.require(criterionId)
            if (current.text !== before.text)
              throw new NexusError(
                'invalid_state',
                'The criterion changed during compilation. Preview again.',
              )
            const updated = orchestrator.updateCriterion(criterionId, text)
            repos.intelligenceArtifacts.bindAdmission(
              before.taskId ? 'TASK_INSTRUCTION' : 'RUN_INSTRUCTION',
              before.taskId ?? before.runId,
              spec,
            )
            return updated
          })
        },
      )
    },

    'agents.get': ({ agentId }) => {
      const agent = repos.agents.require(agentId)
      return {
        agent,
        sessions: repos.sessions.listByAgent(agentId),
        task: agent.taskId ? repos.tasks.get(agent.taskId) : null,
      }
    },
    'agents.stop': ({ agentId }) => orchestrator.stopAgent(agentId),
    'agents.output': ({ agentId, afterSeq, limit }) =>
      repos.outputs.listByAgent(agentId, afterSeq ?? 0, limit ?? 1000),
    'agents.tools': ({ agentId }) => repos.toolEvents.listByAgent(agentId),

    'messages.list': ({ runId, taskId }) => {
      const all = repos.messages.listByRun(runId)
      if (!taskId) return all
      return all.filter(
        (m) =>
          m.fromTaskId === taskId ||
          m.toTaskId === taskId ||
          repos.messages.listRecipients(m.id).some((r) => r.taskId === taskId),
      )
    },
    'events.list': ({ runId, afterSeq, limit }) =>
      repos.events.listByRun(runId, afterSeq ?? 0, limit ?? 1000),
    'reviews.list': ({ runId }) =>
      attachArbitration(repos.reviews.listByRun(runId), repos.artifacts.listByRun(runId)),
    'verifications.list': ({ runId }) => repos.verifications.listByRun(runId),
    'decisions.list': ({ runId }) => repos.decisions.listByRun(runId),

    'approvals.pending': () => repos.approvals.listPending(),
    'approvals.resolve': ({ approvalId, approve, note }) =>
      orchestrator.resolveApproval(approvalId, approve, note),

    'memory.list': ({ projectId, scope, query }) =>
      query?.trim()
        ? repos.memory.search(query, { projectId, scope, status: 'any', limit: 50 })
        : repos.memory.list({ projectId, scope }),
    'memory.add': ({ scope, projectId, title, content, tags }) => {
      if (scope === 'project' && !projectId)
        throw new NexusError('invalid_input', 'A project memory entry needs a project')
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
    'planning.recommend': ({ projectId, prompt }) =>
      recommendPlanningMode(prompt, repos.projects.require(projectId).profile),
    'routing.list': ({ runId }) => repos.routingDecisions.listByRun(runId),
    'performance.summary': ({ projectId }) => {
      const outcomes = projectId
        ? repos.taskOutcomes.listByProject(projectId)
        : repos.taskOutcomes.listAll()
      return {
        stats: aggregatePerformance(outcomes),
        totalOutcomes: outcomes.length,
        minSamples: MIN_ROUTING_SAMPLES,
      }
    },
    'intelligence.list': ({ projectId, query, includeStale }) =>
      query?.trim()
        ? repos.facts.search(projectId, query, { includeStale: includeStale ?? false, limit: 50 })
        : repos.facts.listByProject(projectId, { includeStale: includeStale ?? false }),
    'intelligence.refresh': async ({ projectId }) => {
      const project = repos.projects.require(projectId)
      const result = await refreshProjectFacts({ repos, git: ctx.git }, project)
      if (!result)
        throw new NexusError(
          'internal',
          'Repository analysis failed; the previous facts are unchanged',
        )
      return result
    },
    'context.packs': ({ taskId, agentId }) => {
      if (!taskId && !agentId)
        throw new NexusError('invalid_input', 'context.packs needs a taskId or an agentId')
      const packs = [
        ...(taskId ? repos.contextPacks.listByTask(taskId) : []),
        ...(agentId ? repos.contextPacks.listByAgent(agentId) : []),
      ]
      const seen = new Set<string>()
      return packs.filter((p) => !seen.has(p.id) && seen.add(p.id))
    },

    'overnight.start': ({
      confirmed,
      confirmation,
      compilationMode,
      compiledTaskSpecId,
      adminRecovery,
      ...input
    }) =>
      intelligenceOperations.run(async () => {
        const defined = Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ) as typeof input
        const supervisor = overnight()
        const selectedMode = compilationMode ?? taskAdmission.defaultMode(input.projectId)
        const metadata = defaultIntentMetadata(input.prompt, 'OVERNIGHT')
        const specId =
          compiledTaskSpecId ??
          (
            await v72['compilation.preview']({
              projectId: input.projectId,
              raw: input.prompt,
              mode: selectedMode,
              metadata,
            })
          ).id
        const spec = await v72['compilation.validate']({
          projectId: input.projectId,
          specId,
          raw: input.prompt,
          mode: selectedMode,
          metadata,
        })
        const snapshot = spec.dependencies
          .find((d) => d.id === `repository:${input.projectId}`)
          ?.version.split(':')[0]
        const p = input.policy
        if (ctx.confirmPower) {
          const conditions =
            Object.entries(p.shutdownOn)
              .filter(([, on]) => on)
              .map(([name]) => name)
              .join(', ') || 'never'
          const detail = [
            `Project: ${repos.projects.require(input.projectId).name}`,
            `Maximum duration: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
            `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the mission ends`,
            `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
            p.endAction !== 'NONE' && p.failsafeEnabled
              ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
              : 'Failsafe: none',
            ...(adminRecovery === true ? ['Administrator recovery: one Windows UAC prompt follows now, for a temporary broker that ends with this run.'] : []),
          ].join('\n')
          const ok = await ctx.confirmPower(
            p.endAction === 'NONE'
              ? 'Start an unattended overnight run?'
              : 'Authorize NEXUS to control Windows power state for this run?',
            detail,
          )
          if (!ok) throw new NexusError('invalid_state', 'The overnight run was not authorized.')
        }
        const started = await supervisor.start({
          ...defined,
          confirmed,
          confirmation,
          compiledTaskSpec: spec,
          ...(snapshot && snapshot !== 'no-head' ? { expectedHead: snapshot } : {}),
        })
        if (adminRecovery !== true) return started
        // 0.9.1: the one UAC prompt of the night, now, while the owner is here (never at 03:00). Declined or
        // unavailable, the night goes on without administrator recovery, and the report says so.
        const service = ctx.privilege?.service() ?? null
        const prepared = service
          ? await service.prepare({ scope: 'OVERNIGHT', runId: started.run.id, projectId: input.projectId })
          : { ok: false as const, reason: ctx.privilege?.unavailableReason ?? 'Privilege sessions are not available.' }
        return { ...started, privilege: { ok: prepared.ok, reason: prepared.ok ? null : prepared.reason } }
      }),
    'overnight.startArena': async ({ campaign, policy: p, confirmed, confirmation }) => {
      const supervisor = overnight()
      if (ctx.confirmPower) {
        const conditions =
          Object.entries(p.shutdownOn)
            .filter(([, on]) => on)
            .map(([name]) => name)
            .join(', ') || 'never'
        const detail = [
          `Arena campaign: ${campaign.name}`,
          `Maximum duration: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
          `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the campaign ends`,
          `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
          p.endAction !== 'NONE' && p.failsafeEnabled
            ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
            : 'Failsafe: none',
        ].join('\n')
        const ok = await ctx.confirmPower(
          p.endAction === 'NONE'
            ? 'Start an unattended overnight Arena campaign?'
            : 'Authorize NEXUS to control Windows power state for this campaign?',
          detail,
        )
        if (!ok) throw new NexusError('invalid_state', 'The overnight campaign was not authorized.')
      }
      const defined = Object.fromEntries(
        Object.entries(campaign).filter(([, v]) => v !== undefined),
      ) as typeof campaign
      return supervisor.startArena({ campaign: defined, policy: p, confirmed, confirmation })
    },
    'overnight.startProgram': async ({ programId, policy: p, confirmed, confirmation }) => {
      const supervisor = overnight()
      if (ctx.confirmPower) {
        const conditions =
          Object.entries(p.shutdownOn)
            .filter(([, on]) => on)
            .map(([name]) => name)
            .join(', ') || 'never'
        const detail = [
          `Program: ${repos.programs.require(programId).name}`,
          `Work window: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
          `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the window ends`,
          `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
          p.endAction !== 'NONE' && p.failsafeEnabled
            ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
            : 'Failsafe: none',
        ].join('\n')
        const ok = await ctx.confirmPower(
          p.endAction === 'NONE'
            ? 'Run this program unattended for one work window?'
            : 'Authorize NEXUS to control Windows power state for this program window?',
          detail,
        )
        if (!ok)
          throw new NexusError('invalid_state', 'The overnight program window was not authorized.')
      }
      return supervisor.startProgram({ programId, policy: p, confirmed, confirmation })
    },
    'overnight.startWorkspaceMission': async ({
      missionId,
      policy: p,
      confirmed,
      confirmation,
    }) => {
      const supervisor = overnight()
      if (ctx.confirmPower) {
        const conditions =
          Object.entries(p.shutdownOn)
            .filter(([, on]) => on)
            .map(([name]) => name)
            .join(', ') || 'never'
        const detail = [
          `Workspace mission: ${repos.workspaceMissions.require(missionId).goal.replace(/\s+/g, ' ').slice(0, 160)}`,
          `Maximum duration: ${Math.floor(p.maxDurationMinutes / 60)} h ${p.maxDurationMinutes % 60} min`,
          `End action: ${p.endAction} (applies on: ${conditions}), ${p.finalDelaySeconds} s after the mission ends`,
          `Force close applications: ${p.forceCloseApplications ? 'yes: unsaved work in other applications may be lost' : 'no'}`,
          p.endAction !== 'NONE' && p.failsafeEnabled
            ? `Failsafe: Windows shuts this PC down after ${Math.floor(p.failsafeAfterMinutes / 60)} h ${p.failsafeAfterMinutes % 60} min even if NEXUS stops responding. A timed shutdown always closes applications without waiting.`
            : 'Failsafe: none',
        ].join('\n')
        const ok = await ctx.confirmPower(
          p.endAction === 'NONE'
            ? 'Run this workspace mission unattended?'
            : 'Authorize NEXUS to control Windows power state for this workspace mission?',
          detail,
        )
        if (!ok)
          throw new NexusError(
            'invalid_state',
            'The overnight workspace mission was not authorized.',
          )
      }
      return supervisor.startWorkspaceMission({ missionId, policy: p, confirmed, confirmation })
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
        ((change.endAction !== undefined &&
          change.endAction !== 'NONE' &&
          change.endAction !== current.policy.endAction) ||
          (change.forceCloseApplications === true && !current.policy.forceCloseApplications) ||
          // 0.9 (review, N-1): less time to say no before Windows is shut down is more power, not less.
          (change.finalDelaySeconds !== undefined && change.finalDelaySeconds < current.policy.finalDelaySeconds) ||
          (change.shutdownOn !== undefined &&
            Object.entries(change.shutdownOn).some(
              ([name, on]) =>
                on && !current.policy.shutdownOn[name as keyof typeof current.policy.shutdownOn],
            )))
      if (escalates && ctx.confirmPower) {
        const ok = await ctx.confirmPower(
          'Change what NEXUS may do to Windows at the end of this run?',
          `New end action: ${change.endAction ?? current.policy.endAction}${change.forceCloseApplications ? ', force close applications' : ''}${change.finalDelaySeconds !== undefined && change.finalDelaySeconds < current.policy.finalDelaySeconds ? `, final delay ${change.finalDelaySeconds} s instead of ${current.policy.finalDelaySeconds} s` : ''}`,
        )
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
    ...(ctx.v4 ?? unavailableV4Handlers()),
    ...(ctx.v5 ?? unavailableV5Handlers()),
    ...(ctx.v6 ?? unavailableV6Handlers()),
    ...(ctx.v7 ?? unavailableV7Handlers()),
    ...createSecurityHandlers(repos),
    ...createAutonomyHandlers({
      autonomy:
        ctx.autonomy ??
        new AutonomyService({ repos, runActive: (runId) => {
          const run = repos.runs.get(runId)
          return run !== null && !TERMINAL_RUN_STATES.includes(run.state)
        } }),
      projectName: (projectId) => repos.projects.get(projectId)?.name ?? null,
      ...(ctx.confirmAutonomy ? { confirm: ctx.confirmAutonomy } : {}),
    }),
    'research.list': ({ projectId, runId, limit }) => ({
      // The path of the kept text and of a held file stays in the runtime.
      artifacts: repos.researchArtifacts.list({ projectId, ...(runId ? { runId } : {}), limit: limit ?? 50 }).map((a) => ({ ...a, textPath: null })),
      downloads: repos.researchDownloads.list({ projectId, ...(runId ? { runId } : {}), limit: limit ?? 50 }).map((d) => ({ id: d.id, projectId: d.projectId, runId: d.runId, url: d.url, finalUrl: d.finalUrl, fileName: d.suggestedName, sniffed: d.sniffed, bytes: d.bytes, sha256: d.sha256, state: d.state, refusal: d.refusal, downloadedAt: d.downloadedAt })),
    }),
    ...createDirectorLineHandlers({
      directorLine: ctx.directorLine ?? unavailableDirectorLine(),
      ...(ctx.confirmAutonomy ? { confirm: ctx.confirmAutonomy } : {}),
    }),
    ...createIsolationHandlers({
      ...(ctx.isolation ?? {
        status: () => ({ requested: repos.settings.get().execution.containment, effective: 'STANDARD' as const, usable: false, detail: 'This runtime has no containment.', isolated: null, restricted: null, sandboxAccount: false, setupAvailable: false, protectedPaths: [], launches: { shell: 0, commands: 0, programs: 0, refused: 0 } }),
        setup: () => Promise.resolve({ ok: false, detail: 'This runtime has no containment.' }),
        apps: () => [],
      }),
      ...(ctx.confirmAutonomy ? { confirm: ctx.confirmAutonomy } : {}),
    }),
    ...createV71Handlers({ repos, git: ctx.git }),
    'presentation.metrics': ({ runId }) =>
      ctx.presentation?.metrics(runId) ?? { runId, measured: false, uacPrompts: 0, visibleWindows: 0, foregroundSteals: 0, consoleFlashes: 0, unexpectedDialogs: 0, notifications: null, recent: [], quietCommands: 0 },
    ...createPrivilegeHandlers(ctx.privilege ?? { service: () => null, unavailableReason: 'This runtime has no privilege broker.', projectOfRun: () => null }),
  }
}

/**
 * Single entry point for renderer requests. The channel must be part of the contract and the
 * input must pass its zod schema before any handler runs; errors become typed results.
 */
export async function dispatchIpc(
  handlers: Handlers,
  channel: unknown,
  input: unknown,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    return { ok: false, error: { code: 'invalid_input', message: 'Unknown IPC channel' } }
  }
  const parsed = ipcInputs[channel].safeParse(input ?? {})
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ')
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

/** A runtime without the Director Line (a test's): every channel says so. */
function unavailableDirectorLine(): DirectorLineHandlerContext['directorLine'] {
  return new Proxy({} as DirectorLineHandlerContext['directorLine'], {
    get: () => () => {
      throw new NexusError('runtime_unavailable', 'The Director Line is not part of this runtime.')
    },
  })
}
