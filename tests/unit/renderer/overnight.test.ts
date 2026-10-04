import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  DEFAULT_OVERNIGHT_POLICY,
  OVERNIGHT_CONFIRMATION_TEXT,
  OvernightPolicySchema,
  type OvernightStatus,
} from '../../../src/shared/overnight'
import { ipcInputs } from '../../../src/shared/ipc'
import {
  authorizationSentence,
  buildOvernightStartInput,
  buildPolicy,
  defaultOvernightForm,
  effectiveFailsafeMinutes,
  formatMinutes,
  formatWallClock,
  joinMinutes,
  resolvePlanning,
  splitMinutes,
  summarizeOvernight,
  validateOvernight,
  type OvernightForm,
} from '../../../src/renderer/src/views/projects/overnight'
import {
  bannerEnablement,
  bannerModel,
  failsafeText,
  formatCountdown,
  powerCountdown,
} from '../../../src/renderer/src/views/run/overnightModel'
import { createPushHandler } from '../../../src/renderer/src/lib/push'
import { qk } from '../../../src/renderer/src/lib/queries'

const form = (patch: Partial<OvernightForm> = {}): OvernightForm => ({ ...defaultOvernightForm(), ...patch })

describe('overnight form to policy', () => {
  it('starts from the defaults, unauthorized, with force close off', () => {
    const f = defaultOvernightForm()
    expect(f.authorized).toBe(false)
    expect(f.forceCloseApplications).toBe(false)
    expect(buildPolicy(f)).toEqual({
      ...DEFAULT_OVERNIGHT_POLICY,
      failsafeAfterMinutes: DEFAULT_OVERNIGHT_POLICY.maxDurationMinutes + 60,
    })
  })

  it('keeps the failsafe at duration + 60 until the user edits it', () => {
    const f = form({ maxDurationMinutes: 90 })
    expect(effectiveFailsafeMinutes(f)).toBe(150)
    expect(buildPolicy(f).failsafeAfterMinutes).toBe(150)
    expect(effectiveFailsafeMinutes(form({ maxDurationMinutes: 90, failsafeAfterMinutes: 100 }))).toBe(100)
  })

  it('produces a policy main accepts and a start request the IPC schema accepts', () => {
    const f = form({ maxDurationMinutes: 1, maxAgents: 3, planning: 'consensus', endAction: 'HIBERNATE', authorized: true })
    expect(OvernightPolicySchema.safeParse(buildPolicy(f)).success).toBe(true)
    const input = buildOvernightStartInput(f, 'p1', '  do it  ')
    expect(input).toMatchObject({
      projectId: 'p1',
      prompt: 'do it',
      confirmed: true,
      confirmation: OVERNIGHT_CONFIRMATION_TEXT,
      maxParallelAgents: 3,
      planningMode: 'consensus',
    })
    expect(ipcInputs['overnight.start'].safeParse(input).success).toBe(true)
  })

  it('omits maxParallelAgents when following the preset and resolves auto planning', () => {
    const input = buildOvernightStartInput(form({ recommendedPlanning: 'consensus' }), 'p1', 'x')
    expect('maxParallelAgents' in input).toBe(false)
    expect(input.planningMode).toBe('consensus')
    expect(resolvePlanning({ planning: 'auto', recommendedPlanning: null })).toBe('single')
    expect(resolvePlanning({ planning: 'single', recommendedPlanning: 'consensus' })).toBe('single')
  })
})

describe('overnight validation', () => {
  it('requires the authorization box and a prompt', () => {
    expect(validateOvernight(form(), 'go').canStart).toBe(false)
    expect(validateOvernight(form({ authorized: true }), 'go').canStart).toBe(true)
    expect(validateOvernight(form({ authorized: true }), '  ').canStart).toBe(false)
  })

  it('rejects a failsafe that is not greater than the duration', () => {
    const v = validateOvernight(form({ authorized: true, maxDurationMinutes: 60, failsafeAfterMinutes: 60 }), 'go')
    expect(v.errors.failsafe).toMatch(/greater than the max duration/)
    expect(v.canStart).toBe(false)
    expect(validateOvernight(form({ authorized: true, maxDurationMinutes: 60, failsafeAfterMinutes: 61 }), 'go').canStart).toBe(true)
  })

  it('ignores the failsafe relation when the failsafe is disabled', () => {
    const f = form({ authorized: true, maxDurationMinutes: 60, failsafeAfterMinutes: 5, failsafeEnabled: false })
    expect(validateOvernight(f, 'go').canStart).toBe(true)
  })

  it('bounds numbers', () => {
    expect(validateOvernight(form({ maxDurationMinutes: 0 }), 'x').errors.duration).toBeDefined()
    expect(validateOvernight(form({ maxDurationMinutes: 25 * 60 }), 'x').errors.duration).toBeDefined()
    expect(validateOvernight(form({ maxAgents: 17 }), 'x').errors.maxAgents).toBeDefined()
    expect(validateOvernight(form({ maxRepairs: 0 }), 'x').errors.maxRepairs).toBeDefined()
    expect(validateOvernight(form({ finalDelaySeconds: 5 }), 'x').errors.finalDelay).toBeDefined()
  })
})

