import { z } from 'zod'

/**
 * v0.5: Workspaces. A workspace is a set of related repositories that one goal can change together. Each
 * enrolled repository is an ordinary NEXUS project; the workspace adds what lies between them: who depends on
 * whom, the contracts they share, the order work and releases must take, and a verification that looks at all
 * of them at once. Everything here is data and pure decisions.
 */

// ───────────────────────────── repositories and the graph ─────────────────────────────

export const REPOSITORY_ROLES = ['library', 'service', 'application', 'website', 'documentation', 'infrastructure', 'other'] as const
export const RepositoryRoleSchema = z.enum(REPOSITORY_ROLES)
export type RepositoryRole = z.infer<typeof RepositoryRoleSchema>

const Key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes')

export interface WorkspaceRepository {
  id: string
  workspaceId: string
  /** Short name used in plans and prompts, unique in the workspace. */
  key: string
  /** The NEXUS project of this repository. */
  projectId: string
  rootPath: string
  role: RepositoryRole
  remote: string | null
  branch: string | null
  languages: string[]
  frameworks: string[]
  /** Check commands as profiled for the project. A repository never inherits another one's stack. */
  commands: { build: string | null; test: string | null; lint: string | null; typecheck: string | null }
  /** Name and version from the repository's own manifest, when it has one. */
  packageName: string | null
  packageVersion: string | null
  manifest: string | null
  enrolledAt: string
  refreshedAt: string
}

export interface Service {
  id: string
  workspaceId: string
  repositoryId: string
  name: string
  /** What it is, in one line. */
  description: string
  createdAt: string
}

export const DEPENDENCY_KINDS = ['imports', 'package_dependency', 'api_provider_consumer', 'schema', 'generated_client', 'deployment', 'documentation'] as const
export const DependencyKindSchema = z.enum(DEPENDENCY_KINDS)
export type DependencyKind = z.infer<typeof DependencyKindSchema>

/** Where an edge comes from. An edge without provenance is not stored. */
export interface EdgeProvenance {
  source: 'manifest' | 'contract' | 'user'
  /** The file (and line, when known) in the dependent repository that shows it. */
  file: string | null
  detail: string
}

/** `from` depends on `to`: `to` must be changed, verified and released first. */
export interface CrossRepoDependency {
  id: string
  workspaceId: string
  fromRepositoryId: string
  toRepositoryId: string
  kind: DependencyKind
  provenance: EdgeProvenance
  createdAt: string
}

export interface GraphEdge {
  from: string
  to: string
}

export type OrderResult = { ok: true; order: string[]; levels: string[][] } | { ok: false; cycle: string[] }

/**
 * Dependency order of the given nodes: every node after everything it depends on. `levels` groups the nodes
 * that could go at the same time. Deterministic (ties are broken by name). A cycle is reported, not ordered.
 */
export function dependencyOrder(nodes: readonly string[], edges: readonly GraphEdge[]): OrderResult {
  const known = new Set(nodes)
  const pending = new Map<string, Set<string>>()
  for (const n of nodes) pending.set(n, new Set())
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue
    pending.get(e.from)?.add(e.to)
  }
  const order: string[] = []
  const levels: string[][] = []
  while (pending.size > 0) {
    const free = [...pending.entries()].filter(([, deps]) => [...deps].every((d) => !pending.has(d))).map(([n]) => n).sort()
    if (free.length === 0) return { ok: false, cycle: [...pending.keys()].sort() }
    levels.push(free)
    for (const n of free) {
      order.push(n)
      pending.delete(n)
    }
  }
  return { ok: true, order, levels }
}

/** Everything that depends on `node`, directly or through others. */
export function dependentsOf(node: string, edges: readonly GraphEdge[]): string[] {
  const out = new Set<string>()
  const queue = [node]
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const e of edges) {
      if (e.to === current && !out.has(e.from) && e.from !== node) {
        out.add(e.from)
        queue.push(e.from)
      }
    }
  }
  return [...out].sort()
}

// ───────────────────────────── contracts ─────────────────────────────

export const CONTRACT_KINDS = ['openapi', 'json_schema', 'typescript_api', 'protobuf', 'database_schema', 'event_schema'] as const
export const ContractKindSchema = z.enum(CONTRACT_KINDS)
export type ContractKind = z.infer<typeof ContractKindSchema>

