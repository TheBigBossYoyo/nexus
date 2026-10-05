import { describe, expect, it } from 'vitest'
import type { ArenaCell, ArenaTrialMetrics, StrategyComparisonRow } from '@shared/v3'
import {
  budgetLine,
  campaignProgress,
  campaignStateInfo,
  canCancel,
  canPause,
  canResume,
  canStart,
  cellModel,
  checkCampaign,
  intervalText,
  intervalsOverlap,
  metricGroups,
  passText,
  sortComparison,
  trialCount,
  trialStateInfo,
  whiskers,
} from '../../../src/renderer/src/views/arena/arenaModel'

const row = (
  strategy: StrategyComparisonRow['strategy'],
  passed: number,
  n: number,
  extra: Partial<StrategyComparisonRow> = {},
): StrategyComparisonRow => ({
  strategy,
  n,
  cases: 1,
  excludedInfrastructure: 0,
  passed,
  passRate: n === 0 ? null : passed / n,
  passInterval:
    n === 0 ? null : { low: Math.max(0, passed / n - 0.2), high: Math.min(1, passed / n + 0.2) },
  medianWallClockMs: 60_000,
  meanSessions: 4,
  meanObservedTokens: 100_000,
  meanRepairs: 0.5,
  criticalHighFindings: 0,
  quotaPauses: 0,
  label: 'WEAK',
  ...extra,
})

describe('sortComparison', () => {
  it('does not put one lucky trial above a well-measured strategy', () => {
    const lucky = row('SWARM', 1, 1, { passInterval: { low: 0.21, high: 1 } })
    const measured = row('BUILD', 18, 20, { passInterval: { low: 0.7, high: 0.97 } })
    expect(sortComparison([lucky, measured]).map((r) => r.strategy)).toEqual(['BUILD', 'SWARM'])
  })
  it('ranks by correctness, never by cost', () => {
    const cheapButWorse = row('SINGLE', 3, 9, {
      meanObservedTokens: 1_000,
      medianWallClockMs: 1_000,
    })
    const costlyButBetter = row('SWARM', 8, 9, {
      meanObservedTokens: 900_000,
      medianWallClockMs: 900_000,
    })
    expect(sortComparison([cheapButWorse, costlyButBetter]).map((r) => r.strategy)).toEqual([
      'SWARM',
      'SINGLE',
    ])
  })
  it('puts unmeasured rows last and does not mutate', () => {
    const input = [row('BUILD', 0, 0), row('SINGLE', 1, 2)]
    expect(sortComparison(input).map((r) => r.strategy)).toEqual(['SINGLE', 'BUILD'])
    expect(input[0]?.strategy).toBe('BUILD')
  })
})

describe('text helpers', () => {
  it('formats intervals and pass counts', () => {
    expect(intervalText({ low: 0.62, high: 0.91 })).toBe('62%–91%')
    expect(intervalText(null)).toBe('—')
    expect(passText(7, 9, 7 / 9)).toBe('7/9 (78%)')
    expect(passText(0, 0, null)).toBe('0/0')
  })
  it('detects overlapping intervals', () => {
    expect(intervalsOverlap({ low: 0.2, high: 0.6 }, { low: 0.5, high: 0.9 })).toBe(true)
    expect(intervalsOverlap({ low: 0.1, high: 0.3 }, { low: 0.5, high: 0.9 })).toBe(false)
    expect(intervalsOverlap(null, { low: 0.5, high: 0.9 })).toBe(true)
  })
})

describe('matrix cells', () => {
  const cell: ArenaCell = {
    caseId: 'c1',
    strategy: 'BUILD',
    trials: [
      { id: 't3', state: 'queued', repetition: 3, score: null },
      { id: 't1', state: 'passed', repetition: 1, score: 88 },
      { id: 't2', state: 'failed', repetition: 2, score: 0 },
    ],
  }
  it('orders repetitions and summarises states in words', () => {
    const m = cellModel(cell)
    expect(m.chips.map((c) => c.id)).toEqual(['t1', 't2', 't3'])
    expect(m.summary).toBe('1 pass · 1 fail · 1 queued')
    expect(m.single).toBe(false)
  })
  it('gives each state its own label and glyph so colour is never the only signal', () => {
    const states = ['queued', 'running', 'passed', 'failed', 'blocked', 'cancelled'] as const
    const glyphs = states.map((s) => trialStateInfo(s).glyph)
    expect(new Set(glyphs).size).toBe(states.length)
    for (const s of states) expect(trialStateInfo(s).label.length).toBeGreaterThan(2)
    expect(trialStateInfo('evaluating').label).toBe('Running')
  })
  it('never exposes a score in the matrix model', () => {
    expect(JSON.stringify(cellModel(cell))).not.toContain('88')
  })
  it('handles an empty cell', () => {
    expect(cellModel(undefined)).toEqual({ chips: [], summary: '', single: false })
  })
})

