import { describe, expect, it } from 'vitest'
import { PROGRAM_POLICY_PRESETS, diffPlans, type Program, type ProgramSummary } from '@shared/program'
import {
  activePrograms,
  activeTimeMs,
  backgroundKindLabel,
  budgetText,
  clockWithDay,
  decisionLabel,
  activeTimeText,
  diffSummary,
  evidenceSummary,
  isAwaitingApproval,
  healthInfo,
  isOpenBacklog,
  planDiffRows,
  presetSummary,
  programActions,
  programStateInfo,
  progressText,
  stateNotice,
  windowText,
  windowTextAt,
  type NoticeContext,
} from '../../../src/renderer/src/views/programs/programsModel'
import {
  buildCreateInput,
  defaultProgramForm,
  splitLines,
  validateProgramForm,
  windowDescription,
  runsPastMidnight,
} from '../../../src/renderer/src/views/programs/programForm'

const program = (patch: Partial<Program> = {}): Program => ({
  id: 'p1',
  projectId: 'proj',
  name: 'Auth migration',
  goal: { statement: 'Move to the new auth model', successCriteria: [], constraints: [], risks: [] },
  state: 'ACTIVE',
  resumeState: null,
  pauseReason: null,
  blockedReason: null,
  policy: PROGRAM_POLICY_PRESETS.balanced,
  schedule: null,
  planVersion: 1,
  branch: 'nexus/program-p1',
  baseCommit: null,
  currentMilestoneId: null,
  currentRunId: null,
  currentRunKind: null,
  activeMs: 60_000,
  activeSince: null,
  quotaWaitSince: null,
  missions: 2,
  replans: 1,
  outcome: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  ...patch,
})

const ctx: NoticeContext = { quotaResetText: null, windowText: null, planProposed: false }

describe('program actions', () => {
  it('shows only the actions that apply', () => {
    expect(programActions('DRAFT')).toEqual({ start: true, pause: false, resume: false, cancel: true, replan: false })
    expect(programActions('ACTIVE')).toMatchObject({ start: false, pause: true, resume: false, cancel: true, replan: true })
    expect(programActions('PAUSED')).toMatchObject({ pause: false, resume: true, replan: true })
    expect(programActions('BLOCKED')).toMatchObject({ resume: true, pause: false })
    expect(programActions('WAITING_FOR_QUOTA')).toMatchObject({ pause: true, resume: false })
    // Paused for a plan decision: Accept and Reject are the only actions; resume and reassess are hidden.
    expect(programActions('PAUSED', true)).toMatchObject({ resume: false, replan: false, cancel: true })
    expect(isAwaitingApproval({ state: 'PAUSED', pauseReason: 'approval' }, false)).toBe(true)
    expect(isAwaitingApproval({ state: 'PAUSED', pauseReason: 'user' }, true)).toBe(true)
    expect(isAwaitingApproval({ state: 'ACTIVE', pauseReason: null }, true)).toBe(false)
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED'] as const)
      expect(programActions(s)).toEqual({ start: false, pause: false, resume: false, cancel: false, replan: false })
  })
})

describe('state labels', () => {
  it('names a pause waiting for approval differently', () => {
    expect(programStateInfo('PAUSED', 'approval').label).toBe('Awaiting approval')
    expect(programStateInfo('PAUSED', 'user').label).toBe('Paused')
    expect(programStateInfo('WAITING_FOR_QUOTA').tone).toBe('waiting')
    expect(programStateInfo('FAILED').tone).toBe('danger')
  })
  it('has a label for health levels and decisions', () => {
    expect(healthInfo('attention').label).toBe('Needs attention')
    expect(decisionLabel('quota_wait')).toBe('Waiting for usage limit')
    expect(backgroundKindLabel('dependency_audit')).toBe('Dependency audit')
    expect(isOpenBacklog('proposed')).toBe(true)
    expect(isOpenBacklog('done')).toBe(false)
  })
})

describe('progress and budgets', () => {
  it('words progress, budgets and active time', () => {
    expect(progressText({ total: 5, completed: 2, active: null })).toBe('2 of 5 milestones')
    expect(progressText({ total: 0, completed: 0, active: null })).toBe('No plan yet')
    expect(activeTimeText(program({ activeMs: 400, activeSince: null }), 0)).toBe('less than a minute')
    expect(activeTimeText(program({ activeMs: 120_000, activeSince: null }), 0)).toBe('2m 00s')
    expect(budgetText(3, 30)).toBe('3 of 30')
    const now = Date.parse('2026-01-01T01:00:00.000Z')
    expect(activeTimeMs(program({ activeMs: 60_000, activeSince: '2026-01-01T00:59:00.000Z' }), now)).toBe(120_000)
    expect(activeTimeMs(program({ activeMs: 60_000, activeSince: null }), now)).toBe(60_000)
  })
})

