import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTROL_LIMITS, ScheduleInputSchema, type GlobalWorkItem, type Schedule } from '@shared/control-plane'
import { friendlyError, headerBadge, holdHelp, ownPage, resumeLabel, runtimeIndicator, stateLabel, WAITING_FALLBACK, loadSentence, actionLine, cancelConfirmation, cancelLabel, CANCEL_PRESERVATION, capacityLine, describeError, EMPTY_SCHEDULE_FORM, hasStarted, HEALTH_LABEL, HOLD_LABEL, inspectorOf, isStarting, itemActions, itemLine, itemPresentation, loadState, queueAnnouncement, RELEASE_LABEL, scheduleDeleteConfirmation, scheduleInput, scheduleLine, STARTING_WINDOW_MS, STATE_LABEL, validateScheduleForm } from '../../../src/renderer/src/views/control/controlModel'

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

    expect(validateScheduleForm(EMPTY_SCHEDULE_FORM)).toMatchObject({ ok: false, errors: { name: expect.any(String), targetId: expect.any(String) } })
    expect(validateScheduleForm({ ...EMPTY_SCHEDULE_FORM, name: 'x', targetId: 'p', time: '25:00' }).errors.time).toContain('HH:MM')
    const form = { ...EMPTY_SCHEDULE_FORM, name: '  Nightly  ', targetId: 'p1', kind: 'weekly' as const, day: 'sunday' as const, time: '03:00', priority: 'P1' as const }
    expect(validateScheduleForm(form).ok).toBe(true)
    const input = scheduleInput(form)
    expect(input).toEqual({ name: 'Nightly', rule: { kind: 'weekly', day: 'sunday', time: '03:00' }, action: { type: 'program', programId: 'p1' }, priority: 'P1', enabled: true })
    expect(ScheduleInputSchema.safeParse(input).success).toBe(true)
    expect(ScheduleInputSchema.safeParse(scheduleInput({ ...form, kind: 'daily' })).success).toBe(true)
  })

  it('builds a schedule for every action type the channel allows', () => {
    const base = { ...EMPTY_SCHEDULE_FORM, name: 'N', targetId: 't1' }
    const cases = [
      [{ actionType: 'program' as const }, { type: 'program', programId: 't1' }],
      [{ actionType: 'arena' as const }, { type: 'arena', campaignId: 't1' }],
      [{ actionType: 'workspace_mission' as const }, { type: 'workspace_mission', missionId: 't1' }],
      [{ actionType: 'scheduled_audit' as const, auditKind: 'architecture_audit' as const }, { type: 'scheduled_audit', projectId: 't1', kind: 'architecture_audit' }],
    ] as const
    for (const [over, action] of cases) {
      const input = scheduleInput({ ...base, ...over, priority: 'P0' })
      expect(input.action).toEqual(action)
      expect(input.priority).toBe('P0')
      expect(ScheduleInputSchema.safeParse(input).success).toBe(true)
    }
    expect(validateScheduleForm({ ...base, actionType: 'arena', targetId: '' }).errors.targetId).toContain('campaign')
  })

  it('uses one verb pair for hold and release', () => {
    expect([HOLD_LABEL, RELEASE_LABEL]).toEqual(['Hold', 'Release'])
  })

  describe('cancel confirmation', () => {
    it('a never-started item is removed without a question and says Remove', () => {
      for (const state of ['QUEUED', 'READY', 'SCHEDULED'] as const) {
        expect(hasStarted(item({ state }))).toBe(false)
        expect(cancelConfirmation(item({ state }))).toBeNull()
        expect(cancelLabel(item({ state }))).toBe('Remove')
      }
      // Held before it ever started: still only a queue entry.
      expect(cancelConfirmation(item({ state: 'PAUSED', heldByUser: true }))).toBeNull()
    })

    it('anything that started asks, including paused, blocked and waiting-for-usage items', () => {
      for (const state of ['RUNNING', 'QUOTA_WAIT', 'BLOCKED'] as const) expect(cancelConfirmation(item({ state }))).not.toBeNull()
      // Paused by the system, or held after it ran.
      expect(cancelConfirmation(item({ state: 'PAUSED', heldByUser: false }))).not.toBeNull()
      expect(cancelConfirmation(item({ state: 'PAUSED', heldByUser: true, startedAt: '2026-01-01T00:00:00Z' }))).not.toBeNull()
      // A queued item that has a start time ran before.
      expect(cancelConfirmation(item({ state: 'QUEUED', startedAt: '2026-01-01T00:00:00Z' }))).not.toBeNull()
      expect(cancelLabel(item({ state: 'RUNNING' }))).toBe('Cancel')
    })

    it('names the workload, the type and the running sessions, and says they are stopped, not drained', () => {
      const c = cancelConfirmation({ ...item({ state: 'RUNNING', type: 'arena', title: 'Nightly campaign' }), activeAgents: 3, allowance: 3 })
      expect(c?.title).toContain('Nightly campaign')
      expect(c?.lines.join(' ')).toContain('Arena campaign')
      expect(c?.lines.join(' ')).toContain('3 running agent sessions will be stopped at once')
      expect(c?.lines.join(' ')).toContain('not allowed to finish')
      expect(c?.lines.join(' ')).toContain('cannot be resumed')
      expect(c?.confirmLabel).toBe('Cancel workload')
      expect(c?.keepLabel).toBe('Keep it running')
      expect(cancelConfirmation({ ...item({ state: 'RUNNING' }), activeAgents: 1, allowance: 1 })?.lines.join(' ')).toContain('1 running agent session will be stopped')
      expect(cancelConfirmation({ ...item({ state: 'RUNNING' }), activeAgents: 0, allowance: 1 })?.lines.join(' ')).toContain('No agent session is running at this moment')
      // A paused or blocked item does not claim a count it cannot know.
      expect(cancelConfirmation(item({ state: 'BLOCKED' }))?.lines.join(' ')).toContain('Any agent session it is running is stopped at once')
    })

    it('states what is kept per workload type, and never claims a worktree is deleted', () => {
      for (const type of ['mission', 'program', 'arena', 'workspace_mission', 'background_job', 'scheduled_audit'] as const) {
        const c = cancelConfirmation(item({ type, state: 'RUNNING' }))
        expect(c?.preserved).toBe(CANCEL_PRESERVATION[type])
        expect(c?.preserved.length).toBeGreaterThan(0)
        expect(c?.preserved.join(' ')).not.toMatch(/(is|are|will be) (deleted|removed|discarded)/i)
      }
      expect(CANCEL_PRESERVATION.mission.join(' ')).toContain('does not delete')
      expect(CANCEL_PRESERVATION.program.join(' ')).toContain('Milestones that already completed keep their work')
      expect(CANCEL_PRESERVATION.arena.join(' ')).toContain('already finished keep their results')
      expect(CANCEL_PRESERVATION.workspace_mission.join(' ')).toContain('already completed keep their work')
      expect(CANCEL_PRESERVATION.scheduled_audit.join(' ')).toContain('no findings')
    })
  })

  it('deleting a schedule always asks, and says that work it already queued stays', () => {
    const schedule = { id: 's1', name: 'Nightly', enabled: true }
    const none = scheduleDeleteConfirmation(schedule, [])
    expect(none.title).toContain('Nightly')
    expect(none.confirmLabel).toBe('Delete schedule')
    expect(none.keepLabel).toBe('Keep schedule')
    expect(none.preserved.join(' ')).toContain('No work from this schedule is on the queue')
    const running = scheduleDeleteConfirmation(schedule, [
      { scheduleId: 's1', title: 'Program A', state: 'RUNNING' },
      { scheduleId: 's1', title: 'Old', state: 'COMPLETED' },
      { scheduleId: 'other', title: 'Other', state: 'RUNNING' },
    ])
    expect(running.preserved.join(' ')).toContain('“Program A”')
    expect(running.preserved.join(' ')).toContain('not cancelled')
    expect(running.preserved.join(' ')).not.toContain('Other')
  })

  describe('blocked and failed items', () => {
    it('are never presented like an ordinary queued job', () => {
      const queued = itemPresentation(item({ state: 'QUEUED' }))
      expect(queued).toMatchObject({ emphasis: 'normal', label: 'Queued', reasonLabel: null, hint: null })
      const blocked = itemPresentation({ ...item({ state: 'BLOCKED', type: 'program' }), reason: 'Milestone 2 could not start.' })
      expect(blocked).toMatchObject({ emphasis: 'attention', tone: 'warning', label: 'Blocked', reasonLabel: 'Blocked because', reasonText: 'Milestone 2 could not start.' })
      expect(blocked.hint).toContain('Programs page')
      const failed = itemPresentation(item({ state: 'FAILED', detail: 'The run crashed.' }))
      expect(failed).toMatchObject({ emphasis: 'failure', tone: 'danger', label: 'Failed', reasonLabel: 'Failed because', reasonText: 'The run crashed.' })
      expect(itemPresentation(item({ state: 'BLOCKED' })).reasonText).toBe('No reason was recorded.')
      expect(itemPresentation(item({ state: 'PAUSED', heldByUser: true })).label).toBe('Held')
    })
  })

  describe('load and mutation errors', () => {
    it('is never a permanent loading state', () => {
      expect(loadState({ hasData: false, isError: false, error: null })).toEqual({ kind: 'loading' })
      expect(loadState({ hasData: false, isError: true, error: new Error('Database is locked') })).toEqual({ kind: 'error', message: 'Database is locked', sentence: 'NEXUS could not read the queue from its background runtime.' })
      expect(loadState({ hasData: true, isError: false, error: null })).toEqual({ kind: 'ready', stale: null })
      expect(loadState({ hasData: true, isError: true, error: new Error('timeout') })).toEqual({ kind: 'ready', stale: 'timeout' })
    })

    it('always has some text for an error', () => {
      expect(describeError(new Error('x'))).toBe('x')
      expect(describeError('y')).toBe('y')
      expect(describeError({ message: 'z' })).toBe('z')
      expect(describeError(null).length).toBeGreaterThan(0)
      expect(describeError(new Error('')).length).toBeGreaterThan(0)
    })
  })

  it('reads Starting… for a just-started item with no session yet', () => {
    const now = Date.parse('2026-01-01T00:10:00Z')
    const fresh = { ...item({ state: 'RUNNING', type: 'program', startedAt: '2026-01-01T00:09:40Z' }), activeAgents: 0, allowance: 2 }
    expect(isStarting(fresh, now)).toBe(true)
    expect(itemLine(fresh, now)).toBe('Program · Starting…')
    expect(itemLine({ ...fresh, startedAt: new Date(now - STARTING_WINDOW_MS - 1000).toISOString() }, now)).toBe('Program · 0 agents running, may hold 2')
    expect(itemLine({ ...fresh, detail: 'Waiting for your approval of the plan.' }, now)).toContain('0 agents running')
    expect(itemLine({ ...fresh, activeAgents: 1 }, now)).toBe('Program · 1 agent running, may hold 2')
    expect(isStarting({ ...fresh, state: 'QUEUED' }, now)).toBe(false)
  })

  it('announces queue changes for a screen reader, and nothing on the first read', () => {
    const a = item({ id: 'a', title: 'Alpha', state: 'QUEUED' })
    expect(queueAnnouncement(null, [a])).toBe('')
    expect(queueAnnouncement(new Map([['a', 'QUEUED']]), [a])).toBe('')
    expect(queueAnnouncement(new Map([['a', 'QUEUED']]), [{ ...a, state: 'RUNNING' }])).toBe('Alpha: now running')
    expect(queueAnnouncement(new Map(), [{ ...a, state: 'BLOCKED' }])).toBe('Alpha: added, blocked')
  })

  it('describes an item for the inspector from the overview alone', () => {
    const schedule: Schedule = { id: 's1', name: 'Nightly', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'p' }, priority: 'P1', enabled: true, nextRunAt: null, lastRunAt: null, lastResult: null, createdAt: '', updatedAt: '' }
    const overview = { schedules: [schedule], incidents: [{ at: '2026-01-01T00:00:00Z', summary: 'Blocked: x', itemId: 'i' }, { at: '2026-01-01T00:00:00Z', summary: 'Other', itemId: 'z' }] }
    const info = inspectorOf({ ...item({ state: 'BLOCKED', scheduleId: 's1', priority: 'P1', requestedAgents: 3 }), reason: 'Blocked: x' }, overview)
    const facts = Object.fromEntries(info.facts.map((f) => [f.label, f.value]))
    expect(facts.Priority).toContain('P1')
    expect(facts.Agents).toBe('3 requested')
    expect(facts.Schedule).toContain('Nightly')
    expect(facts.Deadline).toBe('None')
    expect(facts.Provider).toContain('Not reported')
    expect(info.why).toBe('Blocked: x')
    expect(info.events).toEqual([{ at: '2026-01-01T00:00:00Z', summary: 'Blocked: x' }])
    const running = inspectorOf({ ...item({ state: 'RUNNING' }), activeAgents: 2, allowance: 3 }, overview)
    expect(running.why).toBeNull()
    expect(Object.fromEntries(running.facts.map((f) => [f.label, f.value])).Agents).toBe('2 running · 3 granted · 2 requested')
  })

  describe('review follow-ups', () => {
    it('shows Unknown for the runtime while the connection is lost, and Recovering while it recovers', () => {
      expect(runtimeIndicator('HEALTHY', { stale: true, recovering: false })).toEqual({ label: 'Unknown', tone: 'neutral' })
      // Stale wins over everything else, including a recovering flag.
      expect(runtimeIndicator('BLOCKED', { stale: true, recovering: true }).label).toBe('Unknown')
      expect(runtimeIndicator('HEALTHY', { stale: false, recovering: true })).toEqual({ label: 'Recovering', tone: 'waiting' })
      expect(runtimeIndicator('DEGRADED', { stale: false, recovering: false })).toEqual({ label: 'Degraded', tone: 'warning' })
      expect(headerBadge('HEALTHY', { stale: true, recovering: false })).toEqual({ label: 'Runtime unknown', tone: 'neutral' })
      expect(headerBadge('HEALTHY', { stale: false, recovering: true })).toEqual({ label: 'Runtime recovering', tone: 'waiting' })
      expect(headerBadge('HEALTHY', { stale: false, recovering: false }).label).toBe('Runtime healthy')
    })

    it('a scheduled row says when it starts, in one explicit date format', () => {
      const line = itemLine(item({ state: 'SCHEDULED', type: 'scheduled_audit', notBefore: '2026-10-07T03:30:00' }))
      expect(line).toMatch(/^Scheduled audit · Starts 7 October 2026.*03:30$/)
      expect(itemLine(item({ state: 'SCHEDULED', notBefore: null }))).toBe('Program')
    })

    it('a waiting item always has a reason, in the row and in the inspector', () => {
      const queued = item({ state: 'QUEUED' })
      expect(itemPresentation(queued).reasonText).toBe(WAITING_FALLBACK['QUEUED'])
      expect(WAITING_FALLBACK['QUEUED']).toBe('Waiting for its turn in the queue.')
      expect(itemPresentation({ ...queued, reason: 'Waiting for a workload slot (4 run at once).' }).reasonText).toContain('workload slot')
      const info = inspectorOf(queued, { schedules: [], incidents: [] })
      expect(info.why).toBe('Waiting for its turn in the queue.')
      for (const state of ['QUEUED', 'READY', 'PAUSED', 'QUOTA_WAIT', 'BLOCKED', 'SCHEDULED'] as const)
        expect(inspectorOf(item({ state }), { schedules: [], incidents: [] }).why, state).toEqual(expect.any(String))
      expect(inspectorOf(item({ state: 'RUNNING' }), { schedules: [], incidents: [] }).why).toBeNull()
    })

    it('says what Hold does, from what the engines do', () => {
      expect(holdHelp(item({ type: 'program', state: 'RUNNING' }))).toContain('stops its running agent sessions now')
      expect(holdHelp(item({ type: 'mission', state: 'RUNNING' }))).toContain('Release continues it')
      expect(holdHelp(item({ type: 'arena', state: 'RUNNING' }))).toContain('trials in progress finish')
      expect(holdHelp(item({ type: 'arena', state: 'RUNNING' }))).not.toContain('stops its running')
      expect(holdHelp(item({ state: 'QUEUED' }))).toContain('from starting')
    })

    it('a pause the user did not ask for is "Paused by NEXUS" with Resume; a hold is Held with Release', () => {
      expect(stateLabel(item({ state: 'PAUSED', heldByUser: false }))).toBe('Paused by NEXUS')
      expect(resumeLabel(item({ state: 'PAUSED', heldByUser: false }))).toBe('Resume')
      expect(stateLabel(item({ state: 'PAUSED', heldByUser: true }))).toBe('Held')
      expect(resumeLabel(item({ state: 'PAUSED', heldByUser: true }))).toBe('Release')
      expect(resumeLabel(item({ state: 'QUEUED', heldByUser: true }))).toBe('Release')
      expect(itemPresentation(item({ state: 'PAUSED', heldByUser: false })).label).toBe('Paused by NEXUS')
    })

    it('a blocked item can be opened on its own page, on the workload when that page can show it', () => {
      expect(ownPage(item({ type: 'program', refId: 'p1' }))).toMatchObject({ label: 'Open the Programs page', view: 'programs', opens: 'program', refId: 'p1' })
      expect(ownPage(item({ type: 'program', refId: null }))).toMatchObject({ view: 'programs', opens: null })
      expect(ownPage(item({ type: 'arena', refId: 'c1' }))).toMatchObject({ label: 'Open the Arena page', view: 'arena', opens: 'campaign', refId: 'c1' })
      expect(ownPage(item({ type: 'mission', refId: 'r1' }))).toMatchObject({ view: 'run', opens: 'run', refId: 'r1' })
      expect(ownPage(item({ type: 'workspace_mission', refId: 'm1' }))).toMatchObject({ label: 'Open the Workspaces page', view: 'workspaces', opens: null })
    })

    it('maps known errors to plain sentences, refetches when the list is out of date, and never shows a channel', () => {
      const gone = friendlyError(Object.assign(new Error('control.cancel: Work item abc does not exist'), { code: 'not_found', channel: 'control.cancel' }))
      expect(gone).toEqual({ message: 'That item is no longer in the queue; the list was refreshed.', refetch: true })
      expect(friendlyError(new Error('The item no longer exists.')).refetch).toBe(true)
      const away = friendlyError(Object.assign(new Error('x'), { code: 'runtime_unavailable' }))
      expect(away.message).toContain('cannot reach its background runtime')
      expect(away.refetch).toBe(false)
      const state = friendlyError(Object.assign(new Error('control.pause failed: The item is COMPLETED.'), { code: 'invalid_state' }))
      expect(state.refetch).toBe(true)
      expect(state.message).toContain('The item is COMPLETED.')
      for (const e of [gone, away, state, friendlyError(new Error('control.move: Something odd happened'))]) expect(e.message).not.toMatch(/control\.\w+/)
      expect(friendlyError(new Error('control.move: Something odd happened')).message).toBe('Something odd happened')
      expect(friendlyError(null).message.length).toBeGreaterThan(0)
    })

    it('puts a plain sentence above the technical text of a failed load', () => {
      expect(loadSentence(new Error('boom'))).toContain('could not read the queue')
      expect(loadSentence(Object.assign(new Error('x'), { code: 'runtime_unavailable' }))).toContain('cannot reach')
    })

    it('names the workload of a schedule when it is known, and falls back without it', () => {
      expect(actionLine({ type: 'arena', campaignId: 'c' }, { campaign: 'Nightly' })).toBe('Run the Arena campaign "Nightly"')
      expect(actionLine({ type: 'arena', campaignId: 'c' }, {})).toBe('Run the Arena campaign')
      expect(actionLine({ type: 'workspace_mission', missionId: 'm' }, { mission: 'Migrate auth' })).toBe('Continue the workspace mission "Migrate auth"')
      expect(actionLine({ type: 'scheduled_audit', projectId: 'p', kind: 'dependency_audit' }, { project: 'web' })).toBe('Run a dependency audit of web')
    })

    it('writes weekdays and dates in English whatever the computer language is', () => {
      const now = new Date(2026, 9, 5, 21, 0, 0)
      const schedule: Schedule = { id: 's', name: 'N', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'p' }, priority: 'P2', enabled: true, nextRunAt: new Date(2026, 9, 7, 22, 0, 0).toISOString(), lastRunAt: null, lastResult: null, createdAt: '', updatedAt: '' }
      expect(scheduleLine(schedule, now)).toContain('next Wednesday 22:00')
    })
  })
})
