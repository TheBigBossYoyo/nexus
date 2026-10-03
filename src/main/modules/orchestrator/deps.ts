import type { PushMessage } from '@shared/events'
import type { AgentRuntime } from '@main/modules/agent-runtime/types'
import type { EventBus } from '@main/modules/events'
import type { GitService, WorktreeManager } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'

/** Everything the orchestration layer needs, injected so scenarios can run with a fake runtime. */
export interface OrchestratorDeps {
  repos: Repositories
  bus: EventBus
  runtime: AgentRuntime
  git: GitService
  worktrees: WorktreeManager
  /** Ephemeral main → renderer pushes (streaming output). Durable events go through the bus. */
  push: (message: PushMessage) => void
  logger?: (line: string) => void
}
