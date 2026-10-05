import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { FakeAgentRuntime, completeWith } from '@main/modules/agent-runtime/fake-runtime'
import type { RuntimeUsageReport } from '@main/modules/agent-runtime/types'
import { RuntimeAvailabilityProbe } from '@main/modules/usage'

const NOW = Date.UTC(2026, 9, 4, 22, 0, 0)
const iso = (ms: number): string => new Date(ms).toISOString()

function probeWith(windows: RuntimeUsageReport['windows']) {
  const runtime = new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) })
  runtime.getUsageReport = async () => ({ rateLimitsAvailable: true, subscriptionType: 'max', windows })
  const probe = new RuntimeAvailabilityProbe({ runtime, settings: () => DEFAULT_SETTINGS, now: () => NOW })
  return { probe, runtime }
}

describe('availability probe: the rejected window', () => {
  it('a window at 100% whose reset time has passed is stale, not a limit', async () => {
    const { probe } = probeWith([{ limitType: 'five_hour', utilizationPercent: 100, resetsAt: iso(NOW - 60_000) }])
    expect(await probe.probe({ limitType: 'five_hour' })).toMatchObject({ available: true, method: 'usage_report', outcome: 'available' })
  })

  it('a window at 100% with its reset still ahead is a limit and carries that reset', async () => {
    const { probe } = probeWith([{ limitType: 'five_hour', utilizationPercent: 100, resetsAt: iso(NOW + 600_000) }])
    expect(await probe.probe({ limitType: 'five_hour' })).toMatchObject({ available: false, outcome: 'limited', resetAt: iso(NOW + 600_000) })
  })

  it('another window being full does not decide when the rejected window has room', async () => {
    const { probe } = probeWith([
      { limitType: 'five_hour', utilizationPercent: 20, resetsAt: iso(NOW + 600_000) },
      { limitType: 'seven_day_opus', utilizationPercent: 100, resetsAt: iso(NOW + 9_000_000) },
    ])
    expect(await probe.probe({ limitType: 'five_hour' })).toMatchObject({ available: true })
  })

  it('a rejection that names no window (billing, overage) is not decided by the report: one minimal session answers', async () => {
    const { probe, runtime } = probeWith([{ limitType: 'five_hour', utilizationPercent: 3, resetsAt: iso(NOW + 600_000) }])
    const r = await probe.probe({ limitType: null })
    expect(r).toMatchObject({ method: 'minimal_session', available: true })
    expect(probe.stats).toEqual({ reports: 1, sessions: 1 })
    expect(runtime.sessions).toHaveLength(1)
  })

  it('a rejected window the report does not list also falls back to a session', async () => {
    const { probe } = probeWith([{ limitType: 'five_hour', utilizationPercent: 3, resetsAt: null }])
    expect((await probe.probe({ limitType: 'seven_day' })).method).toBe('minimal_session')
  })

  it('a percentage-less window with a reset ahead is limited; without one the report says nothing', async () => {
    expect(await probeWith([{ limitType: 'five_hour', utilizationPercent: null, resetsAt: iso(NOW + 1000) }]).probe.probe({ limitType: 'five_hour' })).toMatchObject({ available: false, method: 'usage_report' })
    expect((await probeWith([{ limitType: 'five_hour', utilizationPercent: null, resetsAt: null }]).probe.probe({ limitType: 'five_hour' })).method).toBe('minimal_session')
  })

  it('without a hint (a manual check) stale windows are ignored', async () => {
    const { probe } = probeWith([
      { limitType: 'five_hour', utilizationPercent: 100, resetsAt: iso(NOW - 1000) },
      { limitType: 'seven_day', utilizationPercent: 10, resetsAt: iso(NOW + 1000) },
    ])
    expect(await probe.probe()).toMatchObject({ available: true })
  })
})
