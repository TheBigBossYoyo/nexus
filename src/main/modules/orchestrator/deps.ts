import type { PushMessage } from '@shared/events'
import type { AgentRuntime } from '@main/modules/agent-runtime/types'
import type { ContextGraphService } from '@main/modules/context-graph'
import type { TokenIntelligenceEngine } from '@main/modules/token'
import type { EventBus } from '@main/modules/events'
import type { GitService, WorktreeManager } from '@main/modules/git'
import type { Preset, Project } from '@shared/domain'
import type { Repositories } from '@main/modules/persistence'
import type { StrategyPlan } from '@main/modules/strategy/strategies'
import type { PolicyDecision, RunStrategyInfo, Strategy, TaskProfile } from '@shared/v3'
import type { AgentRole } from '@shared/domain'
import type { AutonomyGate } from '@main/modules/autonomy/gate'

/**
 * v0.3: resolves the strategy of a new run. Implemented by the policy service; absent in processes that
 * have none (older scenario tests), where a concrete strategy is configured directly.
 */
export interface StrategyResolver {
  decideForRun(input: {
    project: Project
    prompt: string
    runId: string
    preset: Preset
    requested: Strategy
    candidates?: number
    arenaTrialId?: string | null
  }): { profile: TaskProfile; decision: PolicyDecision | null; plan: StrategyPlan; info: RunStrategyInfo }
}

/** Everything the orchestration layer needs, injected so scenarios can run with a fake runtime. */
export interface OrchestratorDeps {
  /** Production recovery/dispatch requires canonical admission; isolated legacy scenarios opt in. */
  requireEngineeringAdmission?: boolean
  repos: Repositories
  bus: EventBus
  runtime: AgentRuntime
  git: GitService
  worktrees: WorktreeManager
  /** Ephemeral main → renderer pushes (streaming output). Durable events go through the bus. */
  push: (message: PushMessage) => void
  logger?: (line: string) => void
  /**
   * v0.7.2: asked before a task held for a provider's capacity is given a new session. Absent where no
   * admission stands in front of the runtime: the task is then simply tried again after its delay.
   */
  capacityReady?: (taskId: string) => Promise<boolean>
  /** v0.3. See StrategyResolver. */
  strategies?: StrategyResolver
  /**
   * 0.8: the capability gate of a session in an enrolled project; undefined for a project that is not enrolled,
   * whose sessions ask the user as in 0.7. Absent where no autonomy service exists (older scenario tests).
   */
  autonomy?: { gateFor(session: { projectId: string; runId: string | null; taskId: string | null; role: AgentRole; provider: string | null; cwd: string | null }): AutonomyGate | undefined }
  /** v0.7.1. Created from `repos` when absent, so every orchestrator has both. */
  contextGraph?: ContextGraphService
  tokens?: TokenIntelligenceEngine
}
