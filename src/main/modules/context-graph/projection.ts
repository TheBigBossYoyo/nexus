import type { MemoryEntry, Project } from '@shared/domain'
import {
  CONTEXT_SUMMARY_MAX_CHARS,
  CONTEXT_TITLE_MAX_CHARS,
  type ContextConfidence,
  type ContextEdgeType,
  type ContextNodeType,
  type ContextOriginKind,
  type ContextProvenance,
  type ContextSourceKind,
  type ContextStatus,
  type ContextTrust,
} from '@shared/context-graph'
import type { BacklogItem, Milestone, Program, ProgramMemoryEntry } from '@shared/program'
import type { RepositoryFact } from '@shared/v2'
import type { Contract, ContractConsumer, ContractVersion, CrossRepoDependency, Workspace, WorkspaceMemoryEntry, WorkspaceRepository } from '@shared/workspace'
import { moduleOf } from '@main/modules/intelligence/analyze'
import { clip, joinPath, normFile, parentPath, segment, shortHash, subjectKey } from './paths'

/**
 * Projection: stored records in, graph drafts out. Pure and deterministic: the same records always give
 * the same drafts, in the same order, so applying a projection twice changes nothing.
 *
 * No relation is guessed. An edge exists only where a record states it (an import relation, a test
 * mapping, a contract's provider and consumers) or where a record names files that a module contains.
 */

export interface NodeDraft {
  path: string
  type: ContextNodeType
  title: string
  summary: string
  originKind: ContextOriginKind
  originId: string | null
  trust: ContextTrust
  status: ContextStatus
  confidence: ContextConfidence
  subjectKey: string | null
  programId: string | null
  provenance: ContextProvenance
  /** Evidence. `file` sources get their observed state from the service when the draft is applied. */
  sources: { kind: ContextSourceKind; ref: string; hash: string | null }[]
  sourceUpdatedAt: string | null
  /** True for sections and implicit containers: the summary is rebuilt from the children. */
  derived: boolean
}

export interface EdgeDraft {
  fromPath: string
  toPath: string
  type: ContextEdgeType
  trust: ContextTrust
  confidence: ContextConfidence
  provenance: ContextProvenance
}

export interface Projection {
  nodes: NodeDraft[]
  edges: EdgeDraft[]
  /** Origin kinds this projection owns: a projected node of one of these kinds that is not in `nodes` is archived. */
  owns: ContextOriginKind[]
}

const SECTION_TITLES: Record<string, string> = {
  architecture: 'Architecture',
  'architecture/stack': 'Stack',
  'architecture/entry-points': 'Entry points',
  'architecture/dependencies': 'Dependencies',
  'architecture/boundaries': 'Boundaries',
  'architecture/generated': 'Generated paths',
  modules: 'Modules',
  commands: 'Commands',
  decisions: 'Decisions',
  hazards: 'Known hazards',
  memory: 'Project memory',
  programs: 'Programs',
  notes: 'Notes',
  repositories: 'Repositories',
  contracts: 'Contracts',
  standards: 'Standards',
}

class Builder {
  readonly nodes = new Map<string, NodeDraft>()
  readonly edges = new Map<string, EdgeDraft>()

  /** A section or container, created once. Its ancestors are created with it. */
  section(path: string, title?: string, type: ContextNodeType = 'SECTION'): void {
    if (path === '' || this.nodes.has(path)) return
    const up = parentPath(path)
    if (up !== null && up !== '') this.section(up)
    const name = title ?? SECTION_TITLES[path] ?? titleFromSegment(path)
    this.nodes.set(path, {
      path,
      type,
      title: name,
      summary: '',
      originKind: 'graph',
      originId: null,
      trust: 'GENERATED_SUMMARY',
      status: 'CURRENT',
      confidence: 'high',
      subjectKey: null,
      programId: null,
      provenance: { source: 'graph' },
      sources: [],
      sourceUpdatedAt: null,
      derived: true,
    })
  }

