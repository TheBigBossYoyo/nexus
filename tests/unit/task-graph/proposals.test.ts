import { describe, expect, it } from 'vitest'
import type { Task, TaskDependency } from '@shared/domain'
import { GraphChangesSchema, type GraphChanges, type ProposalType, type ProposedTask } from '@shared/v2'
import {
  diffSnapshots,
  snapshotGraph,
  validateProposal,
  type GraphOperation,
} from '@main/modules/task-graph'
import { dep, makeTask } from '../scheduler/factories'

function proposed(key: string, overrides: Partial<ProposedTask> = {}): ProposedTask {
  return {
    key,
    title: key,
    description: key,
    role: 'worker',
    dependencies: [],
    suggestedFiles: [],
    acceptanceCriteria: ['works'],
    complexity: 'small',
    risk: 'low',
    ...overrides,
  }
}

const changes = (c: Partial<GraphChanges>): GraphChanges => GraphChangesSchema.parse(c)

function run(
  type: ProposalType,
  c: Partial<GraphChanges>,
  tasks: Task[],
  deps: TaskDependency[],
  taskId: string | null = null,
  maxNewTasks?: number,
) {
  return validateProposal({
    tasks,
    dependencies: deps,
    proposal: { type, changes: changes(c), taskId },
    ...(maxNewTasks === undefined ? {} : { maxNewTasks }),
  })
}

function ok(result: ReturnType<typeof run>) {
  if (!result.ok) throw new Error(`expected ok, got errors: ${result.errors.join(' | ')}`)
  return result
}

function errors(result: ReturnType<typeof run>): string {
  if (result.ok) throw new Error('expected errors, got ok')
  return result.errors.join('\n')
}

const opNames = (ops: GraphOperation[]): string[] => ops.map((o) => o.op)

// a (completed) <- b (running, the proposer) <- c (ready); d independent ready; z cancelled; f failed
function base() {
  const tasks = [
    makeTask('a', { state: 'completed' }),
    makeTask('b', { state: 'running', attempt: 1 }),
    makeTask('c', { state: 'ready' }),
    makeTask('d', { state: 'ready' }),
    makeTask('z', { state: 'cancelled' }),
    makeTask('f', { state: 'failed' }),
  ]
  const deps = [dep('b', 'a'), dep('c', 'b')]
  return { tasks, deps }
}

