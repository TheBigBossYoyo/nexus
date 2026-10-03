import {
  TERMINAL_TASK_STATES,
  WRITING_ROLES,
  type Task,
  type TaskDependency,
  type TaskState,
} from '@shared/domain'
import type {
  GraphProposal,
  GraphSnapshot,
  GraphSnapshotTask,
  ProposedTask,
} from '@shared/v2'
import { dependantsOf, dependenciesOf, findCycles } from './graph'

// ───────────────────────────── types ─────────────────────────────

/** One mechanical step the orchestrator applies, in order, inside a single transaction. */
export type GraphOperation =
  | {
      op: 'add_task'
      task: ProposedTask
      /** Existing task ids the new task depends on (includes prerequisites inherited from a split task). */
      dependsOnTaskIds: string[]
      /** Keys of other tasks added by the same proposal; their add_task operation comes earlier. */
      dependsOnNewKeys: string[]
    }
  | { op: 'cancel_task'; taskId: string }
  | { op: 'add_dependency'; taskId: string; dependsOnTaskId: string }
  | { op: 'add_dependency_on_new'; taskId: string; newKey: string }
  | { op: 'remove_dependency'; taskId: string; dependsOnTaskId: string }
  | { op: 'set_priority'; taskId: string; priority: number }
  /** The proposer's running task goes back to queued and waits for its new prerequisites. */
  | { op: 'yield_task'; taskId: string }

export interface ProposalValidationInput {
  tasks: readonly Task[]
  dependencies: readonly TaskDependency[]
  proposal: Pick<GraphProposal, 'type' | 'changes' | 'taskId'>
  /** Default 8. */
  maxNewTasks?: number
}

export type ProposalValidation =
  | {
      ok: true
      operations: GraphOperation[]
      requiresApproval: boolean
      approvalReason: string | null
      summary: string
    }
  | { ok: false; errors: string[] }

export const DEFAULT_MAX_NEW_TASKS = 8
/** Proposals adding more tasks than this need user approval. */
export const APPROVAL_NEW_TASK_THRESHOLD = 3

/** Tasks nothing has started on: they may be cancelled, split and rewired freely. */
const NOT_STARTED: readonly TaskState[] = ['draft', 'ready', 'blocked', 'queued']
/** Tasks an agent holds or has held in this attempt: only their own proposer may change them. */
const IN_PROGRESS: readonly TaskState[] = ['assigned', 'running', 'waiting', 'review', 'verification']
/** States from which the proposer's own task can go back to queued. */
const YIELDABLE: readonly TaskState[] = ['assigned', 'running', 'waiting']

const isTerminal = (t: Task): boolean => TERMINAL_TASK_STATES.includes(t.state)
const isNotStarted = (t: Task): boolean => NOT_STARTED.includes(t.state)
const isInProgress = (t: Task): boolean => IN_PROGRESS.includes(t.state)
const isRepairChild = (t: Task): boolean => t.parentTaskId !== null
const isWriting = (t: ProposedTask): boolean => WRITING_ROLES.includes(t.role)

const newNode = (key: string): string => `new:${key}`

interface Ctx {
  byId: Map<string, Task>
  byKey: Map<string, Task>
  deps: readonly TaskDependency[]
  proposer: Task | null
  maxNew: number
  errors: string[]
}

type Built = { ops: GraphOperation[]; summary: string }

// ───────────────────────────── shared checks ─────────────────────────────

/** Resolve an existing task a proposal acts on, reporting why it cannot be acted on. */
function actionTarget(ctx: Ctx, key: string | null, field: string, what: string): Task | null {
  if (key === null) {
    ctx.errors.push(`changes.${field} is required for ${what}: set it to the key of an existing task.`)
    return null
  }
  const task = ctx.byKey.get(key)
  if (!task) {
    ctx.errors.push(
      `changes.${field} '${key}' does not match any task in this run. Use the key shown in the task list.`,
    )
    return null
  }
  if (isRepairChild(task)) {
    ctx.errors.push(
      `Task '${key}' is a repair task managed by the review/verification pipeline and cannot be changed by proposals.`,
    )
    return null
  }
  if (isTerminal(task)) {
    ctx.errors.push(
      `Task '${key}' is ${task.state} and immutable; completed, failed and cancelled tasks cannot be changed. Add a new task instead.`,
    )
    return null
  }
  return task
}

