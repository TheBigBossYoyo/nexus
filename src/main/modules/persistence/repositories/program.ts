import {
  LIVE_PROGRAM_STATES,
  TERMINAL_PROGRAM_STATES,
  type BacklogItem,
  type BacklogStatus,
  type BackgroundJob,
  type ExpertiseArea,
  type ExpertiseProfile,
  type Milestone,
  type Program,
  type ProgramCheckpoint,
  type ProgramDecision,
  type ProgramMemoryEntry,
  type ProgramMission,
  type ProgramPlanRevision,
  type Workstream,
} from '@shared/program'
import type { Database } from '../database'
import { guard, prepare, Table, type Codec } from '../table'

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
const clamp = (limit: number | undefined, fallback: number, max: number): number => Math.min(Math.max(1, limit ?? fallback), max)

const programCodec: Codec<Program> = {
  table: 'programs',
  fields: {
    id: 'text',
    projectId: 'text',
    name: 'text',
    goal: 'json',
    state: 'text',
    resumeState: 'text',
    pauseReason: 'text',
    blockedReason: 'text',
    policy: 'json',
    schedule: 'json',
    planVersion: 'num',
    branch: 'text',
    baseCommit: 'text',
    currentMilestoneId: 'text',
    currentRunId: 'text',
    currentRunKind: 'text',
    activeMs: 'num',
    activeSince: 'text',
    quotaWaitSince: 'text',
    missions: 'num',
    replans: 'num',
    outcome: 'json',
    error: 'text',
    createdAt: 'text',
    startedAt: 'text',
    updatedAt: 'text',
    finishedAt: 'text',
  },
}

export class ProgramRepository extends Table<Program> {
  constructor(db: Database) {
    super(db, programCodec, 'program')
  }

  /** Newest first. */
  list(options: { projectId?: string; limit?: number; offset?: number } = {}): Program[] {
    const limit = clamp(options.limit, 50, 200)
    const offset = Math.max(0, options.offset ?? 0)
    return options.projectId
      ? this.query('WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [options.projectId, limit, offset])
      : this.query('ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [limit, offset])
  }

  count(): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n
  }

  /** Programs the engine still has to drive or watch (everything that is not terminal and not a draft). */
  listOpen(): Program[] {
    const closed = [...TERMINAL_PROGRAM_STATES, 'DRAFT']
    return this.query(`WHERE state NOT IN (${marks(closed.length)}) ORDER BY created_at, rowid`, closed)
  }

  listLive(): Program[] {
    return this.query(`WHERE state IN (${marks(LIVE_PROGRAM_STATES.length)}) ORDER BY created_at, rowid`, [...LIVE_PROGRAM_STATES])
  }

  getByRun(runId: string): Program | null {
    return this.one('WHERE current_run_id = ?', [runId])
  }
}

const workstreamCodec: Codec<Workstream> = {
  table: 'program_workstreams',
  fields: { id: 'text', programId: 'text', key: 'text', name: 'text', expertise: 'text', createdAt: 'text' },
}

export class WorkstreamRepository extends Table<Workstream> {
  constructor(db: Database) {
    super(db, workstreamCodec, 'workstream')
  }

  listByProgram(programId: string): Workstream[] {
    return this.query('WHERE program_id = ? ORDER BY created_at, rowid', [programId])
  }

  getByKey(programId: string, key: string): Workstream | null {
    return this.one('WHERE program_id = ? AND key = ?', [programId, key])
  }
}

const milestoneCodec: Codec<Milestone> = {
  table: 'program_milestones',
  fields: {
    id: 'text',
    programId: 'text',
    key: 'text',
    ordinal: 'num',
    title: 'text',
    objective: 'text',
    acceptanceCriteria: 'json',
    workstreamId: 'text',
    expertise: 'text',
    dependsOn: 'json',
    complexity: 'text',
    risk: 'text',
    state: 'text',
    attempts: 'num',
    gaps: 'json',
    evidence: 'json',
    blockedReason: 'text',
    planVersion: 'num',
    createdAt: 'text',
    startedAt: 'text',
    completedAt: 'text',
  },
}

export class MilestoneRepository extends Table<Milestone> {
  constructor(db: Database) {
    super(db, milestoneCodec, 'milestone')
  }

  /** Roadmap order. */
  listByProgram(programId: string): Milestone[] {
    return this.query('WHERE program_id = ? ORDER BY ordinal, rowid', [programId])
  }