  /** Adds a node under `parent` with a segment made from `name`; a clash with another record gets a hash suffix. */
  add(parent: string, name: string, draft: Omit<NodeDraft, 'path' | 'derived'>): string {
    this.section(parent)
    let path = joinPath(parent, segment(name))
    const existing = this.nodes.get(path)
    if (existing && !(existing.originKind === draft.originKind && existing.originId === draft.originId)) {
      path = joinPath(parent, `${segment(name).slice(0, 60)}-${shortHash(`${draft.originKind}:${draft.originId ?? name}`, 6)}`)
    }
    this.nodes.set(path, { ...draft, path, title: clip(draft.title, CONTEXT_TITLE_MAX_CHARS), summary: clip(draft.summary, CONTEXT_SUMMARY_MAX_CHARS), derived: false })
    return path
  }

  edge(e: EdgeDraft): void {
    if (e.fromPath === e.toPath) return
    const key = `${e.fromPath}\0${e.toPath}\0${e.type}`
    if (!this.edges.has(key)) this.edges.set(key, e)
  }

  result(owns: ContextOriginKind[]): Projection {
    // Edges whose ends did not both materialize are dropped: an edge never points at nothing.
    const edges = [...this.edges.values()].filter((e) => (e.fromPath === '' || this.nodes.has(e.fromPath)) && (e.toPath === '' || this.nodes.has(e.toPath)))
    return { nodes: [...this.nodes.values()].sort((a, b) => a.path.localeCompare(b.path)), edges: edges.sort((a, b) => `${a.fromPath}\0${a.toPath}\0${a.type}`.localeCompare(`${b.fromPath}\0${b.toPath}\0${b.type}`)), owns }
  }
}

function titleFromSegment(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1).replace(/[-_.]+/g, ' ')
  return last.charAt(0).toUpperCase() + last.slice(1)
}

// ───────────────────────────── repository facts ─────────────────────────────

/** Analysis that observed the repository is verified; a low-confidence guess of the analyzer is an inference. */
export function trustOfFact(fact: Pick<RepositoryFact, 'source' | 'confidence'>): ContextTrust {
  if (fact.source === 'user') return 'USER_PROVIDED'
  if (fact.source === 'agent') return 'AGENT_NOTE'
  if (fact.confidence === 'low') return 'INFERRED'
  return 'VERIFIED'
}

const modulePath = (module: string): string => joinPath('modules', module === '.' ? 'root' : segment(module))

function moduleTitle(module: string): string {
  return module === '.' ? '(repository root)' : module
}

/** The module a file belongs to, as the analyzer defines modules. */
function moduleOfFile(file: string): string {
  return moduleOf(normFile(file))
}

function factNode(fact: RepositoryFact, type: ContextNodeType, title: string): Omit<NodeDraft, 'path' | 'derived'> {
  return {
    type,
    title,
    summary: fact.statement,
    originKind: 'repository_fact',
    originId: fact.id,
    trust: trustOfFact(fact),
    status: fact.stale ? 'STALE' : 'CURRENT',
    confidence: fact.confidence,
    subjectKey: subjectKey(fact.kind, fact.subject),
    programId: null,
    provenance: { source: fact.source },
    sources: [
      { kind: 'record', ref: `repository_facts:${fact.id}`, hash: fact.fingerprint },
      ...[...new Set(fact.files.map(normFile))].filter((f) => f !== '').map((f) => ({ kind: 'file' as const, ref: f, hash: null })),
    ],
    sourceUpdatedAt: fact.verifiedAt,
  }
}

/** Edge type from a module to a piece of knowledge that names files inside it. */
const FILE_LINK: Partial<Record<ContextNodeType, ContextEdgeType>> = {
  HAZARD: 'AFFECTED_BY',
  DECISION: 'DECIDED_BY',
  ISSUE: 'AFFECTED_BY',
  CONTRACT: 'IMPLEMENTS',
}

