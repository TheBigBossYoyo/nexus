import { describe, expect, it } from 'vitest'
import { selectRunnable } from '@main/modules/scheduler'
import type { SchedulerInput } from '@main/modules/scheduler'
import { dep, makeTask } from './factories'

const NOW = '2026-06-01T12:00:00.000Z'

function run(partial: Partial<SchedulerInput> & Pick<SchedulerInput, 'tasks'>) {
  return selectRunnable({
    dependencies: [],
    activeTaskIds: [],
    maxParallelAgents: 4,
    now: NOW,
    paused: false,
    ...partial,
  })
}

const reasonOf = (d: ReturnType<typeof run>, id: string) => d.deferred.find((x) => x.taskId === id)?.reason

describe('selectRunnable basics', () => {
  it('starts ready and queued tasks and ignores other states', () => {
    const tasks = [
      makeTask('a', { state: 'ready' }),
      makeTask('b', { state: 'queued' }),
      makeTask('c', { state: 'draft' }),
      makeTask('d', { state: 'running' }),
      makeTask('e', { state: 'cancelled' }),
      makeTask('f', { state: 'blocked' }),
    ]
    const d = run({ tasks, activeTaskIds: ['d'] })
    expect(d.start.sort()).toEqual(['a', 'b'])
    expect(d.deferred).toEqual([])
  })

  it('waits for every dependency to be completed', () => {
    const tasks = [
      makeTask('a', { state: 'completed' }),
      makeTask('b', { state: 'running' }),
      makeTask('c', { state: 'ready' }),
      makeTask('d', { state: 'ready' }),
    ]
    const d = run({
      tasks,
      activeTaskIds: ['b'],
      dependencies: [dep('c', 'a'), dep('c', 'b'), dep('d', 'a')],
    })
    expect(d.start).toEqual(['d'])
    expect(reasonOf(d, 'c')).toEqual({ kind: 'waiting_on_dependencies', dependencyIds: ['b'] })
  })

  it('treats failed, cancelled and missing dependencies as unmet', () => {
    const tasks = [
      makeTask('a', { state: 'failed' }),
      makeTask('b', { state: 'cancelled' }),
      makeTask('c', { state: 'ready' }),
    ]
    const d = run({ tasks, dependencies: [dep('c', 'a'), dep('c', 'b'), dep('c', 'ghost')] })
    expect(d.start).toEqual([])
    expect(reasonOf(d, 'c')).toEqual({
      kind: 'waiting_on_dependencies',
      dependencyIds: ['a', 'b', 'ghost'],
    })
  })

  it('holds tasks that need approval until granted', () => {
    const tasks = [
      makeTask('a', { requiresApproval: true }),
      makeTask('b', { requiresApproval: true, approvalGranted: true }),
    ]
    const d = run({ tasks })
    expect(d.start).toEqual(['b'])
    expect(reasonOf(d, 'a')).toEqual({ kind: 'awaiting_approval' })
  })

  it('starts nothing while paused and says why', () => {
    const d = run({ tasks: [makeTask('a'), makeTask('b')], paused: true })
    expect(d.start).toEqual([])
    expect(d.deferred.map((x) => x.reason.kind)).toEqual(['run_paused', 'run_paused'])
  })

  it('skips tasks whose lease is still live but not expired ones', () => {
    const live = makeTask('live', { leaseOwner: 'agent-1', leaseExpiresAt: '2026-06-01T12:05:00.000Z' })
    const stale = makeTask('stale', { leaseOwner: 'agent-1', leaseExpiresAt: '2026-06-01T11:00:00.000Z' })
    const d = run({ tasks: [live, stale] })
    expect(d.start).toEqual(['stale'])
    expect(reasonOf(d, 'live')?.kind).toBe('leased')
  })
})

describe('concurrency limit', () => {
  const many = ['a', 'b', 'c', 'd'].map((k) => makeTask(k, { role: 'researcher' }))

  it('never exceeds maxParallelAgents', () => {
    const d = run({ tasks: many, maxParallelAgents: 2 })
    expect(d.start).toHaveLength(2)
    expect(d.freeSlots).toBe(2)
    expect(d.deferred.map((x) => x.reason)).toEqual([{ kind: 'no_free_slot' }, { kind: 'no_free_slot' }])
  })

  it('counts active tasks against the limit', () => {
    const tasks = [...many, makeTask('x', { state: 'running', role: 'researcher' })]
    const d = run({ tasks, activeTaskIds: ['x'], maxParallelAgents: 2 })
    expect(d.start).toHaveLength(1)
  })

  it('starts nothing when full or limit is zero', () => {
    const tasks = [...many, makeTask('x', { state: 'running' })]
    expect(run({ tasks, activeTaskIds: ['x'], maxParallelAgents: 1 }).start).toEqual([])
    expect(run({ tasks: many, maxParallelAgents: 0 }).freeSlots).toBe(0)
  })

  it('does not start tasks that are already active', () => {
    const d = run({ tasks: [makeTask('a', { state: 'ready' })], activeTaskIds: ['a'] })
    expect(d.start).toEqual([])
    expect(d.deferred).toEqual([])
  })
})

