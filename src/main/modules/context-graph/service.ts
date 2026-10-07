import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONTEXT_BODY_MAX_CHARS,
  CONTEXT_STATUSES,
  CONTEXT_SUMMARY_MAX_CHARS,
  CONTEXT_TITLE_MAX_CHARS,
  CONTEXT_TRUSTS,
  type ContextEdge,
  type ContextEdgeType,
  type ContextGraphHealth,
  type ContextHistoryEvent,
  type ContextNode,
  type ContextNodeDetail,
  type ContextNodeType,
  type ContextProvenance,
  type ContextRefreshJob,
  type ContextSpace,
  type ContextStatus,
  type ContextTrust,
} from '@shared/context-graph'
import { newId, nowIso } from '@shared/ids'
import { NexusError, errorMessage } from '@shared/result'
import { estimateTokens } from '@shared/token'
import { isSecretPath } from '@main/modules/intelligence/walk'
import type { Repositories } from '@main/modules/persistence/repositories'
import { looksLikeInstruction } from '@main/modules/program/memory'
import { clip, depthOf, joinPath, normFile, parentPath, segment, sha, shortHash, subjectKey, validatePath } from './paths'
import { projectProject, projectWorkspace, type EdgeDraft, type NodeDraft, type Projection } from './projection'

/** State of a file as freshness sees it: size and mtime, or `missing`. Content is never read. */
export type FileStateReader = (rootPath: string, relativePath: string) => Promise<string>

export const defaultFileState: FileStateReader = async (rootPath, rel) => {
  if (rel.startsWith('..') || rel.includes('\0') || isSecretPath(rel)) return 'missing'
  try {
    const st = await lstat(join(rootPath, ...rel.split('/')))
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : 'missing'
  } catch {
    return 'missing'
  }
}

export interface ContextGraphDeps {
  repos: Repositories
  now?: () => string
  fileState?: FileStateReader
}

export interface SyncResult {
  space: ContextSpace
  created: number
  updated: number
  archived: number
  restored: number
  stale: number
  conflicts: number
  nodes: number
  edges: number
}

export interface NoteInput {
  space: ContextSpace
  programId?: string | null
  /** Folder under `notes/`, e.g. a task key. Sanitized into one path segment. */
  folder?: string | null
  title: string
  body: string
  evidence?: string | null
  /** What the note is a statement about (`command:test`, a module path), when it claims a fact. */
  about?: string | null
  /** `progress` notes are archived when their task is no longer open. */
  kind?: 'note' | 'progress'
  author: { source: string; runId?: string | null; taskId?: string | null; agentId?: string | null }
}

export type NoteRejection = 'instruction' | 'transcript' | 'empty' | 'too_long' | 'no_evidence'

const HISTORY: readonly ContextStatus[] = ['SUPERSEDED', 'ARCHIVED']
const EVERY_STATUS: readonly ContextStatus[] = CONTEXT_STATUSES
/** Service-made edges carry a `graph:` source; a projection never removes them. */
const isGraphEdge = (e: Pick<ContextEdge, 'provenance'>): boolean => e.provenance.source.startsWith('graph:')
const sameSpace = (a: ContextSpace, n: Pick<ContextNode, 'spaceKind' | 'spaceId'>): boolean => a.kind === n.spaceKind && a.id === n.spaceId

function hashOf(draft: Pick<NodeDraft, 'title' | 'summary' | 'type' | 'trust'>, body: string | null = null): string {
  return sha([draft.type, draft.trust, draft.title, draft.summary, body ?? ''].join('\0'))
}

/** Why a note is refused, or null. A note is a statement about the project, never an instruction to a later agent. */
export function validateNote(input: Pick<NoteInput, 'title' | 'body' | 'evidence' | 'about'>): NoteRejection | null {
  const title = input.title.trim()
  const body = input.body.trim()
  if (title === '' || body === '') return 'empty'
  if (title.length > CONTEXT_TITLE_MAX_CHARS || body.length > CONTEXT_BODY_MAX_CHARS || (input.evidence ?? '').length > CONTEXT_BODY_MAX_CHARS) return 'too_long'
  if (looksLikeInstruction([title, body, input.evidence ?? ''].join('\n'))) return 'instruction'
  if ((body.match(/^(user|assistant|human|agent|claude)\s*:/gim) ?? []).length >= 2) return 'transcript'
  // A note that claims a fact about a named subject needs evidence; a progress note about one's own task does not.
  if (input.about && (input.evidence ?? '').trim().length < 8) return 'no_evidence'
  return null
}

export class ContextGraphService {
  private readonly now: () => string
  private readonly fileState: FileStateReader

  constructor(private readonly deps: ContextGraphDeps) {
    this.now = deps.now ?? nowIso
    this.fileState = deps.fileState ?? defaultFileState
  }

  private get g() {
    return this.deps.repos.contextGraph
  }

  private tx<T>(fn: () => T): T {
    return this.deps.repos.transaction(fn)
  }

  // ───────────────────────────── sync ─────────────────────────────

  /** Rebuild a project's graph from its stores. Idempotent: a second call with unchanged stores changes nothing. */
  async syncProject(projectId: string): Promise<SyncResult> {
    const { repos } = this.deps
    const project = repos.projects.require(projectId)
    const programs = repos.programs.list({ projectId, limit: 200 }).map((program) => ({
      program,
      milestones: repos.milestones.listByProgram(program.id),
      memory: repos.programMemory.listAll(program.id),
      backlog: repos.backlog.list({ programId: program.id, limit: 200 }),
    }))
    const projection = projectProject({
      project,
      facts: repos.facts.listByProject(projectId, { includeStale: true }),
      memory: repos.memory.list({ projectId, scope: 'project', status: 'any', limit: 100_000 }),
      programs,
    })
    const profile = project.profile
    const stack = profile ? [...profile.languages, ...profile.frameworks].slice(0, 8).join(', ') : ''
    return this.apply(
      { kind: 'project', id: projectId },
      { type: 'REPOSITORY', title: project.name, lead: stack ? `Repository ${project.name} (${stack}).` : `Repository ${project.name}.`, originKind: 'project', originId: projectId },
      projection,
      project.rootPath,
    )
  }

  async syncWorkspace(workspaceId: string): Promise<SyncResult> {
    const { repos } = this.deps
    const workspace = repos.workspaces.require(workspaceId)
    const repositories = repos.enrolledRepositories.listByWorkspace(workspaceId)
    const projection = projectWorkspace({
      workspace,
      repositories,
      dependencies: repos.workspaceDependencies.listByWorkspace(workspaceId),
      contracts: repos.workspaceContracts.listByWorkspace(workspaceId).map((contract) => ({
        contract,
        consumers: repos.contractConsumers.listByContract(contract.id),
        latest: repos.contractVersions.listByContract(contract.id, 1)[0] ?? null,
      })),
      memory: repos.workspaceMemory.listByWorkspace(workspaceId, 500),
    })
    const result = await this.apply(
      { kind: 'workspace', id: workspaceId },
      { type: 'WORKSPACE', title: workspace.name, lead: workspace.description ? `Workspace ${workspace.name}: ${clip(workspace.description, 300)}` : `Workspace ${workspace.name}.`, originKind: 'workspace', originId: workspaceId },
      projection,
      null,
    )
    // A repository of the workspace is the same thing as the root of its project graph: link them when both exist.
    this.tx(() => {
      for (const r of repositories) {
        const from = this.g.nodes.byOrigin('workspace_repository', r.id)[0]
        const to = this.g.nodes.root({ kind: 'project', id: r.projectId })
        if (from && to) this.upsertEdge(from.id, to.id, 'DERIVED_FROM', 'VERIFIED', 'high', { source: 'graph:link', evidence: 'the enrolled repository is this NEXUS project' })
      }
    })
    return result
  }