/** One element of a contract's surface: an operation, a field, an export, a column. */
export interface SurfaceElement {
  /** Stable path of the element, e.g. `POST /orders`, `Order.total`, `export parseDuration`, `orders.total`. */
  path: string
  /** A normalized description of its shape (type, signature, column type). */
  shape: string
  required: boolean
}

export interface Contract {
  id: string
  workspaceId: string
  key: string
  name: string
  kind: ContractKind
  /** The repository that owns the contract. */
  providerRepositoryId: string
  /** Path of the contract file inside the provider repository. */
  path: string
  createdAt: string
}

/** A repository that uses a contract, and where its own copy of it lives (when it keeps one). */
export interface ContractConsumer {
  id: string
  contractId: string
  repositoryId: string
  /** Path of the consumer's copy of the contract (a vendored schema, a generated client), or null. */
  copyPath: string | null
  provenance: EdgeProvenance
  createdAt: string
}

export interface ContractVersion {
  id: string
  contractId: string
  /** 1, 2, 3 in the order the versions were captured. */
  version: number
  /** SHA-256 of the contract file's content. */
  hash: string
  /** The commit the file was read at. */
  commit: string | null
  surface: SurfaceElement[]
  /** Set when the file could not be read as its kind; the surface is then empty. */
  parseError: string | null
  capturedAt: string
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'now_required' | 'now_optional'

export interface SurfaceChange {
  path: string
  change: ChangeKind
  before: string | null
  after: string | null
  /** True when an existing consumer can break on it. */
  breaking: boolean
  why: string
}

export interface CompatibilityResult {
  compatible: boolean
  level: 'identical' | 'compatible' | 'breaking' | 'unknown'
  changes: SurfaceChange[]
  /** One line for a report. */
  summary: string
}

/**
 * Compares two versions of a contract's surface from the consumers' side. Removing an element, changing its
 * shape, or making an optional input required is breaking; adding an optional element or relaxing a
 * requirement is not. A surface that could not be read gives `unknown`, never `compatible`.
 */
export function compareSurfaces(before: Pick<ContractVersion, 'surface' | 'parseError' | 'hash'>, after: Pick<ContractVersion, 'surface' | 'parseError' | 'hash'>): CompatibilityResult {
  if (before.hash === after.hash) return { compatible: true, level: 'identical', changes: [], summary: 'The contract is unchanged.' }
  if (before.parseError || after.parseError) {
    return { compatible: false, level: 'unknown', changes: [], summary: `The contract changed and its surface could not be read (${after.parseError ?? before.parseError ?? ''}); compatibility is unknown.` }
  }
  const old = new Map(before.surface.map((e) => [e.path, e]))
  const next = new Map(after.surface.map((e) => [e.path, e]))
  const changes: SurfaceChange[] = []
  for (const [path, a] of next) {
    const b = old.get(path)
    if (!b) {
      changes.push({ path, change: 'added', before: null, after: a.shape, breaking: a.required && isInput(path), why: a.required && isInput(path) ? 'A new required input: existing callers do not send it.' : 'New element; existing consumers are not affected.' })
      continue
    }
    if (b.shape !== a.shape) changes.push({ path, change: 'changed', before: b.shape, after: a.shape, breaking: true, why: 'The shape changed; consumers written against the old shape can break.' })
    else if (!b.required && a.required) changes.push({ path, change: 'now_required', before: b.shape, after: a.shape, breaking: isInput(path), why: isInput(path) ? 'An optional input became required.' : 'An output is now always present.' })
    else if (b.required && !a.required) changes.push({ path, change: 'now_optional', before: b.shape, after: a.shape, breaking: !isInput(path), why: !isInput(path) ? 'An output consumers rely on may now be absent.' : 'An input is no longer required.' })
  }
  for (const [path, b] of old) {
    if (!next.has(path)) changes.push({ path, change: 'removed', before: b.shape, after: null, breaking: true, why: 'Removed; consumers that use it break.' })
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  const breaking = changes.filter((c) => c.breaking)
  if (changes.length === 0) return { compatible: true, level: 'compatible', changes, summary: 'The contract file changed; its surface did not.' }
  return breaking.length > 0
    ? { compatible: false, level: 'breaking', changes, summary: `${breaking.length} breaking change(s): ${breaking.slice(0, 4).map((c) => `${c.change} ${c.path}`).join('; ')}${breaking.length > 4 ? '; ...' : ''}.` }
    : { compatible: true, level: 'compatible', changes, summary: `${changes.length} compatible change(s): ${changes.slice(0, 4).map((c) => `${c.change} ${c.path}`).join('; ')}${changes.length > 4 ? '; ...' : ''}.` }
}

/** Inputs are what a consumer sends: request bodies and parameters. Everything else is read by consumers. */
function isInput(path: string): boolean {
  return /(^|\s)(request|param|parameter|argument|input)\b/i.test(path) || /\.request\./.test(path) || /#param:/.test(path)
}

/** The next version label for a contract after a comparison: major on breaking, minor on compatible change. */
export function nextContractVersion(current: string, level: CompatibilityResult['level']): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim())
  if (!match) return current
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (level === 'identical') return current
  if (level === 'breaking' || level === 'unknown') return `${major + 1}.0.0`
  return level === 'compatible' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

// ───────────────────────────── policy ─────────────────────────────

export const WorkspacePolicySchema = z
  .object({
    /** Keys of the repositories a workspace mission may change. Empty means none: nothing runs. */
    allowedRepositories: z.array(Key).max(50),
    /** Branch names NEXUS must never be asked to start from or prepare a release on without a new branch. */
    protectedBranches: z.array(z.string().trim().min(1).max(120)).max(20),
    /** A mission may be planned across at most this many repositories. */
    maxRepositoriesPerMission: z.number().int().min(1).max(20),
    maxTasksPerMission: z.number().int().min(1).max(40),
    /** Missions of different repositories that have no dependency between them may run at the same time. */
    maxParallelRepositories: z.number().int().min(1).max(4),
    /** Review requirement passed to every task's run. */
    reviewMode: z.enum(['standard', 'dual', 'auto']),
    /** Publishing is never done by NEXUS in 0.5. This records that the user has not authorized it. */
    publishing: z.literal('never'),
    /** A breaking contract change needs every consumer to be updated in the same mission. */
    requireConsumerUpdateOnBreakingChange: z.boolean(),
    missionStrategy: z.enum(['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE', 'ADAPTIVE']),
    missionPreset: z.enum(['eco', 'balanced', 'maximum']),
  })
  .strict()
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  allowedRepositories: [],
  protectedBranches: ['main', 'master', 'release'],
  maxRepositoriesPerMission: 5,
  maxTasksPerMission: 12,
  maxParallelRepositories: 1,
  reviewMode: 'standard',
  publishing: 'never',
  requireConsumerUpdateOnBreakingChange: true,
  missionStrategy: 'BUILD',
  missionPreset: 'balanced',
}

