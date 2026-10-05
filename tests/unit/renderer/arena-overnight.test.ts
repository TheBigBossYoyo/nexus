import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { ipcInputs } from '../../../src/shared/ipc'
import {
  DEFAULT_OVERNIGHT_POLICY,
  OVERNIGHT_CONFIRMATION_TEXT,
  type OvernightStatus,
} from '../../../src/shared/overnight'
import {
  EMPTY_USAGE_TOTALS,
  unknownValue,
  type UsageOverview,
  type UsageStatus,
} from '../../../src/shared/v3'
import { defaultOvernightForm } from '../../../src/renderer/src/views/projects/overnight'
import {
  OVERNIGHT_BUSY_TEXT,
  activeTrialCount,
  arenaOvernightReadiness,
  buildArenaOvernightInput,
  overnightBusy,
  trialProgressText,
  usageResetText,
  validateArenaOvernight,
} from '../../../src/renderer/src/views/arena/arenaOvernight'
import {
  QUOTA_NO_RESET_TEXT,
  cancelCopy,
  deadlineLabel,
  endActionSummary,
  isArenaWorkload,
  overnightFinished,
  quotaDetail,
  workloadKind,
  workloadNoun,
} from '../../../src/renderer/src/views/overnight/workloadModel'
import {
  overnightPageModel,
  quotaLines,
} from '../../../src/renderer/src/views/overnight/overnightPageModel'
import { bannerModel } from '../../../src/renderer/src/views/run/overnightModel'
import { createPushHandler } from '../../../src/renderer/src/lib/push'
import { qk } from '../../../src/renderer/src/lib/queries'

const NOW = Date.parse('2026-10-04T03:00:00')

