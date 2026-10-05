import { useQuery } from '@tanstack/react-query'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { api, type IpcError } from './bridge'
import { qk } from './queries'

/**
 * 0.3 read hooks used by Mission Control, the task inspector and the mission composer.
 * Every consumer must degrade to a calm empty state on error: usage.* and policy.* may answer
 * `runtime_unavailable` while the backend is wired up.
 */
function useReadRun<C extends IpcChannel>(key: readonly unknown[], channel: C, input: IpcInput<C>, enabled = true) {
  return useQuery<IpcOutputs[C], IpcError>({
    queryKey: key,
    queryFn: () => api.invoke(channel, input),
    enabled,
    retry: false,
  })
}

export const useRunPolicy = (runId: string | null) =>
  useReadRun([...qk.policyRoot(), 'run', runId ?? ''], 'policy.run', { runId: runId ?? '' }, runId !== null)

export const useRunUsage = (runId: string | null, enabled = true) =>
  useReadRun([...qk.usageRoot(), 'run', runId ?? ''], 'usage.run', { runId: runId ?? '' }, runId !== null && enabled)

export const useSpeculative = (runId: string | null) =>
  useReadRun(qk.speculative(runId ?? ''), 'speculative.list', { runId: runId ?? '' }, runId !== null)

/** What ADAPTIVE would choose for this prompt. Pass an already-debounced prompt; empty disables the query. */
export const usePolicyPreview = (projectId: string | null, prompt: string) => {
  const trimmed = prompt.trim()
  return useReadRun(
    [...qk.policyRoot(), 'preview', projectId ?? '', trimmed],
    'policy.preview',
    { projectId: projectId ?? '', prompt: trimmed },
    projectId !== null && trimmed.length > 0,
  )
}