// ───────────────────────────── workspace missions ─────────────────────────────

export const WORKSPACE_MISSION_STATES = ['DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'ACTIVE', 'VERIFYING', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const
export type WorkspaceMissionState = (typeof WORKSPACE_MISSION_STATES)[number]
export const TERMINAL_WORKSPACE_MISSION_STATES: readonly WorkspaceMissionState[] = ['COMPLETED', 'FAILED', 'CANCELLED']

export const CROSS_REPO_TASK_STATES = ['PLANNED', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'] as const
export type CrossRepoTaskState = (typeof CROSS_REPO_TASK_STATES)[number]

const WORKSPACE_MISSION_TRANSITIONS: Record<WorkspaceMissionState, readonly WorkspaceMissionState[]> = {
  DRAFT: ['PLANNING', 'CANCELLED'],
  PLANNING: ['AWAITING_APPROVAL', 'ACTIVE', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['ACTIVE', 'PLANNING', 'CANCELLED'],
  ACTIVE: ['VERIFYING', 'PAUSED', 'WAITING_FOR_QUOTA', 'BLOCKED', 'CANCELLED', 'FAILED'],
  VERIFYING: ['COMPLETED', 'BLOCKED', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['PLANNING', 'ACTIVE', 'VERIFYING', 'WAITING_FOR_QUOTA', 'CANCELLED'],
  WAITING_FOR_QUOTA: ['PLANNING', 'ACTIVE', 'VERIFYING', 'PAUSED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['PLANNING', 'ACTIVE', 'VERIFYING', 'WAITING_FOR_QUOTA', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
}

export function canTransitionWorkspaceMission(from: WorkspaceMissionState, to: WorkspaceMissionState): boolean {
  return WORKSPACE_MISSION_TRANSITIONS[from].includes(to)
}

const Line = z.string().trim().min(1).max(400)

export const PlannedCrossRepoTaskSchema = z
  .object({
    key: Key,
    /** Key of the workspace repository the task changes. One task, one repository. */
    repository: Key,
    title: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(1500),
    acceptanceCriteria: z.array(Line).min(1).max(8),
    dependsOn: z.array(Key).max(8),
    /** Keys of the contracts this task changes (provider) or adapts to (consumer). */
    contracts: z.array(Key).max(8),
  })
  .strict()
export type PlannedCrossRepoTask = z.infer<typeof PlannedCrossRepoTaskSchema>

export const WorkspacePlanSchema = z
  .object({
    summary: z.string().trim().min(1).max(1500),
    tasks: z.array(PlannedCrossRepoTaskSchema).min(1).max(40),
    risks: z.array(Line).max(10),
  })
  .strict()
export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>

export interface WorkspacePlanProblem {
  task: string | null
  problem: string
}

/**
 * Structural validation of a cross-repository plan against the workspace: known and allowed repositories,
 * unique keys, known dependencies, no cycle, and the organization graph respected (a task in a repository
 * that depends on another repository changed by the plan must come after the task that changes it).
 */
export function validateWorkspacePlan(
  plan: Pick<WorkspacePlan, 'tasks'>,
  workspace: { repositories: readonly string[]; contracts: readonly string[]; edges: readonly GraphEdge[]; policy: WorkspacePolicy },
): WorkspacePlanProblem[] {
  const problems: WorkspacePlanProblem[] = []
  const keys = new Set<string>()
  for (const t of plan.tasks) {
    if (keys.has(t.key)) problems.push({ task: t.key, problem: 'duplicate task key' })
    keys.add(t.key)
    if (!workspace.repositories.includes(t.repository)) problems.push({ task: t.key, problem: `unknown repository ${t.repository}` })
    else if (!workspace.policy.allowedRepositories.includes(t.repository)) problems.push({ task: t.key, problem: `repository ${t.repository} is not allowed by the workspace policy` })
    for (const c of t.contracts) if (!workspace.contracts.includes(c)) problems.push({ task: t.key, problem: `unknown contract ${c}` })
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.key) problems.push({ task: t.key, problem: 'depends on itself' })
      else if (!keys.has(d)) problems.push({ task: t.key, problem: `depends on unknown task ${d}` })
    }
  }
  const order = dependencyOrder(
    plan.tasks.map((t) => t.key),
    plan.tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: t.key, to: d }))),
  )
  if (!order.ok) problems.push({ task: null, problem: `dependency cycle between ${order.cycle.join(', ')}` })
  const repos = new Set(plan.tasks.map((t) => t.repository))
  if (repos.size > workspace.policy.maxRepositoriesPerMission) problems.push({ task: null, problem: `the plan spans ${repos.size} repositories, above the limit of ${workspace.policy.maxRepositoriesPerMission}` })
  if (plan.tasks.length > workspace.policy.maxTasksPerMission) problems.push({ task: null, problem: `the plan has ${plan.tasks.length} tasks, above the limit of ${workspace.policy.maxTasksPerMission}` })
  // The organization graph orders the work: a consumer's task waits for the provider's.
  if (order.ok) {
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>()
      const stack = [from]
      while (stack.length > 0) {
        const key = stack.pop() as string
        if (key === to) return true
        if (seen.has(key)) continue
        seen.add(key)
        stack.push(...(plan.tasks.find((t) => t.key === key)?.dependsOn ?? []))
      }
      return false
    }
    for (const edge of workspace.edges) {
      const consumers = plan.tasks.filter((t) => t.repository === edge.from)
      const providers = plan.tasks.filter((t) => t.repository === edge.to)
      for (const c of consumers) {
        for (const p of providers) {
          if (!reaches(c.key, p.key)) problems.push({ task: c.key, problem: `${edge.from} depends on ${edge.to}: task ${c.key} must depend on ${p.key}` })
        }
      }
    }
  }
  return problems
}

