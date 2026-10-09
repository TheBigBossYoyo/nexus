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
  /** v0.3. See StrategyResolver. */
  strategies?: StrategyResolver
  /** v0.7.1. Created from `repos` when absent, so every orchestrator has both. */
  contextGraph?: ContextGraphService
  tokens?: TokenIntelligenceEngine
}
