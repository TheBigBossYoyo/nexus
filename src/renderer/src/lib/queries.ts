import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { MemoryScope } from '@shared/domain'
import { api, type IpcError } from './bridge'

/** Stable query keys. push.ts invalidates by these prefixes, so keep the first segments meaningful. */
export const qk = {
  appInfo: () => ['app', 'info'] as const,
  auth: () => ['auth', 'status'] as const,
  models: () => ['auth', 'models'] as const,
  settings: () => ['settings'] as const,
  projects: () => ['projects', 'list'] as const,
  project: (projectId: string) => ['projects', 'detail', projectId] as const,
  runsRoot: () => ['runs'] as const,
  runsList: () => ['runs', 'list'] as const,
  runs: (projectId: string | null) => ['runs', 'list', projectId ?? 'all'] as const,
  run: (runId: string) => ['runs', 'detail', runId] as const,
  runSummary: (runId: string) => ['runs', 'summary', runId] as const,
  runDiff: (runId: string) => ['runs', 'diff', runId] as const,
  recoverable: () => ['runs', 'recoverable'] as const,
  tasksRoot: () => ['tasks'] as const,
  taskDiff: (taskId: string) => ['tasks', 'diff', taskId] as const,
  taskReviews: (taskId: string) => ['tasks', 'reviews', taskId] as const,
  taskVerifications: (taskId: string) => ['tasks', 'verifications', taskId] as const,
  agent: (agentId: string) => ['agents', 'detail', agentId] as const,
  /** Prefix covering every output query of one agent (used for patching). */
  agentOutputRoot: (agentId: string) => ['agents', 'output', agentId] as const,
  agentOutput: (agentId: string, afterSeq?: number, limit?: number) =>
    ['agents', 'output', agentId, { afterSeq: afterSeq ?? null, limit: limit ?? null }] as const,
  agentTools: (agentId: string) => ['agents', 'tools', agentId] as const,
  messages: (runId: string, taskId?: string) => ['messages', runId, taskId ?? 'all'] as const,
  messagesRoot: (runId: string) => ['messages', runId] as const,
  eventsRoot: (runId: string) => ['events', runId] as const,
  events: (runId: string, afterSeq?: number, limit?: number) =>
    ['events', runId, { afterSeq: afterSeq ?? null, limit: limit ?? null }] as const,
  reviews: (runId: string) => ['reviews', runId] as const,
  verifications: (runId: string) => ['verifications', runId] as const,
  decisions: (runId: string) => ['decisions', runId] as const,
  approvals: () => ['approvals', 'pending'] as const,
  memoryRoot: () => ['memory'] as const,
  memory: (filter: MemoryFilter) =>
    ['memory', 'list', { projectId: filter.projectId ?? null, scope: filter.scope ?? null, query: filter.query ?? '' }] as const,
}

export interface MemoryFilter {
  projectId?: string | null
  scope?: MemoryScope | null
  query?: string
}

/** Reads. A null id disables the query. */
function useRead<C extends IpcChannel>(
  key: readonly unknown[],
  channel: C,
  input: IpcInput<C>,
  enabled = true,
) {
  return useQuery<IpcOutputs[C], IpcError>({
    queryKey: key,
    queryFn: () => api.invoke(channel, input),
    enabled,
  })
}

export const useAppInfo = () => useRead(qk.appInfo(), 'app.info', {})
export const useAuthStatus = () => useRead(qk.auth(), 'auth.status', {})
export const useModels = () => useRead(qk.models(), 'auth.models', {})
export const useSettings = () => useRead(qk.settings(), 'settings.get', {})
export const useProjects = () => useRead(qk.projects(), 'projects.list', {})
export const useProject = (projectId: string | null) =>
  useRead(qk.project(projectId ?? ''), 'projects.get', { projectId: projectId ?? '' }, projectId !== null)
