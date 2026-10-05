import { describe, expect, it } from 'vitest'
import { DEFAULT_OVERNIGHT_POLICY, type OvernightStatus } from '../../../src/shared/overnight'
import type { UsageBreakdownRow } from '../../../src/shared/v3'
import {
  actionHint,
  deadlineRowLabel,
  endedText,
  failsafeRowValue,
  finalActionRow,
} from '../../../src/renderer/src/views/overnight/workloadModel'
import { bannerEnablement } from '../../../src/renderer/src/views/run/overnightModel'
import { breakdownDetail } from '../../../src/renderer/src/views/usage/usageViewModel'

const NOW = Date.parse('2026-10-04T03:00:00')
const ok = { ok: true } as never
const failsafe = (patch = {}) => ({
  scheduledAt: '',
  deadline: '2026-10-04T09:00:00.000Z',
  result: ok,
  cancelledAt: null,
  cancelResult: null,
  lostAt: null,
  ...patch,
})
const power = (patch = {}) => ({
  action: 'SHUTDOWN',
  reason: 'SUCCESS',
  scheduledAt: '',
  executeAt: '2026-10-04T03:59:55.000Z',
  forced: false,
  mechanism: 'os_timer',
  result: null,
  executedAt: null,
  cancelledAt: null,
  ...patch,
})
const s = (patch: Record<string, unknown> = {}) =>
  ({
    workloadType: 'arena_campaign',
    state: 'RUNNING',
    policy: DEFAULT_OVERNIGHT_POLICY,
    failsafe: null,
    terminalReason: null,
    powerAction: null,
    ...patch,
  }) as unknown as OvernightStatus

describe('overnight wording', () => {
  it('names the workload and cases the reason', () => {
    expect(endedText(s({ terminalReason: 'SUCCESS' }))).toBe('campaign ended: success')
    expect(endedText(s({ workloadType: 'mission', terminalReason: 'USER_CANCELLED' }))).toBe(
      'mission ended: user cancelled',
    )
    expect(endedText(s())).toBeNull()
  })

  it('marks the deadline as not reached once the workload ended', () => {
    expect(deadlineRowLabel(s())).toBe('Campaign deadline')
    expect(deadlineRowLabel(s({ state: 'DONE', terminalReason: 'SUCCESS' }))).toBe(
      'Campaign deadline (not reached)',
    )
    expect(deadlineRowLabel(s({ state: 'DONE', terminalReason: 'TIME_LIMIT' }))).toBe(
      'Campaign deadline',
    )
  })

  it('separates the final shutdown from the failsafe timer', () => {
    const scheduled = s({
      state: 'POWER_ACTION_SCHEDULED',
      powerAction: power(),
      failsafe: failsafe({ cancelledAt: 'x' }),
    })
    expect(finalActionRow(scheduled, 'Shutting down in 59:55')).toEqual({
      label: 'End-of-campaign shutdown',
      value: 'scheduled, in 59:55',
    })
    expect(failsafeRowValue(scheduled, NOW)).toBe('replaced by the final shutdown')
    expect(failsafeRowValue(s({ failsafe: failsafe({ cancelledAt: 'x' }) }), NOW)).toBe('cancelled')
    expect(failsafeRowValue(s({ failsafe: failsafe() }), NOW)).toMatch(/^armed for \d\d:\d\d/)
    expect(failsafeRowValue(s(), NOW)).toBe('not armed')
    expect(
      failsafeRowValue(s({ policy: { ...DEFAULT_OVERNIGHT_POLICY, failsafeEnabled: false } }), NOW),
    ).toBe('none')
    expect(finalActionRow(s(), null)).toBeNull()
    expect(finalActionRow(s({ powerAction: power({ cancelledAt: 'x' }) }), null)?.value).toBe('cancelled')
  })

  it('explains hidden actions', () => {
    const done = s({ state: 'DONE', terminalReason: 'SUCCESS', hasReport: true })
    const hint = actionHint('campaign', bannerEnablement(done), true)
    expect(hint).toBe('The campaign is no longer running; only View report applies.')
    expect(actionHint('campaign', bannerEnablement(s()), true)).toBeNull()
  })

  it('shows a short id under duplicate mission labels', () => {
    const row = { key: 'abcdef1234567890', label: 'Same' } as UsageBreakdownRow
    expect(breakdownDetail('run', row)).toBe('abcdef12')
    expect(breakdownDetail('model', row)).toBeNull()
  })
})

describe('authorization wording', () => {
  it('never claims an authorization before the box is ticked', async () => {
    const { authorizationStatus, authorizationScope } = await import('../../../src/renderer/src/views/projects/overnight')
    expect(authorizationStatus('SHUTDOWN', false)).toBe('Not authorized yet: NEXUS will not shut down Windows unless you tick the box.')
    expect(authorizationStatus('SHUTDOWN', true)).toBe('This run is authorized to shut down Windows automatically.')
    expect(authorizationStatus('NONE', false)).toMatch(/no power action/)
    // The scope names the action and the delay, so the fixed sentence is not the only description.
    expect(authorizationScope({ endAction: 'SHUTDOWN', finalDelaySeconds: 60 }, 'campaign')).toBe(
      'This allows NEXUS to shut down this PC 60 s after the campaign ends, in the cases ticked above. You can cancel it while NEXUS counts down.',
    )
    expect(authorizationScope({ endAction: 'HIBERNATE', finalDelaySeconds: 30 })).toContain('hibernate this PC 30 s after the run ends')
    expect(authorizationScope({ endAction: 'NONE', finalDelaySeconds: 60 })).toMatch(/takes no power action/)
  })
})
