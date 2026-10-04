import { describe, expect, it } from 'vitest'
import {
  decidePowerAction,
  decideQuota,
  DEFAULT_OVERNIGHT_POLICY,
  MAX_QUOTA_WAITS,
  normalizeEpochMs,
  outcomeLabel,
  OVERNIGHT_CONFIRMATION_TEXT,
  OvernightPolicySchema,
  QUOTA_RESUME_MARGIN_SECONDS,
  TERMINAL_REASONS,
  toStatus,
  type OvernightPolicy,
  type OvernightRun,
} from '@shared/overnight'
import { buildTrayModel, closeBehaviour } from '@main/modules/overnight/tray-model'

const NOW = '2026-10-04T22:15:00.000Z'

function record(overrides: Partial<OvernightRun> = {}, policy: Partial<OvernightPolicy> = {}): OvernightRun {
  const p = { ...DEFAULT_OVERNIGHT_POLICY, ...policy }
  return {
    id: 'run-1',
    runId: 'run-1',
    workloadType: 'mission',
    projectId: 'p1',
    state: 'RUNNING',
    policy: p,
    authorization: { runId: 'run-1', authorizedAt: NOW, confirmation: OVERNIGHT_CONFIRMATION_TEXT, policy: p },
    startedAt: NOW,
    deadlineAt: '2026-10-05T06:15:00.000Z',
    failsafe: null,
    terminalReason: null,
    terminalDetail: null,
    finalReport: null,
    reportPath: null,
    reportSavedAt: null,
    powerAction: null,
    quota: null,
    watchdog: [],
    amendments: [],
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  }
}

describe('decidePowerAction: the gate in front of every power action', () => {
  it('allows the configured action for every reason the default policy covers', () => {
    for (const reason of ['SUCCESS', 'FAILED', 'BLOCKED', 'QUOTA_EXHAUSTED', 'TIME_LIMIT'] as const) {
      expect(decidePowerAction(record(), 'run-1', reason)).toEqual({ action: 'SHUTDOWN', reason })
    }
    expect(decidePowerAction(record(), 'run-1', 'USER_CANCELLED')).toMatchObject({ action: null })
  })

  it('denies without an overnight record', () => {
    expect(decidePowerAction(null, 'run-1', 'SUCCESS')).toMatchObject({ action: null })
  })

  it('denies when the record or the authorization belongs to another run', () => {
    expect(decidePowerAction(record(), 'run-2', 'SUCCESS')).toMatchObject({ action: null })
    const foreign = record()
    foreign.authorization = { ...foreign.authorization, runId: 'run-2' }
    expect(decidePowerAction(foreign, 'run-1', 'SUCCESS')).toMatchObject({ action: null, why: expect.stringContaining('another run') })
  })

  it('denies without a stored authorization, timestamp or the exact confirmation', () => {
    expect(decidePowerAction(record({ authorization: null as never }), 'run-1', 'SUCCESS').action).toBeNull()
    const noTime = record()
    noTime.authorization = { ...noTime.authorization, authorizedAt: '' }
    expect(decidePowerAction(noTime, 'run-1', 'SUCCESS').action).toBeNull()
    const wrong = record()
    wrong.authorization = { ...wrong.authorization, confirmation: 'sure' }
    expect(decidePowerAction(wrong, 'run-1', 'SUCCESS').action).toBeNull()
  })

  it('denies when Overnight Mode is not enabled or the stored policy is not valid', () => {
    expect(decidePowerAction(record({}, { enabled: false as never }), 'run-1', 'SUCCESS').action).toBeNull()
    expect(decidePowerAction(record({ policy: { endAction: 'SHUTDOWN' } as never }), 'run-1', 'SUCCESS').action).toBeNull()
    expect(decidePowerAction(record({}, { endAction: 'REBOOT' as never }), 'run-1', 'SUCCESS').action).toBeNull()
  })

  it('denies when the condition for the terminal reason is off, and for end action NONE', () => {
    const conditions = { success: false, failure: false, blocker: false, quotaExhausted: false, timeout: false, cancellation: false }
    for (const reason of TERMINAL_REASONS) expect(decidePowerAction(record({}, { shutdownOn: conditions }), 'run-1', reason).action).toBeNull()
    for (const reason of TERMINAL_REASONS) expect(decidePowerAction(record({}, { endAction: 'NONE' }), 'run-1', reason).action).toBeNull()
    expect(decidePowerAction(record({}, { shutdownOn: { ...conditions, timeout: true }, endAction: 'HIBERNATE' }), 'run-1', 'TIME_LIMIT')).toEqual({ action: 'HIBERNATE', reason: 'TIME_LIMIT' })
  })
})