function addFacts(b: Builder, facts: readonly RepositoryFact[]): void {
  const sorted = [...facts].sort((x, y) => (x.kind === y.kind ? x.subject.localeCompare(y.subject) : x.kind.localeCompare(y.kind)) || x.id.localeCompare(y.id))

  // Modules first: everything else hangs off them.
  const moduleFacts = new Map<string, RepositoryFact>()
  for (const f of sorted) if (f.kind === 'module') moduleFacts.set(f.subject, f)
  const ensureModule = (module: string): string => {
    const path = modulePath(module)
    if (b.nodes.has(path)) return path
    b.section('modules')
    const fact = moduleFacts.get(module)
    if (fact) {
      b.nodes.set(path, { ...factNode(fact, 'MODULE', moduleTitle(module)), path, derived: false, summary: clip(fact.statement, CONTEXT_SUMMARY_MAX_CHARS) })
    } else {
      // No module fact: a container that exists only because records name files in it.
      b.nodes.set(path, {
        path,
        type: 'MODULE',
        title: moduleTitle(module),
        summary: '',
        originKind: 'graph',
        originId: null,
        trust: 'GENERATED_SUMMARY',
        status: 'CURRENT',
        confidence: 'low',
        subjectKey: subjectKey('module', module),
        programId: null,
        provenance: { source: 'graph' },
        sources: [],
        sourceUpdatedAt: null,
        derived: true,
      })
    }
    return path
  }
  for (const module of [...moduleFacts.keys()].sort()) ensureModule(module)

  for (const f of sorted) {
    switch (f.kind) {
      case 'module':
        break
      case 'language':
      case 'framework':
        b.add('architecture/stack', `${f.kind}-${f.subject}`, factNode(f, 'ARCHITECTURE', `${f.kind}: ${f.subject}`))
        break
      case 'dependency':
        b.add('architecture/dependencies', f.subject, factNode(f, 'ARCHITECTURE', f.subject))
        break
      case 'boundary':
        b.add('architecture/boundaries', f.subject, factNode(f, 'ARCHITECTURE', f.subject))
        break
      case 'generated_path':
        b.add('architecture/generated', f.subject, factNode(f, 'RULE', `Generated: ${f.subject}`))
        break
      case 'entry_point': {
        const path = b.add('architecture/entry-points', f.subject, factNode(f, 'COMPONENT', f.subject))
        const file = f.files[0]
        if (file) b.edge({ fromPath: ensureModule(moduleOfFile(file)), toPath: path, type: 'PROVIDES', trust: 'VERIFIED', confidence: f.confidence, provenance: { source: f.source, evidence: `${normFile(file)} is in the module` } })
        break
      }
      case 'command':
        b.add('commands', f.subject, factNode(f, 'COMMAND', f.subject))
        break
      case 'import_relation': {
        const [from, to] = f.subject.split(' -> ')
        if (from && to) {
          b.edge({ fromPath: ensureModule(from), toPath: ensureModule(to), type: 'DEPENDS_ON', trust: trustOfFact(f), confidence: f.confidence, provenance: { source: f.source, evidence: f.statement } })
        }
        break
      }
      case 'interface': {
        const m = ensureModule(moduleOfFile(f.subject))
        b.add(joinPath(m, 'interfaces'), f.subject, factNode(f, 'SYMBOL', f.subject))
        break
      }
      case 'hot_file': {
        const m = ensureModule(moduleOfFile(f.subject))
        b.add(joinPath(m, 'files'), f.subject, factNode(f, 'COMPONENT', f.subject))
        break
      }
      case 'test_mapping': {
        // files[1] is the file under test for a one-to-one mapping; a directory mapping names only test files.
        const tested = f.subject.endsWith('/') ? f.files[0] : (f.files[1] ?? f.files[0])
        const m = ensureModule(moduleOfFile(tested ?? f.subject))
        const path = b.add(joinPath(m, 'tests'), f.subject, factNode(f, 'TEST', f.subject))
        b.edge({ fromPath: m, toPath: path, type: 'TESTED_BY', trust: trustOfFact(f), confidence: f.confidence, provenance: { source: f.source, evidence: f.statement } })
        break
      }
      case 'hazard':
      case 'decision': {
        const type: ContextNodeType = f.kind === 'hazard' ? 'HAZARD' : 'DECISION'
        const path = b.add(f.kind === 'hazard' ? 'hazards' : 'decisions', f.subject, factNode(f, type, f.subject))
        linkFiles(b, ensureModule, path, type, f.files, trustOfFact(f), f.confidence, f.source)
        break
      }
    }
  }
}

