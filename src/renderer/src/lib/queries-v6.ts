import type { QueryClient } from '@tanstack/react-query'
import { useRead, useWrite } from './queries'

/** Hooks for the 0.6 Providers page and the provider line of the mission inspector. */

export const qkv6 = {
  root: () => ['providers'] as const,
  overview: () => ['providers', 'overview'] as const,
  sessions: (runId: string) => ['providers', 'sessions', runId] as const,
}

export const useProvidersOverview = () => useRead(qkv6.overview(), 'providers.overview', {})
export const useProviderSessions = (runId: string | null) => useRead(qkv6.sessions(runId ?? ''), 'providers.sessions', { runId: runId ?? '' }, !!runId)

const refresh = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qkv6.root() })
}

export const useRefreshProviders = () => useWrite('providers.refresh', refresh)
export const useSetProviderPolicy = () => useWrite('providers.setPolicy', refresh)
export const useProbeProvider = () => useWrite('providers.probe', refresh)