describe('work window text', () => {
  const schedule = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '07:00' }] }
  const at = (h: number, m = 0) => new Date(2026, 5, 10, h, m, 0, 0).getTime()
  it('has none without a schedule', () => {
    expect(windowTextAt(program(), at(12))).toBeNull()
    expect(windowText(program(), { open: true, closesAt: null, nextOpensAt: null }, at(12))).toBeNull()
  })
  it('says when the window opens, and until when it is open', () => {
    expect(windowTextAt(program({ schedule }), at(12))).toBe('Opens 22:00')
    expect(windowTextAt(program({ schedule }), at(23))).toBe('Open until tomorrow 07:00')
    expect(windowTextAt(program({ schedule }), at(3))).toBe('Open until 07:00')
  })
  it('names the day for a distant time', () => {
    const now = at(12)
    expect(clockWithDay(now + 3 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/)
  })
})

describe('state notices', () => {
  it('never claims a reset time the usage service did not report', () => {
    const n = stateNotice(program({ state: 'WAITING_FOR_QUOTA' }), ctx)
    expect(n?.text).toContain('not a failure')
    expect(n?.text).toContain('has not reported a reset time')
    expect(stateNotice(program({ state: 'WAITING_FOR_QUOTA' }), { ...ctx, quotaResetText: 'at 14:30' })?.text).toContain('resets at 14:30')
  })
  it('explains every pause reason', () => {
    const t = (pauseReason: Program['pauseReason'], c: NoticeContext = ctx) => stateNotice(program({ state: 'PAUSED', pauseReason }), c)
    expect(t('user')?.title).toBe('Paused by you')
    expect(t('work_window', { ...ctx, windowText: 'Opens 22:00' })?.text).toContain('Opens 22:00')
    expect(t('usage_policy')?.title).toContain('usage-limit')
    expect(t('restart')?.title).toContain('restart')
    expect(t('approval', { ...ctx, planProposed: true })?.text).toContain('below')
  })
  it('says what Resume does for a blocked program', () => {
    const n = stateNotice(program({ state: 'BLOCKED', blockedReason: 'Milestone api used all its missions' }), ctx)
    expect(n?.text).toContain('Milestone api used all its missions')
    expect(n?.text).toContain('Resume')
  })
  it('shows the outcome summary of an ended program and nothing for an active one', () => {
    const outcome = { result: 'completed', summary: 'All 4 milestones done', milestonesCompleted: 4, milestonesTotal: 4, missions: 5, replans: 1, finishedAt: 'x' } as const
    expect(stateNotice(program({ state: 'COMPLETED', outcome }), ctx)?.text).toBe('All 4 milestones done')
    expect(stateNotice(program({ state: 'FAILED', error: 'boom' }), ctx)?.tone).toBe('danger')
    expect(stateNotice(program({ state: 'ACTIVE' }), ctx)).toBeNull()
    expect(stateNotice(program({ state: 'PLANNING' }), ctx)?.title).toBe('Planning milestones')
    expect(stateNotice(program({ state: 'REPLANNING' }), ctx)?.title).toContain('Reassessing')
  })
})

describe('plan diff presentation', () => {
  const m = (key: string, extra: Partial<{ title: string; objective: string; dependsOn: string[] }> = {}) => ({
    key,
    title: extra.title ?? key,
    objective: extra.objective ?? 'o',
    acceptanceCriteria: ['c'],
    dependsOn: extra.dependsOn ?? [],
  })
  it('gives each difference a glyph and a text label', () => {
    const diff = diffPlans([m('a'), m('b'), m('c'), m('d')], [m('d'), m('a', { title: 'A2' }), m('e')], ['c'])
    const rows = planDiffRows(diff, (k) => `T-${k}`)
    expect(rows.map((r) => [r.kind, r.label, r.glyph, r.key])).toEqual([
      ['added', 'Added', 'plus', 'e'],
      ['changed', 'Changed', 'edit', 'a'],
      ['deferred', 'Deferred', 'pause', 'c'],
      ['removed', 'Removed', 'minus', 'b'],
      ['reordered', 'Reordered', 'swap', null],
    ])
    expect(rows[1]?.detail).toBe('Changed: title')
    expect(rows[0]?.title).toBe('T-e')
    expect(diffSummary(diff)).toBe('1 added, 1 changed, 1 deferred, 1 removed, order changed')
  })
  it('is empty for an unchanged plan', () => {
    const diff = diffPlans([m('a')], [m('a')])
    expect(planDiffRows(diff, () => null)).toEqual([])
    expect(diffSummary(diff)).toContain('No change')
  })
})

