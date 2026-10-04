import { describe, expect, it } from 'vitest'
import { unknownValue, type Measured } from '@shared/v3'
import {
  canShowPercent,
  describeMeasured,
  sourceExplanation,
} from '../../../src/renderer/src/lib/measured'

const m = <T>(value: T | null, confidence: Measured<T>['confidence']): Measured<T> => ({
  value,
  source: 'RUNTIME',
  confidence,
})

describe('canShowPercent', () => {
  it('allows only an EXACT finite number', () => {
    expect(canShowPercent(m(42, 'EXACT'))).toBe(true)
    expect(canShowPercent(m(0, 'EXACT'))).toBe(true)
    expect(canShowPercent(m(42, 'OBSERVED'))).toBe(false)
    expect(canShowPercent(m(42, 'ESTIMATED'))).toBe(false)
    expect(canShowPercent(m(42, 'UNKNOWN'))).toBe(false)
    expect(canShowPercent(m<number>(null, 'EXACT'))).toBe(false)
    expect(canShowPercent(m(Number.NaN, 'EXACT'))).toBe(false)
    expect(canShowPercent(m('42', 'EXACT'))).toBe(false)
    expect(canShowPercent(null)).toBe(false)
  })
})

describe('describeMeasured', () => {
  it('describes unknown values with a reason and never a number', () => {
    expect(describeMeasured(unknownValue<number>())).toEqual({
      state: 'unknown',
      reason: 'Not reported by Claude',
    })
    expect(describeMeasured(null, { reason: 'Not exposed by runtime' })).toEqual({
      state: 'unknown',
      reason: 'Not exposed by runtime',
    })
  })

  it('returns a percent only for EXACT values', () => {
    expect(describeMeasured(m(37, 'EXACT'), { wantPercent: true })).toMatchObject({
      state: 'value',
      percent: 37,
    })
    expect(describeMeasured(m(37, 'EXACT'))).toMatchObject({ state: 'value', percent: null })
  })

  it('degrades a requested percentage to unknown when the value is not EXACT', () => {
    for (const confidence of ['OBSERVED', 'ESTIMATED'] as const) {
      expect(describeMeasured(m(37, confidence), { wantPercent: true }).state).toBe('unknown')
    }
  })

  it('still shows an observed plain value', () => {
    expect(describeMeasured(m(1200, 'OBSERVED'))).toMatchObject({
      state: 'value',
      value: 1200,
      confidence: 'OBSERVED',
      percent: null,
    })
  })
})

describe('sourceExplanation', () => {
  it('explains each confidence level', () => {
    expect(sourceExplanation('EXACT', 'RUNTIME')).toMatch(/Exact/)
    expect(sourceExplanation('OBSERVED', 'LOCAL_AGGREGATION')).toMatch(/not the whole account/)
    expect(sourceExplanation('ESTIMATED')).toMatch(/approximate/)
    expect(sourceExplanation('UNKNOWN')).toMatch(/does not show a value/)
  })
})
