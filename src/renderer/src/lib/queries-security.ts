import { useInfiniteQuery } from '@tanstack/react-query'
import type { IpcOutputs } from '@shared/ipc'
import { api, type IpcError } from './bridge'

/** 0.7: the execution security decision log. Read-only and paged by a cursor from the main process. */

export const SECURITY_PAGE = 30

export const qkSecurity = {
  decisions: (runId: string | null) => ['security', 'decisions', runId] as const,
}

export function useSecurityDecisions(runId: string | null = null) {
  return useInfiniteQuery<IpcOutputs['security.decisions'], IpcError, { pages: IpcOutputs['security.decisions'][] }, readonly unknown[], number | undefined>({
    queryKey: qkSecurity.decisions(runId),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      api.invoke('security.decisions', { ...(runId === null ? {} : { runId }), limit: SECURITY_PAGE, ...(pageParam === undefined ? {} : { before: pageParam }) }),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  })
}