/** A record that names files is linked from each module that contains one of them. The evidence is the path itself. */
function linkFiles(
  b: Builder,
  ensureModule: (module: string) => string,
  path: string,
  type: ContextNodeType,
  files: readonly string[],
  trust: ContextTrust,
  confidence: ContextConfidence,
  source: string,
): void {
  const modules = new Map<string, string>()
  for (const file of files) {
    const f = normFile(file)
    if (f === '' || f.startsWith('..')) continue
    const m = moduleOfFile(f)
    if (!modules.has(m)) modules.set(m, f)
  }
  for (const [m, file] of [...modules.entries()].sort((a, b2) => a[0].localeCompare(b2[0])).slice(0, 12)) {
    b.edge({ fromPath: ensureModule(m), toPath: path, type: FILE_LINK[type] ?? 'RELATED_TO', trust, confidence, provenance: { source, evidence: `names ${file}` } })
  }
}

/**
 * Decisions and hazards share one subject kind wherever they are stored, so that a program decision and a
 * repository decision about the same subject are compared (and, when they differ, shown as a conflict).
 */
const SUBJECT_KIND: Partial<Record<ContextNodeType, string>> = { DECISION: 'decision', HAZARD: 'hazard' }

// ───────────────────────────── project memory ─────────────────────────────

function addMemory(b: Builder, entries: readonly MemoryEntry[]): void {
  const ensureModule = (module: string): string => {
    const path = modulePath(module)
    if (!b.nodes.has(path)) {
      b.section('modules')
      b.nodes.set(path, {
        path,
        type: 'MODULE',
        title: moduleTitle(module),
        summary: '',
        originKind: 'graph',
        originId: null,
        trust: 'GENERATED_SUMMARY',
        status: 'CURRENT',
        confidence: 'low',
        subjectKey: subjectKey('module', module),
        programId: null,
        provenance: { source: 'graph' },
        sources: [],
        sourceUpdatedAt: null,
        derived: true,
      })
    }
    return path
  }
  for (const m of [...entries].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
    // Run-scoped and global entries stay with the stores that own them; rejected entries are not knowledge.
    if (m.scope !== 'project' || m.status === 'rejected') continue
    const trust: ContextTrust = m.source === 'user' ? 'USER_PROVIDED' : m.status === 'approved' ? 'INFERRED' : 'AGENT_NOTE'
    const path = b.add('memory', `${m.title}-${m.id.slice(0, 6)}`, {
      type: 'MEMORY',
      title: m.title,
      summary: m.content,
      originKind: 'memory',
      originId: m.id,
      trust,
      status: m.status === 'approved' ? 'CURRENT' : 'PROPOSED',
      confidence: m.status === 'approved' ? 'medium' : 'low',
      subjectKey: subjectKey('memory', m.title),
      programId: null,
      provenance: { source: m.source, runId: m.runId, taskId: m.taskId, agentId: m.agentId, evidence: m.evidence },
      sources: [{ kind: 'record', ref: `memory:${m.id}`, hash: null }, ...[...new Set(m.filePaths.map(normFile))].filter((f) => f !== '' && !f.startsWith('..')).slice(0, 20).map((f) => ({ kind: 'file' as const, ref: f, hash: null }))],
      sourceUpdatedAt: m.createdAt,
    })
    linkFiles(b, ensureModule, path, 'MEMORY', m.filePaths, trust, 'medium', m.source)
  }
}

// ───────────────────────────── programs ─────────────────────────────

export interface ProgramRecords {
  program: Program
  milestones: Milestone[]
  memory: ProgramMemoryEntry[]
  backlog: BacklogItem[]
}

const PROGRAM_MEMORY_PLACE: Record<ProgramMemoryEntry['kind'], { folder: string; type: ContextNodeType }> = {
  architecture_decision: { folder: 'decisions', type: 'DECISION' },
  user_decision: { folder: 'decisions', type: 'DECISION' },
  rejected_approach: { folder: 'decisions', type: 'DECISION' },
  hazard: { folder: 'hazards', type: 'HAZARD' },
  security_constraint: { folder: 'hazards', type: 'HAZARD' },
  interface: { folder: 'interfaces', type: 'CONTRACT' },
  performance_baseline: { folder: 'findings', type: 'OUTCOME' },
  failure: { folder: 'findings', type: 'ISSUE' },
}

