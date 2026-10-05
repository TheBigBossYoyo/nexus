import { describe, expect, it } from 'vitest'
import {
  EMPTY_USAGE_TOTALS,
  unknownValue,
  type Measured,
  type UsageBreakdownRow,
  type UsageOverview,
  type UsageWindow,
} from '@shared/v3'
import type { QuotaPauseWithResumes } from '@shared/v3-read'
import {
  NOT_EXPOSED,
  chartGeometry,
  dailySeries,
  efficiencyGroups,
  limitRows,
  mayDrawPlanPercent,
  niceCeil,
  pauseRow,
  pickCurrentRun,
  subscriptionRemaining,
  usageHeader,
  windowRows,
} from '../../../src/renderer/src/views/usage/usageViewModel'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const exact = <T>(value: T): Measured<T> => ({ value, source: 'RUNTIME', confidence: 'EXACT' })
const observed = <T>(value: T): Measured<T> => ({
  value,
  source: 'LOCAL_AGGREGATION',
  confidence: 'OBSERVED',
})
const estimated = <T>(value: T): Measured<T> => ({
  value,
  source: 'LOCAL_AGGREGATION',
  confidence: 'ESTIMATED',
})

function overview(patch: Partial<UsageOverview> = {}): UsageOverview {
  return {
    capturedAt: '2026-10-04T12:00:00Z',
    provider: 'claude',
    accountMode: unknownValue(),
    subscriptionType: unknownValue(),
    status: 'AVAILABLE',
    availability: 'AVAILABLE',
    session: { ...EMPTY_USAGE_TOTALS, inputTokens: 120_000, outputTokens: 30_000, sessions: 8 },
    windows: [],
    subscriptionUtilizationPercent: unknownValue(),
    nextResetAt: unknownValue(),
    retryAfterMs: unknownValue(),
    lastLimitAt: null,
    autoResume: { enabled: true, pause: null, nextCheckAt: unknownValue(), pausedRuns: 0 },
    usageReportSupported: null,
    ...patch,
  }
}

describe('subscription percentage guard', () => {
  it('never yields a percentage for observed-only data', () => {
    const o = overview() // only observed session totals, nothing from the runtime
    expect(subscriptionRemaining(o)).toEqual({ kind: 'unknown', reason: NOT_EXPOSED })
    expect(mayDrawPlanPercent(o)).toBe(false)
  })

  it('rejects observed and estimated percentages, even with a value', () => {
    expect(
      subscriptionRemaining(overview({ subscriptionUtilizationPercent: observed(42) })).kind,
    ).toBe('unknown')
    expect(
      subscriptionRemaining(overview({ subscriptionUtilizationPercent: estimated(42) })).kind,
    ).toBe('unknown')
    expect(
      subscriptionRemaining(
        overview({
          subscriptionUtilizationPercent: { value: null, source: 'RUNTIME', confidence: 'EXACT' },
        }),
      ).kind,
    ).toBe('unknown')
  })

  it('rejects an out-of-range exact value instead of drawing it', () => {
    expect(
      subscriptionRemaining(overview({ subscriptionUtilizationPercent: exact(140) })).kind,
    ).toBe('unknown')
    expect(
      subscriptionRemaining(overview({ subscriptionUtilizationPercent: exact(Number.NaN) })).kind,
    ).toBe('unknown')
  })

  it('shows an exact runtime percentage', () => {
    expect(subscriptionRemaining(overview({ subscriptionUtilizationPercent: exact(37) }))).toEqual({
      kind: 'percent',
      percent: 37,
      confidence: 'EXACT',
    })
  })

  it('handles a missing overview as unknown', () => {
    expect(subscriptionRemaining(null).kind).toBe('unknown')
  })
})

describe('plan windows', () => {
  const w = (patch: Partial<UsageWindow>): UsageWindow => ({
    id: 'w1',
    limitType: 'five_hour',
    status: 'allowed',
    utilizationPercent: null,
    resetAt: null,
    source: 'RUNTIME',
    confidence: 'EXACT',
    observedAt: '2026-10-04T11:00:00Z',
    updatedAt: '2026-10-04T11:00:00Z',
    ...patch,
  })
  it('only carries a percent when the runtime sent one', () => {
    const rows = windowRows([
      w({ id: 'a' }),
      w({ id: 'b', limitType: 'seven_day', utilizationPercent: 64 }),
      w({ id: 'c', utilizationPercent: 250 }),
    ])
    expect(rows.map((r) => r.percent)).toEqual([null, 64, 100])
    expect(rows[0]?.name).toBe('5-hour window')
    expect(rows[1]?.name).toBe('7-day window')
  })
})

describe('usageHeader', () => {
  it('reports the next reset only when it is exact', () => {
    expect(
      usageHeader(overview({ nextResetAt: observed('2026-10-04T15:00:00Z') })).nextReset,
    ).toBeNull()
    expect(usageHeader(overview({ nextResetAt: exact('2026-10-04T15:00:00Z') })).nextReset).toBe(
      '2026-10-04T15:00:00Z',
    )
  })
  it('marks waiting states', () => {
    expect(usageHeader(overview({ status: 'QUOTA_PAUSED' })).waiting).toBe(true)
    expect(usageHeader(overview({ status: 'AVAILABLE' })).waiting).toBe(false)
    expect(usageHeader(overview()).autoResume).toBe('Enabled')
    expect(usageHeader(null).status).toBeNull()
  })
})