export const useRuns = (projectId: string | null = null) =>
  useRead(qk.runs(projectId), 'runs.list', projectId ? { projectId } : {})
export const useRunDetail = (runId: string | null) =>
  useRead(qk.run(runId ?? ''), 'runs.get', { runId: runId ?? '' }, runId !== null)
export const useRunSummary = (runId: string | null) =>
  useRead(qk.runSummary(runId ?? ''), 'runs.summary', { runId: runId ?? '' }, runId !== null)
export const useRunDiff = (runId: string | null, enabled = true) =>
  useRead(qk.runDiff(runId ?? ''), 'runs.diff', { runId: runId ?? '' }, runId !== null && enabled)
export const useRecoverableRuns = () => useRead(qk.recoverable(), 'runs.recoverable', {})
export const useTaskDiff = (taskId: string | null, enabled = true) =>
  useRead(qk.taskDiff(taskId ?? ''), 'tasks.diff', { taskId: taskId ?? '' }, taskId !== null && enabled)
/** Diffs of several tasks at once (same cache entries as useTaskDiff). */
export const useTaskDiffs = (taskIds: readonly string[], enabled = true) =>
  useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: qk.taskDiff(taskId),
      queryFn: () => api.invoke('tasks.diff', { taskId }),
      enabled,
    })),
  })
export const useTaskReviews = (taskId: string | null) =>
  useRead(qk.taskReviews(taskId ?? ''), 'tasks.reviews', { taskId: taskId ?? '' }, taskId !== null)
export const useTaskVerifications = (taskId: string | null) =>
  useRead(qk.taskVerifications(taskId ?? ''), 'tasks.verifications', { taskId: taskId ?? '' }, taskId !== null)
export const useAgentDetail = (agentId: string | null) =>
  useRead(qk.agent(agentId ?? ''), 'agents.get', { agentId: agentId ?? '' }, agentId !== null)
export const useAgentOutput = (agentId: string | null, opts: { afterSeq?: number; limit?: number } = {}) =>
  useRead(
    qk.agentOutput(agentId ?? '', opts.afterSeq, opts.limit),
    'agents.output',
    { agentId: agentId ?? '', ...opts },
    agentId !== null,
  )
export const useAgentTools = (agentId: string | null) =>
  useRead(qk.agentTools(agentId ?? ''), 'agents.tools', { agentId: agentId ?? '' }, agentId !== null)
export const useMessages = (runId: string | null, taskId?: string) =>
  useRead(
    qk.messages(runId ?? '', taskId),
    'messages.list',
    taskId ? { runId: runId ?? '', taskId } : { runId: runId ?? '' },
    runId !== null,
  )
export const useEvents = (runId: string | null, opts: { afterSeq?: number; limit?: number } = {}) =>
  useRead(qk.events(runId ?? '', opts.afterSeq, opts.limit), 'events.list', { runId: runId ?? '', ...opts }, runId !== null)
export const useReviews = (runId: string | null) =>
  useRead(qk.reviews(runId ?? ''), 'reviews.list', { runId: runId ?? '' }, runId !== null)
export const useVerifications = (runId: string | null) =>
  useRead(qk.verifications(runId ?? ''), 'verifications.list', { runId: runId ?? '' }, runId !== null)
export const useDecisions = (runId: string | null) =>
  useRead(qk.decisions(runId ?? ''), 'decisions.list', { runId: runId ?? '' }, runId !== null)
export const usePendingApprovals = () => useRead(qk.approvals(), 'approvals.pending', {})
export const useMemory = (filter: MemoryFilter = {}) => {
  const input: IpcInput<'memory.list'> = {}
  if (filter.projectId) input.projectId = filter.projectId
  if (filter.scope) input.scope = filter.scope
  if (filter.query) input.query = filter.query
  return useRead(qk.memory(filter), 'memory.list', input)
}

// ───────────────────────────── mutations ─────────────────────────────

type AfterSuccess<C extends IpcChannel> = (qc: QueryClient, output: IpcOutputs[C], input: IpcInput<C>) => void

