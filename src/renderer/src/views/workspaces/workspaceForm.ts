import {
  CONTRACT_KINDS,
  DEPENDENCY_KINDS,
  WORKSPACE_MEMORY_KINDS,
  type ContractKind,
  type DependencyKind,
  type WorkspaceMemoryKind,
  type WorkspacePolicy,
} from '@shared/workspace'

/** Form state, validation and IPC input builders for the Workspaces pages. Pure. */

export interface Check<F extends string> {
  ok: boolean
  /** The first problem, for a hint line; null when valid. */
  reason: string | null
  errors: Partial<Record<F, string>>
}

function finish<F extends string>(
  errors: Partial<Record<F, string>>,
  order: readonly F[],
): Check<F> {
  const first = order.find((f) => errors[f])
  return { ok: first === undefined, reason: first ? (errors[first] ?? null) : null, errors }
}

export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
export const LIMITS = {
  workspaceName: 120,
  workspaceDescription: 2000,
  goal: 8000,
  detail: 400,
  contractName: 120,
  path: 400,
  serviceName: 80,
  serviceDescription: 400,
  memoryTitle: 160,
  memoryText: 1500,
} as const

// ───────────────────────────── workspace ─────────────────────────────

export interface WorkspaceForm {
  name: string
  description: string
}
export const emptyWorkspaceForm = (): WorkspaceForm => ({ name: '', description: '' })
export type WorkspaceField = 'name' | 'description'

export function validateWorkspaceForm(f: WorkspaceForm): Check<WorkspaceField> {
  const errors: Partial<Record<WorkspaceField, string>> = {}
  const name = f.name.trim()
  if (name.length === 0) errors.name = 'Give the workspace a name.'
  else if (name.length > LIMITS.workspaceName)
    errors.name = `At most ${LIMITS.workspaceName} characters.`
  if (f.description.trim().length > LIMITS.workspaceDescription)
    errors.description = `At most ${LIMITS.workspaceDescription} characters.`
  return finish(errors, ['name', 'description'])
}

export function buildWorkspaceInput(f: WorkspaceForm): { name: string; description?: string } {
  const description = f.description.trim()
  return { name: f.name.trim(), ...(description ? { description } : {}) }
}

// ───────────────────────────── mission ─────────────────────────────

export function validateGoal(goal: string): { ok: boolean; reason: string | null } {
  const g = goal.trim()
  if (g.length === 0) return { ok: false, reason: 'Describe the goal.' }
  if (g.length > LIMITS.goal) return { ok: false, reason: `At most ${LIMITS.goal} characters.` }
  return { ok: true, reason: null }
}

// ───────────────────────────── dependency ─────────────────────────────

export interface DependencyForm {
  from: string
  to: string
  kind: DependencyKind
  detail: string
}
export const emptyDependencyForm = (): DependencyForm => ({
  from: '',
  to: '',
  kind: 'package_dependency',
  detail: '',
})
export type DependencyField = 'from' | 'to' | 'detail'

export function validateDependencyForm(
  f: DependencyForm,
  existing: readonly { from: string; to: string }[] = [],
): Check<DependencyField> {
  const errors: Partial<Record<DependencyField, string>> = {}
  if (!f.from) errors.from = 'Choose the repository that depends on another.'
  if (!f.to) errors.to = 'Choose the repository it depends on.'
  else if (f.from && f.from === f.to) errors.to = 'A repository cannot depend on itself.'
  else if (f.from && existing.some((e) => e.from === f.from && e.to === f.to))
    errors.to = 'This dependency is already recorded.'
  const detail = f.detail.trim()
  if (detail.length === 0) errors.detail = 'Say why: every dependency needs a reason.'
  else if (detail.length > LIMITS.detail) errors.detail = `At most ${LIMITS.detail} characters.`
  return finish(errors, ['from', 'to', 'detail'])
}

export function buildDependencyInput(workspaceId: string, f: DependencyForm) {
  return { workspaceId, from: f.from, to: f.to, kind: f.kind, detail: f.detail.trim() }
}

export const isDependencyKind = (v: string): v is DependencyKind =>
  (DEPENDENCY_KINDS as readonly string[]).includes(v)

// ───────────────────────────── contract ─────────────────────────────

export interface ContractForm {
  key: string
  name: string
  kind: ContractKind
  provider: string
  path: string
}
export const emptyContractForm = (): ContractForm => ({
  key: '',
  name: '',
  kind: 'openapi',
  provider: '',
  path: '',
})
export type ContractField = 'key' | 'name' | 'provider' | 'path'

