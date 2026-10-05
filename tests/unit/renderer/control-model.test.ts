import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTROL_LIMITS, ScheduleInputSchema, type GlobalWorkItem, type Schedule } from '@shared/control-plane'
import { actionLine, capacityLine, EMPTY_SCHEDULE_FORM, HEALTH_LABEL, itemActions, itemLine, scheduleInput, scheduleLine, STATE_LABEL, validateScheduleForm } from '../../../src/renderer/src/views/control/controlModel'

const item = (over: Partial<GlobalWorkItem> = {}): GlobalWorkItem => ({ id: 'i', type: 'program', refId: 'p', title: 'Program', priority: 'P2', position: 1, state: 'QUEUED', requestedAgents: 2, deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false, payload: null, detail: null, createdAt: '', updatedAt: '', startedAt: null, finishedAt: null, ...over })

describe('control center model', () => {
  it('says how the capacity is used, and that nothing starts during a usage wait', () => {
    const base = { agents: { active: 5, max: 6 }, active: [item(), item()] as never, limits: DEFAULT_CONTROL_LIMITS }
    expect(capacityLine({ ...base, claudeAvailable: true })).toBe('5 of 6 agents in use · 2 of 4 workloads running')
    expect(capacityLine({ ...base, claudeAvailable: false })).toContain('nothing new starts')
    expect(itemLine({ ...item({ type: 'arena' }), activeAgents: 1, allowance: 2 })).toBe('Arena campaign · 1 agent running, may hold 2')
    expect(itemLine(item({ type: 'workspace_mission' }))).toBe('Workspace mission')
  })

  it('offers only the actions that apply to an item', () => {
    expect(itemActions(item())).toEqual({ pause: true, resume: false, cancel: true, reorder: true })
    expect(itemActions(item({ state: 'RUNNING' }))).toEqual({ pause: true, resume: false, cancel: true, reorder: false })
    expect(itemActions(item({ state: 'PAUSED', heldByUser: true }))).toEqual({ pause: false, resume: true, cancel: true, reorder: true })
    expect(itemActions(item({ state: 'BLOCKED' }))).toEqual({ pause: false, resume: false, cancel: true, reorder: false })
    expect(itemActions(item({ state: 'SCHEDULED' }))).toMatchObject({ pause: false, resume: false, cancel: true })
    // A background job cannot be paused.
    expect(itemActions(item({ type: 'scheduled_audit', state: 'RUNNING' })).pause).toBe(false)
    for (const state of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) expect(itemActions(item({ state }))).toEqual({ pause: false, resume: false, cancel: false, reorder: false })
  })

  it('has a label for every state and every health level', () => {
    for (const state of ['QUEUED', 'READY', 'RUNNING', 'PAUSED', 'QUOTA_WAIT', 'BLOCKED', 'SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const) expect(STATE_LABEL[state].label.length).toBeGreaterThan(0)
    expect(HEALTH_LABEL.HEALTHY).toEqual({ tone: 'success', label: 'Runtime healthy' })
    expect(HEALTH_LABEL.BLOCKED.tone).toBe('danger')
    expect(STATE_LABEL.QUOTA_WAIT.label).toBe('Waiting for usage')
  })

  it('describes schedules and builds a valid schedule from the form', () => {
    const now = new Date(2026, 9, 5, 21, 0, 0)
    const schedule: Schedule = { id: 's', name: 'Nightly', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'p1' }, priority: 'P1', enabled: true, nextRunAt: new Date(2026, 9, 5, 22, 0, 0).toISOString(), lastRunAt: null, lastResult: null, createdAt: '', updatedAt: '' }
    expect(scheduleLine(schedule, now)).toContain('Every day at 22:00 · next today')
    expect(scheduleLine({ ...schedule, enabled: false }, now)).toBe('Every day at 22:00 · off')
    expect(scheduleLine({ ...schedule, rule: { kind: 'weekly', day: 'sunday', time: '03:00' }, nextRunAt: new Date(2026, 9, 11, 3, 0, 0).toISOString() }, now)).toContain('Every Sunday at 03:00 · next')
    expect(scheduleLine({ ...schedule, nextRunAt: null }, now)).toContain('no further run')
    expect(actionLine(schedule.action, { program: 'RaceDeck' })).toBe('Continue the program "RaceDeck"')
    expect(actionLine({ type: 'scheduled_audit', projectId: 'x', kind: 'dependency_audit' }, {})).toBe('Run a dependency audit')

    expect(validateScheduleForm(EMPTY_SCHEDULE_FORM)).toMatchObject({ ok: false, errors: { name: expect.any(String), programId: expect.any(String) } })
    expect(validateScheduleForm({ ...EMPTY_SCHEDULE_FORM, name: 'x', programId: 'p', time: '25:00' }).errors.time).toContain('HH:MM')
    const form = { ...EMPTY_SCHEDULE_FORM, name: '  Nightly  ', programId: 'p1', kind: 'weekly' as const, day: 'sunday' as const, time: '03:00', priority: 'P1' as const }
    expect(validateScheduleForm(form).ok).toBe(true)
    const input = scheduleInput(form)
    expect(input).toEqual({ name: 'Nightly', rule: { kind: 'weekly', day: 'sunday', time: '03:00' }, action: { type: 'program', programId: 'p1' }, priority: 'P1', enabled: true })
    expect(ScheduleInputSchema.safeParse(input).success).toBe(true)
    expect(ScheduleInputSchema.safeParse(scheduleInput({ ...form, kind: 'daily' })).success).toBe(true)
  })
})