describe('ADD_TASK', () => {
  it('adds tasks with existing and sibling dependencies in dependency order', () => {
    const { tasks, deps } = base()
    const r = ok(
      run('ADD_TASK', { tasks: [proposed('n2', { dependencies: ['n1'] }), proposed('n1', { dependencies: ['a'] })] }, tasks, deps),
    )
    expect(r.operations).toEqual([
      expect.objectContaining({ op: 'add_task', dependsOnTaskIds: ['a'], dependsOnNewKeys: [] }),
      expect.objectContaining({ op: 'add_task', dependsOnTaskIds: [], dependsOnNewKeys: ['n1'] }),
    ])
    expect(r.operations.map((o) => (o.op === 'add_task' ? o.task.key : ''))).toEqual(['n1', 'n2'])
    expect(r.requiresApproval).toBe(false)
    expect(r.approvalReason).toBeNull()
  })

  it('blocksProposer makes the proposer wait for every new task and yield', () => {
    const { tasks, deps } = base()
    const r = ok(run('ADD_TASK', { tasks: [proposed('n1'), proposed('n2')], blocksProposer: true }, tasks, deps, 'b'))
    expect(opNames(r.operations)).toEqual([
      'add_task',
      'add_task',
      'add_dependency_on_new',
      'add_dependency_on_new',
      'yield_task',
    ])
    expect(r.operations).toContainEqual({ op: 'add_dependency_on_new', taskId: 'b', newKey: 'n2' })
    expect(r.operations.at(-1)).toEqual({ op: 'yield_task', taskId: 'b' })
  })

  it('rejects blocksProposer without a yieldable proposer', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_TASK', { tasks: [proposed('n1')], blocksProposer: true }, tasks, deps, null))).toMatch(
      /needs a proposing task/,
    )
    expect(errors(run('ADD_TASK', { tasks: [proposed('n1')], blocksProposer: true }, tasks, deps, 'c'))).toMatch(
      /cannot yield/,
    )
  })

  it('rejects a new task the proposer would deadlock on (cycle)', () => {
    const { tasks, deps } = base()
    const msg = errors(
      run('ADD_TASK', { tasks: [proposed('n1', { dependencies: ['b'] })], blocksProposer: true }, tasks, deps, 'b'),
    )
    expect(msg).toMatch(/dependency cycle: .*b.*n1.*b|dependency cycle: .*n1.*b.*n1/)
  })

  it('rejects a cycle among new tasks and reports the path', () => {
    const { tasks, deps } = base()
    const msg = errors(
      run('ADD_TASK', { tasks: [proposed('x', { dependencies: ['y'] }), proposed('y', { dependencies: ['x'] })] }, tasks, deps),
    )
    expect(msg).toMatch(/dependency cycle: (x -> y -> x|y -> x -> y)/)
  })

  it('enforces unique keys against terminal tasks and within the proposal', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_TASK', { tasks: [proposed('a')] }, tasks, deps))).toMatch(/'a' already exists/)
    expect(errors(run('ADD_TASK', { tasks: [proposed('z')] }, tasks, deps))).toMatch(/'z' already exists/)
    expect(errors(run('ADD_TASK', { tasks: [proposed('n'), proposed('n')] }, tasks, deps))).toMatch(
      /more than once/,
    )
  })

  it('rejects unknown, self, failed, cancelled and repair-child dependencies', () => {
    const tasks = [...base().tasks, makeTask('r', { state: 'ready', parentTaskId: 'c' })]
    const deps = base().deps
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { dependencies: ['nope'] })] }, tasks, deps))).toMatch(
      /unknown task 'nope'/,
    )
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { dependencies: ['n'] })] }, tasks, deps))).toMatch(
      /depends on itself/,
    )
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { dependencies: ['z'] })] }, tasks, deps))).toMatch(
      /cancelled and never satisfies/,
    )
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { dependencies: ['f'] })] }, tasks, deps))).toMatch(
      /failed and never satisfies/,
    )
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { dependencies: ['r'] })] }, tasks, deps))).toMatch(
      /repair task/,
    )
  })

  it('requires an acceptance criterion for writing roles only', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_TASK', { tasks: [proposed('n', { acceptanceCriteria: [] })] }, tasks, deps))).toMatch(
      /needs at least one acceptance criterion/,
    )
    expect(
      errors(run('ADD_TASK', { tasks: [proposed('n', { role: 'debugger', acceptanceCriteria: [] })] }, tasks, deps)),
    ).toMatch(/debugger/)
    ok(run('ADD_TASK', { tasks: [proposed('n', { role: 'researcher', acceptanceCriteria: [] })] }, tasks, deps))
  })

  it('enforces maxNewTasks (default 8) and requires at least one task', () => {
    const { tasks, deps } = base()
    const nine = Array.from({ length: 9 }, (_, i) => proposed(`n${i}`))
    expect(errors(run('ADD_TASK', { tasks: nine }, tasks, deps))).toMatch(/at most 8/)
    ok(run('ADD_TASK', { tasks: nine.slice(0, 8) }, tasks, deps))
    expect(errors(run('ADD_TASK', { tasks: nine.slice(0, 3) }, tasks, deps, null, 2))).toMatch(/at most 2/)
    expect(errors(run('ADD_TASK', {}, tasks, deps))).toMatch(/at least one entry/)
  })

  it('requires approval only above three new tasks', () => {
    const { tasks, deps } = base()
    const three = ok(run('ADD_TASK', { tasks: ['n1', 'n2', 'n3'].map((k) => proposed(k)) }, tasks, deps))
    expect(three.requiresApproval).toBe(false)
    const four = ok(run('ADD_TASK', { tasks: ['n1', 'n2', 'n3', 'n4'].map((k) => proposed(k)) }, tasks, deps))
    expect(four.requiresApproval).toBe(true)
    expect(four.approvalReason).toMatch(/adds 4 tasks/)
  })

  it('rejects a proposer that does not exist', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_TASK', { tasks: [proposed('n')] }, tasks, deps, 'ghost'))).toMatch(/'ghost' does not exist/)
  })
})