describe('overnight formatting and summary', () => {
  it('splits and joins minutes', () => {
    expect(splitMinutes(135)).toEqual({ hours: 2, minutes: 15 })
    expect(joinMinutes(2, 15)).toBe(135)
    expect(formatMinutes(540)).toBe('9 h')
    expect(formatMinutes(95)).toBe('1 h 35 min')
    expect(formatMinutes(5)).toBe('5 min')
  })

  it('formats wall clock times with a day hint', () => {
    const now = new Date(2026, 5, 10, 22, 0).getTime()
    expect(formatWallClock(new Date(2026, 5, 10, 23, 5).getTime(), now)).toBe('23:05')
    expect(formatWallClock(new Date(2026, 5, 11, 6, 30).getTime(), now)).toBe('06:30 tomorrow')
    expect(formatWallClock('not a date', now)).toBe('—')
  })

  it('words the authorization sentence per end action', () => {
    expect(authorizationSentence('SHUTDOWN')).toBe('This run is authorized to shut down Windows automatically.')
    expect(authorizationSentence('SLEEP')).toBe('This run is authorized to put Windows to sleep automatically.')
    expect(authorizationSentence('HIBERNATE')).toBe('This run is authorized to hibernate Windows automatically.')
    expect(authorizationSentence('NONE')).toMatch(/no power action/)
  })

  it('summarizes the run, failsafe and force close', () => {
    const now = new Date(2026, 5, 10, 22, 0).getTime()
    const lines = summarizeOvernight(form({ maxDurationMinutes: 480, forceCloseApplications: true }), now)
    const text = lines.join('\n')
    expect(text).toContain('Max duration: 8 h (until 06:00 tomorrow)')
    expect(text).toContain('Failsafe shutdown: 07:00 tomorrow (in 9 h)')
    expect(text).toContain('Force close applications: yes')
    expect(text).toMatch(/On success: shut down pc after 60 s/)
    expect(text).toMatch(/On cancellation: leave the PC running/)
    expect(text).toMatch(/On quota exhausted: wait for the limit/)
    expect(lines.at(-1)).toBe('This run is authorized to shut down Windows automatically.')
  })

  it('says no power action is taken for NONE', () => {
    const lines = summarizeOvernight(form({ endAction: 'NONE', failsafeEnabled: false }))
    expect(lines.at(-1)).toMatch(/no power action/)
    expect(lines.join('\n')).toContain('On success: no power action')
    expect(lines.join('\n')).toContain('Failsafe shutdown: not armed (no power action)')
    // Also when the failsafe box is still ticked: main arms no timer for an end action of NONE.
    expect(summarizeOvernight(form({ endAction: 'NONE', failsafeEnabled: true })).join('\n')).toContain('Failsafe shutdown: not armed')
  })
})

type PowerAction = NonNullable<OvernightStatus['powerAction']>
const pendingAction = (executeAt: string, patch: Partial<PowerAction> = {}): PowerAction => ({
  action: 'SHUTDOWN',
  reason: 'SUCCESS',
  scheduledAt: 'x',
  executeAt,
  forced: false,
  mechanism: 'os_timer',
  result: null,
  executedAt: null,
  cancelledAt: null,
  ...patch,
})

function status(patch: Partial<OvernightStatus> = {}): OvernightStatus {
  const ok = { ok: true, exitCode: 0, output: '', executable: 'shutdown', args: [], at: '2026-06-10T22:00:00.000Z' }
  return {
    id: 'r1',
    runId: 'r1',
    projectId: 'p1',
    state: 'RUNNING',
    policy: DEFAULT_OVERNIGHT_POLICY,
    authorization: {
      runId: 'r1',
      authorizedAt: '2026-06-10T22:00:00.000Z',
      confirmation: OVERNIGHT_CONFIRMATION_TEXT,
      policy: DEFAULT_OVERNIGHT_POLICY,
    },
    startedAt: '2026-06-10T22:00:00.000Z',
    deadlineAt: '2026-06-11T06:00:00.000Z',
    failsafe: {
      scheduledAt: '2026-06-10T22:00:00.000Z',
      deadline: '2026-06-11T07:00:00.000Z',
      result: ok,
      cancelledAt: null,
      cancelResult: null,
      lostAt: null,
    },
    terminalReason: null,
    terminalDetail: null,
    reportPath: null,
    reportSavedAt: null,
    powerAction: null,
    quota: null,
    watchdog: [],
    amendments: [],
    error: null,
    createdAt: '',
    updatedAt: '',
    finishedAt: null,
    hasReport: false,
    ...patch,
  }
}

