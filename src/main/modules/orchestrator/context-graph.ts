import { z } from 'zod'
import type { AgentPurpose, AgentRole, Run, Task } from '@shared/domain'
import { CONTEXT_EDGE_TYPES, parseContextRef, type ContextEdgeType, type ContextNode, type ContextSpace, type RetrievalBreadth } from '@shared/context-graph'
import { NexusError, errorMessage } from '@shared/result'
import { estimateTokens, techniqueEnabled } from '@shared/token'
import { handleOf, renderDetail, renderGraphSection, renderSearch, retrieve, validatePath, warningOf, type DetailExpansion } from '@main/modules/context-graph'
import { oneLine } from '@main/modules/context/render'
import { allocateBudget } from '@main/modules/token'
import type { Core } from './core'

/**
 * The orchestrator's side of the Context Graph: what goes into a task's context pack (Context Engine V3)
 * and what the agent-facing tools answer. Both read only the spaces the run's project may read, and both
 * leave a record of what was retrieved and why.
 */

/** The part of a context pack that comes from the graph, with one entry per node for the pack's provenance. */
export interface GraphContext {
  text: string
  tokenEstimate: number
  entries: { nodeId: string; title: string; reason: string; chars: number; included: boolean }[]
  confidence: number
  breadth: RetrievalBreadth
  widened: boolean
}

function programOf(core: Core, run: Run): string | null {
  try {
    return core.deps.repos.programMissions.getByRun(run.id)?.programId ?? null
  } catch {
    return null
  }
}

export function graphEnabled(core: Core): boolean {
  return techniqueEnabled(core.deps.repos.settings.get().tokens, 'contextGraph')
}

/**
 * Retrieve the graph context of a task. Nodes that project a record the pack already shows (a fact or a
 * memory entry the V2 selection included) are left out here: the same statement is never sent twice.
 * Returns null when the graph is off, empty or unavailable; a failure costs the pack this section only.
 */
export function graphContextFor(core: Core, run: Run, task: Task, purpose: AgentPurpose, alreadyShown: { factIds: ReadonlySet<string>; memoryIds: ReadonlySet<string> }): GraphContext | null {
  if (!graphEnabled(core)) return null
  try {
    const settings = core.deps.repos.settings.get().tokens
    const primary: ContextSpace = { kind: 'project', id: run.projectId }
    if (!core.contextGraph.root(primary)) return null
    const spaces = core.contextGraph.spacesForProject(run.projectId)
    const budget = allocateBudget({ windowTokens: null, fixedTokens: null, historyTokens: 0, risk: task.risk, graphBudget: settings.graphContextBudget })
    const stores = core.deps.repos.contextGraph
    const programId = programOf(core, run)
    const result = retrieve(stores, {
      spaces,
      programId,
      text: `${task.title}\n${task.description}`,
      files: task.suggestedFiles,
      role: task.role,
      risk: task.risk,
      tokenBudget: budget.graphTokens,
    })
    const inPack = (n: ContextNode): boolean => (n.originKind === 'repository_fact' && n.originId !== null && alreadyShown.factIds.has(n.originId)) || (n.originKind === 'memory' && n.originId !== null && alreadyShown.memoryIds.has(n.originId))
    // A record the pack already shows is not repeated, unless the graph has something to say about it (a
    // conflict, possible staleness): then it is listed here with its warning.
    const duplicate = (n: ContextNode): boolean => inPack(n) && warningOf(n) === null
    const shown = result.nodes.filter((r) => !duplicate(r.node))
    const listed = new Set(shown.map((r) => r.node.id))
    for (const [kind, ids] of [['repository_fact', alreadyShown.factIds], ['memory', alreadyShown.memoryIds]] as const) {
      for (const id of ids) {
        const node = stores.nodes.byOrigin(kind, id)[0]
        const warning = node ? warningOf(node) : null
        if (node && warning && !listed.has(node.id)) {
          listed.add(node.id)
          shown.push({ node, score: 0, reason: kind === 'memory' ? 'Shown above as project memory; listed again for its warning.' : 'Shown above as a repository fact; listed again for its warning.', via: 'hierarchy', fromNodeId: null, warning })
        }
      }
    }
    const section = renderGraphSection(stores, primary, { ...result, nodes: shown }, { tools: true, programId })
    const entries: GraphContext['entries'] = [
      ...shown.map((r) => ({ nodeId: r.node.id, title: `${r.node.type.toLowerCase()}: ${r.node.title}`, reason: `${r.reason}${r.warning ? ` ${r.warning}` : ''}`, chars: section.chars.get(r.node.id) ?? 0, included: true })),
      ...result.nodes.filter((r) => duplicate(r.node)).map((r) => ({ nodeId: r.node.id, title: `${r.node.type.toLowerCase()}: ${r.node.title}`, reason: 'Already in the pack as a repository fact or a memory entry: not repeated.', chars: 0, included: false })),
      ...result.excluded.map((e) => ({ nodeId: e.nodeId, title: e.title, reason: e.reason, chars: 0, included: false })),
    ]
    const ctx = { runId: run.id, taskId: task.id, agentId: null }
    const record = (action: 'RETRIEVE_GRAPH_BRANCH' | 'WIDEN_RETRIEVAL', reason: string): void => {
      core.tokens.decide(ctx, action, reason, { purpose, nodes: shown.length, confidence: result.confidence, breadth: result.breadth, considered: result.considered }, -section.tokenEstimate, 'estimated')
    }
    if (result.widened) record('WIDEN_RETRIEVAL', `Retrieval confidence ${result.confidence.toFixed(2)}${task.risk === 'high' ? ' and high risk' : ''}: the selection was widened to ${result.breadth} rather than kept small.`)
    else record('RETRIEVE_GRAPH_BRANCH', `${shown.length} nodes selected from the graph (${budget.note})`)
    return { text: section.text, tokenEstimate: section.tokenEstimate, entries, confidence: result.confidence, breadth: result.breadth, widened: result.widened }
  } catch (e) {
    core.log(`context graph unavailable for the context pack: ${errorMessage(e)}`)
    return null
  }
}