/** Resolve a task that something will depend on. Completed is fine; failed or cancelled never satisfies. */
function prerequisite(ctx: Ctx, key: string | null, field: string): Task | null {
  if (key === null) {
    ctx.errors.push(`changes.${field} is required: set it to the key of the prerequisite task.`)
    return null
  }
  const task = ctx.byKey.get(key)
  if (!task) {
    ctx.errors.push(
      `changes.${field} '${key}' does not match any task in this run. Use the key shown in the task list.`,
    )
    return null
  }
  if (isRepairChild(task)) {
    ctx.errors.push(`Task '${key}' is a repair task managed by the pipeline and cannot be depended on.`)
    return null
  }
  if (task.state === 'failed' || task.state === 'cancelled') {
    ctx.errors.push(
      `Task '${key}' is ${task.state}, which never satisfies a dependency. Depend on a task that can still complete, or add a replacement task.`,
    )
    return null
  }
  return task
}

interface ResolvedNew {
  task: ProposedTask
  dependsOnTaskIds: string[]
  dependsOnNewKeys: string[]
}

/**
 * Validate tasks a proposal adds (key uniqueness, criteria, dependency references) and resolve their
 * dependencies to existing ids or sibling keys. `blocked` maps keys that may not be depended on
 * (tasks this proposal removes) to the reason.
 */
function resolveNewTasks(
  ctx: Ctx,
  tasks: readonly ProposedTask[],
  blocked: ReadonlyMap<string, string> = new Map(),
): ResolvedNew[] {
  const newKeys = new Set<string>()
  for (const t of tasks) {
    if (ctx.byKey.has(t.key)) {
      ctx.errors.push(
        `Task key '${t.key}' already exists in this run (terminal tasks keep their keys). Choose a different key.`,
      )
    } else if (newKeys.has(t.key)) {
      ctx.errors.push(`Task key '${t.key}' appears more than once in this proposal. Keys must be unique.`)
    }
    newKeys.add(t.key)
  }
  return tasks.map((task) => {
    if (isWriting(task) && task.acceptanceCriteria.length === 0) {
      ctx.errors.push(
        `Task '${task.key}' has role '${task.role}' which writes files, so it needs at least one acceptance criterion.`,
      )
    }
    const ids: string[] = []
    const keys: string[] = []
    for (const depKey of task.dependencies) {
      if (depKey === task.key) {
        ctx.errors.push(`Task '${task.key}' depends on itself. Remove it from its own dependencies.`)
        continue
      }
      const reason = blocked.get(depKey)
      if (reason !== undefined) {
        ctx.errors.push(`Task '${task.key}' depends on '${depKey}', ${reason}`)
        continue
      }
      if (newKeys.has(depKey) && !ctx.byKey.has(depKey)) {
        if (!keys.includes(depKey)) keys.push(depKey)
        continue
      }
      const existing = ctx.byKey.get(depKey)
      if (!existing) {
        ctx.errors.push(
          `Task '${task.key}' depends on unknown task '${depKey}'. Reference an existing task key or the key of another task in this proposal.`,
        )
      } else if (isRepairChild(existing)) {
        ctx.errors.push(`Task '${task.key}' depends on '${depKey}', a repair task managed by the pipeline.`)
      } else if (existing.state === 'failed' || existing.state === 'cancelled') {
        ctx.errors.push(
          `Task '${task.key}' depends on '${depKey}', which is ${existing.state} and never satisfies a dependency. Depend on a task that can complete.`,
        )
      } else if (!ids.includes(existing.id)) {
        ids.push(existing.id)
      }
    }
    return { task, dependsOnTaskIds: ids, dependsOnNewKeys: keys }
  })
}

