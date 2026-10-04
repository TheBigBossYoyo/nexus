import { describe, expect, it } from 'vitest'
import type { PolicyDiff } from '@shared/v3-read'
import {
  actionText,
  canRollback,
  diffLines,
  evidenceRowText,
  formatContextKey,
  switchText,
} from '../../../src/renderer/src/views/policy/policyModel'

describe('formatContextKey', () => {
  it('spells out category, complexity and risk', () => {
    expect(formatContextKey('bugfix|medium|low')).toBe('Bug fix · medium size · low risk')
    expect(formatContextKey('security|high|high')).toBe('Security change · high size · high risk')
  })
  it('reads fallback keys as "any"', () => {
    expect(formatContextKey('feature|*|*')).toBe('Feature · any size · any risk')
    expect(formatContextKey('*|*|*')).toBe('All tasks')
  })
  it('tolerates a short key', () => {
    expect(formatContextKey('refactor')).toBe('Refactor · any size · any risk')
  })
})

describe('policy text', () => {
  it('writes a strategy switch', () => {
    expect(switchText('SWARM', 'BUILD')).toBe('Swarm → Build')
  })
  it('shows dashes for absent evidence and counts otherwise', () => {
    const base = {
      strategy: 'BUILD',
      arenaCases: 0,
      effectiveN: 0,
      passRate: null,
      passInterval: null,
      meanSessions: null,
      meanObservedTokens: null,
      medianDurationMs: null,
      label: 'INSUFFICIENT',
      suppressed: false,
    } as const
    expect(
      evidenceRowText({ ...base, arenaN: 0, arenaSuccesses: 0, missionN: 5, missionSuccesses: 4 }),
    ).toEqual({ arena: '—', missions: '4/5' })
  })
  it('names every promotion action', () => {
    for (const a of ['promote', 'reject', 'rollback', 'pin', 'unpin', 'config'] as const)
      expect(actionText(a).length).toBeGreaterThan(3)
  })
  it('allows rollback only with a distinct previous snapshot', () => {
    expect(canRollback({ activeId: 'b', previousId: 'a' })).toBe(true)
    expect(canRollback({ activeId: 'a', previousId: null })).toBe(false)
    expect(canRollback({ activeId: 'a', previousId: 'a' })).toBe(false)
  })
})

describe('diffLines', () => {
  it('flattens added, removed, changed and config differences', () => {
    const pref = (contextKey: string) =>
      ({
        contextKey,
        strategy: 'BUILD',
        replaces: 'SWARM',
        reason: '',
        evidence: { arenaTrials: 1, missions: 1, label: 'WEAK' },
        candidateId: null,
      }) as never
    const d = {
      a: { id: 'a', version: 1 },
      b: { id: 'b', version: 2 },
      added: [pref('bugfix|low|low')],
      removed: [pref('ui|low|low')],
      changed: [{ contextKey: 'feature|high|high', from: 'SINGLE', to: 'SWARM' }],
      config: [{ field: 'exploration', from: 'off', to: 'balanced' }],
    } as unknown as PolicyDiff
    expect(diffLines(d)).toEqual([
      { kind: 'added', text: 'Bug fix · low size · low risk: Build' },
      { kind: 'removed', text: 'UI change · low size · low risk: Build' },
      { kind: 'changed', text: 'Feature · high size · high risk: Single → Swarm' },
      { kind: 'config', text: 'exploration: off → balanced' },
    ])
  })
})