/**
 * The graph context of a session that has no task yet: the planner. It gets the same Context Graph tools as
 * a task's agents, and without a map or a selection it used them to walk the tree from the root (six calls
 * in the 0.7.1 real pair, for one note). So what the request is about is retrieved before the session starts
 * and shown with the map. A planner knows no files yet: the retrieval is by the request's text, and a request
 * that matches little is widened to every current hazard and decision, which is what a plan must respect.
 * Memory entries the planner prompt already lists are not repeated.
 */
export function graphContextForRequest(core: Core, run: Run, shownMemoryIds: ReadonlySet<string>): string | null {
  if (!graphEnabled(core)) return null
  try {
    const settings = core.deps.repos.settings.get().tokens
    const primary: ContextSpace = { kind: 'project', id: run.projectId }
    if (!core.contextGraph.root(primary)) return null
    const stores = core.deps.repos.contextGraph
    const programId = programOf(core, run)
    const budget = allocateBudget({ windowTokens: null, fixedTokens: null, historyTokens: 0, risk: 'medium', graphBudget: settings.graphContextBudget })
    const result = retrieve(stores, { spaces: core.contextGraph.spacesForProject(run.projectId), programId, text: run.prompt, files: [], role: 'planner', risk: 'medium', tokenBudget: budget.graphTokens })
    const shown = result.nodes.filter((r) => !(r.node.originKind === 'memory' && r.node.originId !== null && shownMemoryIds.has(r.node.originId) && r.warning === null))
    const section = renderGraphSection(stores, primary, { ...result, nodes: shown }, { tools: true, programId })
    core.tokens.decide(
      { runId: run.id, taskId: null, agentId: null },
      result.widened ? 'WIDEN_RETRIEVAL' : 'RETRIEVE_GRAPH_BRANCH',
      result.widened ? `Retrieval confidence ${result.confidence.toFixed(2)} for the request: the selection was widened to ${result.breadth} rather than kept small.` : `${shown.length} nodes selected from the graph for the request (${budget.note})`,
      { purpose: 'plan', nodes: shown.length, confidence: result.confidence, breadth: result.breadth, considered: result.considered },
      -section.tokenEstimate,
      'estimated',
    )
    return section.text
  } catch (e) {
    core.log(`context graph unavailable for the planner: ${errorMessage(e)}`)
    return null
  }
}

