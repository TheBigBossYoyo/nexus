import { describe, expect, it } from 'vitest'
import { DEFAULT_SCORING, type ArenaTrialMetrics } from '@shared/v3'
import {
  buildMatrix,
  compareStrategies,
  compareTrials,
  trialOutcome,
  mergeScoring,
  resultNotes,
  scoreTrial,
  type RankedTrial,
} from '@main/modules/arena/scoring'
import { metrics } from './helpers'

const ranked = (hidden: boolean, over: Partial<ArenaTrialMetrics> = {}): RankedTrial => ({ hiddenPassed: hidden, metrics: metrics(over) })

describe('compareTrials', () => {
  it('a failing cheap trial never beats a passing expensive one', () => {
    const cheap = ranked(false, { wallClockMs: 1, sessions: 1, inputTokens: 1, outputTokens: 1 })
    const expensive = ranked(true, { wallClockMs: 9e9, sessions: 99, repairs: 9, highFindings: 3, verifierPassed: false, inputTokens: 1e9 })
    expect(compareTrials(cheap, expensive)).toBeGreaterThan(0)
    expect(compareTrials(expensive, cheap)).toBeLessThan(0)
  })

  it('orders by findings, verification, repairs, then time bands, tokens, sessions', () => {
    expect(compareTrials(ranked(true, { highFindings: 1 }), ranked(true, { criticalFindings: 0 }))).toBeGreaterThan(0)
    expect(compareTrials(ranked(true, { testsPassed: false }), ranked(true))).toBeGreaterThan(0)
    expect(compareTrials(ranked(true, { repairs: 1 }), ranked(true, { repairs: 2 }))).toBeLessThan(0)
    expect(compareTrials(ranked(true, { wallClockMs: 50_000 }), ranked(true, { wallClockMs: 100_000 }))).toBeLessThan(0)
    expect(compareTrials(ranked(true, { inputTokens: 500, outputTokens: 0 }), ranked(true))).toBeLessThan(0)
    expect(compareTrials(ranked(true, { sessions: 3 }), ranked(true, { sessions: 4 }))).toBeLessThan(0)
  })

  it('differences inside the band are ties and fall through to later steps', () => {
    const a = ranked(true, { wallClockMs: 100_000, sessions: 3 })
    const b = ranked(true, { wallClockMs: 85_000, sessions: 4 })
    expect(compareTrials(a, b)).toBeLessThan(0) // time tie (15% < 20%), sessions decide
    const narrow = mergeScoring(DEFAULT_SCORING, { band: 0.01 })
    expect(compareTrials(a, b, narrow)).toBeGreaterThan(0) // 15% is now outside the band
  })

  it('unmeasured values tie', () => {
    expect(compareTrials(ranked(true, { wallClockMs: null }), ranked(true, { wallClockMs: 5 }))).toBe(0)
  })
})

describe('scoreTrial', () => {
  it('is 0 when the hidden evaluation failed', () => {
    const r = scoreTrial(metrics(), false, [])
    expect(r.score).toBe(0)
    expect(Object.values(r.breakdown).every((v) => v === 0)).toBe(true)
  })

  it('is passBase plus the weighted parts, and the breakdown sums to the score', () => {
    const m = metrics()
    const r = scoreTrial(m, true, [m])
    expect(r.score).toBe(100)
    expect(r.breakdown['passBase']).toBe(60)
    expect(Object.values(r.breakdown).reduce((a, b) => a + b, 0)).toBeCloseTo(r.score, 5)
  })

  it('a passing trial always scores at least passBase', () => {
    const worst = metrics({ criticalFindings: 5, verifierPassed: false, repairs: 9, wallClockMs: null, inputTokens: null, outputTokens: null })
    expect(scoreTrial(worst, true, []).score).toBeGreaterThanOrEqual(60)
  })

  it('findings, repairs and slowness reduce the score; unmeasured earns nothing', () => {
    const best = metrics()
    const slow = metrics({ wallClockMs: 500_000, repairs: 1, highFindings: 1 })
    const s = scoreTrial(slow, true, [best, slow])
    expect(s.score).toBeLessThan(100)
    expect(s.breakdown['findings']).toBeCloseTo(7.5, 5)
    expect(s.breakdown['repairs']).toBeCloseTo(2.5, 5)
    expect(s.breakdown['time']).toBeCloseTo(1, 5)
    expect(scoreTrial(metrics({ inputTokens: null, outputTokens: null }), true, []).breakdown['usage']).toBe(0)
  })

  it('applies case overrides and keeps the maximum at 100', () => {
    const cfg = mergeScoring(DEFAULT_SCORING, { band: 0.5, weights: { findings: 40, verification: 40, repairs: 40, time: 40, usage: 40 } })
    expect(cfg.band).toBe(0.5)
    expect(cfg.weights.time).toBe(40)
    const m = metrics()
    const r = scoreTrial(m, true, [m], cfg)
    expect(r.score).toBeCloseTo(100, 1)
    expect(Object.values(r.breakdown).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1)
  })
})

