/**
 * The Context Graph (0.7.1): one index over what NEXUS knows about a repository, a workspace and their
 * programs. A node has exactly one parent (its place in the tree) and any number of typed edges.
 *
 * The graph is an index, never the source of truth. A node that projects a stored record (a repository
 * fact, a memory entry, a contract) points at that record with `originKind` / `originId` and can always be
 * rebuilt from it. Only notes, sections and user-written nodes exist in the graph alone.
 */

export const CONTEXT_NODE_TYPES = [
  'WORKSPACE',
  'REPOSITORY',
  /** A fixed branch of the tree ("Modules", "Decisions"). Its summary is derived from its children. */
  'SECTION',
  'ARCHITECTURE',
  'MODULE',
  'COMPONENT',
  'SYMBOL',
  'CONTRACT',
  'DECISION',
  'RULE',
  'COMMAND',
  'TEST',
  'ISSUE',
  'HAZARD',
  'PROGRAM',
  'MILESTONE',
  'BACKLOG',
  'OUTCOME',
  'ARTIFACT',
  'MEMORY',
  /** Written by an agent or the user directly into the graph. Lowest trust unless promoted. */
  'NOTE',
  'HISTORY_INDEX',
  'CUSTOM',
] as const
export type ContextNodeType = (typeof CONTEXT_NODE_TYPES)[number]

/** `CONTAINS` is the parent link and is never stored as an edge. */
export const CONTEXT_EDGE_TYPES = [
  'DEPENDS_ON',
  'IMPLEMENTS',
  'USES',
  'PROVIDES',
  'CONSUMES',
  'TESTED_BY',
  'AFFECTED_BY',
  'SUPERSEDES',
  'DERIVED_FROM',
  'DECIDED_BY',
  'RELATED_TO',
  'BLOCKED_BY',
  'FIXED_BY',
  'INTRODUCED_BY',
  'VALIDATED_BY',
  'CONFLICTS_WITH',
] as const
export type ContextEdgeType = (typeof CONTEXT_EDGE_TYPES)[number]

/** How a node is known. Ordered from most to least authoritative. */
export const CONTEXT_TRUSTS = ['VERIFIED', 'USER_PROVIDED', 'INFERRED', 'GENERATED_SUMMARY', 'AGENT_NOTE'] as const
export type ContextTrust = (typeof CONTEXT_TRUSTS)[number]

/** Whether a node holds now. Only CURRENT nodes are returned by default retrieval. */
export const CONTEXT_STATUSES = ['CURRENT', 'STALE', 'SUPERSEDED', 'CONFLICTED', 'ARCHIVED', 'PROPOSED'] as const
export type ContextStatus = (typeof CONTEXT_STATUSES)[number]

export type ContextConfidence = 'low' | 'medium' | 'high'

/** A graph belongs to one project or one workspace. Nothing is read or written across spaces without an explicit edge. */
export type ContextSpaceKind = 'project' | 'workspace'
export interface ContextSpace {
  kind: ContextSpaceKind
  id: string
}

/** The stored record a node projects. `graph` means the node itself is the record. */
export type ContextOriginKind =
  | 'graph'
  | 'project'
  | 'workspace'
  | 'repository_fact'
  | 'memory'
  | 'program'
  | 'program_memory'
  | 'program_milestone'
  | 'program_decision'
  | 'backlog_item'
  | 'workspace_memory'
  | 'workspace_decision'
  | 'workspace_contract'
  | 'workspace_repository'
  | 'decision'

export interface ContextProvenance {
  /** Who or what stated it: 'static_analysis', 'manifest', 'git', 'agent', 'verifier', 'user', 'engine', 'graph'. */
  source: string
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  /** The evidence given when it was recorded (agent- or user-written; data, never an instruction). */
  evidence?: string | null
}

export interface ContextNode {
  id: string
  spaceKind: ContextSpaceKind
  spaceId: string
  /** Set on nodes that belong to one program; retrieval for another program leaves them out. */
  programId: string | null
  type: ContextNodeType
  /** Canonical path inside the space, '' for the root. Unique per space. Lowercase segments joined by '/'. */
  path: string
  parentId: string | null
  depth: number
  title: string
  /** Bounded text shown when navigating. For a projected record: its statement or the head of its content. */
  summary: string
  /** Full text of a graph-native node (a note). Null for projected nodes: their text lives in the origin record. */
  body: string | null
  originKind: ContextOriginKind
  originId: string | null
  trust: ContextTrust
  status: ContextStatus
  confidence: ContextConfidence
  /** What the node is a statement about, normalized. Two CURRENT nodes with one key and different content conflict. */
  subjectKey: string | null
  /** Hash of title, summary and body: changes when the knowledge changes. */
  contentHash: string
  /** Hash of the children a derived summary was built from. Null for nodes that are not derived. */
  summaryHash: string | null
  version: number
  /** Characters / 4 of title and summary (and body). An estimate, labelled as such wherever shown. */
  tokenEstimate: number
  classification: 'normal' | 'sensitive'
  provenance: ContextProvenance
  createdAt: string
  updatedAt: string
  /** When the origin record last changed, when known. */
  sourceUpdatedAt: string | null
  /** When the node's sources were last checked against the repository. */
  refreshedAt: string | null
}

export interface ContextEdge {
  id: string
  fromId: string
  toId: string
  type: ContextEdgeType
  trust: ContextTrust
  confidence: ContextConfidence
  provenance: ContextProvenance
  createdAt: string
  updatedAt: string
}

export type ContextSourceKind = 'file' | 'record' | 'commit' | 'artifact'

