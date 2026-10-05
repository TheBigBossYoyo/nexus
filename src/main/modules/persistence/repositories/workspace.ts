import {
  TERMINAL_WORKSPACE_MISSION_STATES,
  type Contract,
  type ContractConsumer,
  type ContractVersion,
  type CrossRepoDependency,
  type CrossRepoTask,
  type ReleaseTrain,
  type Service,
  type Workspace,
  type WorkspaceDecision,
  type WorkspaceMemoryEntry,
  type WorkspaceMission,
  type WorkspaceProgram,
  type WorkspaceRepository,
} from '@shared/workspace'
import type { Database } from '../database'
import { prepare, Table, type Codec } from '../table'

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
const clamp = (limit: number | undefined, fallback: number, max: number): number => Math.min(Math.max(1, limit ?? fallback), max)

const workspaceCodec: Codec<Workspace> = { table: 'workspaces', fields: { id: 'text', name: 'text', description: 'text', policy: 'json', createdAt: 'text', updatedAt: 'text' } }

export class WorkspaceRepositoryStore extends Table<Workspace> {
  constructor(db: Database) {
    super(db, workspaceCodec, 'workspace')
  }

  list(limit = 100): Workspace[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [clamp(limit, 100, 500)])
  }
}

const repositoryCodec: Codec<WorkspaceRepository> = {
  table: 'workspace_repositories',
  fields: {
    id: 'text',
    workspaceId: 'text',
    key: 'text',
    projectId: 'text',
    rootPath: 'text',
    role: 'text',
    remote: 'text',
    branch: 'text',
    languages: 'json',
    frameworks: 'json',
    commands: 'json',
    packageName: 'text',
    packageVersion: 'text',
    manifest: 'text',
    enrolledAt: 'text',
    refreshedAt: 'text',
  },
}

export class EnrolledRepositoryStore extends Table<WorkspaceRepository> {
  constructor(db: Database) {
    super(db, repositoryCodec, 'workspace repository')
  }

  listByWorkspace(workspaceId: string): WorkspaceRepository[] {
    return this.query('WHERE workspace_id = ? ORDER BY enrolled_at, rowid', [workspaceId])
  }

  getByKey(workspaceId: string, key: string): WorkspaceRepository | null {
    return this.one('WHERE workspace_id = ? AND key = ?', [workspaceId, key])
  }

  getByProject(workspaceId: string, projectId: string): WorkspaceRepository | null {
    return this.one('WHERE workspace_id = ? AND project_id = ?', [workspaceId, projectId])
  }

  countByWorkspace(workspaceId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM workspace_repositories WHERE workspace_id = ?').get(workspaceId) as { n: number }).n
  }
}

const serviceCodec: Codec<Service> = { table: 'workspace_services', fields: { id: 'text', workspaceId: 'text', repositoryId: 'text', name: 'text', description: 'text', createdAt: 'text' } }

export class ServiceStore extends Table<Service> {
  constructor(db: Database) {
    super(db, serviceCodec, 'service')
  }

  listByWorkspace(workspaceId: string): Service[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at, rowid', [workspaceId])
  }
}

const dependencyCodec: Codec<CrossRepoDependency> = {
  table: 'workspace_dependencies',
  fields: { id: 'text', workspaceId: 'text', fromRepositoryId: 'text', toRepositoryId: 'text', kind: 'text', provenance: 'json', createdAt: 'text' },
}

export class WorkspaceDependencyStore extends Table<CrossRepoDependency> {
  constructor(db: Database) {
    super(db, dependencyCodec, 'workspace dependency')
  }

  listByWorkspace(workspaceId: string): CrossRepoDependency[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at, rowid', [workspaceId])
  }
}

const contractCodec: Codec<Contract> = {
  table: 'workspace_contracts',
  fields: { id: 'text', workspaceId: 'text', key: 'text', name: 'text', kind: 'text', providerRepositoryId: 'text', path: 'text', createdAt: 'text' },
}

