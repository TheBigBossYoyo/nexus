import { describe, expect, it } from 'vitest'
import {
  cancellationCascade,
  countByState,
  dependencyFailureCascade,
  findExpiredLeases,
  isRunFinished,
  isSupersededRepair,
  nextAttemptPlan,
  runOutcome,
} from '@main/modules/scheduler'
import { dep, makeTask } from './factories'

const NOW = '2026-06-01T12:00:00.000Z'

describe('findExpiredLeases', () => {
  it('returns non-terminal tasks with a lapsed lease', () => {
    const tasks = [
      makeTask('expired', { state: 'running', leaseOwner: 'a1', leaseExpiresAt: '2026-06-01T11:59:59.000Z' }),
      makeTask('boundary', { state: 'running', leaseOwner: 'a2', leaseExpiresAt: NOW }),
      makeTask('live', { state: 'running', leaseOwner: 'a3', leaseExpiresAt: '2026-06-01T12:00:01.000Z' }),
      makeTask('none', { state: 'running' }),
      makeTask('done', { state: 'completed', leaseOwner: 'a4', leaseExpiresAt: '2020-01-01T00:00:00.000Z' }),
      makeTask('garbage', { state: 'assigned', leaseOwner: 'a5', leaseExpiresAt: 'not-a-date' }),
    ]
    expect(findExpiredLeases(tasks, NOW).map((t) => t.id)).toEqual(['expired', 'boundary', 'garbage'])
  })
})

describe('dependencyFailureCascade', () => {
  const tasks = [
    makeTask('root', { state: 'failed' }),
    makeTask('child', { state: 'ready' }),
    makeTask('grandchild', { state: 'draft' }),
    makeTask('cancelled-root', { state: 'cancelled' }),
    makeTask('other-child', { state: 'queued' }),
    makeTask('running-child', { state: 'running' }),
    makeTask('already', { state: 'blocked' }),
    makeTask('independent', { state: 'ready' }),
  ]
  const deps = [
    dep('child', 'root'),
    dep('grandchild', 'child'),
    dep('other-child', 'cancelled-root'),
    dep('running-child', 'root'),
    dep('already', 'root'),
  ]

  it('blocks unstarted transitive dependants of failed or cancelled tasks', () => {
    const result = dependencyFailureCascade(tasks, deps)
    expect(result.map((b) => b.taskId)).toEqual(['child', 'grandchild', 'other-child'])
    expect(result[1]?.rootTaskIds).toEqual(['root'])
    expect(result[0]?.reason).toContain('root')
  })

  it('returns nothing when no dependency failed', () => {
    expect(dependencyFailureCascade([makeTask('a'), makeTask('b')], [dep('b', 'a')])).toEqual([])
  })
})

describe('cancellationCascade', () => {
  it('returns non-terminal transitive dependants', () => {
    const tasks = [
      makeTask('a', { state: 'running' }),
      makeTask('b', { state: 'ready' }),
      makeTask('c', { state: 'draft' }),
      makeTask('d', { state: 'completed' }),
      makeTask('e', { state: 'ready' }),
    ]
    const deps = [dep('b', 'a'), dep('c', 'b'), dep('d', 'a')]
    expect(cancellationCascade(tasks, deps, 'a').map((t) => t.id)).toEqual(['b', 'c'])
  })
})