const OPEN_BACKLOG: ReadonlySet<string> = new Set(['proposed', 'accepted', 'scheduled'])

function addProgram(b: Builder, r: ProgramRecords): void {
  const { program } = r
  const root = b.add('programs', `${program.name}-${program.id.slice(0, 6)}`, {
    type: 'PROGRAM',
    title: program.name,
    summary: [`Goal: ${program.goal.statement}`, `State: ${program.state}.`, program.goal.constraints.length > 0 ? `Constraints: ${program.goal.constraints.join('; ')}` : ''].filter((s) => s !== '').join(' '),
    originKind: 'program',
    originId: program.id,
    trust: 'USER_PROVIDED',
    status: 'CURRENT',
    confidence: 'high',
    subjectKey: null,
    programId: program.id,
    provenance: { source: 'user' },
    sources: [{ kind: 'record', ref: `programs:${program.id}`, hash: null }],
    sourceUpdatedAt: program.updatedAt,
  })
  const milestonePath = new Map<string, string>()
  for (const m of [...r.milestones].sort((x, y) => x.ordinal - y.ordinal || x.key.localeCompare(y.key))) {
    const path = b.add(joinPath(root, 'milestones'), m.key, {
      type: 'MILESTONE',
      title: `${m.key}: ${m.title}`,
      summary: `${m.objective} State: ${m.state}.${m.gaps.length > 0 ? ` Open gaps: ${m.gaps.join('; ')}` : ''}`,
      originKind: 'program_milestone',
      originId: m.id,
      trust: 'INFERRED',
      status: 'CURRENT',
      confidence: 'medium',
      subjectKey: null,
      programId: program.id,
      provenance: { source: 'engine' },
      sources: [{ kind: 'record', ref: `program_milestones:${m.id}`, hash: null }],
      sourceUpdatedAt: m.completedAt ?? m.startedAt ?? m.createdAt,
    })
    milestonePath.set(m.key, path)
  }
  for (const m of r.milestones) {
    const from = milestonePath.get(m.key)
    if (!from) continue
    for (const dep of m.dependsOn) {
      const to = milestonePath.get(dep)
      if (to) b.edge({ fromPath: from, toPath: to, type: 'DEPENDS_ON', trust: 'INFERRED', confidence: 'medium', provenance: { source: 'engine', evidence: 'milestone dependency in the accepted plan' } })
    }
  }
  for (const e of [...r.memory].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
    const place = PROGRAM_MEMORY_PLACE[e.kind]
    const trust: ContextTrust = e.source.kind === 'user' ? 'USER_PROVIDED' : e.source.kind === 'milestone_verifier' ? 'VERIFIED' : 'INFERRED'
    const path = b.add(joinPath(root, place.folder), `${e.title}-${e.id.slice(0, 6)}`, {
      type: place.type,
      title: e.title,
      summary: e.content,
      originKind: 'program_memory',
      originId: e.id,
      trust,
      status: e.status === 'superseded' ? 'SUPERSEDED' : 'CURRENT',
      confidence: trust === 'INFERRED' ? 'medium' : 'high',
      subjectKey: subjectKey(SUBJECT_KIND[place.type] ?? `program:${e.kind}`, e.title),
      programId: program.id,
      provenance: { source: e.source.kind, runId: e.source.runId, evidence: e.evidence },
      sources: [{ kind: 'record', ref: `program_memory:${e.id}`, hash: null }],
      sourceUpdatedAt: e.createdAt,
    })
    const milestone = e.milestoneKey ? milestonePath.get(e.milestoneKey) : undefined
    if (milestone) b.edge({ fromPath: path, toPath: milestone, type: 'INTRODUCED_BY', trust, confidence: 'high', provenance: { source: e.source.kind, evidence: `recorded while working on milestone ${e.milestoneKey}` } })
  }
  for (const item of [...r.backlog].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
    if (!OPEN_BACKLOG.has(item.status)) continue
    b.add(joinPath(root, 'backlog'), `${item.title}-${item.id.slice(0, 6)}`, {
      type: 'BACKLOG',
      title: item.title,
      summary: `[${item.category}, ${item.severity}, ${item.status}] ${item.description}`,
      originKind: 'backlog_item',
      originId: item.id,
      trust: 'INFERRED',
      status: 'CURRENT',
      confidence: 'medium',
      subjectKey: null,
      programId: program.id,
      provenance: { source: 'engine', evidence: item.evidence },
      sources: [{ kind: 'record', ref: `backlog_items:${item.id}`, hash: null }],
      sourceUpdatedAt: item.updatedAt,
    })
  }
}

