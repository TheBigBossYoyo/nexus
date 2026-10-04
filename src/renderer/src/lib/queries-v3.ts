import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { IpcOutputs } from '@shared/ipc'
import type { UsageGrouping } from '@shared/v3'
import { api, BRIDGE_UNAVAILABLE, IpcError } from './bridge'
import { qk, useRead, useWrite } from './queries'

/** Hooks for the 0.3 Intelligence pages (Usage, Arena, Policy). All lists are paged in the main process. */

/** The 0.3 service is not wired in this build or process: pages show their calm empty/unknown state, not an error. */
export const isNotWired = (e: unknown): boolean =>
  e instanceof IpcError && (e.code === 'runtime_unavailable' || e.code === BRIDGE_UNAVAILABLE)

export const LIMIT_PAGE = 20
export const TRIAL_PAGE = 50
export const CAMPAIGN_PAGE = 25
export const DECISION_PAGE = 30

export const qkv3 = {
  usageBreakdown: (by: UsageGrouping, sinceDays: number) =>
    ['usage', 'breakdown', by, sinceDays] as const,
  usageRun: (runId: string) => ['usage', 'run', runId] as const,
  usageLimits: () => ['usage', 'limitHistory', 'paged'] as const,
  arenaCampaignsPaged: () => ['arena', 'campaigns', 'paged'] as const,
  arenaTrials: (campaignId: string, offset: number) =>
    ['arena', 'trials', campaignId, offset] as const,
  arenaTrial: (trialId: string) => ['arena', 'trial', trialId] as const,
  policySnapshot: (snapshotId: string) => ['policy', 'snapshot', snapshotId] as const,
  policyCompare: (a: string, b: string) => ['policy', 'compare', a, b] as const,
  policyDecisionsPaged: () => ['policy', 'decisions', 'paged'] as const,
}

// ───────────────────────────── usage ─────────────────────────────

export const useUsageBreakdown = (by: UsageGrouping, sinceDays: number) =>
  useRead(qkv3.usageBreakdown(by, sinceDays), 'usage.breakdown', { by, sinceDays })

export const useRunUsage = (runId: string | null) =>
  useRead(qkv3.usageRun(runId ?? ''), 'usage.run', { runId: runId ?? '' }, !!runId)

export const useUsageEfficiency = () => useRead(qk.usageEfficiency(), 'usage.efficiency', {})

/** Limit history is two parallel lists (events, pauses) on one offset; "Load older" fetches the next offset. */
export function useUsageLimitHistory() {
  return useInfiniteQuery<IpcOutputs['usage.limitHistory'], IpcError>({
    queryKey: qkv3.usageLimits(),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.invoke('usage.limitHistory', { limit: LIMIT_PAGE, offset: pageParam as number }),
    getNextPageParam: (last, all) =>
      last.events.length >= LIMIT_PAGE || last.pauses.length >= LIMIT_PAGE
        ? all.length * LIMIT_PAGE
        : undefined,
  })
}

// ───────────────────────────── arena ─────────────────────────────

export const useArenaCases = () => useRead(qk.arenaCases(), 'arena.cases', {})

export function useArenaCampaigns() {
  return useInfiniteQuery<IpcOutputs['arena.campaigns'], IpcError>({
    queryKey: qkv3.arenaCampaignsPaged(),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.invoke('arena.campaigns', { limit: CAMPAIGN_PAGE, offset: pageParam as number }),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.campaigns.length, 0)
      return loaded < last.total && last.campaigns.length > 0 ? loaded : undefined
    },
  })
}

export const useArenaCampaign = (campaignId: string | null) =>
  useRead(
    qk.arenaCampaign(campaignId ?? ''),
    'arena.campaign',
    { campaignId: campaignId ?? '' },
    !!campaignId,
  )

export const useArenaResults = (campaignId: string | null = null) =>
  useRead(qk.arenaResults(campaignId), 'arena.results', campaignId ? { campaignId } : {})