  getByKey(programId: string, key: string): Milestone | null {
    return this.one('WHERE program_id = ? AND key = ?', [programId, key])
  }
}

const missionCodec: Codec<ProgramMission> = {
  table: 'program_missions',
  fields: {
    id: 'text',
    programId: 'text',
    milestoneId: 'text',
    runId: 'text',
    attempt: 'num',
    strategy: 'text',
    outcome: 'text',
    baseCommit: 'text',
    resultCommit: 'text',
    createdAt: 'text',
    finishedAt: 'text',
  },
}

export class ProgramMissionRepository extends Table<ProgramMission> {
  constructor(db: Database) {
    super(db, missionCodec, 'program mission')
  }

  listByProgram(programId: string): ProgramMission[] {
    return this.query('WHERE program_id = ? ORDER BY created_at, rowid', [programId])
  }

  listByMilestone(milestoneId: string): ProgramMission[] {
    return this.query('WHERE milestone_id = ? ORDER BY attempt, rowid', [milestoneId])
  }

  getByRun(runId: string): ProgramMission | null {
    return this.one('WHERE run_id = ?', [runId])
  }
}

const decisionCodec: Codec<ProgramDecision> = {
  table: 'program_decisions',
  fields: { id: 'text', programId: 'text', kind: 'text', summary: 'text', milestoneId: 'text', runId: 'text', detail: 'json', createdAt: 'text' },
}

export class ProgramDecisionRepository extends Table<ProgramDecision> {
  constructor(db: Database) {
    super(db, decisionCodec, 'program decision')
  }

  /** Oldest first. */
  listByProgram(programId: string, limit = 500): ProgramDecision[] {
    return this.query('WHERE program_id = ? ORDER BY created_at, rowid LIMIT ?', [programId, clamp(limit, 500, 5000)])
  }

  /** Newest first, for the page. */
  recent(programId: string, limit = 50): ProgramDecision[] {
    return this.query('WHERE program_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [programId, clamp(limit, 50, 500)])
  }
}

const checkpointCodec: Codec<ProgramCheckpoint> = {
  table: 'program_checkpoints',
  fields: { id: 'text', programId: 'text', reason: 'text', snapshot: 'json', createdAt: 'text' },
}

export class ProgramCheckpointRepository extends Table<ProgramCheckpoint> {
  constructor(db: Database) {
    super(db, checkpointCodec, 'program checkpoint')
  }

  latest(programId: string): ProgramCheckpoint | null {
    return this.one('WHERE program_id = ? ORDER BY created_at DESC, rowid DESC', [programId])
  }

  count(programId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM program_checkpoints WHERE program_id = ?').get(programId) as { n: number }).n
  }

  /** Keep the newest `keep` checkpoints of a program. */
  prune(programId: string, keep: number): void {
    guard(() =>
      prepare(
        this.db,
        'DELETE FROM program_checkpoints WHERE program_id = ? AND rowid NOT IN (SELECT rowid FROM program_checkpoints WHERE program_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)',
      ).run(programId, programId, keep),
    )
  }
}

const revisionCodec: Codec<ProgramPlanRevision> = {
  table: 'program_plan_revisions',
  fields: {
    id: 'text',
    programId: 'text',
    version: 'num',
    trigger: 'text',
    reason: 'text',
    milestones: 'json',
    deferred: 'json',
    diff: 'json',
    strategyNote: 'text',
    status: 'text',
    runId: 'text',
    createdAt: 'text',
    decidedAt: 'text',
  },
}

export class ProgramPlanRevisionRepository extends Table<ProgramPlanRevision> {
  constructor(db: Database) {
    super(db, revisionCodec, 'plan revision')
  }

  listByProgram(programId: string): ProgramPlanRevision[] {
    return this.query('WHERE program_id = ? ORDER BY created_at, rowid', [programId])
  }

  pending(programId: string): ProgramPlanRevision | null {
    return this.one("WHERE program_id = ? AND status = 'proposed' ORDER BY created_at DESC, rowid DESC", [programId])
  }
}

const memoryCodec: Codec<ProgramMemoryEntry> = {
  table: 'program_memory',
  fields: {
    id: 'text',
    programId: 'text',
    projectId: 'text',
    milestoneKey: 'text',
    kind: 'text',
    title: 'text',
    content: 'text',
    evidence: 'text',
    tags: 'json',
    source: 'json',
    status: 'text',
    createdAt: 'text',
  },
}

export class ProgramMemoryRepository extends Table<ProgramMemoryEntry> {
  constructor(db: Database) {
    super(db, memoryCodec, 'program memory entry')
  }

