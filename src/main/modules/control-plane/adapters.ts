import type { WorkloadPhase, WorkloadSnapshot } from '@shared/control-plane'
import type { BackgroundJobKind } from '@shared/program'
import { isReasoningRun } from '@shared/program'
import { NexusError } from '@shared/result'
import type { Repositories } from '@main/modules/persistence'
import type { WorkloadAdapter } from './service'

/** The engine calls the adapters need. The real engines satisfy these; tests pass small fakes. */
export interface AdapterEngines {
  orchestrator: { pauseRun(runId: string): Promise<unknown>; resumeRun(runId: string): Promise<unknown>; cancelRun(runId: string): Promise<unknown> }
  programs: { start(id: string): Promise<unknown>; pause(id: string): Promise<unknown>; resume(id: string): Promise<unknown>; cancel(id: string): Promise<unknown> }
  arena: { start(id: string): Promise<unknown>; pause(id: string): unknown; resume(id: string): unknown; cancel(id: string): unknown }
  workspaces: { startMission(id: string): Promise<unknown>; pauseMission(id: string): Promise<unknown>; resumeMission(id: string): Promise<unknown>; cancelMission(id: string): Promise<unknown> }
  background: { start(projectId: string, kind: BackgroundJobKind): Promise<{ id: string }>; cancel(jobId: string): Promise<unknown> }
  /** The parallel-agent limit a workload gets when it does not say otherwise. */
  defaultAgents: () => number
}

const ACTIVE_AGENT_STATES = new Set(['starting', 'working'])
const MISSING: WorkloadSnapshot = { phase: 'missing', activeAgents: 0, runIds: [], detail: 'It no longer exists.' }
const oneLine = (text: string | null | undefined, max = 120): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Agent sessions running now in the given runs. */
export function activeAgentsOf(repos: Repositories, runIds: readonly string[]): number {
  let n = 0
  for (const runId of runIds) for (const agent of repos.agents.listByRun(runId)) if (ACTIVE_AGENT_STATES.has(agent.state)) n++
  return n
}

/** Active runs no engine owns: missions the user started directly. */
export function unownedActiveRuns(repos: Repositories): { id: string; title: string; requestedAgents: number }[] {
  return repos.runs
    .listActive()
    .filter((run) => run.state !== 'paused' && !isReasoningRun(run))
    .filter((run) => !repos.arenaTrials.getByRun(run.id) && !repos.programMissions.getByRun(run.id) && !repos.programs.getByRun(run.id) && !repos.workspaceTasks.getByRun(run.id) && !repos.backgroundJobs.getByRun(run.id))
    .map((run) => ({ id: run.id, title: oneLine(run.prompt) || 'Mission', requestedAgents: run.config.maxParallelAgents }))
}

/**
 * Missions the user started directly that the last stop of the runtime interrupted: paused for recovery and
 * owned by no engine. After a restart they are resumed when the user chose `resume`, also when the runtime
 * died before the queue had adopted them.
 */
export function unownedRecoveryRuns(repos: Repositories): string[] {
  return repos.runs
    .listActive()
    .filter((run) => run.state === 'paused' && run.pauseReason === 'recovery' && !isReasoningRun(run))
    .filter((run) => !repos.arenaTrials.getByRun(run.id) && !repos.programMissions.getByRun(run.id) && !repos.programs.getByRun(run.id) && !repos.workspaceTasks.getByRun(run.id) && !repos.backgroundJobs.getByRun(run.id))
    .map((run) => run.id)
}

/**
 * Workloads that are working now and are not on the queue: a program, a campaign or a workspace mission the
 * user started from its own page, and missions started from the composer. The queue adopts them, so the
 * global capacity covers everything that uses agents however it was started.
 */
export function unownedActiveWorkloads(repos: Repositories, defaultAgents: () => number): { type: 'mission' | 'program' | 'arena' | 'workspace_mission'; refId: string; title: string; requestedAgents: number }[] {
  const programs = repos.programs
    .listOpen()
    .filter((p) => p.state === 'PLANNING' || p.state === 'ACTIVE' || p.state === 'REPLANNING' || p.state === 'WAITING_FOR_QUOTA')
    .map((p) => ({ type: 'program' as const, refId: p.id, title: p.name, requestedAgents: defaultAgents() }))
  const campaigns = repos.arenaCampaigns.listByState(['running']).map((c) => ({ type: 'arena' as const, refId: c.id, title: c.name, requestedAgents: c.budgets.maxAgentsPerTrial }))
  const missions = repos.workspaceMissions
    .listOpen()
    .filter((m) => m.state === 'PLANNING' || m.state === 'ACTIVE' || m.state === 'VERIFYING' || m.state === 'WAITING_FOR_QUOTA')
    .map((m) => ({ type: 'workspace_mission' as const, refId: m.id, title: oneLine(m.goal) || 'Workspace mission', requestedAgents: defaultAgents() }))
  const runs = unownedActiveRuns(repos).map((r) => ({ type: 'mission' as const, refId: r.id, title: r.title, requestedAgents: r.requestedAgents }))
  return [...programs, ...campaigns, ...missions, ...runs]
}

