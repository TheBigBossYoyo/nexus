import { describe, expect, it } from 'vitest'
import {
  EMPTY_USAGE_TOTALS,
  unknownValue,
  type Measured,
  type UsageOverview,
  type UsageStatus,
} from '@shared/v3'
import {
  clockText,
  exactResetAt,
  popoverRows,
  quotaBanner,
  untilText,
  usageIndicator,
} from '../../../src/renderer/src/lib/usageModel'

const NOW = Date.parse('2026-10-04T03:00:00')
const at = (hhmm: string) => new Date(`2026-10-04T${hhmm}:00`).toISOString()
const exact = <T>(value: T): Measured<T> => ({ value, source: 'RUNTIME', confidence: 'EXACT' })

function overview(status: UsageStatus, patch: Partial<UsageOverview> = {}): UsageOverview {
  return {
    capturedAt: at('03:00'),
    provider: 'claude',
    accountMode: unknownValue(),
    subscriptionType: unknownValue(),
    status,
    availability: 'AVAILABLE',
    session: { ...EMPTY_USAGE_TOTALS },
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

describe('clockText / untilText', () => {
  it('formats local clock times with a day hint', () => {
    expect(clockText(at('03:43'), NOW)).toBe('03:43')
    expect(clockText('2026-10-05T01:05:00', NOW)).toBe('01:05 tomorrow')
    expect(clockText(null, NOW)).toBe('—')
    expect(clockText('garbage', NOW)).toBe('—')
  })

  it('counts down only to a future moment', () => {
    expect(untilText(at('03:42'), NOW)).toBe('42m')
    expect(untilText(at('04:05'), NOW)).toBe('1h 05m')
    expect(untilText(at('05:00'), NOW)).toBe('2h')
    expect(untilText(at('02:00'), NOW)).toBeNull()
    expect(untilText(null, NOW)).toBeNull()
  })
})

describe('usageIndicator', () => {
  it('shows a calm unknown state when the overview is missing or failed', () => {
    expect(usageIndicator(null, NOW).label).toBe('Checking availability')
    const failed = usageIndicator(null, NOW, true)
    expect(failed.label).toBe('Status unknown')
    expect(failed.tone).toBe('neutral')
  })

  it('maps statuses to labels and tones', () => {
    expect(usageIndicator(overview('AVAILABLE'), NOW)).toMatchObject({
      label: 'Available',
      tone: 'success',
    })
    expect(usageIndicator(overview('AUTH_REQUIRED'), NOW)).toMatchObject({
      label: 'Sign-in required',
      tone: 'danger',
    })
    expect(usageIndicator(overview('RUNTIME_UNAVAILABLE'), NOW).label).toBe('Runtime unavailable')
    expect(usageIndicator(overview('PROBING'), NOW).label).toBe('Checking availability')
    expect(usageIndicator(overview('QUOTA_PAUSED'), NOW).label).toBe('Paused · Usage limit')
  })

  it('shows a reset countdown only for an EXACT reset time', () => {
    const exactReset = overview('QUOTA_PAUSED', { nextResetAt: exact(at('03:42')) })
    expect(usageIndicator(exactReset, NOW)).toMatchObject({
      label: 'Resets 42m',
      icon: 'clock',
      detail: 'Paused · Usage limit',
    })
    const estimated = overview('QUOTA_PAUSED', {
      nextResetAt: { value: at('03:42'), source: 'UNKNOWN', confidence: 'ESTIMATED' },
    })
    expect(usageIndicator(estimated, NOW).label).toBe('Paused · Usage limit')
    const past = overview('WAITING_FOR_RESET', { nextResetAt: exact(at('02:00')) })
    expect(usageIndicator(past, NOW).label).toBe('Waiting for reset')
  })

  it('never invents a reset for an available account', () => {
    expect(
      usageIndicator(overview('AVAILABLE', { nextResetAt: exact(at('03:42')) }), NOW).label,
    ).toBe('Available')
  })
})

describe('exactResetAt', () => {
  it('uses the overview value and never an estimate', () => {
    expect(exactResetAt(overview('QUOTA_PAUSED', { nextResetAt: exact(at('03:42')) }))).toBe(
      at('03:42'),
    )
    expect(exactResetAt(overview('QUOTA_PAUSED'))).toBeNull()
  })
})

describe('quotaBanner', () => {
  const pause = (patch: object = {}) =>
    ({
      id: 'p1',
      runId: null,
      scope: 'global',
      state: 'waiting',
      pausedAt: at('02:50'),
      limitType: 'five_hour',
      resetAt: null,
      resetConfidence: 'UNKNOWN',
      nextCheckAt: null,
      probes: 0,
      checkpointId: null,
      resumeState: null,
      endedAt: null,
      endReason: null,
      createdAt: at('02:50'),
      updatedAt: at('02:50'),
      ...patch,
    }) as never
  const check = (hhmm: string): Measured<string> => ({
    value: at(hhmm),
    source: 'LOCAL_AGGREGATION',
    confidence: 'ESTIMATED',
  })

  it('is hidden when nothing waits', () => {
    expect(quotaBanner(overview('AVAILABLE'), NOW)).toBeNull()
    expect(quotaBanner(null, NOW)).toBeNull()
  })

  it('states the automatic resume and the reset when both are known', () => {
    const o = overview('WAITING_FOR_RESET', {
      nextResetAt: exact(at('03:42')),
      autoResume: { enabled: true, pause: pause(), nextCheckAt: check('03:43'), pausedRuns: 2 },
    })
    const m = quotaBanner(o, NOW)
    expect(m?.headline).toBe('Claude usage limit reached — NEXUS has safely paused 2 runs.')
    expect(m?.resumeLine).toBe('Automatic resume: 03:43 (reset 03:42)')
    expect(m?.countdown).toBe('43m')
  })

  it('says so when the reset time is not reported', () => {
    const o = overview('QUOTA_PAUSED', {
      autoResume: { enabled: true, pause: pause(), nextCheckAt: check('03:50'), pausedRuns: 1 },
    })
    const m = quotaBanner(o, NOW)
    expect(m?.headline).toContain('paused 1 run.')
    expect(m?.resumeLine).toBe('Reset time not reported by Claude; next availability check 03:50')
    expect(m?.resetText).toBeNull()
  })

  it('handles probing, a missing schedule and auto resume off', () => {
    const probing = overview('PROBING', {
      autoResume: {
        enabled: true,
        pause: pause({ state: 'probing' }),
        nextCheckAt: unknownValue(),
        pausedRuns: 0,
      },
    })
    expect(quotaBanner(probing, NOW)?.resumeLine).toBe('Checking availability…')
    expect(quotaBanner(overview('QUOTA_PAUSED'), NOW)?.resumeLine).toContain('not scheduled yet')
    const off = overview('QUOTA_PAUSED', {
      autoResume: { enabled: false, pause: null, nextCheckAt: unknownValue(), pausedRuns: 3 },
    })
    expect(quotaBanner(off, NOW)?.resumeLine).toContain('Automatic resume is off')
  })

  it('shows the banner for a live pause even when the status already says available', () => {
    const live = overview('AVAILABLE', {
      autoResume: { enabled: true, pause: pause(), nextCheckAt: unknownValue(), pausedRuns: 1 },
    })
    expect(quotaBanner(live, NOW)).not.toBeNull()
    const ended = overview('AVAILABLE', {
      autoResume: {
        enabled: true,
        pause: pause({ state: 'resumed' }),
        nextCheckAt: unknownValue(),
        pausedRuns: 0,
      },
    })
    expect(quotaBanner(ended, NOW)).toBeNull()
  })
})

describe('popoverRows', () => {
  it('labels unknown values plainly and known ones with their confidence', () => {
    const rows = popoverRows(
      overview('AVAILABLE', { accountMode: exact('subscription'), subscriptionType: exact('max') }),
      NOW,
    )
    expect(rows.auth[0]).toMatchObject({ value: 'subscription', confidence: 'EXACT' })
    const blank = popoverRows(overview('AVAILABLE'), NOW)
    expect(blank.auth[0]).toMatchObject({ value: 'Not reported', muted: true })
    expect(blank.limit.find((r) => r.label === 'Next known reset')?.value).toBe('Unknown')
    expect(blank.resume.find((r) => r.label === 'Next check')?.value).toBe('None planned')
  })
})