describe('SPLIT_TASK', () => {
  // a <- c (ready, criteria x,y) <- e (ready); plus d independent
  function splitBase() {
    const tasks = [
      makeTask('a', { state: 'completed' }),
      makeTask('c', { state: 'ready', acceptanceCriteria: ['Does X', 'does y'] }),
      makeTask('e', { state: 'blocked' }),
      makeTask('d', { state: 'running', attempt: 1 }),
    ]
    return { tasks, deps: [dep('c', 'a'), dep('e', 'c')] }
  }
  const subs = [
    proposed('c1', { acceptanceCriteria: ['does  x'] }),
    proposed('c2', { dependencies: ['c1'], acceptanceCriteria: ['Does Y'] }),
  ]

  it('replaces the task, inherits its prerequisites, rewires dependants and carries criteria', () => {
    const { tasks, deps } = splitBase()
    const r = ok(run('SPLIT_TASK', { targetTask: 'c', tasks: subs }, tasks, deps, 'd'))
    expect(r.operations).toEqual([
      expect.objectContaining({ op: 'add_task', dependsOnTaskIds: ['a'], dependsOnNewKeys: [] }),
      expect.objectContaining({ op: 'add_task', dependsOnTaskIds: ['a'], dependsOnNewKeys: ['c1'] }),
      { op: 'remove_dependency', taskId: 'e', dependsOnTaskId: 'c' },
      { op: 'add_dependency_on_new', taskId: 'e', newKey: 'c1' },
      { op: 'add_dependency_on_new', taskId: 'e', newKey: 'c2' },
      { op: 'cancel_task', taskId: 'c' },
    ])
    // cancelling another task needs approval
    expect(r.requiresApproval).toBe(true)
    expect(r.approvalReason).toMatch(/'c'/)
  })

  it('lets the proposer split its own running task without approval', () => {
    const tasks = [makeTask('own', { state: 'running', acceptanceCriteria: ['one'] }), makeTask('after', { state: 'blocked' })]
    const r = ok(
      run(
        'SPLIT_TASK',
        { targetTask: 'own', tasks: [proposed('p1', { acceptanceCriteria: ['one'] }), proposed('p2')] },
        tasks,
        [dep('after', 'own')],
        'own',
      ),
    )
    expect(r.operations.at(-1)).toEqual({ op: 'cancel_task', taskId: 'own' })
    expect(r.requiresApproval).toBe(false)
  })

  it('rejects splitting a started task that is not the proposer, and terminal tasks', () => {
    const { tasks, deps } = splitBase()
    expect(errors(run('SPLIT_TASK', { targetTask: 'd', tasks: subs }, tasks, deps, 'c'))).toMatch(/not yours/)
    expect(errors(run('SPLIT_TASK', { targetTask: 'a', tasks: subs }, tasks, deps))).toMatch(/immutable/)
  })

  it('rejects dropped criteria, a single subtask, and subtasks depending on the original', () => {
    const { tasks, deps } = splitBase()
    expect(
      errors(run('SPLIT_TASK', { targetTask: 'c', tasks: [proposed('c1', { acceptanceCriteria: ['does x'] }), proposed('c2')] }, tasks, deps)),
    ).toMatch(/Missing from all subtasks: "does y"/)
    expect(errors(run('SPLIT_TASK', { targetTask: 'c', tasks: [subs[0] as ProposedTask] }, tasks, deps))).toMatch(
      /at least two subtasks/,
    )
    expect(
      errors(
        run('SPLIT_TASK', { targetTask: 'c', tasks: [proposed('c1', { dependencies: ['c'], acceptanceCriteria: ['does x', 'does y'] }), proposed('c2')] }, tasks, deps),
      ),
    ).toMatch(/depends on 'c', the task being split/)
  })

  it('rejects a split whose dependant is already running', () => {
    const tasks = [makeTask('c', { state: 'ready', acceptanceCriteria: [] }), makeTask('e', { state: 'running' })]
    expect(errors(run('SPLIT_TASK', { targetTask: 'c', tasks: [proposed('c1'), proposed('c2')] }, tasks, [dep('e', 'c')]))).toMatch(
      /already running/,
    )
  })

  it('rejects duplicate subtask keys', () => {
    const { tasks, deps } = splitBase()
    expect(
      errors(run('SPLIT_TASK', { targetTask: 'c', tasks: [proposed('d', { acceptanceCriteria: ['does x', 'does y'] }), proposed('c2')] }, tasks, deps)),
    ).toMatch(/'d' already exists/)
  })
})