describe('pickCurrentRun', () => {
  const run = (id: string, state: string, createdAt: string) => ({ id, state, createdAt }) as never
  it('prefers the selection, then the newest active run', () => {
    const runs = [
      run('a', 'completed', '2026-10-01T00:00:00Z'),
      run('b', 'executing', '2026-10-02T00:00:00Z'),
      run('c', 'executing', '2026-10-03T00:00:00Z'),
    ]
    expect(pickCurrentRun('a', runs)).toBe('a')
    expect(pickCurrentRun(null, runs)).toBe('c')
    expect(pickCurrentRun(null, [run('a', 'completed', '2026-10-01T00:00:00Z')])).toBeNull()
  })
})

describe('daily series and chart geometry', () => {
  const row = (key: string, input: number, output: number): UsageBreakdownRow => ({
    ...EMPTY_USAGE_TOTALS,
    key,
    label: key,
    inputTokens: input,
    outputTokens: output,
    sessions: 1,
  })
  it('fills missing days with zeros, oldest first, ending today', () => {
    const s = dailySeries([row('2026-10-03', 100, 50)], 7, new Date(2026, 9, 4))
    expect(s).toHaveLength(7)
    expect(s[0]?.day).toBe('2026-09-28')
    expect(s[6]?.day).toBe('2026-10-04')
    expect(s[5]).toMatchObject({ day: '2026-10-03', total: 150 })
    expect(s[6]?.total).toBe(0)
  })
  it('rounds the axis up to a readable maximum', () => {
    expect(niceCeil(0)).toBe(1)
    expect(niceCeil(730)).toBe(1000)
    expect(niceCeil(1_300_000)).toBe(2_000_000)
    expect(niceCeil(4_200_000)).toBe(5_000_000)
    expect(niceCeil(2_400)).toBe(2_500)
  })
  it('keeps bars inside the plot and gives empty days no height', () => {
    const pts = dailySeries([row('2026-10-04', 900, 100)], 7, new Date(2026, 9, 4))
    const g = chartGeometry(pts, 280, 100)
    expect(g.max).toBe(1000)
    expect(g.bars).toHaveLength(7)
    expect(g.bars[6]?.h).toBeCloseTo(100)
    expect(g.bars[0]?.h).toBe(0)
    for (const b of g.bars) expect(b.x + b.w).toBeLessThanOrEqual(280)
    expect(g.ticks).toEqual([0, 500, 1000])
  })
})

describe('limit rows', () => {
  const pause = (patch: Partial<QuotaPauseWithResumes> = {}): QuotaPauseWithResumes => ({
    id: 'p1',
    runId: null,
    scope: 'global',
    state: 'resumed',
    pausedAt: '2026-10-04T10:00:00Z',
    limitType: 'five_hour',
    resetAt: '2026-10-04T11:00:00Z',
    resetConfidence: 'EXACT',
    nextCheckAt: null,
    probes: 2,
    checkpointId: null,
    resumeState: null,
    endedAt: '2026-10-04T11:05:00Z',
    endReason: null,
    createdAt: '2026-10-04T10:00:00Z',
    updatedAt: '2026-10-04T11:05:00Z',
    runLabel: null,
    resumes: [
      {
        id: 'r1',
        pauseId: 'p1',
        runId: null,
        attemptedAt: '2026-10-04T11:00:30Z',
        kind: 'probe',
        result: 'still_limited',
        method: 'usage_report',
        detail: null,
        waitedMs: null,
        createdAt: '2026-10-04T11:00:30Z',
      },
      {
        id: 'r2',
        pauseId: 'p1',
        runId: null,
        attemptedAt: '2026-10-04T11:05:00Z',
        kind: 'resume',
        result: 'resumed',
        method: 'minimal_session',
        detail: null,
        waitedMs: 3_900_000,
        createdAt: '2026-10-04T11:05:00Z',
      },
    ],
    ...patch,
  })

  it('shows a reset time only when it was exact', () => {
    expect(pauseRow(pause(), NOW).resetAt).toBe('2026-10-04T11:00:00Z')
    expect(pauseRow(pause({ resetConfidence: 'ESTIMATED' }), NOW).resetAt).toBeNull()
    expect(pauseRow(pause({ resetConfidence: 'UNKNOWN', resetAt: null }), NOW).resetAt).toBeNull()
  })
  it('summarises probes, methods, duration and result', () => {
    const r = pauseRow(pause(), NOW)
    expect(r.probes).toBe(2)
    expect(r.methods).toEqual(['Usage report', 'Minimal session'])
    expect(r.pausedMs).toBe(65 * 60_000)
    expect(r.result).toBe('Resumed automatically')
    expect(r.run).toBe('All runs')
  })
  it('measures an open pause up to now', () => {
    const r = pauseRow(pause({ state: 'waiting', endedAt: null, resumes: [] }), NOW)
    expect(r.pausedMs).toBe(2 * 3_600_000)
    expect(r.result).toBe('No check yet')
  })
  it('merges pages newest first without duplicates', () => {
    const page = { events: [], pauses: [pause()] }
    const rows = limitRows(
      [
        page,
        { events: [], pauses: [pause({ id: 'p0', pausedAt: '2026-10-03T10:00:00Z' }), pause()] },
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p0'])
  })
})

describe('efficiencyGroups', () => {
  const r = (strategy: 'SINGLE' | 'BUILD', kind: 'arena' | 'mission') => ({
    strategy,
    kind,
    n: 3,
    successes: 2,
    passRate: 0.67,
    meanSessions: 4,
    meanObservedTokens: 1000,
    medianDurationMs: 1000,
    label: 'WEAK' as const,
  })
  it('keeps arena and mission evidence in separate groups', () => {
    const g = efficiencyGroups([r('BUILD', 'mission'), r('BUILD', 'arena'), r('SINGLE', 'arena')])
    expect(g.map((x) => x.kind)).toEqual(['arena', 'mission'])
    expect(g[0]?.rows.map((x) => x.strategy)).toEqual(['SINGLE', 'BUILD'])
    expect(efficiencyGroups([])).toEqual([])
  })
})