describe('comparison, matrix, notes', () => {
  const trial = (strategy: 'SINGLE' | 'BUILD', passed: boolean, over: Partial<ArenaTrialMetrics> = {}, caseId = 'c1') => ({
    strategy,
    caseId,
    passed,
    metrics: metrics(over),
  })
  // trials spread over three cases so the evidence label is not capped
  const spread = (strategy: 'SINGLE' | 'BUILD', passed: boolean, i: number, over: Partial<ArenaTrialMetrics> = {}) =>
    trial(strategy, passed, over, `case-${i % 3}`)

  it('summarises per strategy with Wilson intervals and labels', () => {
    const rows = compareStrategies([
      ...Array.from({ length: 6 }, (_, i) => spread('BUILD', i < 5, i, { wallClockMs: (i + 1) * 1000, repairs: i % 2, quotaPauses: 1 })),
      trial('SINGLE', false),
    ])
    const build = rows.find((r) => r.strategy === 'BUILD')!
    expect(build.n).toBe(6)
    expect(build.passed).toBe(5)
    expect(build.passInterval!.low).toBeGreaterThan(0.4)
    // efficiency columns are summarised over PASSED trials only (the sixth, failing one is left out)
    expect(build.medianWallClockMs).toBe(3000)
    expect(build.meanRepairs).toBe(0.4)
    expect(build.meanObservedTokens).toBe(1500)
    expect(build.quotaPauses).toBe(6)
    expect(build.label).toBe('WEAK')
    expect(rows.find((r) => r.strategy === 'SINGLE')!.label).toBe('INSUFFICIENT')
    expect(rows.map((r) => r.strategy)).toEqual(['SINGLE', 'BUILD'])
  })

  it('says the evidence does not separate overlapping strategies, and nothing below n=5', () => {
    const rows = compareStrategies([
      ...Array.from({ length: 6 }, (_, i) => spread('BUILD', i < 4, i)),
      ...Array.from({ length: 6 }, (_, i) => spread('SINGLE', i < 3, i)),
    ])
    expect(resultNotes(rows).join(' ')).toContain('The evidence does not separate SINGLE and BUILD on pass rate (intervals overlap)')
    const thin = compareStrategies([trial('BUILD', true), trial('SINGLE', false)])
    const notes = resultNotes(thin).join(' ')
    expect(notes).toContain('n is below 5')
    expect(notes).toContain('nothing is concluded')
    expect(resultNotes([])[0]).toContain('nothing is concluded')
  })

  it('separates strategies only when the intervals do not overlap', () => {
    const rows = compareStrategies([
      ...Array.from({ length: 30 }, (_, i) => spread('BUILD', true, i)),
      ...Array.from({ length: 30 }, (_, i) => spread('SINGLE', false, i)),
    ])
    expect(resultNotes(rows).join(' ')).toContain('BUILD passes more often than SINGLE')
  })

  it('builds a case x strategy matrix with scores', () => {
    const cells = buildMatrix(
      [
        { id: 'a2', caseId: 'c2', strategy: 'BUILD', state: 'failed', repetition: 1 },
        { id: 'a1', caseId: 'c1', strategy: 'BUILD', state: 'passed', repetition: 2 },
        { id: 'a0', caseId: 'c1', strategy: 'BUILD', state: 'passed', repetition: 1 },
        { id: 'b0', caseId: 'c1', strategy: 'SINGLE', state: 'queued', repetition: 1 },
      ],
      [{ trialId: 'a0', score: 91 }],
    )
    expect(cells.map((c) => `${c.caseId}/${c.strategy}`)).toEqual(['c1/SINGLE', 'c1/BUILD', 'c2/BUILD'])
    expect(cells[1]!.trials.map((t) => [t.id, t.score])).toEqual([
      ['a0', 91],
      ['a1', null],
    ])
  })

  it('counts blocked-by-run and timed-out trials as failures and excludes harness blocks (survivorship)', () => {
    expect(trialOutcome({ state: 'passed', blockKind: null })).toBe('pass')
    expect(trialOutcome({ state: 'failed', blockKind: null })).toBe('fail')
    expect(trialOutcome({ state: 'blocked', blockKind: 'run' })).toBe('fail')
    expect(trialOutcome({ state: 'blocked', blockKind: 'timeout' })).toBe('fail')
    expect(trialOutcome({ state: 'blocked', blockKind: 'infrastructure' })).toBe('excluded')
    expect(trialOutcome({ state: 'blocked', blockKind: null })).toBe('excluded')
    expect(trialOutcome({ state: 'cancelled', blockKind: null })).toBe('ignored')
    expect(trialOutcome({ state: 'queued', blockKind: null })).toBe('ignored')
    const rows = compareStrategies([
      spread('BUILD', true, 0),
      spread('BUILD', true, 1),
      spread('BUILD', false, 2), // blocked by the run: a failure
      { ...spread('BUILD', false, 0), infrastructure: true },
      { ...spread('BUILD', false, 1), infrastructure: true },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ n: 3, passed: 2, cases: 3, excludedInfrastructure: 2 })
    expect(resultNotes(rows).join(' ')).toContain('2 trials were left out because the harness blocked them')
  })

  it('caps the label at WEAK below three distinct cases and says why', () => {
    const oneCase = compareStrategies(Array.from({ length: 40 }, () => trial('BUILD', true)))
    expect(oneCase[0]).toMatchObject({ n: 40, cases: 1, label: 'WEAK' })
    const notes = resultNotes(oneCase).join(' ')
    expect(notes).toContain('all 40 trials come from 1 case; repetitions of one case are not independent')
    const three = compareStrategies(Array.from({ length: 40 }, (_, i) => spread('BUILD', true, i)))
    expect(three[0]).toMatchObject({ cases: 3, label: 'STRONG' })
    expect(resultNotes(three).join(' ')).not.toContain('not independent')
    // below five stays INSUFFICIENT
    expect(compareStrategies([trial('BUILD', true)])[0]!.label).toBe('INSUFFICIENT')
  })

  it('adds a multiple-comparison caveat above two strategies and the agent-cap note', () => {
    const strategies = ['SINGLE', 'BUILD', 'SWARM'] as const
    const rows = compareStrategies(strategies.flatMap((s) => Array.from({ length: 12 }, (_, i) => ({ ...spread('BUILD', i < 6, i), strategy: s }))))
    const notes = resultNotes(rows, { agentCaps: [{ strategy: 'SWARM', cap: 2, usual: 8 }] }).join(' ')
    expect(notes).toContain('With 3 strategies there are 3 pairwise comparisons; a single non-overlap can occur by chance')
    expect(notes).toContain('SWARM ran with at most 2 agents in this campaign; its usual limit is 8')
    expect(notes).toContain('summarised over passed trials only')
  })
})
