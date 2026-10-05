import type { QueryClient } from '@tanstack/react-query'
import { qk, useRead, useWrite } from './queries'

/** Hooks for the 0.5 Workspaces pages: workspaces, repositories, graph, contracts, missions, release trains. */

export const qkv5 = {
  root: () => ['workspaces'] as const,
  list: () => ['workspaces', 'list'] as const,
  detail: (workspaceId: string) => ['workspaces', 'detail', workspaceId] as const,
  mission: (missionId: string) => ['workspaces', 'mission', missionId] as const,
}

export const useWorkspaces = () => useRead(qkv5.list(), 'workspace.list', {})
export const useWorkspace = (workspaceId: string | null) =>
  useRead(qkv5.detail(workspaceId ?? ''), 'workspace.get', { workspaceId: workspaceId ?? '' }, !!workspaceId)
export const useWorkspaceMission = (missionId: string | null) =>
  useRead(qkv5.mission(missionId ?? ''), 'workspace.mission', { missionId: missionId ?? '' }, !!missionId)

/** Everything a workspace write can change hangs off one root, plus Home and the run lists (a mission starts runs). */
const refresh = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qkv5.root() })
  void qc.invalidateQueries({ queryKey: qk.homeRoot() })
  void qc.invalidateQueries({ queryKey: qk.runsRoot() })
}

export const useCreateWorkspace = () => useWrite('workspace.create', refresh)
export const useSetWorkspacePolicy = () => useWrite('workspace.setPolicy', refresh)
export const useRemoveWorkspace = () => useWrite('workspace.remove', refresh)
export const useEnrollRepository = () => useWrite('workspace.enroll', refresh)
export const useRefreshRepository = () => useWrite('workspace.refresh', refresh)
export const useUnenrollRepository = () => useWrite('workspace.unenroll', refresh)
export const useSetRepositoryRole = () => useWrite('workspace.setRole', refresh)
export const useDiscoverDependencies = () => useWrite('workspace.discover', refresh)
export const useAddDependency = () => useWrite('workspace.addDependency', refresh)
export const useRemoveDependency = () => useWrite('workspace.removeDependency', refresh)
export const useAddService = () => useWrite('workspace.addService', refresh)
export const useRegisterContract = () => useWrite('workspace.registerContract', refresh)
export const useAddConsumer = () => useWrite('workspace.addConsumer', refresh)
export const useCaptureContract = () => useWrite('workspace.captureContract', refresh)
export const useAddWorkspaceMemory = () => useWrite('workspace.addMemory', refresh)
export const useCreateWorkspaceMission = () => useWrite('workspace.createMission', refresh)
export const useStartWorkspaceMission = () => useWrite('workspace.startMission', refresh)
export const useDecideWorkspacePlan = () => useWrite('workspace.decidePlan', refresh)
export const usePauseWorkspaceMission = () => useWrite('workspace.pauseMission', refresh)
export const useResumeWorkspaceMission = () => useWrite('workspace.resumeMission', refresh)
export const useCancelWorkspaceMission = () => useWrite('workspace.cancelMission', refresh)
export const usePrepareRelease = () => useWrite('workspace.prepareRelease', refresh)
export const useCancelRelease = () => useWrite('workspace.cancelRelease', refresh)
