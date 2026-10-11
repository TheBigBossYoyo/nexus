import type { QueryClient } from '@tanstack/react-query'
import type { AutonomyProfile } from '@shared/autonomy'
import type { IpcInput } from '@shared/ipc'
import { useRead, useWrite } from './queries'

/** 0.8 autonomy: enrollment, grants and boundary requests. Everything here is invalidated by the `autonomy` push. */

export const qkAutonomy = {
  root: () => ['autonomy'] as const,
  status: () => ['autonomy', 'status'] as const,
  overview: (projectId: string, considering: AutonomyProfile | null) => ['autonomy', 'overview', projectId, considering] as const,
  pending: (projectId: string | null) => ['autonomy', 'pending', projectId] as const,
  recent: (projectId: string | null, limit: number) => ['autonomy', 'recent', projectId, limit] as const,
  audit: (input: IpcInput<'autonomy.audit'>) => ['autonomy', 'audit', input] as const,
}

export const RECENT_REQUESTS = 10

export const useAutonomyStatus = () => useRead(qkAutonomy.status(), 'autonomy.status', {})

export const useAutonomyOverview = (projectId: string | null, considering: AutonomyProfile | null = null) =>
  useRead(
    qkAutonomy.overview(projectId ?? '', considering),
    'autonomy.overview',
    { projectId: projectId ?? '', ...(considering ? { considering } : {}) },
    projectId !== null,
  )

export const usePendingBoundaryRequests = (projectId: string | null = null) =>
  useRead(qkAutonomy.pending(projectId), 'autonomy.pending', projectId ? { projectId } : {})

export const useRecentBoundaryRequests = (projectId: string | null = null, limit = RECENT_REQUESTS) =>
  useRead(qkAutonomy.recent(projectId, limit), 'autonomy.recent', { ...(projectId ? { projectId } : {}), limit })

export const useAutonomyAudit = (input: IpcInput<'autonomy.audit'> = {}, enabled = true) => useRead(qkAutonomy.audit(input), 'autonomy.audit', input, enabled)

const refresh = (qc: QueryClient): void => void qc.invalidateQueries({ queryKey: qkAutonomy.root() })

export const useEnrollProject = () => useWrite('autonomy.enroll', refresh)
export const useUnenrollProject = () => useWrite('autonomy.unenroll', refresh)
export const useResolveBoundaryRequest = () => useWrite('autonomy.resolve', refresh)
export const useRevokeGrant = () => useWrite('autonomy.revokeGrant', refresh)