describe('overnight banner model', () => {
  const now = Date.parse('2026-06-10T22:30:00.000Z')

  it('formats countdowns', () => {
    expect(formatCountdown(42_000)).toBe('0:42')
    expect(formatCountdown(61_001)).toBe('1:02')
    expect(formatCountdown(3_725_000)).toBe('1:02:05')
    expect(formatCountdown(-5000)).toBe('0:00')
  })

  it('describes the failsafe in every condition', () => {
    const base = status()
    const f = base.failsafe as NonNullable<OvernightStatus['failsafe']>
    expect(failsafeText(base, now)).toMatch(/^\d\d:\d\d/)
    expect(failsafeText(status({ failsafe: { ...f, cancelledAt: 'x' } }), now)).toBe('cancelled')
    expect(failsafeText(status({ failsafe: { ...f, lostAt: 'x' } }), now)).toBe('lost (Windows restarted)')
    expect(failsafeText(status({ failsafe: { ...f, result: { ...f.result, ok: false } } }), now)).toBe('not armed')
    expect(failsafeText(status({ failsafe: null }), now)).toBe('not armed')
    const off = status({ failsafe: null, policy: { ...DEFAULT_OVERNIGHT_POLICY, failsafeEnabled: false } })
    expect(failsafeText(off, now)).toBe('off')
  })

  it('shows the quota wait with the resume time', () => {
    const m = bannerModel(
      status({ state: 'QUOTA_PAUSED', quota: { pausedAt: 'x', resetsAt: null, resumeAt: '2026-06-10T23:15:00.000Z', waits: 1 } }),
      now,
    )
    expect(m.state).toBe('QUOTA_PAUSED')
    expect(m.detail).toMatch(/waiting for the usage limit, resumes \d\d:\d\d/)
  })

  it('shows a live countdown only for a pending power action', () => {
    const pending = status({ state: 'POWER_ACTION_SCHEDULED', powerAction: pendingAction(new Date(now + 42_000).toISOString()) })
    expect(powerCountdown(pending, now)).toBe('Shutting down in 0:42')
    expect(bannerModel(pending, now).endAction).toBe('SHUT DOWN PC')
    const cancelled = status({
      state: 'POWER_ACTION_SCHEDULED',
      powerAction: pendingAction(new Date(now + 42_000).toISOString(), { cancelledAt: 'x' }),
    })
    expect(powerCountdown(cancelled, now)).toBeNull()
    expect(powerCountdown(status(), now)).toBeNull()
  })

  it('shows the error in the failed states', () => {
    expect(bannerModel(status({ state: 'POWER_ACTION_FAILED', error: 'Access denied' }), now).detail).toBe('Access denied')
    expect(bannerModel(status({ state: 'FINALIZATION_FAILED', error: null }), now).detail).toBe('failed')
  })

  it('enables each action only where the supervisor accepts it', () => {
    const e = (patch: Partial<OvernightStatus>) => bannerEnablement(status(patch))
    expect(e({ state: 'RUNNING' })).toEqual({ canCancelPower: true, canChangeEndAction: true, canExtend: true, canCancelMission: true })
    expect(e({ state: 'QUOTA_PAUSED' }).canExtend).toBe(true)
    const none = { ...DEFAULT_OVERNIGHT_POLICY, endAction: 'NONE' as const }
    expect(e({ state: 'RUNNING', policy: none, failsafe: null }).canCancelPower).toBe(false)
    const scheduled = status({ state: 'POWER_ACTION_SCHEDULED', powerAction: pendingAction('y') })
    expect(bannerEnablement(scheduled)).toEqual({
      canCancelPower: true,
      canChangeEndAction: false,
      canExtend: false,
      canCancelMission: false,
    })
    expect(e({ state: 'POWER_ACTION_FAILED' }).canCancelPower).toBe(true)
    expect(e({ state: 'FINALIZATION_FAILED', failsafe: null }).canCancelPower).toBe(false)
    for (const state of ['FINALIZING', 'DONE', 'CANCELLING'] as const) {
      expect(e({ state })).toEqual({ canCancelPower: false, canChangeEndAction: false, canExtend: false, canCancelMission: false })
    }
  })
})

describe('overnight push', () => {
  it('writes the pushed status straight into the query cache', () => {
    const qc = new QueryClient()
    const h = createPushHandler(qc, { debounceMs: 10, live: { append: () => undefined, clear: () => undefined } })
    const s = status({ state: 'QUOTA_PAUSED' })
    h.handle({ kind: 'overnight', status: s })
    expect(qc.getQueryData(qk.overnight('r1'))).toEqual(s)
    h.dispose()
  })
})