  listActive(programId: string): ProgramMemoryEntry[] {
    return this.query("WHERE program_id = ? AND status = 'active' ORDER BY created_at, rowid", [programId])
  }

  countActive(programId: string): number {
    return (prepare(this.db, "SELECT COUNT(*) AS n FROM program_memory WHERE program_id = ? AND status = 'active'").get(programId) as { n: number }).n
  }
}

const backlogCodec: Codec<BacklogItem> = {
  table: 'backlog_items',
  fields: {
    id: 'text',
    projectId: 'text',
    programId: 'text',
    title: 'text',
    description: 'text',
    category: 'text',
    severity: 'text',
    evidence: 'text',
    complexity: 'text',
    dependencies: 'json',
    recommendedMilestone: 'text',
    provenance: 'json',
    status: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
}

const OPEN_BACKLOG: readonly BacklogStatus[] = ['proposed', 'accepted', 'scheduled']

export class BacklogRepository extends Table<BacklogItem> {
  constructor(db: Database) {
    super(db, backlogCodec, 'backlog item')
  }

  /** Newest first, paged. */
  list(options: { projectId?: string; programId?: string; statuses?: readonly BacklogStatus[]; limit?: number; offset?: number } = {}): BacklogItem[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (options.projectId) {
      where.push('project_id = ?')
      params.push(options.projectId)
    }
    if (options.programId) {
      where.push('program_id = ?')
      params.push(options.programId)
    }
    if (options.statuses && options.statuses.length > 0) {
      where.push(`status IN (${marks(options.statuses.length)})`)
      params.push(...options.statuses)
    }
    params.push(clamp(options.limit, 100, 500), Math.max(0, options.offset ?? 0))
    return this.query(`${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, params)
  }

  countOpen(programId: string): number {
    return (prepare(this.db, `SELECT COUNT(*) AS n FROM backlog_items WHERE program_id = ? AND status IN (${marks(OPEN_BACKLOG.length)})`).get(programId, ...OPEN_BACKLOG) as { n: number }).n
  }

  /** An open item of the project with the same title (proposals are not stored twice). */
  findOpenByTitle(projectId: string, title: string): BacklogItem | null {
    return this.one(`WHERE project_id = ? AND title = ? COLLATE NOCASE AND status IN (${marks(OPEN_BACKLOG.length)})`, [projectId, title, ...OPEN_BACKLOG])
  }
}

const expertiseCodec: Codec<ExpertiseProfile> = {
  table: 'expertise_profiles',
  fields: { id: 'text', projectId: 'text', area: 'text', projectAreas: 'json', milestonesAccepted: 'num', milestonesRejected: 'num', missions: 'num', memoryIds: 'json', updatedAt: 'text' },
}

export class ExpertiseRepository extends Table<ExpertiseProfile> {
  constructor(db: Database) {
    super(db, expertiseCodec, 'expertise profile')
  }

  listByProject(projectId: string): ExpertiseProfile[] {
    return this.query('WHERE project_id = ? ORDER BY area', [projectId])
  }

  getByArea(projectId: string, area: ExpertiseArea): ExpertiseProfile | null {
    return this.one('WHERE project_id = ? AND area = ?', [projectId, area])
  }
}

const jobCodec: Codec<BackgroundJob> = {
  table: 'background_jobs',
  fields: { id: 'text', projectId: 'text', kind: 'text', state: 'text', runId: 'text', proposals: 'num', summary: 'text', error: 'text', createdAt: 'text', startedAt: 'text', finishedAt: 'text' },
}

export class BackgroundJobRepository extends Table<BackgroundJob> {
  constructor(db: Database) {
    super(db, jobCodec, 'background job')
  }

  listByProject(projectId: string, limit = 50): BackgroundJob[] {
    return this.query('WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [projectId, clamp(limit, 50, 200)])
  }

  listOpen(): BackgroundJob[] {
    return this.query("WHERE state IN ('queued', 'running') ORDER BY created_at, rowid")
  }

  getByRun(runId: string): BackgroundJob | null {
    return this.one('WHERE run_id = ?', [runId])
  }
}