// ───────────────────────────── entry points ─────────────────────────────

export interface ProjectRecords {
  project: Project
  facts: RepositoryFact[]
  memory: MemoryEntry[]
  programs: ProgramRecords[]
}

/** The origin kinds a project projection rebuilds. Notes and user nodes (`graph`) are never touched by it. */
export const PROJECT_OWNED: ContextOriginKind[] = ['repository_fact', 'memory', 'program', 'program_memory', 'program_milestone', 'backlog_item']
export const WORKSPACE_OWNED: ContextOriginKind[] = ['workspace_repository', 'workspace_contract', 'workspace_memory']

export function projectProject(records: ProjectRecords): Projection {
  const b = new Builder()
  for (const s of ['architecture', 'modules', 'commands', 'decisions', 'hazards', 'memory', 'notes']) b.section(s)
  addFacts(b, records.facts)
  addMemory(b, records.memory)
  for (const p of [...records.programs].sort((x, y) => x.program.createdAt.localeCompare(y.program.createdAt) || x.program.id.localeCompare(y.program.id))) addProgram(b, p)
  return b.result(PROJECT_OWNED)
}

export interface WorkspaceRecords {
  workspace: Workspace
  repositories: WorkspaceRepository[]
  dependencies: CrossRepoDependency[]
  contracts: { contract: Contract; consumers: ContractConsumer[]; latest: ContractVersion | null }[]
  memory: WorkspaceMemoryEntry[]
}

const WORKSPACE_MEMORY_PLACE: Record<WorkspaceMemoryEntry['kind'], { folder: string; type: ContextNodeType; link: ContextEdgeType }> = {
  architecture: { folder: 'architecture', type: 'ARCHITECTURE', link: 'RELATED_TO' },
  contract: { folder: 'contracts/notes', type: 'MEMORY', link: 'RELATED_TO' },
  release_convention: { folder: 'standards', type: 'RULE', link: 'RELATED_TO' },
  shared_decision: { folder: 'decisions', type: 'DECISION', link: 'DECIDED_BY' },
  integration_hazard: { folder: 'hazards', type: 'HAZARD', link: 'AFFECTED_BY' },
}

