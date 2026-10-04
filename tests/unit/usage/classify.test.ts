import { describe, expect, it } from 'vitest'
import { classifyUsageSignal } from '@main/modules/usage'

const NOW = Date.UTC(2026, 9, 4, 22, 0, 0)

describe('classifyUsageSignal: rate_limit events', () => {
  it('rejected is quota exhausted; resetsAt is epoch SECONDS and becomes an ISO time', () => {
    const resetsAt = Math.floor((NOW + 90 * 60_000) / 1000)
    const s = classifyUsageSignal({ kind: 'rate_limit', status: 'rejected', resetsAt, limitType: 'five_hour' }, NOW)
    expect(s).toMatchObject({
      availability: 'QUOTA_EXHAUSTED',
      eventType: 'limit_rejected',
      limitType: 'five_hour',
      resetAt: new Date(NOW + 90 * 60_000).toISOString(),
      retryAfterMs: 90 * 60_000,
      source: 'SDK_EVENT',
      confidence: 'EXACT',
    })
  })

  it('also accepts a millisecond reset time', () => {
    const s = classifyUsageSignal({ kind: 'rate_limit', status: 'rejected', resetsAt: NOW + 1000, limitType: null }, NOW)
    expect(s?.resetAt).toBe(new Date(NOW + 1000).toISOString())
  })

  it('a missing reset stays unknown (never invented)', () => {
    const s = classifyUsageSignal({ kind: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null }, NOW)
    expect(s).toMatchObject({ resetAt: null, retryAfterMs: null })
  })

  it('allowed_warning stays available but is marked a warning; allowed is routine', () => {
    expect(classifyUsageSignal({ kind: 'rate_limit', status: 'allowed_warning', resetsAt: null, limitType: 'five_hour' }, NOW)).toMatchObject({
      availability: 'AVAILABLE',
      eventType: 'limit_warning',
    })
    expect(classifyUsageSignal({ kind: 'rate_limit', status: 'allowed', resetsAt: null, limitType: null }, NOW)).toMatchObject({
      availability: 'AVAILABLE',
      eventType: 'limit_allowed',
    })
  })

  it('rate_limit_info.utilization has no documented unit: it is stored raw, never as a percentage', () => {
    const s = classifyUsageSignal({ kind: 'rate_limit', status: 'allowed_warning', resetsAt: null, limitType: 'five_hour', utilization: 0.93 }, NOW)
    expect(s).toMatchObject({ utilization: 0.93, utilizationUnit: 'raw' })
    const none = classifyUsageSignal({ kind: 'rate_limit', status: 'allowed', resetsAt: null, limitType: null }, NOW)
    expect(none).toMatchObject({ utilization: null, utilizationUnit: null })
  })

  it('an unknown status carries no meaning', () => {
    expect(classifyUsageSignal({ kind: 'rate_limit', status: 'weird', resetsAt: null, limitType: null }, NOW)).toBeNull()
  })
})

describe('classifyUsageSignal: assistant errors and outcomes', () => {
  it('rate_limit and billing_error are quota', () => {
    for (const error of ['rate_limit', 'billing_error'] as const) {
      expect(classifyUsageSignal({ kind: 'assistant_error', error }, NOW)).toMatchObject({ availability: 'QUOTA_EXHAUSTED', eventType: 'limit_rejected', resetAt: null })
    }
  })

  it('overloaded and server_error are THROTTLED (transient), not quota', () => {
    for (const error of ['overloaded', 'server_error'] as const) {
      expect(classifyUsageSignal({ kind: 'assistant_error', error }, NOW)).toMatchObject({ availability: 'THROTTLED', eventType: 'throttle' })
    }
  })

  it('authentication errors are AUTH_REQUIRED', () => {
    for (const error of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error'] as const) {
      expect(classifyUsageSignal({ kind: 'assistant_error', error }, NOW)).toMatchObject({ availability: 'AUTH_REQUIRED', eventType: 'auth' })
    }
  })

  it('ordinary errors mean nothing for usage', () => {
    for (const error of ['invalid_request', 'model_not_found', 'unknown', 'max_output_tokens'] as const) {
      expect(classifyUsageSignal({ kind: 'assistant_error', error }, NOW)).toBeNull()
    }
  })

  it('turn outcomes: quota, auth and crash map; the rest do not', () => {
    expect(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'quota' }, NOW)?.availability).toBe('QUOTA_EXHAUSTED')
    expect(classifyUsageSignal({ kind: 'turn_outcome', outcome: 'auth' }, NOW)?.availability).toBe('AUTH_REQUIRED')
    const crash = classifyUsageSignal({ kind: 'turn_outcome', outcome: 'crashed' }, NOW)
    expect(crash).toMatchObject({ availability: 'RUNTIME_UNAVAILABLE', confidence: 'OBSERVED' })
    for (const outcome of ['success', 'max_turns', 'structured_output_failed', 'aborted', 'error'] as const) {
      expect(classifyUsageSignal({ kind: 'turn_outcome', outcome }, NOW)).toBeNull()
    }
  })
})

describe('classifyUsageSignal: usage report', () => {
  const report = (windows: { limitType: string; utilizationPercent: number | null; resetsAt: string | null }[]) => ({
    kind: 'usage_report' as const,
    report: { rateLimitsAvailable: true, subscriptionType: 'max', windows },
  })

  it('the report documents 0-100, so its utilization is a percent; the highest window decides', () => {
    const s = classifyUsageSignal(
      report([
        { limitType: 'five_hour', utilizationPercent: 40, resetsAt: '2026-10-05T01:00:00.000Z' },
        { limitType: 'seven_day', utilizationPercent: 97, resetsAt: '2026-10-09T00:00:00.000Z' },
      ]),
      NOW,
    )
    expect(s).toMatchObject({ availability: 'AVAILABLE', limitType: 'seven_day', utilization: 97, utilizationUnit: 'percent', source: 'RUNTIME', confidence: 'EXACT' })
  })

  it('100 percent is limited and carries the window reset', () => {
    const s = classifyUsageSignal(report([{ limitType: 'five_hour', utilizationPercent: 100, resetsAt: new Date(NOW + 30 * 60_000).toISOString() }]), NOW)
    expect(s).toMatchObject({ availability: 'QUOTA_EXHAUSTED', retryAfterMs: 30 * 60_000 })
  })

  it('a report without a single percentage is UNKNOWN, not invented', () => {
    const s = classifyUsageSignal(report([{ limitType: 'five_hour', utilizationPercent: null, resetsAt: null }]), NOW)
    expect(s).toMatchObject({ availability: 'UNKNOWN', utilization: null, confidence: 'UNKNOWN' })
  })
})
