import type { AgentRuntime, AgentSessionHandle, SessionSpec } from '@main/modules/agent-runtime/types'
import type { WorkerManager } from './manager'

/**
 * A provider's runtime whose sessions run in worker processes. Questions about the account, the models and the
 * plan windows are still answered by the runtime in this process: they start no session and hold no work.
 */
export function hostInWorkers(provider: string, local: AgentRuntime, manager: WorkerManager): AgentRuntime {
  const start = (spec: SessionSpec): AgentSessionHandle => manager.startSession(provider, spec)
  return {
    startSession: start,
    resumeSession: (spec, sdkSessionId) => start({ ...spec, resumeSessionId: sdkSessionId }),
    sendMessage: (handle, text) => handle.send(text),
    interruptSession: (handle) => handle.interrupt(),
    stopSession: (handle) => handle.stop(),
    getCapabilities: () => local.getCapabilities(),
    getAccountInfo: (options) => local.getAccountInfo(options),
    ...(local.getUsageReport ? { getUsageReport: (options: { subscriptionMode: boolean }) => (local.getUsageReport as NonNullable<AgentRuntime['getUsageReport']>)(options) } : {}),
    // The sessions belong to the worker manager, which is stopped by the runtime after the orchestrator.
    shutdown: () => local.shutdown(),
  }
}