/** Order new tasks so each follows the new tasks it depends on. Leftovers (a cycle) keep input order. */
function orderNew(resolved: readonly ResolvedNew[]): ResolvedNew[] {
  const keys = new Set(resolved.map((r) => r.task.key))
  const done = new Set<string>()
  const out: ResolvedNew[] = []
  const pending = [...resolved]
  while (pending.length > 0) {
    const i = pending.findIndex((r) => r.dependsOnNewKeys.every((k) => done.has(k) || !keys.has(k)))
    const [next] = pending.splice(i === -1 ? 0 : i, 1)
    if (!next) break
    done.add(next.task.key)
    out.push(next)
  }
  return out
}

const addTaskOps = (resolved: readonly ResolvedNew[]): GraphOperation[] =>
  orderNew(resolved).map((r) => ({
    op: 'add_task' as const,
    task: r.task,
    dependsOnTaskIds: r.dependsOnTaskIds,
    dependsOnNewKeys: r.dependsOnNewKeys,
  }))

function checkNewCount(ctx: Ctx, count: number, type: string): void {
  if (count > ctx.maxNew) {
    ctx.errors.push(
      `${type} adds ${count} tasks but at most ${ctx.maxNew} are allowed per proposal. Propose fewer tasks, or add the rest in a later proposal.`,
    )
  }
}

/**
 * A cancelled task never satisfies a dependency, so open dependants of a cancelled task must be
 * cancelled in the same proposal. Returns repair children of the cancelled tasks, which the pipeline
 * owns and which are cancelled along with their parent.
 */
function checkCancellation(ctx: Ctx, cancelIds: ReadonlySet<string>): string[] {
  const cascade: string[] = []
  for (const id of cancelIds) {
    const cancelled = ctx.byId.get(id)
    if (!cancelled) continue
    for (const dependantId of dependantsOf(ctx.deps, id)) {
      const dependant = ctx.byId.get(dependantId)
      if (!dependant || isTerminal(dependant) || cancelIds.has(dependantId)) continue
      if (isRepairChild(dependant)) {
        if (cancelIds.has(dependant.parentTaskId as string) && !cascade.includes(dependantId)) {
          cascade.push(dependantId)
        }
        continue
      }
      ctx.errors.push(
        `Cannot cancel '${cancelled.key}': task '${dependant.key}' (${dependant.state}) still depends on it, and a cancelled task never satisfies a dependency. Cancel '${dependant.key}' first, or rewire it with REMOVE_DEPENDENCY / ADD_DEPENDENCY.`,
      )
    }
  }
  return cascade
}

// ───────────────────────────── proposal types ─────────────────────────────

function buildAddTask(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  if (changes.tasks.length === 0) {
    ctx.errors.push('ADD_TASK needs at least one entry in changes.tasks.')
    return null
  }
  checkNewCount(ctx, changes.tasks.length, 'ADD_TASK')
  const resolved = resolveNewTasks(ctx, changes.tasks)
  const ops = addTaskOps(resolved)
  if (changes.blocksProposer) {
    const p = ctx.proposer
    if (!p) {
      ctx.errors.push('blocksProposer needs a proposing task, but this proposal has none.')
    } else if (!YIELDABLE.includes(p.state)) {
      ctx.errors.push(
        `blocksProposer: your task '${p.key}' is ${p.state} and cannot yield. Only a running task can wait for new tasks.`,
      )
    } else {
      for (const r of resolved) ops.push({ op: 'add_dependency_on_new', taskId: p.id, newKey: r.task.key })
      ops.push({ op: 'yield_task', taskId: p.id })
    }
  }
  const names = changes.tasks.map((t) => t.key).join(', ')
  return {
    ops,
    summary: `Add ${changes.tasks.length} task${changes.tasks.length === 1 ? '' : 's'} (${names})${
      changes.blocksProposer ? '; the proposing task waits for them' : ''
    }`,
  }
}