  /** Apply a projection to a space: upsert nodes, archive what vanished, reconcile edges, rebuild summaries, find conflicts. */
  private async apply(
    space: ContextSpace,
    root: { type: ContextNodeType; title: string; lead: string; originKind: ContextNode['originKind']; originId: string },
    projection: Projection,
    rootPath: string | null,
  ): Promise<SyncResult> {
    const startedAt = this.now()
    // File states are read before the transaction: the transaction itself does no I/O outside SQLite.
    const states = new Map<string, string>()
    if (rootPath) {
      const files = new Set<string>()
      for (const d of projection.nodes) for (const s of d.sources) if (s.kind === 'file') files.add(s.ref)
      await Promise.all([...files].map(async (f) => states.set(f, await this.fileState(rootPath, f))))
    }
    const counts = { created: 0, updated: 0, archived: 0, restored: 0, stale: 0 }
    const result = this.tx(() => {
      const at = this.now()
      const ids = new Map<string, string>()
      const rootNode = this.upsertNode(space, { path: '', type: root.type, title: root.title, summary: root.lead, originKind: root.originKind, originId: root.originId, trust: 'GENERATED_SUMMARY', status: 'CURRENT', confidence: 'high', subjectKey: null, programId: null, provenance: { source: 'graph' }, sources: [], sourceUpdatedAt: null, derived: true }, null, states, at, counts, root.lead)
      ids.set('', rootNode.id)
      // Sorted by path, so a parent is always applied before its children.
      for (const draft of projection.nodes) {
        const up = parentPath(draft.path)
        const parentId = up === null ? null : (ids.get(up) ?? null)
        ids.set(draft.path, this.upsertNode(space, draft, parentId, states, at, counts, null).id)
      }
      this.archiveVanished(space, projection, ids, at, counts)
      this.reconcileEdges(space, projection.edges, ids, at)
      this.rebuildSummaries(space, at)
      const conflicts = this.detectConflicts(space, at)
      return { conflicts }
    })
    const health = this.health(space)
    this.g.jobs.insert({ id: newId(), spaceKind: space.kind, spaceId: space.id, trigger: 'sync', fromCommit: null, toCommit: null, changedFiles: 0, nodesChecked: projection.nodes.length, nodesStale: counts.stale, nodesRefreshed: counts.created + counts.updated + counts.restored, state: 'completed', error: null, startedAt, finishedAt: this.now() })
    return { space, ...counts, conflicts: result.conflicts, nodes: health.nodes, edges: health.edges }
  }

  private upsertNode(
    space: ContextSpace,
    draft: NodeDraft,
    parentId: string | null,
    states: ReadonlyMap<string, string>,
    at: string,
    counts: { created: number; updated: number; restored: number; stale: number },
    rootLead: string | null,
  ): ContextNode {
    const existing = this.g.nodes.byPath(space, draft.path)
    const contentHash = hashOf(draft)
    const tokenEstimate = estimateTokens(`${draft.title}\n${draft.summary}`)
    if (!existing) {
      const node: ContextNode = {
        id: newId(),
        spaceKind: space.kind,
        spaceId: space.id,
        programId: draft.programId,
        type: draft.type,
        path: draft.path,
        parentId,
        depth: depthOf(draft.path),
        title: draft.title,
        summary: draft.summary,
        body: null,
        originKind: draft.originKind,
        originId: draft.originId,
        trust: draft.trust,
        status: draft.status,
        confidence: draft.confidence,
        subjectKey: draft.subjectKey,
        contentHash,
        summaryHash: draft.derived ? '' : null,
        version: 1,
        tokenEstimate,
        classification: 'normal',
        provenance: draft.provenance,
        createdAt: at,
        updatedAt: at,
        sourceUpdatedAt: draft.sourceUpdatedAt,
        refreshedAt: at,
      }
      this.g.nodes.insert(node)
      this.g.sources.replace(node.id, space.id, draft.sources.map((s) => ({ ...s, hash: s.kind === 'file' ? (states.get(s.ref) ?? null) : s.hash })))
      this.record(node.id, 'created', `From ${draft.originKind}${draft.originId ? ` ${draft.originId.slice(0, 8)}` : ''}.`, at)
      if (draft.status === 'STALE') counts.stale++
      counts.created++
      return node
    }

    // A note or a user node already lives at this path: the projection does not own it.
    if (existing.originKind === 'graph' && (existing.type === 'NOTE' || existing.type === 'CUSTOM')) return existing

    // Freshness: a file that changed since the node's evidence was last accepted makes the node stale, unless
    // the origin record itself was re-verified (its record hash changed), in which case the new state is accepted.
    const before = this.g.sources.ofNode(existing.id)
    const beforeFiles = new Map(before.filter((s) => s.kind === 'file').map((s) => [s.ref, s.hash]))
    const beforeRecord = before.find((s) => s.kind === 'record')?.hash ?? null
    const afterRecord = draft.sources.find((s) => s.kind === 'record')?.hash ?? null
    const reverified = afterRecord !== null && afterRecord !== beforeRecord
    let changedFile: string | null = null
    if (states.size > 0 && !reverified) {
      for (const s of draft.sources) {
        if (s.kind !== 'file') continue
        const old = beforeFiles.get(s.ref)
        const cur = states.get(s.ref) ?? null
        if (old !== undefined && old !== null && cur !== null && old !== cur) {
          changedFile = s.ref
          break
        }
      }
    }
    let status: ContextStatus = draft.status
    if (status === 'CURRENT' && changedFile !== null) status = 'STALE'
    // Supersession is graph knowledge: a record that still says "active" does not undo it.
    // (Found by the history stress: a superseded node whose fact went stale became STALE, and from there current again.)
    if (existing.status === 'SUPERSEDED' && this.g.edges.incoming(existing.id, ['SUPERSEDES'], 1).length > 0) status = 'SUPERSEDED'

    const contentChanged = existing.contentHash !== contentHash
    const derived = draft.derived
    const patch: Partial<ContextNode> = {}
    if (contentChanged && !derived) {
      this.g.versions.insert({ id: newId(), nodeId: existing.id, version: existing.version, title: existing.title, summary: existing.summary, body: existing.body, trust: existing.trust, contentHash: existing.contentHash, createdAt: existing.updatedAt })
      Object.assign(patch, { title: draft.title, summary: draft.summary, trust: draft.trust, type: draft.type, contentHash, version: existing.version + 1, tokenEstimate, updatedAt: at })
      this.record(existing.id, 'updated', `Version ${existing.version + 1}: the ${draft.originKind} record changed.`, at)
      counts.updated++
    } else if (derived && existing.trust !== 'GENERATED_SUMMARY') {
      // A node that projected a record and is now only a container: its statement goes, a derived summary comes.
      Object.assign(patch, { title: draft.title, type: draft.type, trust: draft.trust, summary: '', summaryHash: '', contentHash, updatedAt: at })
    } else if (derived && (existing.title !== draft.title || existing.type !== draft.type || (rootLead !== null && !existing.summary.startsWith(rootLead)))) {
      // Sections keep their derived summary; only the title, the type and (for the root) the lead follow the draft.
      Object.assign(patch, { title: draft.title, type: draft.type, updatedAt: at, ...(rootLead !== null ? { summary: rootLead, summaryHash: '' } : {}) })
    }
    if (existing.status !== status) {
      // CONFLICTED is decided by the conflict pass after every node is in place; until then it is kept.
      if (!(existing.status === 'CONFLICTED' && status === 'CURRENT')) {
        patch.status = status
        patch.updatedAt = at
        if (existing.status === 'ARCHIVED') {
          this.record(existing.id, 'restored', 'The origin record exists again.', at)
          counts.restored++
        } else if (status === 'STALE') {
          this.record(existing.id, 'stale', changedFile ? `${changedFile} changed since the node was verified.` : 'The origin record is marked stale.', at)
        } else if (status === 'CURRENT' && existing.status === 'STALE') {
          this.record(existing.id, 'refreshed', 'The origin record was verified again.', at)
        } else if (status === 'SUPERSEDED') {
          this.record(existing.id, 'superseded', 'The origin record is marked superseded.', at)
        }
      }
    }
    if (status === 'STALE') counts.stale++
    if (existing.parentId !== parentId) patch.parentId = parentId
    if (existing.programId !== draft.programId) patch.programId = draft.programId
    if (existing.confidence !== draft.confidence) patch.confidence = draft.confidence
    if (existing.subjectKey !== draft.subjectKey) patch.subjectKey = draft.subjectKey
    if (existing.originId !== draft.originId || existing.originKind !== draft.originKind) Object.assign(patch, { originId: draft.originId, originKind: draft.originKind })
    if (existing.sourceUpdatedAt !== draft.sourceUpdatedAt) patch.sourceUpdatedAt = draft.sourceUpdatedAt
    if (JSON.stringify(existing.provenance) !== JSON.stringify(draft.provenance)) patch.provenance = draft.provenance
    if (status === 'CURRENT') patch.refreshedAt = at
    const node = Object.keys(patch).length > 0 ? this.g.nodes.update(existing.id, patch) : existing
    // A stale node keeps the file states it was verified against, so it stays stale until it is verified again.
    this.g.sources.replace(node.id, space.id, draft.sources.map((s) => ({ ...s, hash: s.kind === 'file' ? (status === 'STALE' ? (beforeFiles.get(s.ref) ?? states.get(s.ref) ?? null) : (states.get(s.ref) ?? beforeFiles.get(s.ref) ?? null)) : s.hash })))
    return node
  }

