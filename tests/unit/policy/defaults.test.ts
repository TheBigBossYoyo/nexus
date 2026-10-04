import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, defaultReason, defaultStrategy, featuresForContext, parseContextKey } from '@main/modules/policy'

describe('default policy', () => {
  it('uses SINGLE for small localized bugfix and testing work at low or medium risk', () => {
    expect(defaultStrategy('bugfix|small|low')).toBe('SINGLE')
    expect(defaultStrategy('bugfix|small|medium')).toBe('SINGLE')
    expect(defaultStrategy('testing|small|low')).toBe('SINGLE')
  })

  it('does not use SINGLE when the fix spans many files', () => {
    const f = featuresForContext('bugfix|small|low')
    expect(defaultStrategy({ ...f, fileScope: { value: 'many', basis: 'INFERRED' } })).toBe('BUILD')
  })

  it('uses CONSENSUS for security or high risk at medium or large size', () => {
    expect(defaultStrategy('security|medium|low')).toBe('CONSENSUS')
    expect(defaultStrategy('feature|large|high')).toBe('CONSENSUS')
    expect(defaultStrategy('bugfix|medium|high')).toBe('CONSENSUS')
  })

  it('uses BUILD for everything else, including small security and high-risk small work', () => {
    expect(defaultStrategy('feature|medium|low')).toBe('BUILD')
    expect(defaultStrategy('security|small|low')).toBe('BUILD')
    expect(defaultStrategy('bugfix|small|high')).toBe('BUILD')
    expect(defaultStrategy('migration|large|medium')).toBe('BUILD')
  })

  it('never defaults to SWARM or SPECULATIVE for any context', () => {
    const cats = ['bugfix', 'feature', 'refactor', 'migration', 'performance', 'security', 'testing', 'ui', 'infrastructure', 'architecture']
    for (const c of cats)
      for (const x of ['small', 'medium', 'large', '*'])
        for (const r of ['low', 'medium', 'high', '*']) {
          expect(['SWARM', 'SPECULATIVE']).not.toContain(defaultStrategy(`${c}|${x}|${r}`))
        }
    expect(DEFAULT_RULES.every((r) => r.strategy !== 'SWARM' && r.strategy !== 'SPECULATIVE')).toBe(true)
  })

  it('handles fallback keys and explains itself', () => {
    expect(defaultStrategy('bugfix|*|*')).toBe('BUILD')
    expect(defaultStrategy('*|*|*')).toBe('BUILD')
    expect(parseContextKey('bugfix|*|*')).toMatchObject({ category: 'bugfix', complexity: '*', risk: '*' })
    expect(defaultReason('security|large|high')).toContain('CONSENSUS')
  })
})