function buildSplit(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const original = actionTarget(ctx, changes.targetTask, 'targetTask', 'SPLIT_TASK')
  if (changes.tasks.length < 2) {
    ctx.errors.push('SPLIT_TASK needs at least two subtasks in changes.tasks.')
  }
  checkNewCount(ctx, changes.tasks.length, 'SPLIT_TASK')
  if (!original) return null
  const own = ctx.proposer?.id === original.id
  if (!isNotStarted(original) && !own) {
    ctx.errors.push(
      `Cannot split '${original.key}': it is ${original.state} and not yours. Only a task that has not started, or your own task, can be split.`,
    )
    return null
  }
  if (own && !isNotStarted(original) && !YIELDABLE.includes(original.state)) {
    ctx.errors.push(`Cannot split your own task '${original.key}' while it is ${original.state}.`)
    return null
  }

  const blocked = new Map([[original.key, 'the task being split, which is replaced. Depend on the subtasks instead.']])
  const resolved = resolveNewTasks(ctx, changes.tasks, blocked)

  // Subtasks replace the original, so they inherit its prerequisites.
  const inherited = dependenciesOf(ctx.deps, original.id)
  for (const r of resolved) {
    for (const id of inherited) if (!r.dependsOnTaskIds.includes(id)) r.dependsOnTaskIds.push(id)
  }

  // Traceability: every criterion of the original survives in some subtask.
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const carried = new Set(changes.tasks.flatMap((t) => t.acceptanceCriteria.map(norm)))
  const missing = original.acceptanceCriteria.filter((c) => !carried.has(norm(c)))
  if (missing.length > 0) {
    ctx.errors.push(
      `The split must carry over every acceptance criterion of '${original.key}'. Missing from all subtasks: ${missing
        .map((c) => `"${c}"`)
        .join('; ')}. Copy each into the subtask that satisfies it.`,
    )
  }

  const ops = addTaskOps(resolved)
  // Dependants of the original wait for every subtask; a cancelled original would never release them.
  for (const dependantId of dependantsOf(ctx.deps, original.id)) {
    const dependant = ctx.byId.get(dependantId)
    if (!dependant || isTerminal(dependant) || isRepairChild(dependant)) continue
    if (isInProgress(dependant)) {
      ctx.errors.push(
        `Cannot split '${original.key}': task '${dependant.key}' (${dependant.state}) depends on it and is already running, so it cannot be rewired.`,
      )
      continue
    }
    ops.push({ op: 'remove_dependency', taskId: dependantId, dependsOnTaskId: original.id })
    for (const r of orderNew(resolved)) {
      ops.push({ op: 'add_dependency_on_new', taskId: dependantId, newKey: r.task.key })
    }
  }
  ops.push({ op: 'cancel_task', taskId: original.id })
  return {
    ops,
    summary: `Split '${original.key}' into ${changes.tasks.map((t) => t.key).join(', ')}`,
  }
}

function buildCancel(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const target = actionTarget(ctx, changes.targetTask, 'targetTask', 'CANCEL_TASK')
  if (!target) return null
  const cascade = checkCancellation(ctx, new Set([target.id]))
  const ops: GraphOperation[] = [{ op: 'cancel_task', taskId: target.id }]
  for (const id of cascade) ops.push({ op: 'cancel_task', taskId: id })
  return { ops, summary: `Cancel '${target.key}'` }
}

function buildAddDependency(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const target = actionTarget(ctx, changes.targetTask, 'targetTask', 'ADD_DEPENDENCY')
  const prereq = prerequisite(ctx, changes.dependsOn, 'dependsOn')
  if (!target || !prereq) return null
  if (target.id === prereq.id) {
    ctx.errors.push(`Task '${target.key}' cannot depend on itself.`)
    return null
  }
  if (dependenciesOf(ctx.deps, target.id).includes(prereq.id)) {
    ctx.errors.push(`'${target.key}' already depends on '${prereq.key}'; there is nothing to add.`)
    return null
  }
  const own = ctx.proposer?.id === target.id
  const waits = prereq.state !== 'completed'
  const ops: GraphOperation[] = [{ op: 'add_dependency', taskId: target.id, dependsOnTaskId: prereq.id }]
  if (isInProgress(target)) {
    if (!own) {
      ctx.errors.push(
        `Task '${target.key}' is ${target.state}; only the agent working on it may give it a prerequisite. Another running task cannot be given one.`,
      )
      return null
    }
    if (!YIELDABLE.includes(target.state)) {
      ctx.errors.push(`Your task '${target.key}' is ${target.state} and cannot yield to wait for a prerequisite.`)
      return null
    }
    if (waits) ops.push({ op: 'yield_task', taskId: target.id })
  }
  return {
    ops,
    summary: `'${target.key}' now depends on '${prereq.key}'${
      own && waits ? '; the proposing task yields until it completes' : ''
    }`,
  }
}

