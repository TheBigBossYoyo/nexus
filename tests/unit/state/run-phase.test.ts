import { describe, expect, it } from 'vitest'
import { deriveRunPhase } from '@main/modules/state'
import { makeTask } from '../scheduler/factories'

describe('deriveRunPhase', () => {
  it('defaults to executing', () => {
    expect(deriveRunPhase([])).toBe('executing')
    expect(deriveRunPhase([makeTask('a', { state: 'running' })])).toBe('executing')
  })

  it('is repairing when any repair task is in flight', () => {
    const tasks = [
      makeTask('a', { state: 'verification' }),
      makeTask('fix', { kind: 'repair', state: 'running', parentTaskId: 'a' }),
    ]
    expect(deriveRunPhase(tasks)).toBe('repairing')
    expect(deriveRunPhase([makeTask('fix', { kind: 'repair', state: 'waiting' })])).toBe('repairing')
  })

  it('ignores finished or blocked repair tasks', () => {
    const tasks = [
      makeTask('fix', { kind: 'repair', state: 'completed' }),
      makeTask('fix2', { kind: 'repair', state: 'blocked' }),
      makeTask('a', { state: 'running' }),
    ]
    expect(deriveRunPhase(tasks)).toBe('executing')
  })

  it('is verifying or reviewing when those dominate', () => {
    expect(
      deriveRunPhase([makeTask('a', { state: 'verification' }), makeTask('b', { state: 'running' })]),
    ).toBe('verifying')
    expect(
      deriveRunPhase([makeTask('a', { state: 'review' }), makeTask('b', { state: 'review' }), makeTask('c', { state: 'running' })]),
    ).toBe('reviewing')
  })

  it('stays executing while implementation work outnumbers review', () => {
    const tasks = [
      makeTask('a', { state: 'review' }),
      makeTask('b', { state: 'running' }),
      makeTask('c', { state: 'queued' }),
    ]
    expect(deriveRunPhase(tasks)).toBe('executing')
  })

  it('counts running verifier and reviewer roles towards their phase', () => {
    expect(deriveRunPhase([makeTask('v', { role: 'verifier', state: 'running' })])).toBe('verifying')
    expect(deriveRunPhase([makeTask('r', { role: 'security_reviewer', state: 'running' })])).toBe('reviewing')
  })

  it('ignores terminal tasks', () => {
    const tasks = [makeTask('a', { state: 'completed' }), makeTask('b', { state: 'review' })]
    expect(deriveRunPhase(tasks)).toBe('reviewing')
  })
})