describe('OvernightPolicySchema', () => {
  it('accepts the defaults, which never force-close applications', () => {
    expect(OvernightPolicySchema.parse(DEFAULT_OVERNIGHT_POLICY)).toEqual(DEFAULT_OVERNIGHT_POLICY)
    expect(DEFAULT_OVERNIGHT_POLICY.forceCloseApplications).toBe(false)
    expect(DEFAULT_OVERNIGHT_POLICY.shutdownOn.cancellation).toBe(false)
  })

  it('requires the failsafe to fire after the mission deadline', () => {
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, failsafeAfterMinutes: 480 }).success).toBe(false)
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, failsafeAfterMinutes: 481 }).success).toBe(true)
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, failsafeEnabled: false, failsafeAfterMinutes: 60 }).success).toBe(true)
  })

  it('rejects unknown keys and out-of-range values', () => {
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, command: 'x' }).success).toBe(false)
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, maxDurationMinutes: 0 }).success).toBe(false)
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, finalDelaySeconds: 5 }).success).toBe(false)
    expect(OvernightPolicySchema.safeParse({ ...DEFAULT_OVERNIGHT_POLICY, budgets: { maxAgentSessions: 0, maxTotalRepairs: 1 } }).success).toBe(false)
  })
})

describe('decideQuota: a usage limit is not a failure', () => {
  const now = Date.parse(NOW)
  const deadline = now + 8 * 3_600_000
  const base = { policy: 'WAIT_AND_RETRY' as const, now, deadline, waits: 0 }

  it('waits until the reset plus a margin when the reset is inside the mission time', () => {
    const resetsAt = now + 30 * 60_000
    expect(decideQuota({ ...base, resetsAt })).toEqual({ action: 'wait', resumeAt: resetsAt + QUOTA_RESUME_MARGIN_SECONDS * 1000 })
  })

  it('a reset time already in the past resumes after the margin', () => {
    expect(decideQuota({ ...base, resetsAt: now - 60_000 })).toEqual({ action: 'wait', resumeAt: now + QUOTA_RESUME_MARGIN_SECONDS * 1000 })
  })

  it('ends the run when the reset is unknown, after the deadline, or the policy says END_RUN', () => {
    expect(decideQuota({ ...base, resetsAt: null }).action).toBe('end')
    expect(decideQuota({ ...base, resetsAt: deadline + 1 }).action).toBe('end')
    expect(decideQuota({ ...base, resetsAt: deadline - 1000 }).action).toBe('end')
    expect(decideQuota({ ...base, policy: 'END_RUN', resetsAt: now + 1000 }).action).toBe('end')
  })

  it('never waits more than the bounded number of times', () => {
    expect(decideQuota({ ...base, resetsAt: now + 1000, waits: MAX_QUOTA_WAITS - 1 }).action).toBe('wait')
    expect(decideQuota({ ...base, resetsAt: now + 1000, waits: MAX_QUOTA_WAITS }).action).toBe('end')
  })

  it('normalizes SDK reset times given in seconds or milliseconds', () => {
    expect(normalizeEpochMs(1_900_000_000)).toBe(1_900_000_000_000)
    expect(normalizeEpochMs(1_900_000_000_000)).toBe(1_900_000_000_000)
    expect(normalizeEpochMs(null)).toBeNull()
    expect(normalizeEpochMs(0)).toBeNull()
    expect(normalizeEpochMs(Number.NaN)).toBeNull()
  })
})

describe('report outcome labels', () => {
  it('distinguishes partial results from total failures', () => {
    expect(outcomeLabel('SUCCESS', 3, 3)).toBe('SUCCESS')
    expect(outcomeLabel('BLOCKED', 2, 3)).toBe('PARTIAL (BLOCKED)')
    expect(outcomeLabel('BLOCKED', 0, 3)).toBe('BLOCKED')
    expect(outcomeLabel('FAILED', 1, 3)).toBe('PARTIAL (FAILED)')
    expect(outcomeLabel('FAILED', 0, 0)).toBe('FAILED')
    expect(outcomeLabel('TIME_LIMIT', 1, 3)).toBe('TIMEOUT')
    expect(outcomeLabel('QUOTA_EXHAUSTED', 1, 3)).toBe('QUOTA_EXHAUSTED')
  })
})