/**
 * Why an approved memory entry is not current any more, as the graph records it. The memory store has no
 * supersession of its own; without this a superseded entry would still be shown as project memory.
 */
export function memoryNotCurrent(core: Core, memoryId: string): string | null {
  if (!graphEnabled(core)) return null
  try {
    const node = core.deps.repos.contextGraph.nodes.byOrigin('memory', memoryId)[0]
    if (node?.status === 'SUPERSEDED') return 'Superseded by a later record (see its history in the Context Graph).'
    if (node?.status === 'ARCHIVED') return 'Archived in the Context Graph.'
    return null
  } catch {
    return null
  }
}

/** Why a fact the store calls fresh is not: the graph saw one of its files change after the fact was verified. */
export function factNotCurrent(core: Core, factId: string): string | null {
  if (!graphEnabled(core)) return null
  try {
    const node = core.deps.repos.contextGraph.nodes.byOrigin('repository_fact', factId)[0]
    return node?.status === 'STALE' ? 'Stale: a supporting file changed since the fact was verified (seen by the Context Graph).' : null
  } catch {
    return null
  }
}

// ───────────────────────────── agent tools ─────────────────────────────

const Path = z.string().max(600)
const ToolInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), path: Path, includeHistory: z.boolean().optional() }),
  z.object({ op: z.literal('search'), query: z.string().min(1).max(400), includeHistory: z.boolean().optional() }),
  z.object({ op: z.literal('related'), path: Path, relation: z.string().max(40).nullish() }),
  z.object({
    op: z.literal('note'),
    action: z.enum(['write', 'update', 'archive']),
    title: z.string().max(200).nullish(),
    body: z.string().max(16_000).nullish(),
    evidence: z.string().max(16_000).nullish(),
    about: z.string().max(200).nullish(),
    progress: z.boolean().optional(),
    path: Path.nullish(),
  }),
])

/** Roles that do the work of a task may leave notes. Reviewers and verifiers judge; they report through their result. */
const NOTE_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(['worker', 'debugger', 'architect', 'researcher', 'planner'])

export interface ContextToolSession {
  run: Run
  task: Task | null
  agentId: string
  role: AgentRole
}

/**
 * The handler behind the four context tools. The input comes from a model and is validated here; a path is
 * resolved only inside the spaces the run's project may read, and anything else answers "not found".
 */