describe('nextAttemptPlan', () => {
  const task = (attempt: number, override: 'fast' | 'balanced' | 'strongest' | null = null) => ({
    key: 't',
    attempt,
    modelTierOverride: override,
  })

  it('retries after diagnosis on the first failure without changing tier', () => {
    expect(nextAttemptPlan({ task: task(1), maxRetries: 3, failureKind: 'agent_error' })).toMatchObject({
      action: 'retry',
      diagnose: true,
      modelTierOverride: null,
      attemptAfter: 1,
    })
  })

  it('promotes to the next stronger tier on the second failure', () => {
    const base = { task: task(2), maxRetries: 3, failureKind: 'verification_failed' } as const
    expect(nextAttemptPlan(base)).toMatchObject({ action: 'retry', modelTierOverride: 'strongest' })
    expect(nextAttemptPlan({ ...base, baseTier: 'fast' })).toMatchObject({ modelTierOverride: 'balanced' })
    expect(nextAttemptPlan({ ...base, task: task(2, 'fast') })).toMatchObject({ modelTierOverride: 'balanced' })
  })

  it('stays on the strongest tier when already there', () => {
    const plan = nextAttemptPlan({ task: task(3, 'strongest'), maxRetries: 5, failureKind: 'timeout' })
    expect(plan).toMatchObject({ action: 'retry', modelTierOverride: 'strongest' })
  })

  it('gives up beyond maxRetries', () => {
    expect(nextAttemptPlan({ task: task(3), maxRetries: 2, failureKind: 'crash' }).action).toBe('give_up')
    expect(nextAttemptPlan({ task: task(2), maxRetries: 2, failureKind: 'crash' }).action).toBe('retry')
    expect(nextAttemptPlan({ task: task(1), maxRetries: 0, failureKind: 'crash' }).action).toBe('give_up')
  })

  it('never consumes an attempt for quota failures, even beyond maxRetries', () => {
    expect(nextAttemptPlan({ task: task(1), maxRetries: 2, failureKind: 'quota' })).toMatchObject({
      action: 'wait_for_quota',
      attemptAfter: 0,
    })
    expect(nextAttemptPlan({ task: task(5), maxRetries: 2, failureKind: 'quota' })).toMatchObject({
      action: 'wait_for_quota',
      attemptAfter: 4,
    })
    expect(nextAttemptPlan({ task: task(0), maxRetries: 2, failureKind: 'quota' }).attemptAfter).toBe(0)
  })
})

describe('run completion helpers', () => {
  it('is not finished while empty or while any task is active', () => {
    expect(isRunFinished([])).toBe(false)
    expect(isRunFinished([makeTask('a', { state: 'completed' }), makeTask('b', { state: 'running' })])).toBe(false)
    expect(runOutcome([makeTask('a', { state: 'ready' })])).toBeNull()
  })

  it('derives the outcome from terminal task states', () => {
    const t = (state: 'completed' | 'failed' | 'cancelled') => makeTask(state, { state })
    expect(runOutcome([t('completed')])).toBe('completed')
    expect(runOutcome([t('completed'), t('failed'), t('cancelled')])).toBe('failed')
    expect(runOutcome([t('cancelled')])).toBe('cancelled')
    expect(runOutcome([makeTask('x', { state: 'completed' }), makeTask('y', { state: 'cancelled' })])).toBe('cancelled')
  })

  it('ignores repair attempts that died while their parent was retried or completed', () => {
    const parent = makeTask('p', { state: 'completed' })
    const failedFix = makeTask('p-fix1', { state: 'failed', kind: 'repair', role: 'debugger', parentTaskId: 'p' })
    const cancelledFix = makeTask('p-fix2', { state: 'cancelled', kind: 'repair', role: 'debugger', parentTaskId: 'p' })
    expect(isSupersededRepair(failedFix, [parent, failedFix])).toBe(true)
    expect(runOutcome([parent, failedFix, cancelledFix])).toBe('completed')
    // While the parent itself is failed its dead attempts stay part of the picture.
    const failedParent = makeTask('p', { state: 'failed' })
    expect(isSupersededRepair(failedFix, [failedParent, failedFix])).toBe(false)
    expect(runOutcome([failedParent, failedFix])).toBe('failed')
    // A top-level repair task (mission-fix) is a normal task.
    const missionFix = makeTask('mission-fix-1', { state: 'failed', kind: 'repair', role: 'debugger' })
    expect(runOutcome([parent, missionFix])).toBe('failed')
  })

  it('counts tasks by state', () => {
    expect(countByState([makeTask('a'), makeTask('b'), makeTask('c', { state: 'failed' })])).toEqual({
      ready: 2,
      failed: 1,
    })
  })
})