export function validateContractForm(
  f: ContractForm,
  existingKeys: readonly string[] = [],
): Check<ContractField> {
  const errors: Partial<Record<ContractField, string>> = {}
  if (!KEY_PATTERN.test(f.key.trim()))
    errors.key = 'Use lower-case letters, digits and dashes (at most 40).'
  else if (existingKeys.includes(f.key.trim()))
    errors.key = 'A contract with this key already exists.'
  const name = f.name.trim()
  if (name.length === 0) errors.name = 'Give the contract a name.'
  else if (name.length > LIMITS.contractName)
    errors.name = `At most ${LIMITS.contractName} characters.`
  if (!f.provider) errors.provider = 'Choose the repository that owns the contract.'
  const path = f.path.trim()
  if (path.length === 0) errors.path = 'Give the path of the contract file inside the provider.'
  else if (path.length > LIMITS.path) errors.path = `At most ${LIMITS.path} characters.`
  return finish(errors, ['key', 'name', 'provider', 'path'])
}

export function buildContractInput(workspaceId: string, f: ContractForm) {
  return {
    workspaceId,
    key: f.key.trim(),
    name: f.name.trim(),
    kind: f.kind,
    provider: f.provider,
    path: f.path.trim(),
  }
}

export const isContractKind = (v: string): v is ContractKind =>
  (CONTRACT_KINDS as readonly string[]).includes(v)

export interface ConsumerForm {
  repository: string
  copyPath: string
}
export type ConsumerField = 'repository' | 'copyPath'

export function validateConsumerForm(
  f: ConsumerForm,
  taken: readonly string[] = [],
): Check<ConsumerField> {
  const errors: Partial<Record<ConsumerField, string>> = {}
  if (!f.repository) errors.repository = 'Choose a repository.'
  else if (taken.includes(f.repository))
    errors.repository = 'This repository is already a consumer (or owns the contract).'
  if (f.copyPath.trim().length > LIMITS.path) errors.copyPath = `At most ${LIMITS.path} characters.`
  return finish(errors, ['repository', 'copyPath'])
}

export function buildConsumerInput(contractId: string, f: ConsumerForm) {
  const copyPath = f.copyPath.trim()
  return { contractId, repository: f.repository, copyPath: copyPath ? copyPath : null }
}

// ───────────────────────────── service ─────────────────────────────

export interface ServiceForm {
  name: string
  description: string
}
export type ServiceField = 'name' | 'description'

export function validateServiceForm(f: ServiceForm): Check<ServiceField> {
  const errors: Partial<Record<ServiceField, string>> = {}
  const name = f.name.trim()
  if (name.length === 0) errors.name = 'Name the service.'
  else if (name.length > LIMITS.serviceName)
    errors.name = `At most ${LIMITS.serviceName} characters.`
  if (f.description.trim().length > LIMITS.serviceDescription)
    errors.description = `At most ${LIMITS.serviceDescription} characters.`
  return finish(errors, ['name', 'description'])
}

export function buildServiceInput(repositoryId: string, f: ServiceForm) {
  return { repositoryId, name: f.name.trim(), description: f.description.trim() }
}

// ───────────────────────────── memory ─────────────────────────────

export interface MemoryForm {
  kind: WorkspaceMemoryKind
  title: string
  content: string
  evidence: string
  repositories: string[]
}
export const emptyMemoryForm = (): MemoryForm => ({
  kind: 'architecture',
  title: '',
  content: '',
  evidence: '',
  repositories: [],
})
export type MemoryField = 'title' | 'content' | 'evidence' | 'repositories'

export const MEMORY_REPOSITORIES_HINT =
  'Workspace memory is for facts that span repositories. A fact about one repository belongs to that repository’s own memory, so choose at least two.'

export function validateMemoryForm(f: MemoryForm): Check<MemoryField> {
  const errors: Partial<Record<MemoryField, string>> = {}
  const title = f.title.trim()
  if (title.length === 0) errors.title = 'Give the entry a title.'
  else if (title.length > LIMITS.memoryTitle)
    errors.title = `At most ${LIMITS.memoryTitle} characters.`
  const content = f.content.trim()
  if (content.length === 0) errors.content = 'Say what is true.'
  else if (content.length > LIMITS.memoryText)
    errors.content = `At most ${LIMITS.memoryText} characters.`
  const evidence = f.evidence.trim()
  if (evidence.length === 0)
    errors.evidence = 'Say how you know (a file, a commit, a verification).'
  else if (evidence.length > LIMITS.memoryText)
    errors.evidence = `At most ${LIMITS.memoryText} characters.`
  if (f.repositories.length < 2)
    errors.repositories =
      'Choose at least two repositories: a fact about one repository belongs to that repository.'
  return finish(errors, ['title', 'content', 'evidence', 'repositories'])
}