export class ContractStore extends Table<Contract> {
  constructor(db: Database) {
    super(db, contractCodec, 'contract')
  }

  listByWorkspace(workspaceId: string): Contract[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at, rowid', [workspaceId])
  }

  getByKey(workspaceId: string, key: string): Contract | null {
    return this.one('WHERE workspace_id = ? AND key = ?', [workspaceId, key])
  }

  countByWorkspace(workspaceId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM workspace_contracts WHERE workspace_id = ?').get(workspaceId) as { n: number }).n
  }
}

const consumerCodec: Codec<ContractConsumer> = {
  table: 'workspace_contract_consumers',
  fields: { id: 'text', contractId: 'text', repositoryId: 'text', copyPath: 'text', provenance: 'json', createdAt: 'text' },
}

export class ContractConsumerStore extends Table<ContractConsumer> {
  constructor(db: Database) {
    super(db, consumerCodec, 'contract consumer')
  }

  listByContract(contractId: string): ContractConsumer[] {
    return this.query('WHERE contract_id = ? ORDER BY created_at, rowid', [contractId])
  }

  find(contractId: string, repositoryId: string): ContractConsumer | null {
    return this.one('WHERE contract_id = ? AND repository_id = ?', [contractId, repositoryId])
  }
}

const versionCodec: Codec<ContractVersion> = {
  table: 'workspace_contract_versions',
  fields: { id: 'text', contractId: 'text', version: 'num', hash: 'text', commit: 'text', surface: 'json', parseError: 'text', capturedAt: 'text' },
}

export class ContractVersionStore extends Table<ContractVersion> {
  constructor(db: Database) {
    super(db, versionCodec, 'contract version')
  }

  /** Oldest first; at most the newest `limit`. */
  listByContract(contractId: string, limit = 50): ContractVersion[] {
    return this.query('WHERE contract_id = ? ORDER BY version DESC LIMIT ?', [contractId, clamp(limit, 50, 500)]).reverse()
  }

  latest(contractId: string): ContractVersion | null {
    return this.one('WHERE contract_id = ? ORDER BY version DESC', [contractId])
  }
}

const missionCodec: Codec<WorkspaceMission> = {
  table: 'workspace_missions',
  fields: {
    id: 'text',
    workspaceId: 'text',
    programId: 'text',
    goal: 'text',
    state: 'text',
    resumeState: 'text',
    blockedReason: 'text',
    plan: 'json',
    plannerRunId: 'text',
    verification: 'json',
    error: 'text',
    createdAt: 'text',
    startedAt: 'text',
    updatedAt: 'text',
    finishedAt: 'text',
  },
}

export class WorkspaceMissionStore extends Table<WorkspaceMission> {
  constructor(db: Database) {
    super(db, missionCodec, 'workspace mission')
  }

  listByWorkspace(workspaceId: string, limit = 50): WorkspaceMission[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [workspaceId, clamp(limit, 50, 200)])
  }

  /** The missions of a workspace program, oldest first. */
  listByProgram(programId: string): WorkspaceMission[] {
    return this.query('WHERE program_id = ? ORDER BY created_at, rowid', [programId])
  }

  /** Missions the engine still has to drive or watch. */
  listOpen(): WorkspaceMission[] {
    const closed = [...TERMINAL_WORKSPACE_MISSION_STATES, 'DRAFT']
    return this.query(`WHERE state NOT IN (${marks(closed.length)}) ORDER BY created_at, rowid`, closed)
  }

  countActive(workspaceId: string): number {
    const closed = [...TERMINAL_WORKSPACE_MISSION_STATES, 'DRAFT']
    return (prepare(this.db, `SELECT COUNT(*) AS n FROM workspace_missions WHERE workspace_id = ? AND state NOT IN (${marks(closed.length)})`).get(workspaceId, ...closed) as { n: number }).n
  }

  getByPlannerRun(runId: string): WorkspaceMission | null {
    return this.one('WHERE planner_run_id = ?', [runId])
  }
}

