import { describe, expect, it } from 'vitest'
import {
  betterByBand,
  distribution,
  evidenceLabel,
  intervalsSeparated,
  labelAtLeast,
  mean,
  median,
  mulberry32,
  recencyWeight,
  sampleBeta,
  wilsonInterval,
} from '@main/modules/policy'

describe('wilsonInterval', () => {
  it('matches known values', () => {
    const half = wilsonInterval(5, 10)!
    expect(half.low).toBeCloseTo(0.2366, 3)
    expect(half.high).toBeCloseTo(0.7634, 3)
    const none = wilsonInterval(0, 10)!
    expect(none.low).toBe(0)
    expect(none.high).toBeCloseTo(0.2775, 3)
    const all = wilsonInterval(10, 10)!
    expect(all.low).toBeCloseTo(0.7225, 3)
    expect(all.high).toBeLessThanOrEqual(1)
  })

  it('is null for n = 0 and clamps nonsense counts', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    const over = wilsonInterval(50, 10)!
    expect(over.high).toBeLessThanOrEqual(1)
    expect(wilsonInterval(-3, 10)!.low).toBe(0)
  })

  it('narrows as n grows at the same proportion', () => {
    const small = wilsonInterval(5, 10)!
    const large = wilsonInterval(50, 100)!
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })
})

describe('labels and comparisons', () => {
  it('labels by sample size, with STRONG needing a narrow interval', () => {
    expect(evidenceLabel(4, wilsonInterval(4, 4))).toBe('INSUFFICIENT')
    expect(evidenceLabel(5, wilsonInterval(5, 5))).toBe('WEAK')
    expect(evidenceLabel(12, wilsonInterval(6, 12))).toBe('MODERATE')
    expect(evidenceLabel(30, wilsonInterval(15, 30))).toBe('MODERATE') // width > 0.30
    expect(evidenceLabel(60, wilsonInterval(55, 60))).toBe('STRONG')
    expect(labelAtLeast('MODERATE', 'WEAK')).toBe(true)
    expect(labelAtLeast('WEAK', 'MODERATE')).toBe(false)
  })

  it('separates only non-overlapping intervals', () => {
    expect(intervalsSeparated({ low: 0.1, high: 0.3 }, { low: 0.4, high: 0.6 })).toBe(true)
    expect(intervalsSeparated({ low: 0.1, high: 0.5 }, { low: 0.4, high: 0.6 })).toBe(false)
    expect(intervalsSeparated(null, { low: 0.4, high: 0.6 })).toBe(false)
  })

  it('betterByBand needs a clear margin and ignores nulls and zero baselines', () => {
    expect(betterByBand(7, 10, 0.2)).toBe(true)
    expect(betterByBand(9, 10, 0.2)).toBe(false)
    expect(betterByBand(null, 10, 0.2)).toBe(false)
    expect(betterByBand(1, 0, 0.2)).toBe(false)
  })
})

describe('summaries and weights', () => {
  it('mean, median and distribution', () => {
    expect(mean([])).toBeNull()
    expect(mean([1, 2, 3])).toBe(2)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(distribution([0, 1, 1, 9], 3)).toEqual([1, 2, 1])
  })

  it('recency halves per half-life and treats the future as now', () => {
    expect(recencyWeight(0, 90)).toBe(1)
    expect(recencyWeight(90, 90)).toBeCloseTo(0.5)
    expect(recencyWeight(180, 90)).toBeCloseTo(0.25)
    expect(recencyWeight(-5, 90)).toBe(1)
  })
})

describe('random', () => {
  it('mulberry32 is reproducible and in [0,1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 20; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('sampleBeta has roughly the right mean', () => {
    const rand = mulberry32(7)
    let sum = 0
    for (let i = 0; i < 4000; i++) sum += sampleBeta(9, 3, rand)
    expect(sum / 4000).toBeCloseTo(0.75, 1)
  })
})