describe('campaign progress and actions', () => {
  it('groups trial states', () => {
    const p = campaignProgress(
      { passed: 4, failed: 1, running: 1, evaluating: 1, queued: 3, blocked: 1 },
      11,
    )
    expect(p).toMatchObject({
      passed: 4,
      failed: 1,
      running: 2,
      queued: 3,
      other: 1,
      total: 11,
      finished: 6,
    })
  })
  it('allows only valid actions per state', () => {
    expect(canStart('draft')).toBe(true)
    expect(canPause('running')).toBe(true)
    expect(canResume('paused')).toBe(true)
    expect(canCancel('completed')).toBe(false)
    expect(canPause('paused')).toBe(false)
  })
  it('words a quota pause calmly', () => {
    const i = campaignStateInfo('paused', 'quota')
    expect(i.note).toBe('Paused for Claude usage limit. Resumes automatically.')
    expect(i.tone).toBe('waiting')
    expect(campaignStateInfo('paused', 'user').note).toBeNull()
  })
})

describe('new campaign planning', () => {
  it('counts trials', () => {
    expect(trialCount(3, 2, 4)).toBe(24)
    expect(trialCount(0, 2, 4)).toBe(0)
  })
  it('describes budget presets from the shared defaults', () => {
    expect(budgetLine('eco').summary).toContain('12 trials')
    expect(budgetLine('research').label).toBe('Research')
  })
  it('validates before create and warns when the budget will stop the plan', () => {
    expect(
      checkCampaign({ name: '', cases: 1, strategies: 1, repetitions: 1, preset: 'eco' }).ok,
    ).toBe(false)
    expect(
      checkCampaign({ name: 'x', cases: 0, strategies: 1, repetitions: 1, preset: 'eco' }).error,
    ).toMatch(/case/)
    expect(
      checkCampaign({ name: 'x', cases: 1, strategies: 1, repetitions: 21, preset: 'eco' }).ok,
    ).toBe(false)
    const big = checkCampaign({ name: 'x', cases: 5, strategies: 5, repetitions: 3, preset: 'eco' })
    expect(big.ok).toBe(true)
    expect(big.warning).toMatch(/75 trials/)
    expect(
      checkCampaign({ name: 'x', cases: 1, strategies: 2, repetitions: 3, preset: 'eco' }).warning,
    ).toBeNull()
  })
})

describe('whiskers', () => {
  it('scales on a fixed 0 to 100% axis and clamps', () => {
    const w = whiskers(
      [row('BUILD', 8, 10, { passInterval: { low: 0.49, high: 0.94 } }), row('SINGLE', 0, 0)],
      200,
    )
    expect(w[0]).toMatchObject({ x: 160, hasInterval: true })
    expect(w[0]?.low).toBeCloseTo(98)
    expect(w[0]?.high).toBeCloseTo(188)
    expect(w[1]?.hasInterval).toBe(false)
  })
})

describe('metricGroups', () => {
  const m = {
    buildPassed: true,
    typecheckPassed: null,
    testsPassed: false,
    hiddenPassed: false,
    acceptanceTotal: 4,
    acceptancePassed: 3,
    verifierPassed: null,
    criticalFindings: 1,
    highFindings: 0,
    mediumFindings: 2,
    repairs: 1,
    wallClockMs: 120_000,
    sessions: 3,
    turns: null,
    inputTokens: 52_000,
    outputTokens: 4_000,
    toolCalls: 40,
    humanInterventions: 0,
    approvals: 1,
    manualRetries: 0,
    blockers: 0,
    crashedAgents: 0,
    recoveredSessions: 1,
    schedulerFailures: 0,
    unfinishedTasks: 0,
    quotaPauses: 0,
    quotaWaitMs: 0,
    autoResumeSuccesses: 0,
    throttleEvents: 0,
  } as unknown as ArenaTrialMetrics
  it('lists all six groups with "Not measured" for nulls', () => {
    const g = metricGroups(m)
    expect(g.map((x) => x.title)).toEqual([
      'Correctness',
      'Quality',
      'Efficiency',
      'Autonomy',
      'Stability',
      'Limit behaviour',
    ])
    const all = g.flatMap((x) => x.items)
    expect(all.find((i) => i.label === 'Typecheck')).toMatchObject({
      value: 'Not measured',
      measured: false,
    })
    expect(all.find((i) => i.label === 'Turns')?.value).toBe('Not measured')
    expect(all.find((i) => i.label === 'Hidden evaluation')).toMatchObject({
      value: 'Failed',
      bad: true,
    })
    expect(all.find((i) => i.label === 'Acceptance criteria')?.value).toBe('3 of 4')
    expect(all.find((i) => i.label === 'Critical findings')?.bad).toBe(true)
  })
  it('returns nothing without metrics', () => {
    expect(metricGroups(null)).toEqual([])
  })
})