export function createWorkloadAdapters(repos: Repositories, engines: AdapterEngines): Record<'mission' | 'program' | 'arena' | 'workspace_mission' | 'background_job' | 'scheduled_audit', WorkloadAdapter> {
  const snapshotOf = (phase: WorkloadPhase, runIds: (string | null | undefined)[], detail: string | null): WorkloadSnapshot => {
    const ids = [...new Set(runIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    return { phase, activeAgents: activeAgentsOf(repos, ids), runIds: ids, detail }
  }

  const mission: WorkloadAdapter = {
    // A mission is created by the user in the composer; the queue adopts it once it runs.
    start: async (item) => {
      if (!item.refId) throw new NexusError('invalid_state', 'A mission is started from the composer, not from the queue.')
      const run = repos.runs.get(item.refId)
      if (run?.state === 'paused') await engines.orchestrator.resumeRun(item.refId)
      return item.refId
    },
    pause: async (id) => void (await engines.orchestrator.pauseRun(id)),
    resume: async (id) => void (await engines.orchestrator.resumeRun(id)),
    cancel: async (id) => void (await engines.orchestrator.cancelRun(id)),
    snapshot: (id) => {
      const run = repos.runs.get(id)
      if (!run) return MISSING
      const phase: WorkloadPhase =
        run.state === 'completed' ? 'completed' : run.state === 'failed' ? 'failed' : run.state === 'cancelled' ? 'cancelled' : run.state === 'paused' ? (run.pauseReason === 'quota' ? 'quota_wait' : 'paused') : 'working'
      const detail = run.state === 'awaiting_approval' ? 'Waiting for your approval of the plan.' : run.state === 'paused' ? `Paused (${run.pauseReason ?? 'user'}).` : run.state === 'failed' ? oneLine(run.error, 200) || null : null
      return snapshotOf(phase, [run.id], detail)
    },
    title: ({ refId }) => (refId ? oneLine(repos.runs.get(refId)?.prompt) || null : null),
    requestedAgents: ({ refId }) => (refId ? (repos.runs.get(refId)?.config.maxParallelAgents ?? engines.defaultAgents()) : engines.defaultAgents()),
  }

  const program: WorkloadAdapter = {
    start: async (item) => {
      if (!item.refId) throw new NexusError('invalid_state', 'The program does not exist.')
      const p = repos.programs.get(item.refId)
      if (!p) throw new NexusError('not_found', 'The program no longer exists.')
      if (p.state === 'DRAFT') await engines.programs.start(p.id)
      else if (p.state === 'PAUSED' || p.state === 'BLOCKED') await engines.programs.resume(p.id)
      return p.id
    },
    pause: async (id) => void (await engines.programs.pause(id)),
    resume: async (id) => void (await engines.programs.resume(id)),
    cancel: async (id) => void (await engines.programs.cancel(id)),
    snapshot: (id) => {
      const p = repos.programs.get(id)
      if (!p) return MISSING
      const phase: WorkloadPhase =
        p.state === 'DRAFT' ? 'not_started' : p.state === 'PAUSED' ? 'paused' : p.state === 'WAITING_FOR_QUOTA' ? 'quota_wait' : p.state === 'BLOCKED' ? 'blocked' : p.state === 'COMPLETED' ? 'completed' : p.state === 'CANCELLED' ? 'cancelled' : p.state === 'FAILED' ? 'failed' : 'working'
      const live = repos.programMissions.listByProgram(id).filter((m) => m.outcome === 'running').map((m) => m.runId)
      return snapshotOf(phase, [p.currentRunId, ...live], p.state === 'BLOCKED' ? oneLine(p.blockedReason, 200) || null : null)
    },
    title: ({ refId }) => (refId ? (repos.programs.get(refId)?.name ?? null) : null),
    // A program asks for what its own policy allows it to run at once.
    requestedAgents: ({ refId }) => (refId ? (repos.programs.get(refId)?.policy.maxAgents ?? engines.defaultAgents()) : engines.defaultAgents()),
  }

  const arena: WorkloadAdapter = {
    start: async (item) => {
      if (!item.refId) throw new NexusError('invalid_state', 'The campaign does not exist.')
      const c = repos.arenaCampaigns.get(item.refId)
      if (!c) throw new NexusError('not_found', 'The campaign no longer exists.')
      if (c.state === 'draft') await engines.arena.start(c.id)
      else if (c.state === 'paused') engines.arena.resume(c.id)
      return c.id
    },
    pause: async (id) => void engines.arena.pause(id),
    resume: async (id) => void engines.arena.resume(id),
    cancel: async (id) => void engines.arena.cancel(id),
    snapshot: (id) => {
      const c = repos.arenaCampaigns.get(id)
      if (!c) return MISSING
      const phase: WorkloadPhase =
        c.state === 'draft' ? 'not_started' : c.state === 'paused' ? (c.pauseReason === 'quota' ? 'quota_wait' : 'paused') : c.state === 'completed' ? 'completed' : c.state === 'cancelled' ? 'cancelled' : c.state === 'failed' ? 'failed' : 'working'
      const runs = repos.arenaTrials.listByCampaignStates(id, ['running']).map((t) => t.runId)
      return snapshotOf(phase, runs, c.state === 'failed' ? oneLine(c.error, 200) || null : c.state === 'paused' ? `Paused (${c.pauseReason ?? 'user'}).` : null)
    },
    title: ({ refId }) => (refId ? (repos.arenaCampaigns.get(refId)?.name ?? null) : null),
    requestedAgents: ({ refId }) => (refId ? (repos.arenaCampaigns.get(refId)?.budgets.maxAgentsPerTrial ?? engines.defaultAgents()) : engines.defaultAgents()),
  }

  const workspaceMission: WorkloadAdapter = {
    start: async (item) => {
      if (!item.refId) throw new NexusError('invalid_state', 'The workspace mission does not exist.')
      const m = repos.workspaceMissions.get(item.refId)
      if (!m) throw new NexusError('not_found', 'The workspace mission no longer exists.')
      if (m.state === 'DRAFT') await engines.workspaces.startMission(m.id)
      else if (m.state === 'PAUSED' || m.state === 'BLOCKED') await engines.workspaces.resumeMission(m.id)
      return m.id
    },
    pause: async (id) => void (await engines.workspaces.pauseMission(id)),
    resume: async (id) => void (await engines.workspaces.resumeMission(id)),
    cancel: async (id) => void (await engines.workspaces.cancelMission(id)),
    snapshot: (id) => {
      const m = repos.workspaceMissions.get(id)
      if (!m) return MISSING
      const phase: WorkloadPhase =
        m.state === 'DRAFT'
          ? 'not_started'
          : m.state === 'PAUSED'
            ? 'paused'
            : m.state === 'WAITING_FOR_QUOTA'
              ? 'quota_wait'
              : m.state === 'BLOCKED' || m.state === 'AWAITING_APPROVAL'
                ? 'blocked'
                : m.state === 'COMPLETED'
                  ? 'completed'
                  : m.state === 'CANCELLED'
                    ? 'cancelled'
                    : m.state === 'FAILED'
                      ? 'failed'
                      : 'working'
      const runs = [m.plannerRunId, ...repos.workspaceTasks.listByMission(id).filter((t) => t.state === 'RUNNING').map((t) => t.runId)]
      const detail = m.state === 'AWAITING_APPROVAL' ? 'The cross-repository plan is waiting for your approval.' : m.state === 'BLOCKED' ? oneLine(m.blockedReason, 200) || null : null
      return snapshotOf(phase, runs, detail)
    },
    title: ({ refId }) => (refId ? oneLine(repos.workspaceMissions.get(refId)?.goal) || null : null),
    requestedAgents: () => engines.defaultAgents(),
  }

  const audit: WorkloadAdapter = {
    start: async (item) => {
      if (item.refId) return item.refId
      const payload = item.payload as { projectId?: string; kind?: BackgroundJobKind } | null
      if (!payload?.projectId || !payload.kind) throw new NexusError('invalid_state', 'The audit has no project or kind.')
      return (await engines.background.start(payload.projectId, payload.kind)).id
    },
    pause: async () => {
      throw new NexusError('invalid_state', 'A background job cannot be paused; cancel it instead.')
    },
    resume: async () => undefined,
    cancel: async (id) => void (await engines.background.cancel(id)),
    snapshot: (id) => {
      const job = repos.backgroundJobs.get(id)
      if (!job) return MISSING
      const phase: WorkloadPhase = job.state === 'completed' ? 'completed' : job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' : 'working'
      return snapshotOf(phase, [job.runId], job.state === 'failed' ? oneLine(job.error, 200) || null : null)
    },
    title: ({ payload }) => {
      const p = payload as { projectId?: string; kind?: string } | null
      const project = p?.projectId ? repos.projects.get(p.projectId) : null
      return p?.kind ? `${p.kind.replace(/_/g, ' ')}${project ? ` of ${project.name}` : ''}` : null
    },
    requestedAgents: () => 1,
  }

  return { mission, program, arena, workspace_mission: workspaceMission, background_job: audit, scheduled_audit: audit }
}
