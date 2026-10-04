import { REASONING_MARKERS } from '@shared/program'
import {
  TERMINAL_RUN_STATES,
  type Project,
  type Run,
  type RunState,
  type Task,
  type TaskDependency,
  type TaskState,
} from '@shared/domain'
import type { Database } from '../database'
import { Table, decode, guard, prepare, type Codec, type Row, type SqlValue } from '../table'

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

const projectCodec: Codec<Project> = {
  table: 'projects',
  fields: {
    id: 'text',
    name: 'text',
    rootPath: 'text',
    profile: 'json',
    respectProjectClaudeConfig: 'bool',
    createdAt: 'text',
    lastOpenedAt: 'text',
  },
}

export class ProjectRepository extends Table<Project> {
  constructor(db: Database) {
    super(db, projectCodec, 'project')
  }

  /** Root paths compare case-insensitively (Windows drive letters and folders). */
  getByRootPath(rootPath: string): Project | null {
    return this.one('WHERE root_path = ?', [rootPath])
  }

  /** The user's projects. The hidden projects of Arena trials are not listed. */
  list(): Project[] {
    return this.query(
      'WHERE id NOT IN (SELECT project_id FROM arena_trials WHERE project_id IS NOT NULL) ORDER BY last_opened_at DESC, rowid DESC',
    )
  }

  isArena(projectId: string): boolean {
    return prepare(this.db, 'SELECT 1 FROM arena_trials WHERE project_id = ? LIMIT 1').get(projectId) !== undefined
  }

  listArena(): Project[] {
    return this.query(
      'WHERE id IN (SELECT project_id FROM arena_trials WHERE project_id IS NOT NULL) ORDER BY created_at, rowid',
    )
  }
}

const runCodec: Codec<Run> = {
  table: 'runs',
  fields: {
    id: 'text',
    projectId: 'text',
    mode: 'text',
    preset: 'text',
    state: 'text',
    resumeState: 'text',
    pauseReason: 'text',
    prompt: 'text',
    plan: 'json',
    baseBranch: 'text',
    baseCommit: 'text',
    integrationBranch: 'text',
    config: 'json',
    error: 'text',
    createdAt: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

export class RunRepository extends Table<Run> {
  constructor(db: Database) {
    super(db, runCodec, 'run')
  }

  /** Newest first. */
  listByProject(projectId: string): Run[] {
    return this.query('WHERE project_id = ? ORDER BY created_at DESC, rowid DESC', [projectId])
  }

  /** The newest runs of every project, newest first. */
  listRecent(limit = 50): Run[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 500)])
  }

  /**
   * The newest runs of the user's own projects. Runs of Arena trials and the read-only sessions NEXUS runs for
   * itself (program planning, verification, reassessment, background analysis) are left out in SQL, before the limit.
   */
  listRecentUser(limit = 50): Run[] {
    return this.query(
      `WHERE id NOT IN (SELECT run_id FROM arena_trials WHERE run_id IS NOT NULL)
         AND NOT (mode = 'ask' AND prompt LIKE 'NEXUS %' AND (${Object.values(REASONING_MARKERS).map(() => 'prompt LIKE ?').join(' OR ')}))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [...Object.values(REASONING_MARKERS).map((marker) => `${marker}%`), Math.min(Math.max(1, limit), 500)],
    )
  }

  /** Runs in any non-terminal state (including paused), oldest first. */
  listActive(): Run[] {
    const terminal: SqlValue[] = [...TERMINAL_RUN_STATES]
    return this.query(`WHERE state NOT IN (${placeholders(terminal.length)}) ORDER BY created_at, rowid`, terminal)
  }

  listByState(state: RunState): Run[] {
    return this.query('WHERE state = ? ORDER BY created_at, rowid', [state])
  }
}

const taskCodec: Codec<Task> = {
  table: 'tasks',
  fields: {
    id: 'text',
    runId: 'text',
    key: 'text',
    title: 'text',
    description: 'text',
    role: 'text',
    kind: 'text',
    state: 'text',
    priority: 'num',
    complexity: 'text',
    risk: 'text',
    parallelizable: 'bool',
    requiresApproval: 'bool',
    approvalGranted: 'bool',
    suggestedFiles: 'json',
    acceptanceCriteria: 'json',
    attempt: 'num',
    repairCycles: 'num',
    parentTaskId: 'text',
    modelTierOverride: 'text',
    branch: 'text',
    worktreeId: 'text',
    leaseOwner: 'text',
    leaseExpiresAt: 'text',
    resultSummary: 'text',
    blockedReason: 'text',
    error: 'json',
    createdAt: 'text',
    startedAt: 'text',
    finishedAt: 'text',
  },
}

export class TaskRepository extends Table<Task> {
  constructor(db: Database) {
    super(db, taskCodec, 'task')
  }

  listByRun(runId: string): Task[] {
    return this.byRun(runId)
  }

  listByState(runId: string, states: TaskState | readonly TaskState[]): Task[] {
    const list: SqlValue[] = typeof states === 'string' ? [states] : [...states]
    if (list.length === 0) return []
    return this.query(`WHERE run_id = ? AND state IN (${placeholders(list.length)}) ORDER BY priority DESC, created_at, rowid`, [
      runId,
      ...list,
    ])
  }

  getByKey(runId: string, key: string): Task | null {
    return this.one('WHERE run_id = ? AND "key" = ?', [runId, key])
  }

  /** Tasks whose lease passed `now` while still held by an agent (assigned or running). */
  listExpiredLeases(now: string): Task[] {
    return this.query(
      "WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ? AND state IN ('assigned', 'running') ORDER BY lease_expires_at",
      [now],
    )
  }

  listByParent(parentTaskId: string): Task[] {
    return this.query('WHERE parent_task_id = ? ORDER BY created_at, rowid', [parentTaskId])
  }
}

const dependencyCodec: Codec<TaskDependency> = {
  table: 'task_dependencies',
  fields: { taskId: 'text', dependsOnTaskId: 'text' },
}

export class DependencyRepository {
  constructor(private readonly db: Database) {}

  /** Idempotent. Both tasks must exist; a task cannot depend on itself. */
  add(taskId: string, dependsOnTaskId: string): TaskDependency {
    guard(() =>
      prepare(this.db, 'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(
        taskId,
        dependsOnTaskId,
      ),
    )
    return { taskId, dependsOnTaskId }
  }

  remove(taskId: string, dependsOnTaskId: string): boolean {
    return (
      prepare(this.db, 'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').run(
        taskId,
        dependsOnTaskId,
      ).changes > 0
    )
  }

  listByRun(runId: string): TaskDependency[] {
    return this.map(
      'SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.run_id = ? ORDER BY t.created_at, t.rowid, d.depends_on_task_id',
      runId,
    )
  }

  listForTask(taskId: string): TaskDependency[] {
    return this.map('SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id', taskId)
  }

  listDependants(taskId: string): TaskDependency[] {
    return this.map(
      'SELECT task_id, depends_on_task_id FROM task_dependencies WHERE depends_on_task_id = ? ORDER BY task_id',
      taskId,
    )
  }

  private map(sql: string, param: string): TaskDependency[] {
    return (prepare(this.db, sql).all(param) as Row[]).map((r) => decode(dependencyCodec, r))
  }
}