describe('CANCEL_TASK', () => {
  it('cancels a leaf task and needs approval unless it is the proposer own', () => {
    const { tasks, deps } = base()
    const other = ok(run('CANCEL_TASK', { targetTask: 'd' }, tasks, deps, 'b'))
    expect(other.operations).toEqual([{ op: 'cancel_task', taskId: 'd' }])
    expect(other.requiresApproval).toBe(true)
    const own = ok(run('CANCEL_TASK', { targetTask: 'c' }, tasks, deps, 'c'))
    expect(own.requiresApproval).toBe(false)
  })

  it('never lets a cancellation satisfy an open dependant', () => {
    const { tasks, deps } = base()
    const msg = errors(run('CANCEL_TASK', { targetTask: 'b' }, tasks, deps, 'b'))
    expect(msg).toMatch(/Cannot cancel 'b': task 'c' \(ready\) still depends on it/)
    expect(msg).toMatch(/never satisfies a dependency/)
  })

  it('allows cancelling once the dependant edge is removed or the dependant is terminal', () => {
    const tasks = [makeTask('b', { state: 'ready' }), makeTask('c', { state: 'cancelled' })]
    ok(run('CANCEL_TASK', { targetTask: 'b' }, tasks, [dep('c', 'b')]))
  })

  it('cascades to repair children of the cancelled task', () => {
    const tasks = [makeTask('p', { state: 'running' }), makeTask('rep', { state: 'ready', parentTaskId: 'p' })]
    const r = ok(run('CANCEL_TASK', { targetTask: 'p' }, tasks, [dep('rep', 'p')], 'p'))
    expect(r.operations).toEqual([
      { op: 'cancel_task', taskId: 'p' },
      { op: 'cancel_task', taskId: 'rep' },
    ])
  })

  it('rejects terminal, repair-child, unknown and missing targets', () => {
    const tasks = [...base().tasks, makeTask('r', { state: 'ready', parentTaskId: 'c' })]
    const deps = base().deps
    expect(errors(run('CANCEL_TASK', { targetTask: 'a' }, tasks, deps))).toMatch(/completed and immutable/)
    expect(errors(run('CANCEL_TASK', { targetTask: 'z' }, tasks, deps))).toMatch(/cancelled and immutable/)
    expect(errors(run('CANCEL_TASK', { targetTask: 'f' }, tasks, deps))).toMatch(/failed and immutable/)
    expect(errors(run('CANCEL_TASK', { targetTask: 'r' }, tasks, deps))).toMatch(/repair task/)
    expect(errors(run('CANCEL_TASK', { targetTask: 'nope' }, tasks, deps))).toMatch(/does not match any task/)
    expect(errors(run('CANCEL_TASK', {}, tasks, deps))).toMatch(/targetTask is required/)
  })
})

