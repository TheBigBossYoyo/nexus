import type { MemoryEntry, Run, Task } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { OrchestratorDeps } from './deps'

export interface ProposeMemoryInput {
  run: Run
  taskId: string | null
  agentId: string | null
  source: string
  title: string
  content: string
  evidence: string
  tags: string[]
  filePaths: string[]
}

/**
 * Project memory with provenance. Agents can only propose; an entry reaches other agents' context
 * once it is approved (by the user, or automatically after a verifier pass when configured).
 */
export class MemoryService {
  constructor(private readonly deps: Pick<OrchestratorDeps, 'repos' | 'bus'>) {}

  propose(input: ProposeMemoryInput): MemoryEntry {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const entry = repos.memory.insert({
        id: newId(),
        scope: 'project',
        projectId: input.run.projectId,
        runId: input.run.id,
        taskId: input.taskId,
        agentId: input.agentId,
        kind: 'fact',
        title: input.title,
        content: input.content,
        tags: input.tags,
        filePaths: input.filePaths,
        source: input.source,
        evidence: input.evidence,
        status: 'proposed',
        createdAt: nowIso(),
      })
      bus.emit({
        runId: input.run.id,
        taskId: input.taskId,
        agentId: input.agentId,
        type: 'memory.proposed',
        payload: { memoryId: entry.id, title: entry.title },
      })
      return entry
    })
  }

  /** Approve entries proposed while working on a task that has now passed verification. */
  promoteForTask(run: Run, taskId: string): number {
    const { repos, bus } = this.deps
    if (!repos.settings.get().memory.autoApproveVerifierMemory) return 0
    const proposed = repos.memory
      .list({ projectId: run.projectId, runId: run.id, status: 'proposed' })
      .filter((m) => m.taskId === taskId)
    for (const entry of proposed) {
      bus.transaction(() => {
        repos.memory.update(entry.id, { status: 'approved' })
        bus.emit({ runId: run.id, taskId, type: 'memory.promoted', payload: { memoryId: entry.id } })
      })
    }
    return proposed.length
  }

  /** Approved entries relevant to a task, found by full-text search over its title and files. */
  relevantFor(run: Run, task: Pick<Task, 'title' | 'description' | 'suggestedFiles'>): MemoryEntry[] {
    const { repos } = this.deps
    const settings = repos.settings.get().memory
    if (!settings.enabled || settings.maxEntriesPerContext === 0) return []
    const query = [task.title, task.description.slice(0, 300), ...task.suggestedFiles].join(' ')
    return repos.memory.search(query, {
      projectId: run.projectId,
      runId: run.id,
      limit: settings.maxEntriesPerContext,
    })
  }
}