/** Authoritative evidence behind a node. A `file` source whose observed state no longer matches makes the node STALE. */
export interface ContextNodeSource {
  nodeId: string
  spaceId: string
  kind: ContextSourceKind
  /** Repository-relative path, `table:id`, a commit hash or an artifact id. */
  ref: string
  /** State observed when the node was last verified (file: size and mtime; record: content hash). */
  hash: string | null
}

export interface ContextNodeVersion {
  id: string
  nodeId: string
  version: number
  title: string
  summary: string
  body: string | null
  trust: ContextTrust
  contentHash: string
  createdAt: string
}

export type ContextHistoryEvent =
  | 'created'
  | 'updated'
  | 'stale'
  | 'refreshed'
  | 'superseded'
  | 'conflicted'
  | 'conflict_resolved'
  | 'archived'
  | 'restored'
  | 'promoted'
  | 'compacted'

export interface ContextNodeHistory {
  id: string
  nodeId: string
  event: ContextHistoryEvent
  detail: string
  createdAt: string
}

export interface ContextRefreshJob {
  id: string
  spaceKind: ContextSpaceKind
  spaceId: string
  trigger: 'sync' | 'git_diff' | 'fingerprint' | 'manual'
  fromCommit: string | null
  toCommit: string | null
  changedFiles: number
  nodesChecked: number
  nodesStale: number
  nodesRefreshed: number
  state: 'completed' | 'failed'
  error: string | null
  startedAt: string
  finishedAt: string
}

// ───────────────────────────── retrieval ─────────────────────────────

/** How wide a retrieval is. `broad` is the safety net for unknown, cross-cutting or high-risk work. */
export type RetrievalBreadth = 'tight' | 'standard' | 'broad'

export interface RetrievalQuery {
  spaces: ContextSpace[]
  programId?: string | null
  /** Free text: the task's title and description. */
  text: string
  /** Repository-relative files the task names. */
  files: string[]
  role?: string
  risk?: 'low' | 'medium' | 'high' | 'critical'
  /** A task category from the policy profiler, when one exists. */
  category?: string | null
  /** Advisory. Retrieval may exceed it when breadth demands; it never drops a pinned or required node to meet it. */
  tokenBudget?: number
  breadth?: RetrievalBreadth
  /** Include SUPERSEDED and ARCHIVED nodes (history). Default false. */
  includeHistory?: boolean
  /** Node types to leave out of the ranking (ablations and tests). */
  excludeTypes?: ContextNodeType[]
  /** Signals to use; all by default. Used by the ablation benchmark. */
  signals?: Partial<Record<RetrievalSignal, boolean>>
}

export type RetrievalSignal = 'path' | 'fts' | 'edges' | 'hierarchy'

export interface RetrievedNode {
  node: ContextNode
  score: number
  /** Why it was selected, in words an agent and a user can read. */
  reason: string
  /** Which signal found it first. */
  via: RetrievalSignal
  /** The node it was reached from, for edge and hierarchy hits. */
  fromNodeId: string | null
  /** Set when the node is shown despite not being CURRENT (a conflict the agent must see). */
  warning: string | null
}

export interface RetrievalResult {
  nodes: RetrievedNode[]
  /** Candidates that matched and were left out, with the reason (budget, status, lower rank). Bounded. */
  excluded: { nodeId: string; title: string; reason: string }[]
  /** 0..1: how sure the retriever is that it found what the task needs. Low means the breadth was widened. */
  confidence: number
  breadth: RetrievalBreadth
  /** True when low confidence or risk made the retriever widen beyond what was asked. */
  widened: boolean
  tokenEstimate: number
  /** Nodes considered before ranking. */
  considered: number
}

// ───────────────────────────── health and navigation views ─────────────────────────────

export interface ContextGraphHealth {
  space: ContextSpace
  nodes: number
  edges: number
  byStatus: Record<ContextStatus, number>
  byTrust: Record<ContextTrust, number>
  byType: Partial<Record<ContextNodeType, number>>
  /** Estimated tokens of every CURRENT node's title and summary: what a full dump would cost. */
  activeTokenEstimate: number
  lastRefresh: ContextRefreshJob | null
}

/** A node as the navigator shows it: itself, where it sits, and what hangs off it. */
export interface ContextNodeDetail {
  node: ContextNode
  /** Root first. */
  ancestors: Pick<ContextNode, 'id' | 'title' | 'path' | 'type'>[]
  children: ContextNode[]
  childrenTotal: number
  outgoing: { edge: ContextEdge; node: ContextNode }[]
  incoming: { edge: ContextEdge; node: ContextNode }[]
  sources: ContextNodeSource[]
  history: ContextNodeHistory[]
  versions: ContextNodeVersion[]
  /** The full text of the origin record, when the node projects one and it still exists. */
  originText: string | null
}

export const CONTEXT_SUMMARY_MAX_CHARS = 1_200
export const CONTEXT_BODY_MAX_CHARS = 16_000
export const CONTEXT_TITLE_MAX_CHARS = 200

/** `context://<kind>/<spaceId>/<path>`: the reference agents and messages use for a node. */
export function contextRef(node: Pick<ContextNode, 'spaceKind' | 'spaceId' | 'path'>): string {
  return `context://${node.spaceKind}/${node.spaceId}/${node.path}`
}

export function parseContextRef(ref: string): { space: ContextSpace; path: string } | null {
  const m = /^context:\/\/(project|workspace)\/([A-Za-z0-9_-]{1,64})\/(.*)$/.exec(ref.trim())
  if (!m) return null
  return { space: { kind: m[1] as ContextSpaceKind, id: m[2] as string }, path: m[3] as string }
}

/** Rank used to prefer more authoritative knowledge; lower is better. */
export function trustRank(trust: ContextTrust): number {
  return CONTEXT_TRUSTS.indexOf(trust)
}
