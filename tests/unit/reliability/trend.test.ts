import { describe, expect, it } from 'vitest'
import { judgeGrowth, judgeLatency, judgeProportional, median, percentile, robustSlope, SOAK_LIMITS, type Point } from '../../helpers/trend'

// A seeded generator: the tests must say the same thing every time.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** One sample every half minute for `hours`. */
function series(hours: number, value: (t: number, noise: number) => number, seed = 7): Point[] {
  const random = rng(seed)
  const points: Point[] = []
  for (let i = 0; i <= hours * 120; i += 1) {
    const t = i / 120
    points.push({ t, v: value(t, random() - 0.5) })
  }
  return points
}

const rss = SOAK_LIMITS.growth.rssMb

describe('trend of a long run', () => {
  it('median, percentile and the robust slope', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(robustSlope([{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 20 }])).toBeCloseTo(10)
    // One spike does not move it.
    expect(robustSlope(series(4, (t) => (Math.abs(t - 2) < 0.005 ? 5000 : 100 + t)))).toBeCloseTo(1, 1)
  })

  it('a leak fails: memory that climbs 40 MB an hour for twelve hours', () => {
    const verdict = judgeGrowth(series(12, (t, n) => 180 + 40 * t + n * 30), rss)
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.slopePerHour).toBeGreaterThan(35)
  })

  it('noise around a level passes, however loud', () => {
    expect(judgeGrowth(series(12, (_t, n) => 220 + n * 120), rss).verdict).toBe('PASS')
  })

  it('a sawtooth (a collector that runs) passes', () => {
    expect(judgeGrowth(series(12, (t, n) => 200 + ((t * 6) % 1) * 80 + n * 10), rss).verdict).toBe('PASS')
  })

  it('a step that then stays flat passes: it is a new level, not a climb', () => {
    const verdict = judgeGrowth(series(12, (t, n) => (t < 4 ? 150 : 420) + n * 10), rss)
    expect(verdict.verdict).toBe('PASS')
    expect(verdict.reason).toContain('slope within its limit')
  })

  it('a slow leak within the hourly limit is not called a failure by the ratio alone, and is reported with its slope', () => {
    const verdict = judgeGrowth(series(12, (t, n) => 100 + 10 * t + n * 5), rss)
    expect(verdict.verdict).toBe('PASS')
    expect(verdict.slopePerHour).toBeCloseTo(10, 0)
  })

  it('the warm-up is left out: a start that settles is not growth', () => {
    expect(judgeGrowth(series(12, (t, n) => 300 - 200 * Math.exp(-t * 6) + n * 8), rss).verdict).toBe('PASS')
  })

  it('a run too short to show a trend says so and does not pass by default', () => {
    expect(judgeGrowth(series(0.2, (t) => 100 + 500 * t), rss).verdict).toBe('TOO_SHORT')
    expect(judgeGrowth([{ t: 0, v: 1 }, { t: 5, v: 900 }], rss).verdict).toBe('TOO_SHORT')
  })

  it('a count that only ever rises (handles never closed) fails', () => {
    const verdict = judgeGrowth(series(12, (t) => 300 + Math.floor(t * 120)), SOAK_LIMITS.growth.osHandles)
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.risingShare).toBeGreaterThan(0.9)
  })

  it('a store that grows with the work done passes; one whose cost per item doubles and more fails', () => {
    const linear = Array.from({ length: 60 }, (_, i) => ({ work: i * 10, v: 1_000_000 + i * 10 * 4096 }))
    expect(judgeProportional(linear, SOAK_LIMITS.proportional.dbBytes).verdict).toBe('PASS')
    const quadratic = Array.from({ length: 60 }, (_, i) => ({ work: i * 10, v: 1_000_000 + (i * 10) ** 2 * 40 }))
    expect(judgeProportional(quadratic, SOAK_LIMITS.proportional.dbBytes).verdict).toBe('FAIL')
    expect(judgeProportional([{ work: 0, v: 1 }, { work: 1, v: 2 }], 2).verdict).toBe('TOO_SHORT')
  })

  it('latency: the same at the end passes, three times slower fails', () => {
    const random = rng(3)
    const steady = Array.from({ length: 400 }, () => 20 + random() * 30)
    expect(judgeLatency(steady, SOAK_LIMITS.latency.ratio, SOAK_LIMITS.latency.slackMs).verdict).toBe('PASS')
    const slowing = Array.from({ length: 400 }, (_, i) => (20 + random() * 30) * (1 + (i / 400) * 6))
    expect(judgeLatency(slowing, SOAK_LIMITS.latency.ratio, SOAK_LIMITS.latency.slackMs).verdict).toBe('FAIL')
    expect(judgeLatency([1, 2, 3], 2, 50).verdict).toBe('TOO_SHORT')
  })
})