  private archiveVanished(space: ContextSpace, projection: Projection, ids: ReadonlyMap<string, string>, at: string, counts: { archived: number }): void {
    const kept = new Set(ids.values())
    for (let offset = 0; ; offset += 500) {
      const batch = this.g.nodes.listProjected(space, projection.owns, 500, offset)
      for (const node of batch) {
        if (kept.has(node.id) || node.status === 'ARCHIVED') continue
        this.g.nodes.update(node.id, { status: 'ARCHIVED', updatedAt: at })
        this.record(node.id, 'archived', 'The origin record no longer exists.', at)
        counts.archived++
      }
      if (batch.length < 500) break
    }
    // Containers the projection no longer produces, with nothing active left under them.
    const containers: ContextNode[] = []
    for (let offset = 0; ; offset += 500) {
      const batch = this.g.nodes.listDerived(space, 500, offset)
      containers.push(...batch.filter((node) => !kept.has(node.id) && node.path !== ''))
      if (batch.length < 500) break
    }
    // Deepest first (the listing order), so a branch emptied by archiving its last container is archived too.
    for (const node of containers) {
      if (this.g.nodes.countChildren(node.id) > 0) continue
      this.g.nodes.update(node.id, { status: 'ARCHIVED', updatedAt: at })
      this.record(node.id, 'archived', 'The branch is empty.', at)
      counts.archived++
    }
  }

  private reconcileEdges(space: ContextSpace, drafts: readonly EdgeDraft[], ids: ReadonlyMap<string, string>, at: string): void {
    const wanted = new Map<string, EdgeDraft & { fromId: string; toId: string }>()
    for (const d of drafts) {
      const fromId = ids.get(d.fromPath)
      const toId = ids.get(d.toPath)
      if (fromId && toId) wanted.set(`${fromId}\0${toId}\0${d.type}`, { ...d, fromId, toId })
    }
    for (let offset = 0; ; ) {
      const batch = this.g.edges.ofSpace(space, 500, offset)
      let removed = 0
      for (const e of batch) {
        if (isGraphEdge(e)) continue
        const key = `${e.fromId}\0${e.toId}\0${e.type}`
        const w = wanted.get(key)
        if (!w) {
          this.g.edges.delete(e.id)
          removed++
          continue
        }
        if (e.trust !== w.trust || e.confidence !== w.confidence || JSON.stringify(e.provenance) !== JSON.stringify(w.provenance)) this.g.edges.update(e.id, { trust: w.trust, confidence: w.confidence, provenance: w.provenance, updatedAt: at })
        wanted.delete(key)
      }
      if (batch.length < 500) break
      offset += 500 - removed
    }
    for (const w of wanted.values()) this.g.edges.insert({ id: newId(), fromId: w.fromId, toId: w.toId, type: w.type, trust: w.trust, confidence: w.confidence, provenance: w.provenance, createdAt: at, updatedAt: at })
  }

  private upsertEdge(fromId: string, toId: string, type: ContextEdgeType, trust: ContextTrust, confidence: ContextEdge['confidence'], provenance: ContextProvenance): ContextEdge {
    const at = this.now()
    const existing = this.g.edges.find(fromId, toId, type)
    if (existing) return existing
    return this.g.edges.insert({ id: newId(), fromId, toId, type, trust, confidence, provenance, createdAt: at, updatedAt: at })
  }

  // ───────────────────────────── summaries ─────────────────────────────

