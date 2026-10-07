import { useRead } from './queries'

/** Hooks for the 0.7 Control Center. Writes use `useWrite` with the channel directly and invalidate this root. */

export const qkControl = {
  root: () => ['control'] as const,
  overview: () => ['control', 'overview'] as const,
}

export const useControlOverview = () => useRead(qkControl.overview(), 'control.overview', {})

/** The runtime's own state: identity, workers and leases. Invalidated by the `runtime` push. */
export const qkRuntime = {
  root: () => ['runtime'] as const,
  status: () => ['runtime', 'status'] as const,
  workers: () => ['runtime', 'workers'] as const,
}
export const useRuntimeStatus = (enabled = true) => useRead(qkRuntime.status(), 'runtime.status', {}, enabled)
export const useRuntimeWorkers = (enabled = true) => useRead(qkRuntime.workers(), 'runtime.workers', {}, enabled)
export const useItemDecisions = (itemId: string | null) =>
  useRead(['control', 'decisions', itemId ?? ''], 'control.decisions', { itemId: itemId ?? '' }, itemId !== null)
