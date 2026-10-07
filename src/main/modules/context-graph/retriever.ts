import {
  trustRank,
  type ContextEdgeType,
  type ContextNode,
  type ContextNodeType,
  type ContextSpace,
  type ContextStatus,
  type RetrievalBreadth,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievalSignal,
  type RetrievedNode,
} from '@shared/context-graph'
import { moduleOf } from '@main/modules/intelligence/analyze'
import type { ContextGraphStores } from '@main/modules/persistence/repositories'
import { joinPath, normFile, segment } from './paths'

/**
 * Ranked retrieval over the graph. Four signals, in the order of how much they are trusted:
 *  1. path: a node whose evidence is one of the task's files, and the module that contains the file;
 *  2. edges: what is one typed relation away from those (tests, decisions, hazards, contracts);
 *  3. full text (BM25) over titles, summaries and paths;
 *  4. hierarchy: in a broad retrieval, every current hazard and decision.
 *
 * A wrong node is worse than a larger context, so: scope and path outrank text; a node that is not CURRENT
 * is never returned as if it were; and when the retriever is not confident it widens instead of guessing.
 */

const STOP: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'will', 'should', 'must', 'are', 'not', 'all', 'any', 'can', 'add', 'use', 'new', 'has', 'have',
  'its', 'when', 'then', 'also', 'each', 'make', 'was', 'were', 'been', 'being', 'but', 'you', 'your', 'our', 'their', 'there', 'what', 'which', 'while',
  'does', 'did', 'done', 'fix', 'bug', 'task', 'file', 'files', 'code', 'change', 'changes', 'update', 'implement', 'need', 'needs', 'via', 'per', 'out', 'who', 'how', 'why',
])

/** The meaningful terms of a text: lowercase words of three letters or more that are not stop words. */
export function queryTerms(text: string): string[] {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9_]+/)) if (t.length >= 3 && !STOP.has(t)) out.add(t)
  return [...out]
}

/** A crude stem, so that "sessions" and "session", "caching" and "cache" compare equal. The index itself stems with Porter. */
const stem = (t: string): string => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t)

/** Categories and risks for which a narrow context is the wrong default. */
const BROAD_CATEGORIES: ReadonlySet<string> = new Set(['architecture', 'security', 'refactor', 'migration', 'cross_cutting', 'workspace', 'unknown'])

const LIMITS: Record<RetrievalBreadth, { nodes: number; budgetFactor: number; fts: number; hops: number }> = {
  tight: { nodes: 6, budgetFactor: 0.6, fts: 12, hops: 1 },
  standard: { nodes: 12, budgetFactor: 1, fts: 30, hops: 1 },
  broad: { nodes: 30, budgetFactor: 3, fts: 60, hops: 2 },
}

/** How much of a node's score an edge passes on. Relations that constrain work pass on more than ones that only inform. */
const EDGE_WEIGHT: Partial<Record<ContextEdgeType, number>> = {
  AFFECTED_BY: 0.85,
  DECIDED_BY: 0.85,
  PROVIDES: 0.8,
  CONSUMES: 0.8,
  IMPLEMENTS: 0.8,
  TESTED_BY: 0.6,
  RELATED_TO: 0.55,
  DEPENDS_ON: 0.4,
  INTRODUCED_BY: 0.3,
  DERIVED_FROM: 0.5,
}

const EDGE_PHRASE: Partial<Record<ContextEdgeType, string>> = {
  AFFECTED_BY: 'is affected by',
  DECIDED_BY: 'is governed by the decision',
  PROVIDES: 'provides',
  CONSUMES: 'consumes',
  IMPLEMENTS: 'implements',
  TESTED_BY: 'is tested by',
  RELATED_TO: 'is related to',
  DEPENDS_ON: 'depends on',
  INTRODUCED_BY: 'was introduced by',
  DERIVED_FROM: 'is',
}

