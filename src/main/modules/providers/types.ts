import type { ProviderId, ProviderStatus } from '@shared/provider'
import type { AgentRuntime, RuntimeUsageReport } from '@main/modules/agent-runtime'

/**
 * One agent runtime provider: how NEXUS finds out whether it is there, and the runtime that runs its sessions.
 * Discovery never reads a credential store and never sends a prompt: it asks the provider's own tool for its
 * version and its login state.
 */
export interface AgentRuntimeProvider {
  readonly id: ProviderId
  /** What is installed, signed in and supported, as of now. Never throws: a failure is a status. */
  discover(): Promise<ProviderStatus>
  /** The runtime that runs this provider's sessions, or null for a provider NEXUS only detects. */
  runtime(): AgentRuntime | null
  /** The model asked for when the policy names none; null when the runtime chooses. */
  defaultModel(): string | null
  /** Plan usage as the provider reports it without a prompt; null when it reports none. */
  usageReport(): Promise<RuntimeUsageReport | null>
  /**
   * One minimal real session ("reply OK") to find out whether the provider works end to end. Uses the
   * provider's quota, so it runs only when the user asks for it.
   */
  probe(): Promise<{ ok: boolean; detail: string }>
}

/** Runs a command with an argument array and a timeout; never through a shell with interpolated text. */
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }>