  /**
   * Summaries of sections and containers are computed from their children, deepest first: what kinds of
   * node the branch holds, how many, and the first names. No model writes them; a branch whose children did
   * not change keeps its summary (the hash of the children is compared).
   */
  private rebuildSummaries(space: ContextSpace, at: string, onlyIds?: ReadonlySet<string>): number {
    let changed = 0
    for (let offset = 0; ; offset += 500) {
      const batch = this.g.nodes.listDerived(space, 500, offset)
      for (const node of batch) {
        if (onlyIds && !onlyIds.has(node.id)) continue
        const children = this.g.nodes.children(node.id, { limit: 200 })
        const total = this.g.nodes.countChildren(node.id)
        const summaryHash = sha(`${total}\0${children.map((c) => `${c.id}:${c.contentHash}:${c.status}`).join('\0')}`)
        if (node.summaryHash === summaryHash) continue
        const lead = node.path === '' ? node.summary.split('\nContains: ')[0] ?? '' : ''
        const summary = clip(describeChildren(lead, children, total), CONTEXT_SUMMARY_MAX_CHARS)
        this.g.nodes.update(node.id, { summary, summaryHash, contentHash: hashOf({ type: node.type, trust: node.trust, title: node.title, summary }), tokenEstimate: estimateTokens(`${node.title}\n${summary}`), updatedAt: at })
        changed++
      }
      if (batch.length < 500) break
    }
    return changed
  }

  // ───────────────────────────── conflicts ─────────────────────────────