describe('ordering', () => {
  it('orders by priority descending', () => {
    const tasks = [
      makeTask('low', { priority: 1 }),
      makeTask('high', { priority: 10 }),
      makeTask('mid', { priority: 5 }),
    ]
    expect(run({ tasks }).start).toEqual(['high', 'mid', 'low'])
  })

  it('breaks priority ties by transitive dependant count', () => {
    const tasks = [
      makeTask('leaf'),
      makeTask('root'),
      makeTask('mid', { state: 'draft' }),
      makeTask('end', { state: 'draft' }),
    ]
    const dependencies = [dep('mid', 'root'), dep('end', 'mid')]
    expect(run({ tasks, dependencies }).start).toEqual(['root', 'leaf'])
  })

  it('then orders by createdAt', () => {
    const early = makeTask('early', { createdAt: '2026-01-01T00:00:00.000Z' })
    const late = makeTask('late', { createdAt: '2026-02-01T00:00:00.000Z' })
    expect(run({ tasks: [late, early] }).start).toEqual(['early', 'late'])
  })

  it('gives the single slot to the highest ranked task', () => {
    const tasks = [makeTask('a', { priority: 1 }), makeTask('b', { priority: 2 })]
    const d = run({ tasks, maxParallelAgents: 1 })
    expect(d.start).toEqual(['b'])
    expect(reasonOf(d, 'a')).toEqual({ kind: 'no_free_slot' })
  })
})

describe('file ownership', () => {
  it('serializes two writers touching the same file', () => {
    const tasks = [
      makeTask('a', { priority: 2, suggestedFiles: ['src/shared.ts'] }),
      makeTask('b', { priority: 1, suggestedFiles: ['./SRC/shared.ts'] }),
    ]
    const d = run({ tasks })
    expect(d.start).toEqual(['a'])
    expect(reasonOf(d, 'b')).toEqual({
      kind: 'serialized_file_overlap',
      behindTaskId: 'a',
      files: ['src/shared.ts'],
    })
  })

  it('runs writers with disjoint files in parallel', () => {
    const tasks = [
      makeTask('a', { suggestedFiles: ['src/a.ts'] }),
      makeTask('b', { suggestedFiles: ['src/b.ts'] }),
      makeTask('c', { suggestedFiles: ['docs/**'] }),
    ]
    expect(run({ tasks }).start.sort()).toEqual(['a', 'b', 'c'])
  })

  it('conflicts with an already active writing task', () => {
    const tasks = [
      makeTask('active', { state: 'running', suggestedFiles: ['src'] }),
      makeTask('next', { suggestedFiles: ['src/x.ts'] }),
      makeTask('other', { suggestedFiles: ['lib/y.ts'] }),
    ]
    const d = run({ tasks, activeTaskIds: ['active'] })
    expect(d.start).toEqual(['other'])
    expect(reasonOf(d, 'next')).toMatchObject({ kind: 'serialized_file_overlap', behindTaskId: 'active' })
  })

  it('does not let a blocked conflicting task consume a slot', () => {
    const tasks = [
      makeTask('a', { priority: 3, suggestedFiles: ['f.ts'] }),
      makeTask('b', { priority: 2, suggestedFiles: ['f.ts'] }),
      makeTask('c', { priority: 1, suggestedFiles: ['g.ts'] }),
    ]
    const d = run({ tasks, maxParallelAgents: 2 })
    expect(d.start).toEqual(['a', 'c'])
  })

  it('never conflicts read-only roles, neither as candidate nor as active task', () => {
    const tasks = [
      makeTask('writer', { suggestedFiles: ['src/a.ts'] }),
      makeTask('reader', { role: 'reviewer', suggestedFiles: ['src/a.ts'] }),
      makeTask('researcher', { role: 'researcher', suggestedFiles: ['src'] }),
    ]
    expect(run({ tasks }).start.sort()).toEqual(['reader', 'researcher', 'writer'])

    const withActiveReader = [
      makeTask('active', { state: 'running', role: 'reviewer', suggestedFiles: ['src'] }),
      makeTask('w', { suggestedFiles: ['src/a.ts'] }),
    ]
    expect(run({ tasks: withActiveReader, activeTaskIds: ['active'] }).start).toEqual(['w'])
  })

  it('debugger counts as a writing role', () => {
    const tasks = [
      makeTask('a', { priority: 2, suggestedFiles: ['x.ts'] }),
      makeTask('b', { priority: 1, role: 'debugger', suggestedFiles: ['x.ts'] }),
    ]
    expect(run({ tasks }).start).toEqual(['a'])
  })

  it('does not run a non-parallelizable writer alongside any other writer', () => {
    const tasks = [
      makeTask('solo', { priority: 2, parallelizable: false, suggestedFiles: ['a.ts'] }),
      makeTask('other', { priority: 1, suggestedFiles: ['b.ts'] }),
      makeTask('reader', { priority: 0, role: 'researcher' }),
    ]
    const d = run({ tasks })
    expect(d.start).toEqual(['solo', 'reader'])
    expect(reasonOf(d, 'other')).toEqual({ kind: 'serialized_not_parallelizable', behindTaskId: 'solo' })
  })

  it('also waits for an active non-parallelizable writer', () => {
    const tasks = [
      makeTask('solo', { state: 'running', parallelizable: false }),
      makeTask('other', { suggestedFiles: ['b.ts'] }),
    ]
    const d = run({ tasks, activeTaskIds: ['solo'] })
    expect(d.start).toEqual([])
    expect(reasonOf(d, 'other')).toMatchObject({ kind: 'serialized_not_parallelizable' })
  })

  it('tasks without suggested files do not conflict', () => {
    const tasks = [makeTask('a'), makeTask('b')]
    expect(run({ tasks }).start).toHaveLength(2)
  })
})