describe('ADD_DEPENDENCY', () => {
  it('adds an edge between not-started tasks', () => {
    const { tasks, deps } = base()
    const r = ok(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'c' }, tasks, deps))
    expect(r.operations).toEqual([{ op: 'add_dependency', taskId: 'd', dependsOnTaskId: 'c' }])
    // Another agent's (or nobody's) task: the user decides.
    expect(r.requiresApproval).toBe(true)
    expect(r.approvalReason).toMatch(/dependencies of 'd', not the proposer's own task/)
    const own = ok(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'c' }, tasks, deps, 'd'))
    expect(own.requiresApproval).toBe(false)
  })

  it('lets the proposer own running task gain a prerequisite and yield', () => {
    const { tasks, deps } = base()
    const r = ok(run('ADD_DEPENDENCY', { targetTask: 'b', dependsOn: 'd' }, tasks, deps, 'b'))
    expect(r.operations).toEqual([
      { op: 'add_dependency', taskId: 'b', dependsOnTaskId: 'd' },
      { op: 'yield_task', taskId: 'b' },
    ])
  })

  it('does not yield when the new prerequisite is already completed', () => {
    const tasks = [makeTask('a', { state: 'completed' }), makeTask('b', { state: 'running' })]
    const r = ok(run('ADD_DEPENDENCY', { targetTask: 'b', dependsOn: 'a' }, tasks, [], 'b'))
    expect(opNames(r.operations)).toEqual(['add_dependency'])
  })

  it('rejects giving another running task a prerequisite', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'b', dependsOn: 'd' }, tasks, deps, 'd'))).toMatch(
      /only the agent working on it/,
    )
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'b', dependsOn: 'd' }, tasks, deps, null))).toMatch(
      /only the agent working on it/,
    )
  })

  it('rejects the proposer own task in review or verification', () => {
    const tasks = [makeTask('b', { state: 'review' }), makeTask('d', { state: 'ready' })]
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'b', dependsOn: 'd' }, tasks, [], 'b'))).toMatch(/cannot yield/)
  })

  it('rejects cycles (direct and transitive) with the path', () => {
    const { tasks, deps } = base()
    // c depends on b depends on a; making a ready task a depend on c closes a cycle only if a is open
    const open = [makeTask('a', { state: 'ready' }), makeTask('b', { state: 'ready' }), makeTask('c', { state: 'ready' })]
    const edges = [dep('b', 'a'), dep('c', 'b')]
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'a', dependsOn: 'c' }, open, edges))).toMatch(
      /dependency cycle: .* -> .*/,
    )
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'a', dependsOn: 'b' }, open, edges))).toMatch(/cycle/)
    // base graph unaffected
    ok(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'c' }, tasks, deps))
  })

  it('rejects self, duplicate, terminal target, failed/cancelled prerequisite and repair child', () => {
    const tasks = [...base().tasks, makeTask('r', { state: 'ready', parentTaskId: 'c' })]
    const deps = base().deps
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'd' }, tasks, deps))).toMatch(/depend on itself/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'c', dependsOn: 'b' }, tasks, deps))).toMatch(/already depends/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'a', dependsOn: 'd' }, tasks, deps))).toMatch(/immutable/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'z' }, tasks, deps))).toMatch(/never satisfies/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'f' }, tasks, deps))).toMatch(/never satisfies/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'd', dependsOn: 'r' }, tasks, deps))).toMatch(/repair task/)
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'r', dependsOn: 'd' }, tasks, deps))).toMatch(/repair task/)
  })

  it('requires both keys', () => {
    const { tasks, deps } = base()
    expect(errors(run('ADD_DEPENDENCY', { targetTask: 'd' }, tasks, deps))).toMatch(/dependsOn is required/)
  })
})

describe('REMOVE_DEPENDENCY', () => {
  it('removes an edge from a not-started task', () => {
    const { tasks, deps } = base()
    const r = ok(run('REMOVE_DEPENDENCY', { targetTask: 'c', dependsOn: 'b' }, tasks, deps))
    expect(r.operations).toEqual([{ op: 'remove_dependency', taskId: 'c', dependsOnTaskId: 'b' }])
    expect(r.requiresApproval).toBe(true)
    expect(ok(run('REMOVE_DEPENDENCY', { targetTask: 'c', dependsOn: 'b' }, tasks, deps, 'c')).requiresApproval).toBe(false)
  })

  it('never lets a started task lose a prerequisite, even the proposer own', () => {
    const { tasks, deps } = base()
    expect(errors(run('REMOVE_DEPENDENCY', { targetTask: 'b', dependsOn: 'a' }, tasks, deps, 'b'))).toMatch(
      /cannot lose a prerequisite/,
    )
  })

  it('rejects missing edges, terminal targets and unknown keys', () => {
    const { tasks, deps } = base()
    expect(errors(run('REMOVE_DEPENDENCY', { targetTask: 'd', dependsOn: 'a' }, tasks, deps))).toMatch(/nothing to remove/)
    expect(errors(run('REMOVE_DEPENDENCY', { targetTask: 'a', dependsOn: 'b' }, tasks, deps))).toMatch(/immutable/)
    expect(errors(run('REMOVE_DEPENDENCY', { targetTask: 'c', dependsOn: 'nope' }, tasks, deps))).toMatch(/does not match/)
    expect(errors(run('REMOVE_DEPENDENCY', { targetTask: 'c' }, tasks, deps))).toMatch(/dependsOn is required/)
  })

  it('allows dropping an edge to a cancelled prerequisite', () => {
    const tasks = [makeTask('z', { state: 'cancelled' }), makeTask('c', { state: 'blocked' })]
    ok(run('REMOVE_DEPENDENCY', { targetTask: 'c', dependsOn: 'z' }, tasks, [dep('c', 'z')]))
  })
})

