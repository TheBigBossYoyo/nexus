import { MutationCache, QueryClient } from '@tanstack/react-query'
import { BRIDGE_UNAVAILABLE, IpcError } from './bridge'
import { toast } from '../store/toasts'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (mutation.meta?.silent) return
        toast.error(error instanceof IpcError ? `${error.channel}: ${error.message}` : error.message)
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // Main-process errors are deterministic; only retry when the bridge itself hiccuped.
        retry: (count, error) => !(error instanceof IpcError) || (error.code === 'ipc_failure' && count < 1),
      },
    },
  })
}

export function isBridgeMissing(error: unknown): boolean {
  return error instanceof IpcError && error.code === BRIDGE_UNAVAILABLE
}