/** Errors surface as toasts through the QueryClient's MutationCache (see queryClient.ts). */
function useWrite<C extends IpcChannel>(channel: C, after?: AfterSuccess<C>) {
  const qc = useQueryClient()
  return useMutation<IpcOutputs[C], IpcError, IpcInput<C>>({
    mutationFn: (input) => api.invoke(channel, input),
    onSuccess: (output, input) => after?.(qc, output, input),
  })
}

const refreshRuns = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qk.runsRoot() })
  void qc.invalidateQueries({ queryKey: qk.approvals() })
}
const refreshTasks = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qk.tasksRoot() })
  refreshRuns(qc)
}
const refreshProjects = (qc: QueryClient) => void qc.invalidateQueries({ queryKey: ['projects'] })

export const useRefreshAuth = () => {
  const qc = useQueryClient()
  return useMutation<IpcOutputs['auth.status'], IpcError, void>({
    mutationFn: () => api.invoke('auth.status', { refresh: true }),
    onSuccess: (status) => {
      qc.setQueryData(qk.auth(), status)
      void qc.invalidateQueries({ queryKey: qk.models() })
    },
  })
}
export const useUpdateSettings = () =>
  useWrite('settings.update', (qc, settings) => {
    qc.setQueryData(qk.settings(), settings)
    void qc.invalidateQueries({ queryKey: qk.auth() })
  })
export const useOpenDataDir = () => useWrite('app.openDataDir')

export const useOpenProject = () => useWrite('projects.open', refreshProjects)
export const useReprofileProject = () => useWrite('projects.reprofile', refreshProjects)
export const useUpdateProject = () => useWrite('projects.update', refreshProjects)
export const useRemoveProject = () =>
  useWrite('projects.remove', (qc) => {
    refreshProjects(qc)
    refreshRuns(qc)
  })

export const useCreateRun = () => useWrite('runs.create', refreshRuns)
export const useApprovePlan = () => useWrite('runs.approvePlan', refreshRuns)
export const useReplan = () => useWrite('runs.replan', refreshRuns)
export const usePauseRun = () => useWrite('runs.pause', refreshRuns)
export const useResumeRun = () => useWrite('runs.resume', refreshRuns)
export const useCancelRun = () => useWrite('runs.cancel', refreshRuns)
export const useRecoverRun = () => useWrite('runs.recover', refreshRuns)
export const useCleanupRun = () => useWrite('runs.cleanup', refreshRuns)

export const useRetryTask = () => useWrite('tasks.retry', refreshTasks)
export const useCancelTask = () => useWrite('tasks.cancel', refreshTasks)
export const useSetTaskPriority = () => useWrite('tasks.setPriority', refreshTasks)
export const useAddTask = () => useWrite('tasks.add', refreshTasks)
export const useInstructTask = () =>
  useWrite('tasks.instruct', (qc) => void qc.invalidateQueries({ queryKey: ['messages'] }))
export const useResolveBlocker = () => useWrite('tasks.resolveBlocker', refreshTasks)
export const useUpdateCriterion = () => useWrite('criteria.update', refreshRuns)

export const useStopAgent = () =>
  useWrite('agents.stop', (qc) => {
    void qc.invalidateQueries({ queryKey: ['agents'] })
    refreshRuns(qc)
  })
export const useResolveApproval = () => useWrite('approvals.resolve', refreshRuns)

export const useAddMemory = () =>
  useWrite('memory.add', (qc) => void qc.invalidateQueries({ queryKey: qk.memoryRoot() }))
export const useSetMemoryStatus = () =>
  useWrite('memory.setStatus', (qc) => void qc.invalidateQueries({ queryKey: qk.memoryRoot() }))
export const useDeleteMemory = () =>
  useWrite('memory.delete', (qc) => void qc.invalidateQueries({ queryKey: qk.memoryRoot() }))
