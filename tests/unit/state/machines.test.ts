import { describe, expect, it } from 'vitest'
import { AGENT_STATES, RUN_STATES, TASK_STATES } from '@shared/domain'
import type { RunState, TaskState } from '@shared/domain'
import { NexusError } from '@shared/result'
import {
  allowedTransitions,
  assertTransition,
  canPauseRun,
  canTransition,
  isFinalState,
  resumeTarget,
} from '@main/modules/state'

describe('task machine', () => {
  it.each<[TaskState, TaskState]>([
    ['draft', 'ready'],
    ['ready', 'queued'],
    ['queued', 'assigned'],
    ['assigned', 'running'],
    ['running', 'review'],
    ['review', 'verification'],
    ['verification', 'completed'],
    ['running', 'waiting'],
    ['review', 'waiting'],
    ['verification', 'waiting'],
    ['waiting', 'running'],
    ['waiting', 'review'],
    ['blocked', 'ready'],
    ['failed', 'ready'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition('task', from, to)).toBe(true)
    expect(() => assertTransition('task', from, to)).not.toThrow()
  })

  it.each<[TaskState, TaskState]>([
    ['draft', 'running'],
    ['ready', 'running'],
    ['queued', 'completed'],
    ['review', 'queued'],
    ['blocked', 'running'],
    ['failed', 'completed'],
    ['completed', 'ready'],
    ['cancelled', 'ready'],
    ['running', 'running'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition('task', from, to)).toBe(false)
    expect(() => assertTransition('task', from, to)).toThrow(NexusError)
  })

  it('allows every non-terminal state to become blocked, failed or cancelled', () => {
    for (const s of TASK_STATES) {
      if (s === 'completed' || s === 'cancelled' || s === 'failed' || s === 'blocked') continue
      for (const to of ['blocked', 'failed', 'cancelled'] as const) {
        expect(canTransition('task', s, to), `${s} -> ${to}`).toBe(true)
      }
    }
  })

  it('treats completed and cancelled as final but failed as retryable', () => {
    expect(isFinalState('task', 'completed')).toBe(true)
    expect(isFinalState('task', 'cancelled')).toBe(true)
    expect(isFinalState('task', 'failed')).toBe(false)
    expect(allowedTransitions('task', 'failed')).toEqual(['ready'])
  })

  it('throws invalid_transition with details', () => {
    try {
      assertTransition('task', 'completed', 'running')
      expect.unreachable()
    } catch (e) {
      expect((e as NexusError).code).toBe('invalid_transition')
      expect((e as NexusError).detail).toMatchObject({ kind: 'task', from: 'completed', to: 'running' })
    }
  })

  it('only references valid states', () => {
    for (const s of TASK_STATES) {
      for (const to of allowedTransitions('task', s)) expect(TASK_STATES).toContain(to)
    }
  })
})

describe('agent machine', () => {
  it.each([
    ['idle', 'starting'],
    ['starting', 'working'],
    ['working', 'waiting'],
    ['waiting', 'working'],
    ['working', 'blocked'],
    ['blocked', 'working'],
    ['working', 'stopping'],
    ['stopping', 'stopped'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition('agent', from, to)).toBe(true)
  })

  it('allows any state except failed to become failed', () => {
    for (const s of AGENT_STATES) {
      expect(canTransition('agent', s, 'failed')).toBe(s !== 'failed')
    }
  })

  it.each([
    ['idle', 'working'],
    ['starting', 'idle'],
    ['stopped', 'working'],
    ['stopped', 'starting'],
    ['stopping', 'working'],
    ['failed', 'idle'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition('agent', from, to)).toBe(false)
    expect(() => assertTransition('agent', from, to)).toThrow(NexusError)
  })
})

describe('run machine', () => {
  it.each<[RunState, RunState]>([
    ['planning', 'awaiting_approval'],
    ['awaiting_approval', 'executing'],
    ['awaiting_approval', 'planning'],
    ['executing', 'testing'],
    ['testing', 'executing'],
    ['executing', 'reviewing'],
    ['reviewing', 'verifying'],
    ['verifying', 'repairing'],
    ['repairing', 'executing'],
    ['executing', 'completed'],
    ['verifying', 'completed'],
    ['executing', 'paused'],
    ['planning', 'paused'],
    ['paused', 'executing'],
    ['paused', 'awaiting_approval'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition('run', from, to)).toBe(true)
  })

  it.each<[RunState, RunState]>([
    ['planning', 'completed'],
    ['awaiting_approval', 'completed'],
    ['testing', 'completed'],
    ['reviewing', 'completed'],
    ['repairing', 'completed'],
    ['paused', 'completed'],
    ['planning', 'verifying'],
    ['executing', 'planning'],
    ['completed', 'executing'],
    ['failed', 'executing'],
    ['cancelled', 'planning'],
    ['paused', 'paused'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition('run', from, to)).toBe(false)
    expect(() => assertTransition('run', from, to)).toThrow(NexusError)
  })

  it('allows every non-terminal state to fail or be cancelled', () => {
    for (const s of RUN_STATES) {
      const terminal = isFinalState('run', s)
      expect(canTransition('run', s, 'failed')).toBe(!terminal)
      expect(canTransition('run', s, 'cancelled')).toBe(!terminal)
    }
  })

  it('pauses only active states', () => {
    expect(canPauseRun('executing')).toBe(true)
    expect(canPauseRun('planning')).toBe(true)
    expect(canPauseRun('paused')).toBe(false)
    expect(canPauseRun('completed')).toBe(false)
  })

  describe('resumeTarget', () => {
    it('returns the recorded resume state', () => {
      expect(resumeTarget({ state: 'paused', resumeState: 'testing' })).toBe('testing')
    })
    it('rejects runs that are not paused or have no resume state', () => {
      expect(() => resumeTarget({ state: 'executing', resumeState: 'executing' })).toThrow(NexusError)
      expect(() => resumeTarget({ state: 'paused', resumeState: null })).toThrow(NexusError)
      expect(() => resumeTarget({ state: 'paused', resumeState: 'completed' })).toThrow(NexusError)
    })
  })
})