describe('REPRIORITIZE', () => {
  it('sets a priority', () => {
    const { tasks, deps } = base()
    const r = ok(run('REPRIORITIZE', { targetTask: 'd', priority: 50 }, tasks, deps))
    expect(r.operations).toEqual([{ op: 'set_priority', taskId: 'd', priority: 50 }])
    expect(r.requiresApproval).toBe(true)
    expect(r.approvalReason).toMatch(/priority of 'd'/)
    expect(ok(run('REPRIORITIZE', { targetTask: 'd', priority: 50 }, tasks, deps, 'd')).requiresApproval).toBe(false)
  })

  it('rejects terminal tasks, missing priority and no-ops', () => {
    const { tasks, deps } = base()
    expect(errors(run('REPRIORITIZE', { targetTask: 'a', priority: 5 }, tasks, deps))).toMatch(/immutable/)
    expect(errors(run('REPRIORITIZE', { targetTask: 'd' }, tasks, deps))).toMatch(/priority is required/)
    expect(errors(run('REPRIORITIZE', { targetTask: 'd', priority: 0 }, tasks, deps))).toMatch(/already has priority 0/)
  })
})

describe('REPLAN', () => {
  // running r1, completed a, not-started: n1, n2 (depends n1), n3 independent
  function replanBase() {
    const tasks = [
      makeTask('a', { state: 'completed' }),
      makeTask('r1', { state: 'running' }),
      makeTask('n1', { state: 'ready' }),
      makeTask('n2', { state: 'blocked' }),
      makeTask('n3', { state: 'queued' }),
      makeTask('rep', { state: 'ready', parentTaskId: 'r1' }),
    ]
    return { tasks, deps: [dep('n2', 'n1'), dep('rep', 'r1')] }
  }

  it('cancels unstarted tasks missing from the list, adds new ones, never touches running or terminal', () => {
    const { tasks, deps } = replanBase()
    const r = ok(
      run('REPLAN', { tasks: [proposed('n1'), proposed('n2'), proposed('m1', { dependencies: ['a', 'n1'] })] }, tasks, deps, 'r1'),
    )
    expect(r.operations).toEqual([
      expect.objectContaining({ op: 'add_task', dependsOnTaskIds: ['a', 'n1'].map((k) => k) }),
      { op: 'cancel_task', taskId: 'n3' },
    ])
    expect(r.requiresApproval).toBe(true)
    expect(r.approvalReason).toMatch(/REPLAN/)
    const cancelled = r.operations.filter((o) => o.op === 'cancel_task').map((o) => (o as { taskId: string }).taskId)
    expect(cancelled).not.toContain('r1')
    expect(cancelled).not.toContain('a')
    expect(cancelled).not.toContain('rep')
  })

  it('cancels everything not started when the list is empty', () => {
    const { tasks, deps } = replanBase()
    const r = ok(run('REPLAN', {}, tasks, deps, 'r1'))
    expect(r.operations.map((o) => (o as { taskId: string }).taskId).sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('rejects listing started or terminal task keys', () => {
    const { tasks, deps } = replanBase()
    expect(errors(run('REPLAN', { tasks: [proposed('r1')] }, tasks, deps, 'r1'))).toMatch(/'r1' is running/)
    expect(errors(run('REPLAN', { tasks: [proposed('a')] }, tasks, deps, 'r1'))).toMatch(/'a' is completed/)
    expect(errors(run('REPLAN', { tasks: [proposed('rep')] }, tasks, deps, 'r1'))).toMatch(/repair task/)
  })

  it('rejects when a kept task depends on a cancelled one or a running task depends on it', () => {
    const { tasks, deps } = replanBase()
    // keep n2 but drop n1: n2 would wait on a cancelled task forever
    expect(errors(run('REPLAN', { tasks: [proposed('n2'), proposed('n3')] }, tasks, deps, 'r1'))).toMatch(
      /Cannot cancel 'n1': task 'n2'/,
    )
    const withRunningDependant = [makeTask('n1', { state: 'ready' }), makeTask('r1', { state: 'running' })]
    expect(errors(run('REPLAN', { tasks: [proposed('x')] }, withRunningDependant, [dep('r1', 'n1')], 'r1'))).toMatch(
      /Cannot cancel 'n1': task 'r1' \(running\)/,
    )
  })

  it('rejects new tasks depending on a task the replan cancels', () => {
    const { tasks, deps } = replanBase()
    expect(errors(run('REPLAN', { tasks: [proposed('m', { dependencies: ['n3'] })] }, tasks, deps, 'r1'))).toMatch(
      /depends on 'n3', which this REPLAN cancels/,
    )
  })

  it('checks keys, criteria, cycles and the new-task cap like any addition', () => {
    const { tasks, deps } = replanBase()
    expect(errors(run('REPLAN', { tasks: [proposed('a2'), proposed('a2')] }, tasks, deps, 'r1'))).toMatch(/more than once/)
    expect(errors(run('REPLAN', { tasks: [proposed('m', { acceptanceCriteria: [] })] }, tasks, deps, 'r1'))).toMatch(
      /acceptance criterion/,
    )
    expect(
      errors(run('REPLAN', { tasks: [proposed('x', { dependencies: ['y'] }), proposed('y', { dependencies: ['x'] })] }, tasks, deps, 'r1')),
    ).toMatch(/cycle/)
    const nine = Array.from({ length: 9 }, (_, i) => proposed(`q${i}`))
    expect(errors(run('REPLAN', { tasks: nine }, tasks, deps, 'r1'))).toMatch(/at most 8/)
  })

  it('rejects a replan that changes nothing', () => {
    const tasks = [makeTask('r1', { state: 'running' })]
    expect(errors(run('REPLAN', {}, tasks, [], 'r1'))).toMatch(/changes nothing/)
  })
})

describe('snapshotGraph and diffSnapshots', () => {
  it('snapshots tasks and valid, unique dependencies', () => {
    const { tasks, deps } = base()
    const snap = snapshotGraph(tasks, [...deps, dep('c', 'b'), dep('c', 'ghost')])
    expect(snap.tasks).toHaveLength(6)
    expect(snap.tasks[1]).toEqual({
      id: 'b',
      key: 'b',
      title: 'b',
      role: 'worker',
      kind: 'implement',
      state: 'running',
      priority: 0,
      parentTaskId: null,
    })
    expect(snap.dependencies).toEqual([
      { taskId: 'b', dependsOnTaskId: 'a' },
      { taskId: 'c', dependsOnTaskId: 'b' },
    ])
  })

  it('diffs added, removed, changed tasks and dependencies by key', () => {
    const before = snapshotGraph(
      [makeTask('a', { state: 'ready' }), makeTask('b', { state: 'ready' }), makeTask('c', { state: 'ready' })],
      [dep('b', 'a'), dep('c', 'b')],
    )
    const after = snapshotGraph(
      [makeTask('a', { state: 'completed', priority: 3 }), makeTask('b', { state: 'ready' }), makeTask('n', { state: 'ready' })],
      [dep('b', 'a'), dep('n', 'b')],
    )
    const diff = diffSnapshots(before, after)
    expect(diff.addedTasks.map((t) => t.key)).toEqual(['n'])
    expect(diff.removedTasks.map((t) => t.key)).toEqual(['c'])
    expect(diff.changedTasks).toEqual([
      { key: 'a', field: 'state', from: 'ready', to: 'completed' },
      { key: 'a', field: 'priority', from: '0', to: '3' },
    ])
    expect(diff.addedDependencies).toEqual([{ taskKey: 'n', dependsOnKey: 'b' }])
    expect(diff.removedDependencies).toEqual([{ taskKey: 'c', dependsOnKey: 'b' }])
  })

  it('reports no differences for identical snapshots', () => {
    const { tasks, deps } = base()
    const s = snapshotGraph(tasks, deps)
    expect(diffSnapshots(s, s)).toEqual({
      addedTasks: [],
      removedTasks: [],
      changedTasks: [],
      addedDependencies: [],
      removedDependencies: [],
    })
  })
})