describe('tray model and window close behaviour', () => {
  const time = (iso: string): string => iso.slice(11, 16)
  const failsafe = {
    scheduledAt: NOW,
    deadline: '2026-10-05T06:42:00.000Z',
    result: { ok: true, exitCode: 0, output: '', executable: 'x', args: [], at: NOW },
    cancelledAt: null,
    cancelResult: null,
    lostAt: null,
  }
  const input = (overnight: OvernightRun | null, runState: string | null = 'executing', activeAgents = 3): Parameters<typeof buildTrayModel>[0] => ({
    overnight: overnight ? toStatus(overnight) : null,
    projectName: 'shop',
    runState,
    activeAgents,
    time,
  })

  it('there is no tray icon without a live overnight mission', () => {
    expect(buildTrayModel(input(null)).visible).toBe(false)
    for (const state of ['DONE', 'FINALIZATION_FAILED', 'POWER_ACTION_FAILED', 'IDLE'] as const) {
      expect(buildTrayModel(input(record({ state }))).visible).toBe(false)
    }
  })

  it('RUNNING: shows the agents and the shutdown time, with all four actions', () => {
    const model = buildTrayModel(input(record({ failsafe })))
    expect(model).toMatchObject({ visible: true, status: 'RUNNING', runId: 'run-1' })
    expect(model.lines).toEqual(['NEXUS', 'Overnight mission running', '3 agents active', 'Shutdown scheduled 06:42'])
    expect(model.tooltip).toContain('shop')
    expect(model.tooltip).toContain('06:42')
    expect(model.tooltip.length).toBeLessThanOrEqual(127)
    expect(model.items.map((i) => [i.label, i.enabled])).toEqual([
      ['Open NEXUS', true],
      ['Pause', true],
      ['Cancel shutdown', true],
      ['Cancel mission', true],
    ])
  })

  it('PAUSED: a user pause offers Resume; a quota pause explains itself', () => {
    const paused = buildTrayModel(input(record({ failsafe }), 'paused', 0))
    expect(paused.status).toBe('PAUSED')
    expect(paused.items[1]).toMatchObject({ action: 'resume', label: 'Resume', enabled: true })
    const quota = buildTrayModel(input(record({ state: 'QUOTA_PAUSED', failsafe }), 'paused', 0))
    expect(quota.status).toBe('PAUSED')
    expect(quota.lines[1]).toMatch(/usage limit/)
    expect(quota.items[1]).toMatchObject({ action: 'pause', enabled: false })
  })

  it('FINALIZING: nothing but Open is offered', () => {
    const model = buildTrayModel(input(record({ state: 'FINALIZING', failsafe })))
    expect(model.status).toBe('FINALIZING')
    expect(model.items.filter((i) => i.enabled).map((i) => i.action)).toEqual(['open'])
  })

  it('SHUTDOWN SCHEDULED: shows the time and still lets the user cancel', () => {
    const powerAction = { action: 'SHUTDOWN' as const, reason: 'SUCCESS' as const, scheduledAt: NOW, executeAt: '2026-10-05T03:01:00.000Z', forced: true, mechanism: 'os_timer' as const, result: null, executedAt: null, cancelledAt: null }
    const model = buildTrayModel(input(record({ state: 'POWER_ACTION_SCHEDULED', powerAction }), 'completed', 0))
    expect(model.status).toBe('SHUTDOWN SCHEDULED')
    expect(model.lines).toContain('Shutdown scheduled 03:01')
    expect(model.items.find((i) => i.action === 'cancelPower')?.enabled).toBe(true)
    expect(model.items.find((i) => i.action === 'cancelMission')?.enabled).toBe(false)
  })

  it('with no power action and no failsafe, Cancel shutdown is disabled', () => {
    const model = buildTrayModel(input(record({}, { endAction: 'NONE' })))
    expect(model.lines).toContain('No power action')
    expect(model.items.find((i) => i.action === 'cancelPower')?.enabled).toBe(false)
  })

  it('closing the window asks only while an overnight mission is active', () => {
    expect(closeBehaviour(true)).toBe('ask')
    expect(closeBehaviour(false)).toBe('close')
  })
})