export function buildMemoryInput(workspaceId: string, f: MemoryForm) {
  return {
    workspaceId,
    kind: f.kind,
    title: f.title.trim(),
    content: f.content.trim(),
    evidence: f.evidence.trim(),
    repositories: [...f.repositories].sort(),
  }
}

export const isMemoryKind = (v: string): v is WorkspaceMemoryKind =>
  (WORKSPACE_MEMORY_KINDS as readonly string[]).includes(v)

// ───────────────────────────── policy ─────────────────────────────

export interface PolicyForm {
  allowedRepositories: string[]
  /** Comma-separated. */
  protectedBranches: string
  maxRepositoriesPerMission: string
  maxTasksPerMission: string
  maxParallelRepositories: string
  reviewMode: WorkspacePolicy['reviewMode']
  missionStrategy: WorkspacePolicy['missionStrategy']
  missionPreset: WorkspacePolicy['missionPreset']
  requireConsumerUpdateOnBreakingChange: boolean
}
export type PolicyField =
  | 'protectedBranches'
  | 'maxRepositoriesPerMission'
  | 'maxTasksPerMission'
  | 'maxParallelRepositories'

export function policyToForm(p: WorkspacePolicy): PolicyForm {
  return {
    allowedRepositories: [...p.allowedRepositories],
    protectedBranches: p.protectedBranches.join(', '),
    maxRepositoriesPerMission: String(p.maxRepositoriesPerMission),
    maxTasksPerMission: String(p.maxTasksPerMission),
    maxParallelRepositories: String(p.maxParallelRepositories),
    reviewMode: p.reviewMode,
    missionStrategy: p.missionStrategy,
    missionPreset: p.missionPreset,
    requireConsumerUpdateOnBreakingChange: p.requireConsumerUpdateOnBreakingChange,
  }
}

export function splitBranches(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(',')) {
    const t = part.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function intIn(text: string, min: number, max: number): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= min && n <= max ? n : null
}

export function validatePolicyForm(f: PolicyForm): Check<PolicyField> {
  const errors: Partial<Record<PolicyField, string>> = {}
  const branches = splitBranches(f.protectedBranches)
  if (branches.length > 20) errors.protectedBranches = 'At most 20 protected branches.'
  else if (branches.some((b) => b.length > 120))
    errors.protectedBranches = 'A branch name is at most 120 characters.'
  if (intIn(f.maxRepositoriesPerMission, 1, 20) === null)
    errors.maxRepositoriesPerMission = 'A whole number from 1 to 20.'
  if (intIn(f.maxTasksPerMission, 1, 40) === null)
    errors.maxTasksPerMission = 'A whole number from 1 to 40.'
  if (intIn(f.maxParallelRepositories, 1, 4) === null)
    errors.maxParallelRepositories = 'A whole number from 1 to 4.'
  return finish(errors, [
    'protectedBranches',
    'maxRepositoriesPerMission',
    'maxTasksPerMission',
    'maxParallelRepositories',
  ])
}

/** Null when the form is invalid. Publishing is always 'never'. */
export function buildPolicy(f: PolicyForm): WorkspacePolicy | null {
  if (!validatePolicyForm(f).ok) return null
  return {
    allowedRepositories: [...new Set(f.allowedRepositories)].sort(),
    protectedBranches: splitBranches(f.protectedBranches),
    maxRepositoriesPerMission: Number(f.maxRepositoriesPerMission),
    maxTasksPerMission: Number(f.maxTasksPerMission),
    maxParallelRepositories: Number(f.maxParallelRepositories),
    reviewMode: f.reviewMode,
    publishing: 'never',
    requireConsumerUpdateOnBreakingChange: f.requireConsumerUpdateOnBreakingChange,
    missionStrategy: f.missionStrategy,
    missionPreset: f.missionPreset,
  }
}

export function policyEquals(a: WorkspacePolicy, b: WorkspacePolicy): boolean {
  const norm = (p: WorkspacePolicy) =>
    JSON.stringify(
      Object.entries({ ...p, allowedRepositories: [...p.allowedRepositories].sort() }).sort(
        ([x], [y]) => (x < y ? -1 : 1),
      ),
    )
  return norm(a) === norm(b)
}