describe('preset summary', () => {
  it('describes approval, usage limit, budget and strategy', () => {
    const c = presetSummary(PROGRAM_POLICY_PRESETS.conservative)
    expect(c.map((l) => l.label)).toEqual(['Approval', 'Usage limit', 'Mission budget', 'Strategy'])
    expect(c[0]?.value).toContain('every revision')
    expect(c[1]?.value).toContain('Pauses')
    expect(c[2]?.value).toContain('10 missions')
    expect(c[3]?.value).toContain('Build')
    expect(presetSummary(PROGRAM_POLICY_PRESETS.autonomous)[3]?.value).toContain('speculation')
    expect(presetSummary(PROGRAM_POLICY_PRESETS.balanced)[1]?.value).toContain('Waits')
  })
})

describe('home list', () => {
  it('keeps programs that are live or waiting, not drafts or ended ones', () => {
    const row = (state: Program['state']): ProgramSummary => ({
      program: program({ state }),
      milestones: { total: 1, completed: 0, active: null },
      backlogOpen: 0,
      window: { open: true, closesAt: null, nextOpensAt: null },
    })
    const kept = activePrograms(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'WAITING_FOR_QUOTA', 'CANCELLED'].map((s) => row(s as Program['state'])))
    expect(kept.map((r) => r.program.state)).toEqual(['ACTIVE', 'PAUSED', 'WAITING_FOR_QUOTA'])
  })
})

describe('program form', () => {
  const valid = () => ({ ...defaultProgramForm('proj'), name: 'Auth', goal: 'Move to the new model' })
  it('requires a project, a name and a goal, with the first reason', () => {
    expect(validateProgramForm(defaultProgramForm(null)).reason).toBe('Open a project first.')
    const c = validateProgramForm({ ...defaultProgramForm('proj') })
    expect(c.ok).toBe(false)
    expect(c.reason).toBe('Give the program a name.')
    expect(validateProgramForm({ ...defaultProgramForm('proj'), name: 'x' }).reason).toBe('Describe the goal.')
    expect(validateProgramForm(valid()).ok).toBe(true)
  })
  it('limits lines and lengths', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `c${i}`).join('\n')
    expect(validateProgramForm({ ...valid(), successCriteria: tooMany }).errors.successCriteria).toContain('At most 10')
    expect(validateProgramForm({ ...valid(), constraints: 'x'.repeat(401) }).errors.constraints).toContain('400')
    expect(validateProgramForm({ ...valid(), name: 'n'.repeat(121) }).errors.name).toContain('120')
  })
  it('validates the work window only when enabled', () => {
    expect(validateProgramForm({ ...valid(), start: 'nope' }).ok).toBe(true)
    const w = { ...valid(), windowEnabled: true }
    expect(validateProgramForm({ ...w, start: '25:00' }).errors.start).toContain('24-hour')
    expect(validateProgramForm({ ...w, end: '7:00' }).errors.end).toContain('24-hour')
    expect(validateProgramForm({ ...w, days: [] }).errors.days).toContain('at least one day')
    expect(validateProgramForm({ ...w, start: '08:00', end: '08:00' }).errors.end).toContain('24 hours')
    expect(validateProgramForm(w).ok).toBe(true)
  })
  it('says when a window runs past midnight', () => {
    expect(runsPastMidnight('22:00', '07:00')).toBe(true)
    expect(runsPastMidnight('09:00', '17:00')).toBe(false)
    expect(windowDescription('22:00', '07:00')).toContain('past midnight')
    expect(windowDescription('09:00', '17:00')).toContain('same day')
    expect(windowDescription('99:00', '17:00')).toBeNull()
  })
  it('builds the create input', () => {
    expect(splitLines(' a \n\n b\r\n')).toEqual(['a', 'b'])
    const plain = buildCreateInput(valid(), false)
    expect(plain).toEqual({ projectId: 'proj', name: 'Auth', goal: 'Move to the new model', preset: 'balanced', schedule: null, start: false })
    const full = buildCreateInput(
      { ...valid(), preset: 'conservative', successCriteria: 'one\ntwo', constraints: 'none', windowEnabled: true, days: [5, 1], start: '22:00', end: '07:00' },
      true,
    )
    expect(full).toMatchObject({
      preset: 'conservative',
      successCriteria: ['one', 'two'],
      constraints: ['none'],
      schedule: { windows: [{ days: [1, 5], start: '22:00', end: '07:00' }] },
      start: true,
    })
  })
})

describe('evidence summary', () => {
  const gate = (name: string, passed: boolean) => ({ name, passed, detail: '' }) as never
  it('counts gates and criteria for an accepted milestone', () => {
    const e = { verdict: 'accepted', gates: [gate('a', true), gate('b', true)], judgment: { criteria: [{ met: true }, { met: true }, { met: false }] } } as never
    expect(evidenceSummary(e)).toBe('Accepted · 2 of 2 gates passed · 2 of 3 criteria met')
  })
  it('names the failed gate for a rejected one', () => {
    const e = { verdict: 'rejected', gates: [gate('mission_completed', true), gate('checks_passed', false)], judgment: null } as never
    expect(evidenceSummary(e)).toBe('Rejected · gate checks_passed failed')
  })
})