function buildRemoveDependency(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const target = actionTarget(ctx, changes.targetTask, 'targetTask', 'REMOVE_DEPENDENCY')
  if (changes.dependsOn === null) {
    ctx.errors.push('changes.dependsOn is required for REMOVE_DEPENDENCY: set it to the prerequisite to drop.')
  }
  const prereq = changes.dependsOn === null ? undefined : ctx.byKey.get(changes.dependsOn)
  if (changes.dependsOn !== null && !prereq) {
    ctx.errors.push(`changes.dependsOn '${changes.dependsOn}' does not match any task in this run.`)
  }
  if (!target || !prereq) return null
  if (isInProgress(target)) {
    ctx.errors.push(
      `Task '${target.key}' is ${target.state}; a started task cannot lose a prerequisite. Only tasks that have not started can be rewired.`,
    )
    return null
  }
  if (isRepairChild(prereq)) {
    ctx.errors.push(`Task '${prereq.key}' is a repair task managed by the pipeline; its edges cannot be changed.`)
    return null
  }
  if (!dependenciesOf(ctx.deps, target.id).includes(prereq.id)) {
    ctx.errors.push(`'${target.key}' does not depend on '${prereq.key}'; there is nothing to remove.`)
    return null
  }
  return {
    ops: [{ op: 'remove_dependency', taskId: target.id, dependsOnTaskId: prereq.id }],
    summary: `'${target.key}' no longer depends on '${prereq.key}'`,
  }
}

function buildReprioritize(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const target = actionTarget(ctx, changes.targetTask, 'targetTask', 'REPRIORITIZE')
  if (changes.priority === null) {
    ctx.errors.push('changes.priority is required for REPRIORITIZE: set an integer from -100 to 100.')
  }
  if (!target || changes.priority === null) return null
  if (target.priority === changes.priority) {
    ctx.errors.push(`'${target.key}' already has priority ${changes.priority}; there is nothing to change.`)
    return null
  }
  return {
    ops: [{ op: 'set_priority', taskId: target.id, priority: changes.priority }],
    summary: `Set priority of '${target.key}' from ${target.priority} to ${changes.priority}`,
  }
}

function buildReplan(ctx: Ctx, changes: GraphProposal['changes']): Built | null {
  const listed = new Set(changes.tasks.map((t) => t.key))
  const fresh: ProposedTask[] = []
  for (const t of changes.tasks) {
    const existing = ctx.byKey.get(t.key)
    if (!existing) {
      fresh.push(t)
    } else if (isRepairChild(existing)) {
      ctx.errors.push(`Task '${t.key}' is a repair task managed by the pipeline; remove it from the REPLAN list.`)
    } else if (!isNotStarted(existing)) {
      ctx.errors.push(
        `Task '${t.key}' is ${existing.state}; REPLAN lists only work that has not started. Remove it from the list (it is left untouched) or choose a new key.`,
      )
    }
    // A listed key that matches a not-yet-started task keeps that task unchanged.
  }
  checkNewCount(ctx, fresh.length, 'REPLAN')

  const cancelTasks = [...ctx.byKey.values()].filter(
    (t) => isNotStarted(t) && !isRepairChild(t) && !listed.has(t.key),
  )
  const cancelIds = new Set(cancelTasks.map((t) => t.id))
  const blocked = new Map(
    cancelTasks.map((t) => [t.key, 'which this REPLAN cancels (it is not in the new list). Keep it in the list or depend on something else.']),
  )
  const resolved = resolveNewTasks(ctx, fresh, blocked)
  const cascade = checkCancellation(ctx, cancelIds)

  if (fresh.length === 0 && cancelTasks.length === 0) {
    ctx.errors.push('This REPLAN changes nothing: every open task is kept and no new task is listed.')
  }
  const ops: GraphOperation[] = [...addTaskOps(resolved)]
  for (const t of cancelTasks) ops.push({ op: 'cancel_task', taskId: t.id })
  for (const id of cascade) ops.push({ op: 'cancel_task', taskId: id })
  return {
    ops,
    summary: `Replan: cancel ${cancelTasks.length} unstarted task${cancelTasks.length === 1 ? '' : 's'}, add ${fresh.length}; running and finished tasks are untouched`,
  }
}