  /**
   * Two current nodes that claim the same subject with different content, with no SUPERSEDES edge between
   * them, are in conflict. Both are marked and linked; neither is silently preferred. Returns how many nodes
   * are CONFLICTED afterwards. Only the mechanical case is found: statements about one thing under two
   * different names are not compared.
   */
  private detectConflicts(space: ContextSpace, at: string): number {
    const conflicted = new Set<string>()
    for (const key of this.g.nodes.conflictingSubjects(space)) {
      const nodes = this.g.nodes.bySubject(space, key)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i] as ContextNode
          const b = nodes[j] as ContextNode
          if (a.contentHash === b.contentHash) continue
          // Knowledge of two different programs is not compared; program knowledge is compared with project knowledge.
          if (a.programId && b.programId && a.programId !== b.programId) continue
          if (this.g.edges.find(a.id, b.id, 'SUPERSEDES') || this.g.edges.find(b.id, a.id, 'SUPERSEDES')) continue
          conflicted.add(a.id)
          conflicted.add(b.id)
          this.upsertEdge(a.id, b.id, 'CONFLICTS_WITH', 'VERIFIED', 'high', { source: 'graph:conflict', evidence: `both state ${key} with different content` })
        }
      }
    }
    for (const id of conflicted) {
      const node = this.g.nodes.require(id)
      if (node.status !== 'CONFLICTED') {
        this.g.nodes.update(id, { status: 'CONFLICTED', updatedAt: at })
        this.record(id, 'conflicted', `Another current node states ${node.subjectKey ?? 'the same subject'} differently.`, at)
      }
    }
    for (let offset = 0; ; ) {
      const batch = this.g.nodes.listByStatus(space, 'CONFLICTED', 500, offset)
      let resolved = 0
      for (const node of batch) {
        if (conflicted.has(node.id)) continue
        this.g.nodes.update(node.id, { status: 'CURRENT', updatedAt: at })
        for (const e of [...this.g.edges.outgoing(node.id, ['CONFLICTS_WITH']), ...this.g.edges.incoming(node.id, ['CONFLICTS_WITH'])]) this.g.edges.delete(e.id)
        this.record(node.id, 'conflict_resolved', 'No other current node contradicts it any more.', at)
        resolved++
      }
      if (batch.length < 500) break
      offset += 500 - resolved
    }
    return conflicted.size
  }

  // ───────────────────────────── freshness ─────────────────────────────

  /**
   * Check file evidence and mark nodes STALE. With `changedFiles` only the nodes that name one of those
   * files are looked at (an index lookup); without it every file source of the space is checked.
   */
  async refresh(space: ContextSpace, rootPath: string, options: { changedFiles?: readonly string[]; fromCommit?: string | null; toCommit?: string | null; trigger?: ContextRefreshJob['trigger'] } = {}): Promise<ContextRefreshJob> {
    const startedAt = this.now()
    const cache = new Map<string, string>()
    const state = async (ref: string): Promise<string> => {
      let s = cache.get(ref)
      if (s === undefined) {
        s = await this.fileState(rootPath, ref)
        cache.set(ref, s)
      }
      return s
    }
    const stale = new Map<string, string>()
    let checked = 0
    const consider = async (nodeId: string, ref: string, hash: string | null): Promise<void> => {
      checked++
      if (hash === null || stale.has(nodeId)) return
      if ((await state(ref)) !== hash) stale.set(nodeId, ref)
    }
    try {
      if (options.changedFiles) {
        const files = [...new Set(options.changedFiles.map(normFile).filter((f) => f !== ''))]
        for (const hit of this.g.sources.nodesForFiles(space.id, files)) await consider(hit.nodeId, hit.ref, hit.hash)
      } else {
        for (let offset = 0; ; offset += 1000) {
          const batch = this.g.sources.fileSources(space.id, 1000, offset)
          for (const s of batch) await consider(s.nodeId, s.ref, s.hash)
          if (batch.length < 1000) break
        }
      }
      const marked = this.tx(() => {
        const at = this.now()
        let n = 0
        const touchedParents = new Set<string>()
        for (const [nodeId, ref] of stale) {
          const node = this.g.nodes.get(nodeId)
          if (!node || !sameSpace(space, node) || node.status !== 'CURRENT') continue
          this.g.nodes.update(nodeId, { status: 'STALE', updatedAt: at })
          this.record(nodeId, 'stale', `${ref} changed since the node was verified.`, at)
          n++
          for (const a of this.ancestorsOf(node)) touchedParents.add(a.id)
        }
        if (touchedParents.size > 0) this.rebuildSummaries(space, at, touchedParents)
        return n
      })
      return this.g.jobs.insert({ id: newId(), spaceKind: space.kind, spaceId: space.id, trigger: options.trigger ?? (options.changedFiles ? 'git_diff' : 'fingerprint'), fromCommit: options.fromCommit ?? null, toCommit: options.toCommit ?? null, changedFiles: options.changedFiles?.length ?? 0, nodesChecked: checked, nodesStale: marked, nodesRefreshed: 0, state: 'completed', error: null, startedAt, finishedAt: this.now() })
    } catch (e) {
      return this.g.jobs.insert({ id: newId(), spaceKind: space.kind, spaceId: space.id, trigger: options.trigger ?? 'fingerprint', fromCommit: options.fromCommit ?? null, toCommit: options.toCommit ?? null, changedFiles: options.changedFiles?.length ?? 0, nodesChecked: checked, nodesStale: 0, nodesRefreshed: 0, state: 'failed', error: errorMessage(e).slice(0, 500), startedAt, finishedAt: this.now() })
    }
  }

  /**
   * Incremental refresh from git: the files changed between the commit of the last refresh and HEAD, plus the
   * files changed in the working tree. Falls back to a full check when there is no earlier commit to diff from.
   */
  async refreshFromGit(space: ContextSpace, rootPath: string, git: { run(cwd: string, args: readonly string[], opts?: { okCodes?: number[] }): Promise<{ exitCode: number | null; stdout: string }> }): Promise<ContextRefreshJob> {
    let head: string | null
    try {
      const r = await git.run(rootPath, ['rev-parse', 'HEAD'], { okCodes: [0, 128] })
      head = r.exitCode === 0 ? r.stdout.trim() || null : null
    } catch {
      head = null
    }
    const last = this.g.jobs.latestWithCommit(space)
    if (!head || !last?.toCommit) return this.refresh(space, rootPath, { toCommit: head, trigger: 'fingerprint' })
    const changed = new Set<string>()
    try {
      if (last.toCommit !== head) {
        const diff = await git.run(rootPath, ['diff', '--name-only', '-z', last.toCommit, head], { okCodes: [0, 128] })
        if (diff.exitCode !== 0) return this.refresh(space, rootPath, { toCommit: head, trigger: 'fingerprint' })
        for (const f of diff.stdout.split('\0')) if (f.trim() !== '') changed.add(normFile(f))
      }
      const status = await git.run(rootPath, ['status', '--porcelain', '-z', '--untracked-files=no'], { okCodes: [0, 128] })
      for (const entry of status.stdout.split('\0')) if (entry.length > 3) changed.add(normFile(entry.slice(3)))
    } catch {
      return this.refresh(space, rootPath, { toCommit: head, trigger: 'fingerprint' })
    }
    return this.refresh(space, rootPath, { changedFiles: [...changed], fromCommit: last.toCommit, toCommit: head, trigger: 'git_diff' })
  }

  /** Accept a stale node's evidence as it is now: the user (or a verifier) looked and the statement still holds. */
  async reverify(nodeId: string, rootPath: string | null, by: string): Promise<ContextNode> {
    const node = this.g.nodes.require(nodeId)
    if (node.status !== 'STALE') return node
    const sources = this.g.sources.ofNode(nodeId)
    const states = new Map<string, string>()
    if (rootPath) for (const s of sources) if (s.kind === 'file') states.set(s.ref, await this.fileState(rootPath, s.ref))
    return this.tx(() => {
      const at = this.now()
      for (const [ref, hash] of states) this.g.sources.setHash(nodeId, 'file', ref, hash)
      const updated = this.g.nodes.update(nodeId, { status: 'CURRENT', refreshedAt: at, updatedAt: at })
      this.record(nodeId, 'refreshed', `Confirmed as still holding by ${clip(by, 60)}.`, at)
      this.rebuildSummaries({ kind: node.spaceKind, id: node.spaceId }, at, new Set(this.ancestorsOf(node).map((a) => a.id)))
      this.detectConflicts({ kind: node.spaceKind, id: node.spaceId }, at)
      return updated
    })
  }

  // ───────────────────────────── notes and other writes ─────────────────────────────

  /**
   * Store a note. Always AGENT_NOTE (or USER_PROVIDED for the user), never VERIFIED: speculation cannot become
   * durable truth by being written down. Throws `invalid_input` with the reason when the note is refused.
   */
  writeNote(input: NoteInput): ContextNode {
    const rejection = validateNote(input)
    if (rejection) throw new NexusError('invalid_input', NOTE_REJECTIONS[rejection], { rejection })
    const title = input.title.trim()
    const body = input.body.trim()
    const byUser = input.author.source === 'user'
    return this.tx(() => {
      const at = this.now()
      const space = input.space
      const root = this.g.nodes.root(space)
      if (!root) throw new NexusError('not_found', 'This project has no context graph yet')
      const folder = joinPath('notes', input.folder ? segment(input.folder) : 'general')
      const parent = this.ensureSection(space, folder, at)
      const trust: ContextTrust = byUser ? 'USER_PROVIDED' : 'AGENT_NOTE'
      const draft = { type: 'NOTE' as const, trust, title, summary: clip(body, CONTEXT_SUMMARY_MAX_CHARS) }
      const contentHash = hashOf(draft, body)
      // The same note written twice is one note.
      const twin = this.g.nodes.children(parent.id, { types: ['NOTE'], limit: 500 }).find((n) => n.contentHash === contentHash)
      if (twin) return twin
      const node: ContextNode = {
        id: newId(),
        spaceKind: space.kind,
        spaceId: space.id,
        programId: input.programId ?? null,
        type: 'NOTE',
        path: joinPath(folder, `${segment(title).slice(0, 60)}-${shortHash(`${title}\0${body}\0${at}`, 6)}`),
        parentId: parent.id,
        depth: depthOf(folder) + 1,
        title,
        summary: draft.summary,
        body,
        originKind: 'graph',
        originId: null,
        trust,
        status: 'CURRENT',
        confidence: byUser ? 'high' : 'low',
        subjectKey: input.about ? subjectKey('note', input.about) : null,
        contentHash,
        summaryHash: null,
        version: 1,
        tokenEstimate: estimateTokens(`${title}\n${body}`),
        classification: 'normal',
        provenance: { source: input.kind === 'progress' ? `${input.author.source}:progress` : input.author.source, runId: input.author.runId ?? null, taskId: input.author.taskId ?? null, agentId: input.author.agentId ?? null, evidence: input.evidence ?? null },
        createdAt: at,
        updatedAt: at,
        sourceUpdatedAt: null,
        refreshedAt: at,
      }
      this.g.nodes.insert(node)
      this.record(node.id, 'created', `Note written by ${clip(input.author.source, 40)}.`, at)
      this.rebuildSummaries(space, at, new Set(this.ancestorsOf(node).map((a) => a.id)))
      return node
    })
  }

  /** Replace a note's text. Only notes can be edited, and an agent only edits notes of its own run. */
  updateNote(nodeId: string, patch: { title?: string; body?: string }, by: { source: string; runId?: string | null }): ContextNode {
    const node = this.g.nodes.require(nodeId)
    this.assertEditableNote(node, by)
    const title = (patch.title ?? node.title).trim()
    const body = (patch.body ?? node.body ?? '').trim()
    const rejection = validateNote({ title, body, evidence: node.provenance.evidence ?? null, about: null })
    if (rejection) throw new NexusError('invalid_input', NOTE_REJECTIONS[rejection], { rejection })
    return this.tx(() => {
      const at = this.now()
      const summary = clip(body, CONTEXT_SUMMARY_MAX_CHARS)
      const contentHash = hashOf({ type: node.type, trust: node.trust, title, summary }, body)
      if (contentHash === node.contentHash) return node
      this.g.versions.insert({ id: newId(), nodeId, version: node.version, title: node.title, summary: node.summary, body: node.body, trust: node.trust, contentHash: node.contentHash, createdAt: node.updatedAt })
      const updated = this.g.nodes.update(nodeId, { title, body, summary, contentHash, version: node.version + 1, tokenEstimate: estimateTokens(`${title}\n${body}`), updatedAt: at })
      this.record(nodeId, 'updated', `Version ${node.version + 1}: edited by ${clip(by.source, 40)}.`, at)
      return updated
    })
  }

  private assertEditableNote(node: ContextNode, by: { source: string; runId?: string | null }): void {
    if (node.type !== 'NOTE' || node.originKind !== 'graph') throw new NexusError('invalid_state', 'Only notes can be edited through the graph. Facts, memory and contracts change in the stores that own them.')
    if (by.source === 'user') return
    if (node.trust !== 'AGENT_NOTE') throw new NexusError('invalid_state', 'This note was promoted or written by the user: an agent cannot change it.')
    if (!by.runId || node.provenance.runId !== by.runId) throw new NexusError('invalid_state', 'An agent can change only the notes written in its own run.')
  }

  /**
   * Raise a note's trust. `user` makes it USER_PROVIDED; `verifier` makes it VERIFIED and needs evidence.
   * Nothing else can be promoted here: a memory entry is approved in the memory store.
   */
  promoteNote(nodeId: string, by: 'user' | 'verifier', evidence: string | null): ContextNode {
    const node = this.g.nodes.require(nodeId)
    if (node.type !== 'NOTE' || node.originKind !== 'graph') throw new NexusError('invalid_state', 'Only notes are promoted in the graph.')
    if (by === 'verifier' && (evidence ?? '').trim().length < 8) throw new NexusError('invalid_input', 'A verifier promotes a note only with evidence.')
    if (evidence && looksLikeInstruction(evidence)) throw new NexusError('invalid_input', NOTE_REJECTIONS.instruction)
    const trust: ContextTrust = by === 'user' ? 'USER_PROVIDED' : 'VERIFIED'
    if (node.trust === trust) return node
    return this.tx(() => {
      const at = this.now()
      this.g.versions.insert({ id: newId(), nodeId, version: node.version, title: node.title, summary: node.summary, body: node.body, trust: node.trust, contentHash: node.contentHash, createdAt: node.updatedAt })
      const updated = this.g.nodes.update(nodeId, {
        trust,
        confidence: 'high',
        contentHash: hashOf({ type: node.type, trust, title: node.title, summary: node.summary }, node.body),
        version: node.version + 1,
        provenance: { ...node.provenance, evidence: evidence ?? node.provenance.evidence ?? null },
        updatedAt: at,
      })
      this.record(nodeId, 'promoted', `${node.trust} to ${trust} by the ${by}.`, at)
      this.detectConflicts({ kind: node.spaceKind, id: node.spaceId }, at)
      return updated
    })
  }

  /** `newer` replaces `older`. The older node stays as history and leaves active retrieval. */
  supersede(olderId: string, newerId: string, reason: string): void {
    const older = this.g.nodes.require(olderId)
    const newer = this.g.nodes.require(newerId)
    if (older.id === newer.id) throw new NexusError('invalid_input', 'A node cannot supersede itself')
    if (older.spaceKind !== newer.spaceKind || older.spaceId !== newer.spaceId) throw new NexusError('invalid_state', 'Supersession stays inside one project or workspace')
    this.tx(() => {
      const at = this.now()
      this.upsertEdge(newer.id, older.id, 'SUPERSEDES', 'USER_PROVIDED', 'high', { source: 'graph:supersede', evidence: clip(reason, 300) })
      if (older.status !== 'SUPERSEDED') {
        this.g.nodes.update(older.id, { status: 'SUPERSEDED', updatedAt: at })
        this.record(older.id, 'superseded', `By ${newer.title}: ${clip(reason, 200)}`, at)
      }
      const space = { kind: older.spaceKind, id: older.spaceId }
      this.rebuildSummaries(space, at, new Set(this.ancestorsOf(older).map((a) => a.id)))
      this.detectConflicts(space, at)
    })
  }

  archive(nodeId: string, reason: string): ContextNode {
    const node = this.g.nodes.require(nodeId)
    if (node.status === 'ARCHIVED') return node
    if (node.path === '') throw new NexusError('invalid_state', 'The root of a graph cannot be archived')
    return this.tx(() => {
      const at = this.now()
      const updated = this.g.nodes.update(nodeId, { status: 'ARCHIVED', updatedAt: at })
      this.record(nodeId, 'archived', clip(reason, 300), at)
      const space = { kind: node.spaceKind, id: node.spaceId }
      this.rebuildSummaries(space, at, new Set(this.ancestorsOf(node).map((a) => a.id)))
      this.detectConflicts(space, at)
      return updated
    })
  }

  /** Archive a note on an agent's request. The same ownership rule as an edit. */
  archiveNote(nodeId: string, by: { source: string; runId?: string | null }, reason: string): ContextNode {
    this.assertEditableNote(this.g.nodes.require(nodeId), by)
    return this.archive(nodeId, reason)
  }

  // ───────────────────────────── hygiene ─────────────────────────────

  /**
   * Take junk out of active retrieval. Nothing is deleted: every node touched becomes ARCHIVED and stays
   * readable as history.
   *  - a note that repeats another note's content;
   *  - a progress note whose task is no longer open.
   */
  collectGarbage(space: ContextSpace, isTaskOpen: (taskId: string) => boolean): { duplicates: number; obsoleteProgress: number } {
    return this.tx(() => {
      const at = this.now()
      let duplicates = 0
      let obsoleteProgress = 0
      const seen = new Map<string, string>()
      const touched = new Set<string>()
      for (let offset = 0; ; ) {
        const batch = this.g.nodes.listBySpace(space, { types: ['NOTE'], statuses: ['CURRENT'], limit: 500, offset })
        let archived = 0
        for (const note of batch) {
          const first = seen.get(note.contentHash)
          let reason: string | null = null
          if (first && first !== note.id) {
            reason = 'Duplicate of an earlier note.'
            duplicates++
          } else if (note.provenance.source.endsWith(':progress') && note.provenance.taskId && !isTaskOpen(note.provenance.taskId)) {
            reason = 'Progress note of a task that is no longer open.'
            obsoleteProgress++
          } else {
            seen.set(note.contentHash, note.id)
          }
          if (reason) {
            this.g.nodes.update(note.id, { status: 'ARCHIVED', updatedAt: at })
            this.record(note.id, 'archived', reason, at)
            for (const a of this.ancestorsOf(note)) touched.add(a.id)
            archived++
          }
        }
        if (batch.length < 500) break
        offset += 500 - archived
      }
      if (touched.size > 0) this.rebuildSummaries(space, at, touched)
      return { duplicates, obsoleteProgress }
    })
  }

  /**
   * Fold many notes of one branch into a single current note. The folded notes are archived and stay linked
   * (DERIVED_FROM), so every one of them can still be read. The text is assembled from the notes themselves.
   */
  compactNotes(parentId: string, minimum = 12): ContextNode | null {
    const parent = this.g.nodes.require(parentId)
    const notes = this.g.nodes.children(parentId, { types: ['NOTE'], statuses: ['CURRENT'], limit: 500 }).filter((n) => n.trust === 'AGENT_NOTE')
    if (notes.length < minimum) return null
    const space = { kind: parent.spaceKind, id: parent.spaceId }
    return this.tx(() => {
      const at = this.now()
      const ordered = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      const body = clip(ordered.map((n) => `- ${n.title}: ${firstSentence(n.body ?? n.summary)}`).join('\n'), CONTEXT_BODY_MAX_CHARS)
      const title = `Summary of ${ordered.length} notes`
      const node: ContextNode = {
        id: newId(),
        spaceKind: space.kind,
        spaceId: space.id,
        programId: parent.programId,
        type: 'NOTE',
        path: joinPath(parent.path, `summary-${shortHash(`${parent.id}\0${at}\0${ordered.length}`, 6)}`),
        parentId: parent.id,
        depth: parent.depth + 1,
        title,
        summary: clip(body, CONTEXT_SUMMARY_MAX_CHARS),
        body,
        originKind: 'graph',
        originId: null,
        trust: 'GENERATED_SUMMARY',
        status: 'CURRENT',
        confidence: 'low',
        subjectKey: null,
        contentHash: sha(`NOTE\0GENERATED_SUMMARY\0${title}\0${body}`),
        summaryHash: null,
        version: 1,
        tokenEstimate: estimateTokens(`${title}\n${body}`),
        classification: 'normal',
        provenance: { source: 'graph' },
        createdAt: at,
        updatedAt: at,
        sourceUpdatedAt: null,
        refreshedAt: at,
      }
      this.g.nodes.insert(node)
      this.record(node.id, 'created', `Compaction of ${ordered.length} notes.`, at)
      for (const n of ordered) {
        this.upsertEdge(node.id, n.id, 'DERIVED_FROM', 'VERIFIED', 'high', { source: 'graph:compaction' })
        this.g.nodes.update(n.id, { status: 'ARCHIVED', updatedAt: at })
        this.record(n.id, 'compacted', `Folded into "${title}".`, at)
      }
      this.rebuildSummaries(space, at, new Set([parent.id, ...this.ancestorsOf(parent).map((a) => a.id)]))
      return node
    })
  }

  private ensureSection(space: ContextSpace, path: string, at: string): ContextNode {
    const existing = this.g.nodes.byPath(space, path)
    if (existing) {
      if (existing.status === 'ARCHIVED') return this.g.nodes.update(existing.id, { status: 'CURRENT', updatedAt: at })
      return existing
    }
    const up = parentPath(path)
    const parent = up === null ? null : up === '' ? this.g.nodes.root(space) : this.ensureSection(space, up, at)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const title = name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_.]+/g, ' ')
    return this.g.nodes.insert({
      id: newId(),
      spaceKind: space.kind,
      spaceId: space.id,
      programId: null,
      type: 'SECTION',
      path,
      parentId: parent?.id ?? null,
      depth: depthOf(path),
      title,
      summary: '',
      body: null,
      originKind: 'graph',
      originId: null,
      trust: 'GENERATED_SUMMARY',
      status: 'CURRENT',
      confidence: 'high',
      subjectKey: null,
      contentHash: sha(`SECTION\0${title}`),
      summaryHash: '',
      version: 1,
      tokenEstimate: estimateTokens(title),
      classification: 'normal',
      provenance: { source: 'graph' },
      createdAt: at,
      updatedAt: at,
      sourceUpdatedAt: null,
      refreshedAt: at,
    })
  }

  private record(nodeId: string, event: ContextHistoryEvent, detail: string, at: string): void {
    this.g.history.insert({ id: newId(), nodeId, event, detail, createdAt: at })
  }

  // ───────────────────────────── navigation ─────────────────────────────

  /** A node, when it lies in one of the allowed spaces. Anything else reads as not found: a scope never leaks existence. */
  getNode(nodeId: string, allowed: readonly ContextSpace[]): ContextNode {
    const node = this.g.nodes.get(nodeId)
    if (!node || !allowed.some((s) => sameSpace(s, node))) throw new NexusError('not_found', 'Context node not found')
    return node
  }

  getByPath(space: ContextSpace, path: string, allowed: readonly ContextSpace[]): ContextNode {
    if (!allowed.some((s) => s.kind === space.kind && s.id === space.id)) throw new NexusError('not_found', 'Context node not found')
    const node = this.g.nodes.byPath(space, validatePath(path))
    if (!node) throw new NexusError('not_found', 'Context node not found')
    return node
  }

  root(space: ContextSpace): ContextNode | null {
    return this.g.nodes.root(space)
  }

  getChildren(nodeId: string, allowed: readonly ContextSpace[], options: { includeHistory?: boolean; limit?: number; offset?: number; types?: ContextNodeType[] } = {}): { children: ContextNode[]; total: number } {
    const node = this.getNode(nodeId, allowed)
    const statuses = options.includeHistory ? EVERY_STATUS : undefined
    return { children: this.g.nodes.children(node.id, { ...options, ...(statuses ? { statuses } : {}) }), total: this.g.nodes.countChildren(node.id, statuses) }
  }

  /** Ancestors, root first. */
  getPath(nodeId: string, allowed: readonly ContextSpace[]): ContextNode[] {
    return this.ancestorsOf(this.getNode(nodeId, allowed))
  }

  private ancestorsOf(node: ContextNode): ContextNode[] {
    const out: ContextNode[] = []
    let cur: ContextNode | null = node
    for (let i = 0; i < 32 && cur?.parentId; i++) {
      cur = this.g.nodes.get(cur.parentId)
      if (cur) out.unshift(cur)
    }
    return out
  }

  /** Nodes one edge away, in the allowed spaces only: an edge into a space the caller may not read is not followed. */
  getNeighbors(nodeId: string, allowed: readonly ContextSpace[], options: { types?: ContextEdgeType[]; includeHistory?: boolean; limit?: number } = {}): { outgoing: { edge: ContextEdge; node: ContextNode }[]; incoming: { edge: ContextEdge; node: ContextNode }[] } {
    const node = this.getNode(nodeId, allowed)
    const limit = options.limit ?? 50
    const visible = (n: ContextNode | undefined): n is ContextNode => !!n && allowed.some((s) => sameSpace(s, n)) && (options.includeHistory === true || !HISTORY.includes(n.status))
    const out = this.g.edges.outgoing(node.id, options.types, limit)
    const inc = this.g.edges.incoming(node.id, options.types, limit)
    const byId = new Map(this.g.nodes.getMany([...out.map((e) => e.toId), ...inc.map((e) => e.fromId)]).map((n) => [n.id, n]))
    return {
      outgoing: out.flatMap((edge) => (visible(byId.get(edge.toId)) ? [{ edge, node: byId.get(edge.toId) as ContextNode }] : [])),
      incoming: inc.flatMap((edge) => (visible(byId.get(edge.fromId)) ? [{ edge, node: byId.get(edge.fromId) as ContextNode }] : [])),
    }
  }

  getSources(nodeId: string, allowed: readonly ContextSpace[]) {
    return this.g.sources.ofNode(this.getNode(nodeId, allowed).id)
  }

  getHistory(nodeId: string, allowed: readonly ContextSpace[]) {
    const node = this.getNode(nodeId, allowed)
    return { history: this.g.history.ofNode(node.id), versions: this.g.versions.ofNode(node.id) }
  }

  search(allowed: readonly ContextSpace[], text: string, options: { includeHistory?: boolean; limit?: number; types?: ContextNodeType[] } = {}): ContextNode[] {
    return this.g.nodes.search(allowed, text, { limit: options.limit ?? 20, ...(options.types ? { types: options.types } : {}), ...(options.includeHistory ? { statuses: EVERY_STATUS } : {}) }).map((h) => h.node)
  }

  /** The subtree under a node, breadth first, to `depth` levels and at most `limit` nodes. */
  expand(nodeId: string, allowed: readonly ContextSpace[], depth = 1, limit = 60): ContextNode[] {
    const start = this.getNode(nodeId, allowed)
    const max = Math.max(1, Math.min(200, limit))
    const out: ContextNode[] = []
    let level = [start]
    for (let d = 0; d < Math.max(1, Math.min(4, depth)) && level.length > 0 && out.length < max; d++) {
      const next: ContextNode[] = []
      for (const n of level) {
        if (out.length >= max) break
        const children = this.g.nodes.children(n.id, { limit: Math.min(100, max - out.length) })
        out.push(...children)
        next.push(...children)
      }
      level = next
    }
    return out.slice(0, max)
  }

  detail(nodeId: string, allowed: readonly ContextSpace[], options: { includeHistory?: boolean } = {}): ContextNodeDetail {
    const node = this.getNode(nodeId, allowed)
    const { children, total } = this.getChildren(nodeId, allowed, { includeHistory: options.includeHistory ?? false, limit: 200 })
    const neighbors = this.getNeighbors(nodeId, allowed, { includeHistory: true })
    return {
      node,
      ancestors: this.ancestorsOf(node).map((a) => ({ id: a.id, title: a.title, path: a.path, type: a.type })),
      children,
      childrenTotal: total,
      outgoing: neighbors.outgoing,
      incoming: neighbors.incoming,
      sources: this.g.sources.ofNode(node.id),
      history: this.g.history.ofNode(node.id),
      versions: this.g.versions.ofNode(node.id),
      originText: this.originText(node),
    }
  }

  /** The full text of the record a node projects. The summary is an index entry; this is the statement itself. */
  originText(node: ContextNode): string | null {
    const { repos } = this.deps
    if (node.originKind === 'graph') return node.body
    if (!node.originId) return null
    try {
      switch (node.originKind) {
        case 'repository_fact': {
          const f = repos.facts.get(node.originId)
          return f ? `${f.statement}\nSupporting files: ${f.files.join(', ') || '(none)'}` : null
        }
        case 'memory': {
          const m = repos.memory.get(node.originId)
          return m ? `${m.content}${m.evidence ? `\nEvidence: ${m.evidence}` : ''}${m.filePaths.length > 0 ? `\nFiles: ${m.filePaths.join(', ')}` : ''}` : null
        }
        case 'program_memory': {
          const m = repos.programMemory.get(node.originId)
          return m ? `${m.content}\nEvidence: ${m.evidence}` : null
        }
        case 'workspace_memory': {
          const m = repos.workspaceMemory.get(node.originId)
          return m ? `${m.content}\nEvidence: ${m.evidence}\nRepositories: ${m.repositories.join(', ')}` : null
        }
        case 'backlog_item': {
          const item = repos.backlog.get(node.originId)
          return item ? `${item.description}\nEvidence: ${item.evidence}` : null
        }
        case 'program_milestone': {
          const m = repos.milestones.get(node.originId)
          return m ? `${m.objective}\nAcceptance criteria:\n${m.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : null
        }
        default:
          return null
      }
    } catch {
      return null
    }
  }

  health(space: ContextSpace): ContextGraphHealth {
    const byStatus = Object.fromEntries(CONTEXT_STATUSES.map((s) => [s, 0])) as Record<ContextStatus, number>
    for (const r of this.g.nodes.countByStatus(space)) if (r.status in byStatus) byStatus[r.status as ContextStatus] = r.n
    const byTrust = Object.fromEntries(CONTEXT_TRUSTS.map((t) => [t, 0])) as Record<ContextTrust, number>
    for (const r of this.g.nodes.countByTrust(space)) if (r.trust in byTrust) byTrust[r.trust as ContextTrust] = r.n
    const byType: ContextGraphHealth['byType'] = {}
    for (const r of this.g.nodes.countByType(space)) byType[r.type as ContextNodeType] = r.n
    return {
      space,
      nodes: Object.values(byStatus).reduce((a, b) => a + b, 0),
      edges: this.g.nodes.countEdges(space),
      byStatus,
      byTrust,
      byType,
      activeTokenEstimate: this.g.nodes.activeTokenEstimate(space),
      lastRefresh: this.g.jobs.latest(space),
    }
  }

  /** The spaces a task in a project may read: the project itself and every workspace that enrols it. */
  spacesForProject(projectId: string): ContextSpace[] {
    const spaces: ContextSpace[] = [{ kind: 'project', id: projectId }]
    const seen = new Set<string>()
    for (const r of this.deps.repos.enrolledRepositories.listByProject(projectId)) {
      if (seen.has(r.workspaceId)) continue
      seen.add(r.workspaceId)
      spaces.push({ kind: 'workspace', id: r.workspaceId })
    }
    return spaces
  }
}

const NOTE_REJECTIONS: Record<NoteRejection, string> = {
  instruction: 'A note is a statement about the project. Text addressed to a later agent, or a command to run, is not stored.',
  transcript: 'A note is a fact, not a transcript.',
  empty: 'A note needs a title and a body.',
  too_long: `A note's title is at most ${CONTEXT_TITLE_MAX_CHARS} characters and its body at most ${CONTEXT_BODY_MAX_CHARS}.`,
  no_evidence: 'A note that states a fact about a named subject needs evidence (a file and line, a command and its output).',
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  return clip(end > 0 ? flat.slice(0, end + 1) : flat, 240)
}

const PLURAL: Partial<Record<ContextNodeType, string>> = {
  SECTION: 'sections',
  MODULE: 'modules',
  ARCHITECTURE: 'architecture facts',
  COMPONENT: 'components',
  SYMBOL: 'interfaces',
  CONTRACT: 'contracts',
  DECISION: 'decisions',
  RULE: 'rules',
  COMMAND: 'commands',
  TEST: 'test mappings',
  ISSUE: 'issues',
  HAZARD: 'hazards',
  PROGRAM: 'programs',
  MILESTONE: 'milestones',
  BACKLOG: 'backlog items',
  OUTCOME: 'outcomes',
  MEMORY: 'memory entries',
  NOTE: 'notes',
  REPOSITORY: 'repositories',
}

/** "Contains: 4 modules (src/main, src/renderer, ...); 2 hazards (...)". Counts say how many are stale or in conflict. */
function describeChildren(lead: string, children: readonly ContextNode[], total: number): string {
  if (total === 0) return lead || 'Empty.'
  const groups = new Map<ContextNodeType, ContextNode[]>()
  for (const c of children) groups.set(c.type, [...(groups.get(c.type) ?? []), c])
  const parts = [...groups.entries()].map(([type, list]) => {
    const names = list.slice(0, 6).map((n) => n.title)
    const flagged = list.filter((n) => n.status !== 'CURRENT').length
    return `${list.length} ${PLURAL[type] ?? `${type.toLowerCase()} nodes`}${flagged > 0 ? ` (${flagged} stale or in conflict)` : ''}: ${names.join(', ')}${list.length > names.length ? ', …' : ''}`
  })
  const more = total > children.length ? `; ${total - children.length} more` : ''
  const body = `Contains: ${parts.join('; ')}${more}.`
  return lead ? `${lead}\n${body}` : body
}
