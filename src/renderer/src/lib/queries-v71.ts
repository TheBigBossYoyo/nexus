import type { ContextSpace } from '@shared/context-graph'
import type { IpcInput } from '@shared/ipc'
import { useRead, useWrite } from './queries'

/** Hooks for the 0.7.1 Context view and the token figures. */

export const qkKnowledge = {
  root: () => ['knowledge'] as const,
  health: (projectId: string) => ['knowledge', 'health', projectId] as const,
  tree: (projectId: string, space: string, parentId: string | null, history: boolean) => ['knowledge', 'tree', projectId, space, parentId, history] as const,
  node: (projectId: string, nodeId: string, history: boolean) => ['knowledge', 'node', projectId, nodeId, history] as const,
  search: (projectId: string, query: string, history: boolean) => ['knowledge', 'search', projectId, query, history] as const,
}

export const qkTokens = {
  root: () => ['tokens'] as const,
  overview: (days: number) => ['tokens', 'overview', days] as const,
  agent: (agentId: string) => ['tokens', 'agent', agentId] as const,
}

export const useKnowledgeHealth = (projectId: string | null) => useRead(qkKnowledge.health(projectId ?? ''), 'knowledge.health', { projectId: projectId ?? '' }, projectId !== null)

/** One level of the tree: the children of `parentId`, or of the root when it is null. */
export const useKnowledgeTree = (projectId: string | null, space: ContextSpace | null, parentId: string | null, includeHistory: boolean, enabled = true) => {
  const input: IpcInput<'knowledge.tree'> = { projectId: projectId ?? '', includeHistory }
  if (space) input.space = space
  if (parentId) input.parentId = parentId
  return useRead(qkKnowledge.tree(projectId ?? '', space ? `${space.kind}:${space.id}` : '', parentId, includeHistory), 'knowledge.tree', input, projectId !== null && space !== null && enabled)
}

export const useKnowledgeNode = (projectId: string | null, nodeId: string | null, includeHistory: boolean) =>
  useRead(qkKnowledge.node(projectId ?? '', nodeId ?? '', includeHistory), 'knowledge.node', { projectId: projectId ?? '', nodeId: nodeId ?? '', includeHistory }, projectId !== null && nodeId !== null)

export const useKnowledgeSearch = (projectId: string | null, query: string, includeHistory: boolean) =>
  useRead(qkKnowledge.search(projectId ?? '', query, includeHistory), 'knowledge.search', { projectId: projectId ?? '', query: query || 'x', includeHistory }, projectId !== null && query.length > 0)

const refreshKnowledge = (qc: Parameters<NonNullable<Parameters<typeof useWrite>[1]>>[0]): void => void qc.invalidateQueries({ queryKey: qkKnowledge.root() })

export const useKnowledgeRefresh = () => useWrite('knowledge.refresh', refreshKnowledge)
export const useKnowledgeConfirm = () => useWrite('knowledge.confirm', refreshKnowledge)
export const useKnowledgeWriteNote = () => useWrite('knowledge.writeNote', refreshKnowledge)
export const useKnowledgePromote = () => useWrite('knowledge.promote', refreshKnowledge)
export const useKnowledgeArchive = () => useWrite('knowledge.archive', refreshKnowledge)

export const useTokenOverview = (days: number) => useRead(qkTokens.overview(days), 'tokens.overview', { days })
export const useAgentTokens = (agentId: string | null) => useRead(qkTokens.agent(agentId ?? ''), 'tokens.agent', { agentId: agentId ?? '' }, agentId !== null)