// ───────────────────────────── cycle simulation ─────────────────────────────

/** Apply the operations to the dependency edges and return the first cycle as keys, or null. */
function findResultingCycle(ctx: Ctx, tasks: readonly Task[], ops: readonly GraphOperation[]): string[] | null {
  const edges = new Map<string, string[]>()
  const name = new Map<string, string>()
  for (const t of tasks) {
    edges.set(t.id, [])
    name.set(t.id, t.key)
  }
  const add = (from: string, to: string): void => {
    const list = edges.get(from) ?? []
    if (!list.includes(to)) list.push(to)
    edges.set(from, list)
  }
  for (const d of ctx.deps) if (edges.has(d.taskId)) add(d.taskId, d.dependsOnTaskId)
  for (const op of ops) {
    switch (op.op) {
      case 'add_task': {
        const node = newNode(op.task.key)
        name.set(node, op.task.key)
        edges.set(node, [])
        for (const id of op.dependsOnTaskIds) add(node, id)
        for (const key of op.dependsOnNewKeys) add(node, newNode(key))
        break
      }
      case 'add_dependency':
        add(op.taskId, op.dependsOnTaskId)
        break
      case 'add_dependency_on_new':
        add(op.taskId, newNode(op.newKey))
        break
      case 'remove_dependency': {
        const list = edges.get(op.taskId)
        if (list) {
          edges.set(
            op.taskId,
            list.filter((id) => id !== op.dependsOnTaskId),
          )
        }
        break
      }
      default:
        break
    }
  }
  const cycle = findCycles(edges)[0]
  return cycle ? cycle.map((n) => name.get(n) ?? n) : null
}

// ───────────────────────────── entry point ─────────────────────────────

export function validateProposal(input: ProposalValidationInput): ProposalValidation {
  const { tasks, dependencies, proposal } = input
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  const proposer = proposal.taskId === null ? null : (byId.get(proposal.taskId) ?? null)
  const ctx: Ctx = {
    byId,
    byKey,
    deps: dependencies,
    proposer,
    maxNew: input.maxNewTasks ?? DEFAULT_MAX_NEW_TASKS,
    errors: [],
  }
  if (proposal.taskId !== null && !proposer) {
    ctx.errors.push(`The proposing task '${proposal.taskId}' does not exist in this run.`)
  }

  const { changes } = proposal
  let built: Built | null
  switch (proposal.type) {
    case 'ADD_TASK':
      built = buildAddTask(ctx, changes)
      break
    case 'SPLIT_TASK':
      built = buildSplit(ctx, changes)
      break
    case 'CANCEL_TASK':
      built = buildCancel(ctx, changes)
      break
    case 'ADD_DEPENDENCY':
      built = buildAddDependency(ctx, changes)
      break
    case 'REMOVE_DEPENDENCY':
      built = buildRemoveDependency(ctx, changes)
      break
    case 'REPRIORITIZE':
      built = buildReprioritize(ctx, changes)
      break
    case 'REPLAN':
      built = buildReplan(ctx, changes)
      break
  }
  if (ctx.errors.length > 0 || !built) {
    return { ok: false, errors: ctx.errors.length > 0 ? ctx.errors : ['The proposal could not be applied.'] }
  }

  const cycle = findResultingCycle(ctx, tasks, built.ops)
  if (cycle) {
    return {
      ok: false,
      errors: [
        `The change would create a dependency cycle: ${cycle.join(' -> ')}. Remove one of these dependencies or choose a different prerequisite.`,
      ],
    }
  }

  const reasons: string[] = []
  if (proposal.type === 'REPLAN') reasons.push('REPLAN replaces the open plan')
  const foreign = built.ops.filter(
    (op): op is Extract<GraphOperation, { op: 'cancel_task' }> =>
      op.op === 'cancel_task' && op.taskId !== proposal.taskId,
  )
  if (foreign.length > 0 && proposal.type !== 'REPLAN') {
    const keys = foreign.map((op) => byId.get(op.taskId)?.key ?? op.taskId)
    reasons.push(`cancels ${keys.map((k) => `'${k}'`).join(', ')}, not the proposer's own task`)
  } else if (foreign.length > 0) {
    reasons.push(`cancels ${foreign.length} task${foreign.length === 1 ? '' : 's'}`)
  }
  const added = built.ops.filter((op) => op.op === 'add_task').length
  if (added > APPROVAL_NEW_TASK_THRESHOLD) {
    reasons.push(`adds ${added} tasks (more than ${APPROVAL_NEW_TASK_THRESHOLD})`)
  }

  return {
    ok: true,
    operations: built.ops,
    requiresApproval: reasons.length > 0,
    approvalReason: reasons.length > 0 ? reasons.join('; ') : null,
    summary: built.summary,
  }
}