const programCodec: Codec<WorkspaceProgram> = {
  table: 'workspace_programs',
  fields: { id: 'text', workspaceId: 'text', name: 'text', goal: 'text', milestones: 'json', state: 'text', blockedReason: 'text', createdAt: 'text', startedAt: 'text', updatedAt: 'text', finishedAt: 'text' },
}

export class WorkspaceProgramStore extends Table<WorkspaceProgram> {
  constructor(db: Database) {
    super(db, programCodec, 'workspace program')
  }

  listByWorkspace(workspaceId: string, limit = 30): WorkspaceProgram[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [workspaceId, clamp(limit, 30, 200)])
  }

  listOpen(): WorkspaceProgram[] {
    return this.query("WHERE state IN ('ACTIVE', 'BLOCKED') ORDER BY created_at, rowid")
  }

  countActive(workspaceId: string): number {
    return (prepare(this.db, "SELECT COUNT(*) AS n FROM workspace_programs WHERE workspace_id = ? AND state IN ('ACTIVE', 'BLOCKED')").get(workspaceId) as { n: number }).n
  }
}

const taskCodec: Codec<CrossRepoTask> = {
  table: 'workspace_tasks',
  fields: {
    id: 'text',
    missionId: 'text',
    repositoryId: 'text',
    key: 'text',
    repository: 'text',
    ordinal: 'num',
    title: 'text',
    objective: 'text',
    acceptanceCriteria: 'json',
    dependsOn: 'json',
    contracts: 'json',
    state: 'text',
    runId: 'text',
    baseCommit: 'text',
    resultCommit: 'text',
    resultBranch: 'text',
    summary: 'text',
    error: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

export class WorkspaceTaskStore extends Table<CrossRepoTask> {
  constructor(db: Database) {
    super(db, taskCodec, 'cross-repository task')
  }

  listByMission(missionId: string): CrossRepoTask[] {
    return this.query('WHERE mission_id = ? ORDER BY ordinal, rowid', [missionId])
  }

  getByRun(runId: string): CrossRepoTask | null {
    return this.one('WHERE run_id = ?', [runId])
  }
}

const trainCodec: Codec<ReleaseTrain> = {
  table: 'workspace_release_trains',
  fields: { id: 'text', workspaceId: 'text', missionId: 'text', name: 'text', state: 'text', plan: 'json', publishAuthorized: 'bool', createdAt: 'text' },
}

export class ReleaseTrainStore extends Table<ReleaseTrain> {
  constructor(db: Database) {
    super(db, trainCodec, 'release train')
  }

  listByWorkspace(workspaceId: string, limit = 30): ReleaseTrain[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [workspaceId, clamp(limit, 30, 200)])
  }
}

const memoryCodec: Codec<WorkspaceMemoryEntry> = {
  table: 'workspace_memory',
  fields: { id: 'text', workspaceId: 'text', kind: 'text', title: 'text', content: 'text', evidence: 'text', repositories: 'json', source: 'json', createdAt: 'text' },
}

export class WorkspaceMemoryStore extends Table<WorkspaceMemoryEntry> {
  constructor(db: Database) {
    super(db, memoryCodec, 'workspace memory entry')
  }

  listByWorkspace(workspaceId: string, limit = 100): WorkspaceMemoryEntry[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [workspaceId, clamp(limit, 100, 500)])
  }
}

const decisionCodec: Codec<WorkspaceDecision> = {
  table: 'workspace_decisions',
  fields: { id: 'text', workspaceId: 'text', missionId: 'text', kind: 'text', summary: 'text', detail: 'json', createdAt: 'text' },
}

export class WorkspaceDecisionStore extends Table<WorkspaceDecision> {
  constructor(db: Database) {
    super(db, decisionCodec, 'workspace decision')
  }

  recent(workspaceId: string, limit = 100): WorkspaceDecision[] {
    return this.query('WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [workspaceId, clamp(limit, 100, 500)])
  }

  listByMission(missionId: string): WorkspaceDecision[] {
    return this.query('WHERE mission_id = ? ORDER BY created_at, rowid', [missionId])
  }
}
