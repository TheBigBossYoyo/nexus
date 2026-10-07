import type { ContextSpace } from '@shared/context-graph'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import { AUTO_DEFAULTS, techniqueEnabled, type Technique, type TokenOverview } from '@shared/token'
import { ContextGraphService } from '@main/modules/context-graph'
import type { GitService } from '@main/modules/git/git-service'
import type { Repositories } from '@main/modules/persistence'
import { composition } from '@main/modules/token'

type Channel = Extract<IpcChannel, `knowledge.${string}` | `tokens.${string}`>
export type V71Handlers = { [C in Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

const DAY_MS = 86_400_000
const TECHNIQUES: Technique[] = ['stablePrefix', 'contextGraph', 'toolLoading', 'outputFiltering', 'pressureRotation']

/**
 * v0.7.1 channels: the Context Graph (browse, search, the few writes a user may make) and the token figures.
 * Every graph call names a project; what it may read is that project's graph and the graphs of the
 * workspaces that enrol it. The renderer never receives the whole graph: listings are paged.
 */
export function createV71Handlers(ctx: { repos: Repositories; git: GitService }): V71Handlers {
  const { repos } = ctx
  const graph = new ContextGraphService({ repos })
  const spacesOf = (projectId: string): ContextSpace[] => {
    repos.projects.require(projectId)
    return graph.spacesForProject(projectId)
  }
  const spaceOf = (projectId: string, space: { kind: 'project' | 'workspace'; id: string } | undefined): { space: ContextSpace; allowed: ContextSpace[] } => {
    const allowed = spacesOf(projectId)
    const wanted = space ?? { kind: 'project' as const, id: projectId }
    const found = allowed.find((s) => s.kind === wanted.kind && s.id === wanted.id)
    if (!found) throw new NexusError('not_found', 'That graph is not part of this project')
    return { space: found, allowed }
  }
  /** Notes are the only nodes a user edits here; everything else changes in the store that owns it. */
  const noteOf = (projectId: string, nodeId: string) => {
    const node = graph.getNode(nodeId, spacesOf(projectId))
    return node
  }

  return {
    'knowledge.health': ({ projectId }) => {
      const spaces = spacesOf(projectId)
      const settings = repos.settings.get().tokens
      return {
        spaces: spaces.map((space) => ({
          space,
          name: space.kind === 'project' ? (repos.projects.get(space.id)?.name ?? 'Project') : (repos.workspaces.get(space.id)?.name ?? 'Workspace'),
          health: graph.root(space) ? graph.health(space) : null,
          refreshes: repos.contextGraph.jobs.list(space, 5),
        })),
        enabled: techniqueEnabled(settings, 'contextGraph'),
        setting: settings.contextGraph,
      }
    },
    'knowledge.tree': ({ projectId, space, parentId, includeHistory, offset }) => {
      const { space: s, allowed } = spaceOf(projectId, space)
      const parent = parentId ? graph.getNode(parentId, allowed) : graph.root(s)
      if (!parent) return { parent: null, children: [], total: 0, childCounts: {} }
      const { children, total } = graph.getChildren(parent.id, allowed, { includeHistory: includeHistory ?? false, limit: 200, offset: offset ?? 0 })
      const childCounts: Record<string, number> = {}
      for (const c of children) childCounts[c.id] = repos.contextGraph.nodes.countChildren(c.id, includeHistory ? ['CURRENT', 'STALE', 'CONFLICTED', 'SUPERSEDED', 'ARCHIVED', 'PROPOSED'] : undefined)
      return { parent, children, total, childCounts }
    },
    'knowledge.node': ({ projectId, nodeId, includeHistory }) => graph.detail(nodeId, spacesOf(projectId), { includeHistory: includeHistory ?? false }),
    'knowledge.search': ({ projectId, query, includeHistory }) => graph.search(spacesOf(projectId), query, { includeHistory: includeHistory ?? false, limit: 40 }),
    'knowledge.refresh': async ({ projectId }) => {
      const project = repos.projects.require(projectId)
      const sync = await graph.syncProject(projectId)
      for (const enrolment of repos.enrolledRepositories.listByProject(projectId)) await graph.syncWorkspace(enrolment.workspaceId)
      const job = await graph.refreshFromGit({ kind: 'project', id: projectId }, project.rootPath, ctx.git)
      return { sync, job }
    },
    'knowledge.confirm': async ({ projectId, nodeId }) => {
      const node = graph.getNode(nodeId, spacesOf(projectId))
      const root = node.spaceKind === 'project' ? (repos.projects.get(node.spaceId)?.rootPath ?? null) : null
      return graph.reverify(node.id, root, 'the user')
    },
    'knowledge.writeNote': ({ projectId, title, body, evidence }) => {
      spacesOf(projectId)
      return graph.writeNote({ space: { kind: 'project', id: projectId }, title, body, evidence: evidence ?? null, author: { source: 'user' } })
    },
    'knowledge.promote': ({ projectId, nodeId }) => graph.promoteNote(noteOf(projectId, nodeId).id, 'user', null),
    'knowledge.archive': ({ projectId, nodeId, reason }) => graph.archiveNote(noteOf(projectId, nodeId).id, { source: 'user' }, reason),
    'knowledge.supersede': ({ projectId, olderId, newerId, reason }) => {
      const allowed = spacesOf(projectId)
      graph.supersede(graph.getNode(olderId, allowed).id, graph.getNode(newerId, allowed).id, reason)
      return null
    },

    'tokens.overview': ({ days }): TokenOverview => {
      const since = new Date(Date.now() - (days ?? 7) * DAY_MS).toISOString()
      const settings = repos.settings.get().tokens
      const breakdowns = repos.requestBreakdowns.recent(since, 2000)
      // One breakdown per session: the latest (a session reports one at the end of every turn).
      const latest = new Map<string, (typeof breakdowns)[number]>()
      for (const b of breakdowns) {
        const key = b.agentId ?? b.id
        if (!latest.has(key)) latest.set(key, b)
      }
      const sessions = [...latest.values()]
      const components = sessions.flatMap((b) => b.components)
      return {
        sinceIso: since,
        cache: repos.cacheEvents.totals(since),
        byRole: repos.cacheEvents.totalsBy('role', since),
        byModel: repos.cacheEvents.totalsBy('model', since),
        byProvider: repos.cacheEvents.totalsBy('provider', since),
        misses: repos.cacheEvents.misses(since, 20),
        compactions: repos.compactionEvents.count(since),
        sessionActions: repos.sessionEfficiency.countByAction(since),
        decisions: repos.optimizationDecisions.countByAction(since),
        composition: composition(components),
        compositionSessions: sessions.length,
        compositionBasis: sessions.length === 0 ? null : sessions.every((b) => b.basis === 'exact') ? 'exact' : sessions.some((b) => b.basis === 'estimated') ? 'estimated' : 'observed',
        techniques: TECHNIQUES.map((technique) => ({ technique, setting: settings[technique], enabled: techniqueEnabled(settings, technique), autoDefault: AUTO_DEFAULTS[technique] })),
        contextUsageDetail: settings.contextUsageDetail,
      }
    },
    'tokens.agent': ({ agentId }) => {
      const agent = repos.agents.require(agentId)
      const packs = repos.contextPacks.listByAgent(agentId)
      return {
        breakdown: repos.requestBreakdowns.latestForAgent(agentId),
        cache: repos.cacheEvents.listByAgent(agentId, 200),
        decisions: [...repos.optimizationDecisions.listByAgent(agentId, 100), ...(agent.taskId ? repos.optimizationDecisions.listByRun(agent.runId, 500).filter((d) => d.agentId === null && d.taskId === agent.taskId) : [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        compactions: repos.compactionEvents.listByAgent(agentId),
        efficiency: repos.sessionEfficiency.listByAgent(agentId, 50),
        graphNodes: packs.flatMap((p) => p.entries.filter((e) => e.sourceKind === 'context_node').map((e) => ({ packId: p.id, nodeId: e.sourceId, title: e.title, reason: e.reason, included: e.included, chars: e.chars }))),
      }
    },
    'tokens.run': ({ runId }) => {
      repos.runs.require(runId)
      return {
        cache: repos.cacheEvents.totals('1970-01-01T00:00:00.000Z', runId),
        decisions: repos.optimizationDecisions.listByRun(runId, 500),
        compactions: repos.compactionEvents.listByRun(runId),
        artifactRefs: repos.artifactContextRefs.listByRun(runId, 200),
      }
    },
  }
}