export const useArenaTrials = (campaignId: string | null, page: number) =>
  useQuery<IpcOutputs['arena.trials'], IpcError>({
    queryKey: qkv3.arenaTrials(campaignId ?? '', page),
    queryFn: () =>
      api.invoke('arena.trials', {
        campaignId: campaignId ?? '',
        limit: TRIAL_PAGE,
        offset: page * TRIAL_PAGE,
      }),
    enabled: !!campaignId,
    placeholderData: (prev) => prev,
  })

export const useArenaTrial = (trialId: string | null) =>
  useRead(qkv3.arenaTrial(trialId ?? ''), 'arena.trial', { trialId: trialId ?? '' }, !!trialId)

const refreshArena = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qk.arenaRoot() })
  void qc.invalidateQueries({ queryKey: qk.homeRoot() })
}
export const useCreateCampaign = () => useWrite('arena.createCampaign', refreshArena)
export const useStartCampaign = () => useWrite('arena.start', refreshArena)
export const usePauseCampaign = () => useWrite('arena.pause', refreshArena)
export const useResumeCampaign = () => useWrite('arena.resume', refreshArena)
export const useCancelCampaign = () => useWrite('arena.cancel', refreshArena)
export const useImportCase = () =>
  useWrite('arena.importCase', (qc) => void qc.invalidateQueries({ queryKey: qk.arenaCases() }))
export const useTrustCase = () =>
  useWrite('arena.trustCase', (qc) => void qc.invalidateQueries({ queryKey: qk.arenaCases() }))

// ───────────────────────────── policy ─────────────────────────────

export const usePolicyOverview = () => useRead(qk.policyOverview(), 'policy.overview', {})

export const usePolicySnapshot = (snapshotId: string | null) =>
  useRead(
    qkv3.policySnapshot(snapshotId ?? ''),
    'policy.snapshot',
    { snapshotId: snapshotId ?? '' },
    !!snapshotId,
  )

export const usePolicyCompare = (a: string | null, b: string | null) =>
  useRead(
    qkv3.policyCompare(a ?? '', b ?? ''),
    'policy.compare',
    { a: a ?? '', b: b ?? '' },
    !!a && !!b && a !== b,
  )

export function usePolicyDecisions() {
  return useInfiniteQuery<IpcOutputs['policy.decisions'], IpcError>({
    queryKey: qkv3.policyDecisionsPaged(),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.invoke('policy.decisions', { limit: DECISION_PAGE, offset: pageParam as number }),
    getNextPageParam: (last, all) =>
      last.length >= DECISION_PAGE ? all.length * DECISION_PAGE : undefined,
  })
}

/** Every policy write answers with the new overview, which replaces the cached one. */
const applyPolicy = (qc: QueryClient, overview: IpcOutputs['policy.overview']) => {
  qc.setQueryData(qk.policyOverview(), overview)
  void qc.invalidateQueries({ queryKey: qk.policyRoot() })
  void qc.invalidateQueries({ queryKey: qk.homeRoot() })
}
export const usePromoteCandidate = () => useWrite('policy.promote', applyPolicy)
export const useRejectCandidate = () => useWrite('policy.reject', applyPolicy)
export const useRollbackPolicy = () => useWrite('policy.rollback', applyPolicy)
export const usePinSnapshot = () => useWrite('policy.pin', applyPolicy)
export const useSetPolicyConfig = () => useWrite('policy.setConfig', applyPolicy)
export const useLearn = () =>
  useWrite('policy.learn', (qc) => {
    void qc.invalidateQueries({ queryKey: qk.policyRoot() })
    void qc.invalidateQueries({ queryKey: qk.homeRoot() })
  })

/** Lets a page wait for a refetch of everything under a root, e.g. after "Refresh". */
export function useInvalidateRoot() {
  const qc = useQueryClient()
  return (root: readonly unknown[]) => void qc.invalidateQueries({ queryKey: root })
}