function campaign(patch: Partial<OvernightStatus> = {}): OvernightStatus {
  return {
    id: 'c1',
    runId: 'c1',
    workloadType: 'arena_campaign',
    projectId: 'arena',
    state: 'RUNNING',
    policy: DEFAULT_OVERNIGHT_POLICY,
    authorization: {
      runId: 'c1',
      authorizedAt: '2026-10-04T01:00:00.000Z',
      confirmation: OVERNIGHT_CONFIRMATION_TEXT,
      policy: DEFAULT_OVERNIGHT_POLICY,
    },
    startedAt: '2026-10-04T01:00:00.000Z',
    deadlineAt: '2026-10-04T09:00:00.000Z',
    failsafe: null,
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

const draft = {
  name: '  Swarm vs Build  ',
  caseIds: ['case-1', 'case-2'],
  strategies: ['SINGLE', 'BUILD'] as const,
  repetitions: 2,
  modelPreset: 'balanced' as const,
  budgetPreset: 'balanced' as const,
}

describe('Arena overnight start input', () => {
  it('builds an input the IPC schema accepts, with the explicit authorization', () => {
    const form = { ...defaultOvernightForm(), authorized: true, maxDurationMinutes: 120 }
    const input = buildArenaOvernightInput(form, draft)
    expect(input.confirmed).toBe(true)
    expect(input.confirmation).toBe(OVERNIGHT_CONFIRMATION_TEXT)
    expect(input.campaign).toEqual({
      name: 'Swarm vs Build',
      caseIds: ['case-1', 'case-2'],
      strategies: ['SINGLE', 'BUILD'],
      repetitions: 2,
      modelPreset: 'balanced',
      budgetPreset: 'balanced',
    })
    expect(input.policy.maxDurationMinutes).toBe(120)
    expect(input.policy.failsafeAfterMinutes).toBe(180)
    expect(ipcInputs['overnight.startArena'].safeParse(input).success).toBe(true)
  })

  it('does not require a prompt, and needs the authorization to start', () => {
    const f = defaultOvernightForm()
    const v = validateArenaOvernight(f)
    expect(v.errors.prompt).toBeUndefined()
    expect(v.policyValid).toBe(true)
    expect(v.canStart).toBe(false)
    expect(v.errors.authorization).toBeTruthy()
    expect(validateArenaOvernight({ ...f, authorized: true }).canStart).toBe(true)
  })

  it('rejects an invalid policy even when authorized', () => {
    const f = { ...defaultOvernightForm(), authorized: true, maxDurationMinutes: 0 }
    const v = validateArenaOvernight(f)
    expect(v.canStart).toBe(false)
    expect(v.errors.duration).toBeTruthy()
  })

  it('blocks when another overnight workload is active', () => {
    expect(overnightBusy(undefined)).toBeNull()
    expect(overnightBusy([])).toBeNull()
    expect(overnightBusy([campaign()])).toBe(OVERNIGHT_BUSY_TEXT)
  })

  it('explains what is missing before it is ready', () => {
    const f = defaultOvernightForm()
    const ok = validateArenaOvernight({ ...f, authorized: true })
    expect(arenaOvernightReadiness(ok, null, OVERNIGHT_BUSY_TEXT)).toBe(OVERNIGHT_BUSY_TEXT)
    expect(arenaOvernightReadiness(ok, 'Pick at least one case.', null)).toBe(
      'Pick at least one case.',
    )
    expect(arenaOvernightReadiness(validateArenaOvernight(f), null, null)).toMatch(/authorization/i)
    expect(arenaOvernightReadiness(ok, null, null)).toMatch(/^Ready/)
  })
})

describe('campaign progress helpers', () => {
  it('counts trials that hold a worker', () => {
    expect(
      activeTrialCount({ queued: 4, provisioning: 1, running: 2, evaluating: 1, passed: 3 }),
    ).toBe(4)
    expect(activeTrialCount({})).toBe(0)
  })

  it('words progress with a plural', () => {
    expect(trialProgressText(3, 12)).toBe('3 of 12 trials finished')
    expect(trialProgressText(0, 1)).toBe('0 of 1 trial finished')
  })

  it('shows a reset time only when the usage service reported one', () => {
    const exact = <T>(value: T) => ({
      value,
      source: 'RUNTIME' as const,
      confidence: 'EXACT' as const,
    })
    const overview = (status: UsageStatus, patch: Partial<UsageOverview> = {}): UsageOverview => ({
      capturedAt: '2026-10-04T03:00:00.000Z',
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
    })
    expect(usageResetText(null, NOW)).toBeNull()
    expect(usageResetText(overview('AVAILABLE'), NOW)).toBeNull()
    expect(usageResetText(overview('QUOTA_PAUSED'), NOW)).toBe('Not reported')
    const at = new Date('2026-10-04T05:30:00').toISOString()
    expect(usageResetText(overview('QUOTA_PAUSED', { nextResetAt: exact(at) }), NOW)).toBe('05:30')
  })
})

describe('workload-aware overnight wording', () => {
  it('tells a campaign from a mission', () => {
    expect(isArenaWorkload(campaign())).toBe(true)
    expect(isArenaWorkload(campaign({ workloadType: 'mission' }))).toBe(false)
    expect(workloadNoun(campaign())).toBe('campaign')
    expect(workloadKind(campaign())).toBe('Arena campaign')
    expect(workloadKind(campaign({ workloadType: 'mission' }))).toBe('Mission')
    expect(deadlineLabel('campaign')).toBe('Campaign deadline')
    expect(deadlineLabel('mission')).toBe('Mission deadline')
  })

  it('words the cancel confirmation for the workload', () => {
    expect(cancelCopy('campaign').confirmLabel).toBe('Cancel campaign')
    expect(cancelCopy('campaign').body).toMatch(/trials/)
    expect(cancelCopy('mission').confirmLabel).toBe('Cancel mission')
  })

  it('summarizes the end action and its conditions', () => {
    expect(endActionSummary({ ...DEFAULT_OVERNIGHT_POLICY, endAction: 'NONE' })).toMatch(/^None/)
    expect(endActionSummary(DEFAULT_OVERNIGHT_POLICY)).toBe(
      'Shut down PC on success, failure, blocker, quota exhausted, timeout',
    )
    expect(
      endActionSummary({
        ...DEFAULT_OVERNIGHT_POLICY,
        endAction: 'SLEEP',
        shutdownOn: {
          ...DEFAULT_OVERNIGHT_POLICY.shutdownOn,
          success: false,
          failure: false,
          blocker: false,
          quotaExhausted: false,
          timeout: false,
        },
      }),
    ).toBe('Sleep, but no condition applies')
  })

  it('reads a paused campaign without a reset time honestly, never inventing one', () => {
    const s = campaign({
      state: 'QUOTA_PAUSED',
      quota: { pausedAt: '2026-10-04T02:00:00.000Z', resetsAt: null, resumeAt: null, waits: 1 },
    })
    expect(quotaDetail(s, NOW)).toBe(QUOTA_NO_RESET_TEXT)
    expect(bannerModel(s, NOW).detail).toBe(QUOTA_NO_RESET_TEXT)
    const lines = quotaLines(s, NOW)
    expect(lines.map((l) => l.key)).toEqual(['paused', 'noreset', 'deadline'])
    expect(lines[0]?.text).toBe('Campaign paused for Claude usage limit')
  })

  it('shows the reported time for a paused campaign that has one', () => {
    const s = campaign({
      state: 'QUOTA_PAUSED',
      quota: {
        pausedAt: '',
        resetsAt: '2026-10-04T05:00:00.000Z',
        resumeAt: '2026-10-04T05:01:30.000Z',
        waits: 1,
      },
    })
    expect(quotaDetail(s, NOW)).toMatch(/^waiting for the usage limit, resumes /)
    expect(quotaLines(s, NOW).map((l) => l.key)).toEqual(['paused', 'reset', 'resume', 'deadline'])
  })

  it('keeps the mission wording unchanged', () => {
    const m = campaign({ workloadType: 'mission', state: 'QUOTA_PAUSED' })
    expect(quotaDetail(m, NOW)).toBe('waiting for the usage limit')
    expect(quotaLines(m, NOW)[0]?.text).toBe('Mission paused for Claude usage limit')
    expect(overnightPageModel(campaign({ workloadType: 'mission' }), NOW).summary).toMatch(
      /mission is running unattended/,
    )
    expect(overnightPageModel(campaign(), NOW).summary).toMatch(/campaign is running unattended/)
  })

  it('knows which states are finished', () => {
    expect(overnightFinished('DONE')).toBe(true)
    expect(overnightFinished('POWER_ACTION_FAILED')).toBe(true)
    expect(overnightFinished('RUNNING')).toBe(false)
    expect(overnightFinished('POWER_ACTION_SCHEDULED')).toBe(false)
  })
})

describe('overnight push for a campaign', () => {
  it('stores the status under the campaign id', () => {
    const qc = new QueryClient()
    const h = createPushHandler(qc, {
      debounceMs: 10,
      live: { append: () => undefined, clear: () => undefined },
    })
    const s = campaign({ state: 'FINALIZING' })
    h.handle({ kind: 'overnight', status: s })
    expect(qc.getQueryData(qk.overnight('c1'))).toEqual(s)
    h.dispose()
  })
})