export function projectWorkspace(records: WorkspaceRecords): Projection {
  const b = new Builder()
  for (const s of ['repositories', 'architecture', 'contracts', 'decisions', 'standards', 'hazards', 'notes']) b.section(s)
  const repoPath = new Map<string, string>()
  const repoByKey = new Map<string, string>()
  for (const r of [...records.repositories].sort((x, y) => x.key.localeCompare(y.key))) {
    const commands = (['build', 'test', 'lint', 'typecheck'] as const).filter((k) => r.commands[k]).map((k) => `${k}: ${r.commands[k]}`)
    const path = b.add('repositories', r.key, {
      type: 'REPOSITORY',
      title: r.key,
      summary: [`Role: ${r.role}.`, r.languages.length > 0 ? `Languages: ${r.languages.join(', ')}.` : '', r.frameworks.length > 0 ? `Frameworks: ${r.frameworks.join(', ')}.` : '', commands.length > 0 ? `Commands: ${commands.join('; ')}.` : ''].filter((s) => s !== '').join(' '),
      originKind: 'workspace_repository',
      originId: r.id,
      trust: 'VERIFIED',
      status: 'CURRENT',
      confidence: 'high',
      subjectKey: subjectKey('repository', r.key),
      programId: null,
      provenance: { source: 'manifest' },
      sources: [{ kind: 'record', ref: `workspace_repositories:${r.id}`, hash: null }],
      sourceUpdatedAt: null,
    })
    repoPath.set(r.id, path)
    repoByKey.set(r.key, path)
  }
  for (const d of records.dependencies) {
    const from = repoPath.get(d.fromRepositoryId)
    const to = repoPath.get(d.toRepositoryId)
    if (from && to) b.edge({ fromPath: from, toPath: to, type: 'DEPENDS_ON', trust: d.provenance.source === 'user' ? 'USER_PROVIDED' : 'VERIFIED', confidence: 'high', provenance: { source: d.provenance.source, evidence: `${d.kind}: ${d.provenance.detail}${d.provenance.file ? ` (${d.provenance.file})` : ''}` } })
  }
  for (const c of [...records.contracts].sort((x, y) => x.contract.key.localeCompare(y.contract.key))) {
    const { contract, consumers, latest } = c
    const surface = latest ? `Version ${latest.version}${latest.parseError ? ' (could not be parsed)' : `, ${latest.surface.length} surface elements`}.` : 'No version captured yet.'
    const path = b.add('contracts', contract.key, {
      type: 'CONTRACT',
      title: `${contract.key}: ${contract.name}`,
      summary: `${contract.kind} contract at ${contract.path}. ${surface}`,
      originKind: 'workspace_contract',
      originId: contract.id,
      trust: 'VERIFIED',
      status: 'CURRENT',
      confidence: 'high',
      subjectKey: subjectKey('contract', contract.key),
      programId: null,
      provenance: { source: 'contract' },
      sources: [{ kind: 'record', ref: `workspace_contracts:${contract.id}`, hash: latest?.hash ?? null }, ...(latest?.commit ? [{ kind: 'commit' as const, ref: latest.commit, hash: null }] : [])],
      sourceUpdatedAt: latest?.capturedAt ?? contract.createdAt,
    })
    const provider = repoPath.get(contract.providerRepositoryId)
    if (provider) b.edge({ fromPath: provider, toPath: path, type: 'PROVIDES', trust: 'VERIFIED', confidence: 'high', provenance: { source: 'contract', evidence: `owns ${contract.path}` } })
    for (const consumer of consumers) {
      const from = repoPath.get(consumer.repositoryId)
      if (from) b.edge({ fromPath: from, toPath: path, type: 'CONSUMES', trust: consumer.provenance.source === 'user' ? 'USER_PROVIDED' : 'VERIFIED', confidence: 'high', provenance: { source: consumer.provenance.source, evidence: consumer.provenance.detail } })
    }
  }
  for (const m of [...records.memory].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
    const place = WORKSPACE_MEMORY_PLACE[m.kind]
    const trust: ContextTrust = m.source.kind === 'user' ? 'USER_PROVIDED' : m.source.kind === 'verification' ? 'VERIFIED' : 'INFERRED'
    const path = b.add(place.folder, `${m.title}-${m.id.slice(0, 6)}`, {
      type: place.type,
      title: m.title,
      summary: m.content,
      originKind: 'workspace_memory',
      originId: m.id,
      trust,
      status: 'CURRENT',
      confidence: trust === 'INFERRED' ? 'medium' : 'high',
      subjectKey: subjectKey(SUBJECT_KIND[place.type] ?? `workspace:${m.kind}`, m.title),
      programId: null,
      provenance: { source: m.source.kind, evidence: m.evidence },
      sources: [{ kind: 'record', ref: `workspace_memory:${m.id}`, hash: null }],
      sourceUpdatedAt: m.createdAt,
    })
    for (const key of m.repositories) {
      const from = repoByKey.get(key)
      if (from) b.edge({ fromPath: from, toPath: path, type: place.link, trust, confidence: 'high', provenance: { source: m.source.kind, evidence: `the entry names repository ${key}` } })
    }
  }
  return b.result(WORKSPACE_OWNED)
}