const TRUST_FACTOR = [1, 1, 0.9, 0.8, 0.7] as const
/** Types that organise the tree. They are shown in the map, never ranked as knowledge. */
const STRUCTURAL: ReadonlySet<ContextNodeType> = new Set<ContextNodeType>(['SECTION', 'HISTORY_INDEX', 'WORKSPACE'])
/** Statements people or agents made. When stale they may still matter, so they are shown with a warning; a stale analysis fact is not shown. */
const STATEMENTS: ReadonlySet<ContextNodeType> = new Set<ContextNodeType>(['MEMORY', 'DECISION', 'HAZARD', 'NOTE', 'RULE', 'ISSUE', 'CONTRACT', 'OUTCOME'])

interface Candidate {
  node: ContextNode
  score: number
  reason: string
  via: RetrievalSignal
  fromNodeId: string | null
  required: boolean
}

const modulePathOf = (file: string): string => {
  const m = moduleOf(normFile(file))
  return joinPath('modules', m === '.' ? 'root' : segment(m))
}

export function retrieve(stores: ContextGraphStores, query: RetrievalQuery): RetrievalResult {
  const on = (s: RetrievalSignal): boolean => query.signals?.[s] !== false
  const risk = query.risk ?? 'medium'
  const highRisk = risk === 'high' || risk === 'critical'
  const spaces = query.spaces
  const inScope = (n: ContextNode): boolean => spaces.some((s) => s.kind === n.spaceKind && s.id === n.spaceId)
  const allowedStatuses: ContextStatus[] = ['CURRENT', 'CONFLICTED', 'STALE', ...(query.includeHistory ? (['SUPERSEDED', 'ARCHIVED'] as ContextStatus[]) : [])]
  const excludedTypes = new Set(query.excludeTypes ?? [])
  const excluded: RetrievalResult['excluded'] = []
  const noteExclusion = (n: ContextNode, reason: string): void => {
    if (excluded.length < 30) excluded.push({ nodeId: n.id, title: n.title, reason })
  }

  /** Whether a node may be ranked at all, with the reason when it may not. */
  const admissible = (n: ContextNode): boolean => {
    if (!inScope(n) || STRUCTURAL.has(n.type) || n.path === '' || excludedTypes.has(n.type)) return false
    if (!allowedStatuses.includes(n.status)) return false
    if (n.programId && n.programId !== (query.programId ?? null)) return false
    if (n.status === 'STALE' && !STATEMENTS.has(n.type)) {
      noteExclusion(n, 'Stale: a supporting file changed since it was verified.')
      return false
    }
    if (highRisk && n.trust === 'AGENT_NOTE') {
      noteExclusion(n, `Unverified agent note: not used for ${risk}-risk work.`)
      return false
    }
    return true
  }

  const candidates = new Map<string, Candidate>()
  let considered = 0
  const offer = (node: ContextNode, score: number, reason: string, via: RetrievalSignal, fromNodeId: string | null, required = false): void => {
    considered++
    if (!admissible(node)) return
    const prior = candidates.get(node.id)
    if (!prior || score > prior.score) candidates.set(node.id, { node, score, reason, via, fromNodeId, required: required || (prior?.required ?? false) })
    else if (required) prior.required = true
  }

  // 1. Path: the task's files.
  const files = [...new Set(query.files.map(normFile).filter((f) => f !== '' && !f.startsWith('..')))]
  let pathHits = 0
  if (on('path') && files.length > 0) {
    for (const space of spaces) {
      if (space.kind !== 'project') continue
      const hits = stores.sources.nodesForFiles(space.id, files)
      const byId = new Map(stores.nodes.getMany([...new Set(hits.map((h) => h.nodeId))]).map((n) => [n.id, n]))
      for (const h of hits) {
        const node = byId.get(h.nodeId)
        if (!node) continue
        offer(node, 10, `Its evidence is the task's file ${h.ref}.`, 'path', null, true)
        pathHits++
      }
      for (const file of files) {
        const module = stores.nodes.byPath(space, modulePathOf(file))
        if (module) {
          offer(module, 8, `Contains the task's file ${file}.`, 'path', null, true)
          pathHits++
        }
      }
    }
  }

  // The project's own node in each workspace: the way into contracts and cross-repository knowledge.
  if (on('edges')) {
    for (const space of spaces) {
      if (space.kind !== 'project') continue
      const root = stores.nodes.root(space)
      if (!root) continue
      for (const e of stores.edges.incoming(root.id, ['DERIVED_FROM'], 20)) {
        const repo = stores.nodes.get(e.fromId)
        if (repo) offer(repo, 5, 'This repository as the workspace sees it.', 'edges', root.id)
      }
    }
  }

  // 3. Full text. Run before the edge pass so that strong text hits are seeds too.
  const terms = queryTerms(query.text)
  let strongText = 0
  let textHits = 0
  if (on('fts') && terms.length > 0) {
    const requested = query.breadth ?? 'standard'
    const hits = stores.nodes.search(spaces, terms.join(' '), { statuses: allowedStatuses, limit: LIMITS[requested].fts })
    hits.forEach((h, i) => {
      const hay = `${h.node.title} ${h.node.path}`.toLowerCase()
      const all = `${hay} ${h.node.summary.toLowerCase()}`
      const inTitle = terms.filter((t) => hay.includes(stem(t)))
      const inAll = terms.filter((t) => all.includes(stem(t)))
      // One shared word in a long summary is noise; it takes a title match or two shared terms to count.
      if (inTitle.length === 0 && inAll.length < 2) return
      const score = 2 + 3 * (1 - i / Math.max(1, hits.length)) + Math.min(3, inTitle.length) + Math.min(1, inAll.length * 0.25)
      if (inTitle.length >= 2 || (inTitle.length >= 1 && inAll.length >= 3)) strongText++
      textHits++
      offer(h.node, score, `Matches the task's terms: ${(inTitle.length > 0 ? inTitle : inAll).slice(0, 5).join(', ')}.`, 'fts', null)
    })
  }

  // Confidence, before widening: path evidence is strong, title matches are fair, nothing is weak.
  let confidence = pathHits > 0 ? 0.9 : strongText > 0 ? 0.7 : textHits > 0 ? 0.45 : 0.1
  if (pathHits > 0 && textHits === 0 && terms.length > 0) confidence = 0.8

  let breadth: RetrievalBreadth = query.breadth ?? 'standard'
  let widened = false
  if (breadth !== 'broad' && (confidence < 0.5 || highRisk || (query.category != null && BROAD_CATEGORIES.has(query.category)))) {
    breadth = 'broad'
    widened = true
  }
  const limits = LIMITS[breadth]

  // 2. Edges: follow typed relations from what was found so far.
  if (on('edges')) {
    let frontier = [...candidates.values()].filter((c) => c.score >= 4).sort((a, b) => b.score - a.score).slice(0, 12)
    for (let hop = 0; hop < limits.hops && frontier.length > 0; hop++) {
      const next: Candidate[] = []
      const edges = stores.edges.touching(frontier.map((c) => c.node.id), 500)
      const from = new Map(frontier.map((c) => [c.node.id, c]))
      const otherIds = new Set<string>()
      for (const e of edges) {
        if (from.has(e.fromId)) otherIds.add(e.toId)
        if (from.has(e.toId)) otherIds.add(e.fromId)
      }
      const byId = new Map(stores.nodes.getMany([...otherIds]).map((n) => [n.id, n]))
      for (const e of edges) {
        const weight = EDGE_WEIGHT[e.type]
        if (weight === undefined) continue
        // Outgoing: from a found node to what it relates to. Incoming is followed only for relations that read both ways.
        const outFrom = from.get(e.fromId)
        const inFrom = from.get(e.toId)
        const pairs: { seed: Candidate; other: ContextNode | undefined; outgoing: boolean }[] = []
        if (outFrom) pairs.push({ seed: outFrom, other: byId.get(e.toId), outgoing: true })
        if (inFrom && (e.type === 'RELATED_TO' || e.type === 'PROVIDES' || e.type === 'CONSUMES' || e.type === 'IMPLEMENTS')) pairs.push({ seed: inFrom, other: byId.get(e.fromId), outgoing: false })
        for (const { seed, other, outgoing } of pairs) {
          if (!other || other.id === seed.node.id) continue
          const score = seed.score * weight * (e.trust === 'INFERRED' ? 0.85 : 1)
          if (score < 1.5) continue
          const phrase = EDGE_PHRASE[e.type] ?? e.type.toLowerCase()
          const reason = outgoing ? `${seed.node.title} ${phrase} it.` : `It ${phrase} ${seed.node.title}.`
          const before = candidates.get(other.id)?.score ?? 0
          offer(other, score, reason, 'edges', seed.node.id)
          const now = candidates.get(other.id)
          if (now && now.score > before) next.push(now)
        }
      }
      frontier = next.sort((a, b) => b.score - a.score).slice(0, 12)
    }
  }

  // 4. Hierarchy.
  if (on('hierarchy')) {
    for (const space of spaces) {
      // Commands are not offered here: every pack already carries the check commands (the benchmark showed
      // that offering them again only spent the budget of nodes that mattered).
      if (breadth === 'broad') {
        for (const section of ['hazards', 'decisions']) {
          const s = stores.nodes.byPath(space, section)
          if (s) for (const c of stores.nodes.children(s.id, { limit: 40 })) offer(c, 2.5, `Broad retrieval: every current entry under ${section}/.`, 'hierarchy', s.id)
        }
      }
    }
  }

  // A conflict is shown whole: the nodes that contradict a selected node come with it.
  for (const c of [...candidates.values()]) {
    if (c.node.status !== 'CONFLICTED') continue
    c.required = true
    for (const e of [...stores.edges.outgoing(c.node.id, ['CONFLICTS_WITH'], 10), ...stores.edges.incoming(c.node.id, ['CONFLICTS_WITH'], 10)]) {
      const other = stores.nodes.get(e.fromId === c.node.id ? e.toId : e.fromId)
      if (other) offer(other, c.score, `It contradicts ${c.node.title}.`, 'edges', c.node.id, true)
    }
  }

  const ranked = [...candidates.values()]
    .map((c) => ({ ...c, score: c.score * (TRUST_FACTOR[trustRank(c.node.trust)] ?? 0.7) * (c.node.status === 'STALE' ? 0.6 : 1) }))
    .sort((a, b) => b.score - a.score || trustRank(a.node.trust) - trustRank(b.node.trust) || a.node.path.localeCompare(b.node.path))

  const budget = Math.round((query.tokenBudget ?? 2_000) * limits.budgetFactor)
  const nodes: RetrievedNode[] = []
  let tokens = 0
  for (const c of ranked) {
    const cost = c.node.tokenEstimate + 12
    // The budget is advisory: a required node (the task's own files, a conflict) is never dropped to meet it.
    if (!c.required && nodes.length >= limits.nodes) {
      noteExclusion(c.node, `Relevant (${c.reason}) but below the ${limits.nodes} best for a ${breadth} retrieval.`)
      continue
    }
    if (!c.required && tokens + cost > budget && nodes.length > 0) {
      noteExclusion(c.node, `Relevant (${c.reason}) but over the advisory budget of ${budget} tokens.`)
      continue
    }
    tokens += cost
    nodes.push({ node: c.node, score: Math.round(c.score * 100) / 100, reason: c.reason, via: c.via, fromNodeId: c.fromNodeId, warning: warningOf(c.node) })
  }

  return { nodes, excluded, confidence, breadth, widened, tokenEstimate: tokens, considered }
}

/** What an agent must be told about a node that is not plainly current and verified. */
export function warningOf(node: ContextNode): string | null {
  if (node.status === 'CONFLICTED') return 'CONFLICT: another current record states this subject differently. Neither is authoritative; check the source.'
  if (node.status === 'STALE') return 'POSSIBLY OUTDATED: a file this was based on changed since it was recorded. Verify against the code.'
  if (node.status === 'SUPERSEDED') return 'HISTORICAL: superseded by a later record.'
  if (node.status === 'ARCHIVED') return 'HISTORICAL: archived.'
  if (node.trust === 'AGENT_NOTE') return 'UNVERIFIED: an agent wrote this note; it is a lead to check, not a fact.'
  return null
}

/** The spaces a retrieval reads, as plain data for a trace. */
export function describeSpaces(spaces: readonly ContextSpace[]): string {
  return spaces.map((s) => `${s.kind}:${s.id.slice(0, 8)}`).join(', ')
}