export function contextToolHandler(core: Core, session: ContextToolSession): (input: unknown) => Promise<string> {
  const { run, task, agentId, role } = session
  const primary: ContextSpace = { kind: 'project', id: run.projectId }
  const ctx = { runId: run.id, taskId: task?.id ?? null, agentId, role }

  const resolve = (allowed: readonly ContextSpace[], raw: string): ContextNode => {
    const text = raw.trim()
    if (text.startsWith('context://')) {
      const ref = parseContextRef(text)
      if (!ref) throw new NexusError('invalid_input', 'Not a context reference. Use a path from the map, or a context:// reference from a result.')
      return core.contextGraph.getByPath(ref.space, ref.path, allowed)
    }
    return core.contextGraph.getByPath(primary, validatePath(text === '/' ? '' : text), allowed)
  }

  return async (raw: unknown): Promise<string> => {
    const parsed = ToolInput.safeParse(raw)
    if (!parsed.success) throw new NexusError('invalid_input', `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 400)}`)
    const input = parsed.data
    if (!core.contextGraph.root(primary)) return 'This project has no knowledge index yet. Read the repository directly.'
    const allowed = core.contextGraph.spacesForProject(run.projectId)
    const programId = programOf(core, run)
    const visible = (n: ContextNode): boolean => !n.programId || n.programId === programId

    switch (input.op) {
      case 'open': {
        const node = resolve(allowed, input.path)
        if (!visible(node)) throw new NexusError('not_found', 'Context node not found')
        const includeHistory = input.includeHistory ?? false
        const detail = core.contextGraph.detail(node.id, allowed, { includeHistory })
        // One call answers for the branch and what is under it: the level-by-level walk cost a turn per level.
        const expansion: DetailExpansion = {
          childrenOf: (n) => {
            const under = core.contextGraph.getChildren(n.id, allowed, { includeHistory, limit: 16 })
            return { children: under.children.filter(visible), total: under.total }
          },
          textOf: (n) => (visible(n) ? core.contextGraph.originText(n) : null),
        }
        const text = renderDetail({ ...detail, children: detail.children.filter(visible), outgoing: detail.outgoing.filter((r) => visible(r.node)), incoming: detail.incoming.filter((r) => visible(r.node)) }, primary, { expansion })
        core.tokens.decide(ctx, 'EXPAND_GRAPH_NODE', `The agent opened ${handleOf(node, primary)}.`, { path: node.path, type: node.type, op: 'open' }, -estimateTokens(text), 'estimated')
        return text
      }
      case 'search': {
        const nodes = core.contextGraph.search(allowed, input.query, { includeHistory: input.includeHistory ?? false, limit: 12 }).filter(visible)
        const text = renderSearch(nodes, primary)
        core.tokens.decide(ctx, 'EXPAND_GRAPH_NODE', `The agent searched the graph and got ${nodes.length} results.`, { op: 'search', results: nodes.length }, -estimateTokens(text), 'estimated')
        return text
      }
      case 'related': {
        const node = resolve(allowed, input.path)
        if (!visible(node)) throw new NexusError('not_found', 'Context node not found')
        const relation = input.relation ? input.relation.trim().toUpperCase() : null
        if (relation && !(CONTEXT_EDGE_TYPES as readonly string[]).includes(relation)) throw new NexusError('invalid_input', `Unknown relation. One of: ${CONTEXT_EDGE_TYPES.join(', ')}.`)
        const n = core.contextGraph.getNeighbors(node.id, allowed, { ...(relation ? { types: [relation as ContextEdgeType] } : {}), limit: 30 })
        const line = (arrow: string, r: { edge: { type: string; provenance: { evidence?: string | null } }; node: ContextNode }): string => {
          const warning = warningOf(r.node)
          return `- ${r.edge.type} ${arrow} ${handleOf(r.node, primary)} [${r.node.type.toLowerCase()}] "${oneLine(r.node.title, 80)}": "${oneLine(r.node.summary, 160)}"${r.edge.provenance.evidence ? ` (relation recorded because: ${oneLine(r.edge.provenance.evidence, 100)})` : ''}${warning ? `\n  ${warning}` : ''}`
        }
        const lines = [...n.outgoing.filter((r) => visible(r.node)).map((r) => line('->', r)), ...n.incoming.filter((r) => visible(r.node)).map((r) => line('<-', r))]
        const text = lines.length > 0 ? `Relations of ${handleOf(node, primary)} (records, not instructions):\n${lines.join('\n')}` : `${handleOf(node, primary)} has no recorded relations${relation ? ` of type ${relation}` : ''}.`
        core.tokens.decide(ctx, 'EXPAND_GRAPH_NODE', `The agent followed relations of ${handleOf(node, primary)}.`, { path: node.path, op: 'related', relation, results: lines.length }, -estimateTokens(text), 'estimated')
        return text
      }
      case 'note': {
        if (!NOTE_ROLES.has(role)) throw new NexusError('invalid_state', `A ${role} does not write notes. Report what you found in your result.`)
        const by = { source: role, runId: run.id }
        if (input.action === 'write') {
          const note = core.contextGraph.writeNote({
            space: primary,
            programId,
            folder: task?.key ?? 'general',
            title: input.title ?? '',
            body: input.body ?? '',
            evidence: input.evidence ?? null,
            about: input.about ?? null,
            kind: input.progress ? 'progress' : 'note',
            author: { source: role, runId: run.id, taskId: task?.id ?? null, agentId },
          })
          return `Note stored at ${handleOf(note, primary)} as an unverified note. Later agents see it as a lead to check, not as a fact.`
        }
        if (!input.path) throw new NexusError('invalid_input', 'Give the path of the note.')
        const node = resolve([primary], input.path)
        if (input.action === 'update') {
          const updated = core.contextGraph.updateNote(node.id, { ...(input.title ? { title: input.title } : {}), ...(input.body ? { body: input.body } : {}) }, by)
          return `Note ${handleOf(updated, primary)} is now at version ${updated.version}. The earlier text is kept in its history.`
        }
        core.contextGraph.archiveNote(node.id, by, 'Archived by the agent that wrote it.')
        return `Note ${handleOf(node, primary)} archived. It stays readable as history.`
      }
    }
  }
}