// ───────────────────────────── snapshots ─────────────────────────────

export function snapshotGraph(
  tasks: readonly Task[],
  dependencies: readonly TaskDependency[],
): GraphSnapshot {
  const known = new Set(tasks.map((t) => t.id))
  const seen = new Set<string>()
  const deps: GraphSnapshot['dependencies'] = []
  for (const d of dependencies) {
    if (!known.has(d.taskId) || !known.has(d.dependsOnTaskId)) continue
    const id = `${d.taskId}\u0000${d.dependsOnTaskId}`
    if (seen.has(id)) continue
    seen.add(id)
    deps.push({ taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId })
  }
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      role: t.role,
      kind: t.kind,
      state: t.state,
      priority: t.priority,
      parentTaskId: t.parentTaskId,
    })),
    dependencies: deps,
  }
}

export interface SnapshotDependencyRef {
  taskKey: string
  dependsOnKey: string
}

export interface SnapshotDiff {
  addedTasks: GraphSnapshotTask[]
  removedTasks: GraphSnapshotTask[]
  changedTasks: { key: string; field: string; from: string; to: string }[]
  addedDependencies: SnapshotDependencyRef[]
  removedDependencies: SnapshotDependencyRef[]
}

const CHANGE_FIELDS = ['title', 'role', 'kind', 'state', 'priority', 'parentTaskId'] as const

/** Differences between two snapshots, matched by task key. Dependencies are reported by key. */
export function diffSnapshots(a: GraphSnapshot, b: GraphSnapshot): SnapshotDiff {
  const aByKey = new Map(a.tasks.map((t) => [t.key, t]))
  const bByKey = new Map(b.tasks.map((t) => [t.key, t]))
  const keyOf = (snap: GraphSnapshot): Map<string, string> => new Map(snap.tasks.map((t) => [t.id, t.key]))
  const edgeSet = (snap: GraphSnapshot): Map<string, SnapshotDependencyRef> => {
    const keys = keyOf(snap)
    const out = new Map<string, SnapshotDependencyRef>()
    for (const d of snap.dependencies) {
      const ref = {
        taskKey: keys.get(d.taskId) ?? d.taskId,
        dependsOnKey: keys.get(d.dependsOnTaskId) ?? d.dependsOnTaskId,
      }
      out.set(`${ref.taskKey}\u0000${ref.dependsOnKey}`, ref)
    }
    return out
  }

  const changedTasks: SnapshotDiff['changedTasks'] = []
  for (const [key, before] of aByKey) {
    const after = bByKey.get(key)
    if (!after) continue
    for (const field of CHANGE_FIELDS) {
      if (before[field] !== after[field]) {
        changedTasks.push({ key, field, from: String(before[field]), to: String(after[field]) })
      }
    }
  }
  const aEdges = edgeSet(a)
  const bEdges = edgeSet(b)
  return {
    addedTasks: b.tasks.filter((t) => !aByKey.has(t.key)),
    removedTasks: a.tasks.filter((t) => !bByKey.has(t.key)),
    changedTasks,
    addedDependencies: [...bEdges].filter(([k]) => !aEdges.has(k)).map(([, v]) => v),
    removedDependencies: [...aEdges].filter(([k]) => !bEdges.has(k)).map(([, v]) => v),
  }
}
