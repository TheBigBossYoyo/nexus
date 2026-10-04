import { describe, expect, it } from 'vitest'
import { contextWords, overnightWord, planningWords, shortTitle, strategyWord } from '../../../src/renderer/src/lib/wording'

describe('wording', () => {
  it('sentence-cases strategies', () => {
    expect(strategyWord('BUILD')).toBe('Build')
    expect(strategyWord('ADAPTIVE')).toBe('Adaptive')
  })
  it('renders context keys in words', () => {
    expect(contextWords('ui|medium|low')).toBe('UI change · medium size · low risk')
    expect(contextWords('*|*|*')).toBe('All tasks')
  })
  it('derives a short title from the first sentence', () => {
    expect(shortTitle('Fix the login bug. Then add tests for it and update docs.')).toBe('Fix the login bug')
    expect(shortTitle('x '.repeat(80)).length).toBeLessThanOrEqual(60)
    expect(shortTitle('  \n  ')).toBe('Untitled mission')
  })
  it('words overnight states and planning recommendations', () => {
    expect(overnightWord('POWER_ACTION_SCHEDULED')).toBe('Shutdown scheduled')
    expect(overnightWord('ENDING_SOON')).toBe('Ending soon')
    expect(planningWords('single')).toContain('single planner')
  })
})