export interface CrossRepoTask extends PlannedCrossRepoTask {
  id: string
  missionId: string
  repositoryId: string
  ordinal: number
  state: CrossRepoTaskState
  /** The run that worked on it. */
  runId: string | null
  baseCommit: string | null
  /** The commit of the run's integration branch, when it completed. */
  resultCommit: string | null
  resultBranch: string | null
  /** What the run reported, passed on to the tasks that depend on this one. */
  summary: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface VerificationCheck {
  name: string
  /** The repository it concerns, or null for a workspace-wide check. */
  repository: string | null
  passed: boolean
  detail: string
}

export interface WorkspaceVerification {
  passed: boolean
  checks: VerificationCheck[]
  /** One compatibility result per contract touched by the mission. */
  contracts: { contract: string; fromVersion: number | null; toVersion: number; result: CompatibilityResult; consumersInSync: { repository: string; inSync: boolean; detail: string }[] }[]
  createdAt: string
}

export interface WorkspaceMission {
  id: string
  workspaceId: string
  /** Set when the mission is one milestone of a workspace program. */
  programId: string | null
  goal: string
  state: WorkspaceMissionState
  resumeState: WorkspaceMissionState | null
  blockedReason: string | null
  plan: WorkspacePlan | null
  plannerRunId: string | null
  verification: WorkspaceVerification | null
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

// ───────────────────────────── workspace programs ─────────────────────────────

export const WORKSPACE_PROGRAM_STATES = ['DRAFT', 'ACTIVE', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const
export type WorkspaceProgramState = (typeof WORKSPACE_PROGRAM_STATES)[number]

export interface WorkspaceMilestone {
  title: string
  /** The goal of the cross-repository mission that carries this milestone out. */
  goal: string
  missionId: string | null
  state: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED'
}

/**
 * A goal pursued across several cross-repository missions, one per milestone, in the order the user gave.
 * A milestone is complete when its mission passed the workspace's global verification; the next mission then
 * starts from the results of the ones before it, in every repository. The milestones are written by the user:
 * a workspace program does not plan or replan them (that is what a single-repository program does).
 */
export interface WorkspaceProgram {
  id: string
  workspaceId: string
  name: string
  goal: string
  milestones: WorkspaceMilestone[]
  state: WorkspaceProgramState
  blockedReason: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

export const WorkspaceProgramInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    milestones: z
      .array(z.object({ title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(4000) }).strict())
      .min(1)
      .max(12),
  })
  .strict()
export type WorkspaceProgramInput = z.infer<typeof WorkspaceProgramInputSchema>

// ───────────────────────────── release trains ─────────────────────────────

export const BUMP_KINDS = ['major', 'minor', 'patch', 'none'] as const
export type BumpKind = (typeof BUMP_KINDS)[number]

export interface ReleaseStep {
  repository: string
  currentVersion: string | null
  nextVersion: string | null
  bump: BumpKind
  /** Why this bump: its own change, a breaking contract, or a dependency that moved. */
  reason: string
  /** Repositories that must be released before this one. */
  after: string[]
  /** The branch holding the change to release. */
  branch: string | null
  commit: string | null
}

export interface ReleasePlan {
  steps: ReleaseStep[]
  /** Steps that can be released together, in order. */
  levels: string[][]
  problems: string[]
}

export interface ReleaseTrain {
  id: string
  workspaceId: string
  missionId: string | null
  name: string
  /** `PREPARED`: the plan exists and nothing was published. NEXUS 0.5 never goes further. */
  state: 'PREPARED' | 'CANCELLED'
  plan: ReleasePlan
  /** Always false in 0.5: publishing needs an explicit authorization that 0.5 does not offer. */
  publishAuthorized: false
  createdAt: string
}

export function bumpVersion(version: string | null, bump: BumpKind): string | null {
  if (version === null) return null
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim())
  if (!match || bump === 'none') return version
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const BUMP_RANK: Record<BumpKind, number> = { none: 0, patch: 1, minor: 2, major: 3 }
const strongest = (a: BumpKind, b: BumpKind): BumpKind => (BUMP_RANK[a] >= BUMP_RANK[b] ? a : b)

export interface ReleaseInput {
  repositories: { key: string; version: string | null; branch: string | null; commit: string | null; changed: boolean }[]
  /** `from` depends on `to`. */
  edges: GraphEdge[]
  /** The strongest contract change each provider repository made. */
  contractChanges: { repository: string; level: CompatibilityResult['level'] }[]
}

/**
 * The order and the version bumps of a coordinated release. A changed repository gets at least a patch; a
 * provider with a compatible contract change a minor, with a breaking one a major; a repository that depends
 * on a released one is released after it and gets at least a patch (its dependency moved). Pure.
 */
export function planRelease(input: ReleaseInput): ReleasePlan {
  const problems: string[] = []
  const keys = input.repositories.map((r) => r.key)
  const order = dependencyOrder(keys, input.edges)
  if (!order.ok) return { steps: [], levels: [], problems: [`The repositories depend on each other in a cycle (${order.cycle.join(', ')}); no release order exists.`] }
  const bumps = new Map<string, { bump: BumpKind; reason: string }>()
  for (const r of input.repositories) if (r.changed) bumps.set(r.key, { bump: 'patch', reason: 'Changed by the mission.' })
  for (const c of input.contractChanges) {
    const bump: BumpKind = c.level === 'breaking' || c.level === 'unknown' ? 'major' : c.level === 'compatible' ? 'minor' : 'none'
    if (bump === 'none') continue
    const current = bumps.get(c.repository)?.bump ?? 'none'
    if (strongest(current, bump) !== current) bumps.set(c.repository, { bump, reason: c.level === 'compatible' ? 'A contract it provides gained elements.' : 'A contract it provides changed incompatibly.' })
  }
  // In dependency order, so a provider's release is known when its consumers are looked at.
  for (const key of order.order) {
    const released = input.edges.filter((e) => e.from === key && bumps.has(e.to)).map((e) => e.to)
    if (released.length > 0 && !bumps.has(key)) bumps.set(key, { bump: 'patch', reason: `Depends on ${released.sort().join(', ')}, released in this train.` })
  }
  const steps: ReleaseStep[] = []
  for (const key of order.order) {
    const b = bumps.get(key)
    if (!b) continue
    const repo = input.repositories.find((r) => r.key === key)
    if (!repo) continue
    if (repo.version === null) problems.push(`${key} has no version in a manifest; its release cannot be numbered.`)
    steps.push({
      repository: key,
      currentVersion: repo.version,
      nextVersion: bumpVersion(repo.version, b.bump),
      bump: b.bump,
      reason: b.reason,
      after: input.edges.filter((e) => e.from === key && bumps.has(e.to)).map((e) => e.to).sort(),
      branch: repo.branch,
      commit: repo.commit,
    })
  }
  const inTrain = new Set(steps.map((s) => s.repository))
  return { steps, levels: order.levels.map((level) => level.filter((k) => inTrain.has(k))).filter((level) => level.length > 0), problems }
}

// ───────────────────────────── workspace, memory, decisions ─────────────────────────────

export interface Workspace {
  id: string
  name: string
  description: string
  policy: WorkspacePolicy
  createdAt: string
  updatedAt: string
}

export const WORKSPACE_MEMORY_KINDS = ['architecture', 'contract', 'release_convention', 'shared_decision', 'integration_hazard'] as const
export type WorkspaceMemoryKind = (typeof WORKSPACE_MEMORY_KINDS)[number]

/** Cross-repository knowledge. What concerns a single repository stays in that repository's own memory. */
export interface WorkspaceMemoryEntry {
  id: string
  workspaceId: string
  kind: WorkspaceMemoryKind
  title: string
  content: string
  evidence: string
  /** The repositories it is about (at least two, or a contract's provider and consumers). */
  repositories: string[]
  source: { kind: 'verification' | 'user' | 'engine'; missionId: string | null }
  createdAt: string
}

export interface WorkspaceDecision {
  id: string
  workspaceId: string
  missionId: string | null
  kind: string
  summary: string
  detail: Record<string, unknown> | null
  createdAt: string
}

export type RepositoryHealth = { level: 'ok' | 'attention' | 'unknown'; reason: string }

export interface WorkspaceDetail {
  workspace: Workspace
  repositories: (WorkspaceRepository & { health: RepositoryHealth })[]
  services: Service[]
  dependencies: CrossRepoDependency[]
  /** Repository keys in dependency order, or the cycle. */
  order: OrderResult
  contracts: (Contract & { versions: ContractVersion[]; consumers: ContractConsumer[] })[]
  missions: WorkspaceMission[]
  programs: WorkspaceProgram[]
  releaseTrains: ReleaseTrain[]
  memory: WorkspaceMemoryEntry[]
  decisions: WorkspaceDecision[]
}

export interface WorkspaceSummary {
  workspace: Workspace
  repositories: number
  contracts: number
  activeMissions: number
  activePrograms: number
}
