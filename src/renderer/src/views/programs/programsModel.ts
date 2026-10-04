import {
  TERMINAL_PROGRAM_STATES,
  windowStatus,
  type BacklogStatus,
  type MilestoneState,
  type PlanDiff,
  type Program,
  type ProgramDecisionKind,
  type ProgramDetail,
  type ProgramPolicy,
  type ProgramState,
  type ProgramSummary,
  type WindowStatus,
} from '@shared/program'
import { formatDuration } from '../../lib/format'
import type { StatusInfo, Tone } from '../../lib/status'

/** Pure presentation rules for the Programs pages. No DOM, no clock of its own: callers pass `now`. */

const pad2 = (n: number) => String(n).padStart(2, '0')

// ───────────────────────────── states ─────────────────────────────

export function programStateInfo(state: ProgramState, pauseReason: Program['pauseReason'] = null): StatusInfo {
  switch (state) {
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral' }
    case 'PLANNING':
      return { label: 'Planning', tone: 'active' }
    case 'ACTIVE':
      return { label: 'Active', tone: 'active' }
    case 'PAUSED':
      return { label: pauseReason === 'approval' ? 'Awaiting approval' : 'Paused', tone: pauseReason === 'approval' ? 'review' : 'waiting' }
    case 'WAITING_FOR_QUOTA':
      return { label: 'Waiting for usage limit', tone: 'waiting' }
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'warning' }
    case 'REPLANNING':
      return { label: 'Reassessing', tone: 'review' }
    case 'COMPLETED':
      return { label: 'Completed', tone: 'success' }
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' }
    case 'FAILED':
      return { label: 'Failed', tone: 'danger' }
  }
}

export function milestoneStateInfo(state: MilestoneState): StatusInfo {
  switch (state) {
    case 'PLANNED':
      return { label: 'Planned', tone: 'neutral' }
    case 'READY':
      return { label: 'Ready', tone: 'neutral' }
    case 'ACTIVE':
      return { label: 'In progress', tone: 'active' }
    case 'VERIFYING':
      return { label: 'Verifying', tone: 'review' }
    case 'COMPLETED':
      return { label: 'Completed', tone: 'success' }
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'warning' }
    case 'DEFERRED':
      return { label: 'Deferred', tone: 'neutral' }
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' }
  }
}

export const isTerminalProgram = (state: ProgramState): boolean => TERMINAL_PROGRAM_STATES.includes(state)

export type HealthLevel = ProgramDetail['health']['level']

export function healthInfo(level: HealthLevel): { label: string; tone: Tone } {
  switch (level) {
    case 'healthy':
      return { label: 'Healthy', tone: 'success' }
    case 'waiting':
      return { label: 'Waiting', tone: 'waiting' }
    case 'attention':
      return { label: 'Needs attention', tone: 'warning' }
    case 'ended':
      return { label: 'Ended', tone: 'neutral' }
  }
}

// ───────────────────────────── actions ─────────────────────────────

export interface ProgramActions {
  start: boolean
  pause: boolean
  resume: boolean
  cancel: boolean
  replan: boolean
}

/** Which controls apply in a state. Controls that cannot apply are hidden, never disabled. */
export function programActions(state: ProgramState): ProgramActions {
  return {
    start: state === 'DRAFT',
    pause: state === 'PLANNING' || state === 'ACTIVE' || state === 'WAITING_FOR_QUOTA' || state === 'REPLANNING',
    resume: state === 'PAUSED' || state === 'BLOCKED',
    cancel: !isTerminalProgram(state),
    replan: state === 'ACTIVE' || state === 'PAUSED' || state === 'BLOCKED' || state === 'WAITING_FOR_QUOTA',
  }
}

// ───────────────────────────── progress, window, time ─────────────────────────────

export const progressText = (m: ProgramSummary['milestones']): string => `${m.completed} of ${m.total} milestones`

export const hasWindows = (program: Pick<Program, 'schedule'>): boolean => !!program.schedule && program.schedule.windows.length > 0

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const WEEKDAY_LABELS = WEEKDAYS

/** "22:00", "tomorrow 22:00" or "Tue 22:00": the local clock time, with the day when it is not today. */
export function clockWithDay(epochMs: number, now: number): string {
  const d = new Date(epochMs)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const that = new Date(epochMs)
  that.setHours(0, 0, 0, 0)
  const days = Math.round((that.getTime() - today.getTime()) / 86_400_000)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (days === 0) return clock
  if (days === 1) return `tomorrow ${clock}`
  return `${WEEKDAYS[d.getDay()]} ${clock}`
}

/** "Opens 22:00", "Open until 07:00", or null when the program has no work window. */
export function windowText(program: Pick<Program, 'schedule'>, status: WindowStatus, now: number): string | null {
  if (!hasWindows(program)) return null
  if (status.open && status.closesAt !== null) return `Open until ${clockWithDay(status.closesAt, now)}`
  if (!status.open && status.nextOpensAt !== null) return `Opens ${clockWithDay(status.nextOpensAt, now)}`
  return null
}

/** Window status recomputed at `now`, so the text does not go stale between refetches. */
export const windowTextAt = (program: Pick<Program, 'schedule'>, now: number): string | null =>
  windowText(program, windowStatus(program.schedule, now), now)

/** Active time including the running span. */
export function activeTimeMs(program: Pick<Program, 'activeMs' | 'activeSince'>, now: number): number {
  const since = program.activeSince ? Date.parse(program.activeSince) : NaN
  return program.activeMs + (Number.isNaN(since) ? 0 : Math.max(0, now - since))
}
export const activeTimeText = (program: Pick<Program, 'activeMs' | 'activeSince'>, now: number): string =>
  formatDuration(activeTimeMs(program, now))

export const budgetText = (used: number, budget: number): string => `${used} of ${budget}`

/** Replans used against `maxReplans` (a budget of 0 means no reassessment is allowed). */
export const replanBudgetText = (program: Pick<Program, 'replans' | 'policy'>): string =>
  budgetText(program.replans, program.policy.maxReplans)

// ───────────────────────────── state notices ─────────────────────────────

export interface StateNotice {
  tone: 'warning' | 'danger' | 'active' | 'neutral' | 'success'
  title: string
  text: string
}

export interface NoticeContext {
  /** The reset time the usage service reported as exact; null when it reported none. */
  quotaResetText: string | null
  /** "Opens 22:00", when known. */
  windowText: string | null
  /** A plan revision is waiting for a decision. */
  planProposed: boolean
}

/** What the page says about the state, one notice per state. Never invents a time. */
export function stateNotice(program: Program, ctx: NoticeContext): StateNotice | null {
  const o = program.outcome
  switch (program.state) {
    case 'DRAFT':
      return { tone: 'neutral', title: 'Not started', text: 'Nothing has run yet. Start the program and NEXUS plans the milestones first.' }
    case 'PLANNING':
      return { tone: 'active', title: 'Planning milestones', text: 'A read-only session is turning the goal into a short list of verifiable milestones. No code is changed during planning.' }
    case 'ACTIVE':
      return null
    case 'WAITING_FOR_QUOTA':
      return {
        tone: 'warning',
        title: 'Waiting for the Claude usage limit',
        text: `This is not a failure. The program continues by itself when Claude is available again; waiting time does not count against the duration budget. ${
          ctx.quotaResetText ? `Claude reported that the limit resets ${ctx.quotaResetText}.` : 'Claude has not reported a reset time.'
        }`,
      }
    case 'PAUSED':
      return pausedNotice(program, ctx)
    case 'BLOCKED':
      return {
        tone: 'warning',
        title: 'Blocked',
        text: `${program.blockedReason ?? 'The program cannot continue without a decision.'} Resume gives the blocked milestones another round of missions and continues the plan.`,
      }
    case 'REPLANNING':
      return { tone: 'active', title: 'Reassessing the plan', text: 'A read-only session is checking whether the remaining milestones still make sense. It either keeps the plan or proposes a revision.' }
    case 'COMPLETED':
      return { tone: 'success', title: 'Program completed', text: o?.summary ?? 'Every milestone was completed and verified.' }
    case 'FAILED':
      return { tone: 'danger', title: 'Program failed', text: o?.summary ?? program.error ?? 'The program failed.' }
    case 'CANCELLED':
      return { tone: 'neutral', title: 'Program cancelled', text: o?.summary ?? 'The program was cancelled. Completed milestones and the program branch are kept.' }
  }
}

function pausedNotice(program: Program, ctx: NoticeContext): StateNotice {
  switch (program.pauseReason) {
    case 'user':
      return { tone: 'neutral', title: 'Paused by you', text: 'Nothing runs until you resume. The running mission, if any, was paused with it.' }
    case 'work_window':
      return {
        tone: 'neutral',
        title: 'Outside the work window',
        text: `The program works only inside its schedule. ${ctx.windowText ? `${ctx.windowText}.` : 'No further opening is known.'} It resumes by itself.`,
      }
    case 'usage_policy':
      return { tone: 'warning', title: 'Paused by the usage-limit policy', text: 'A usage limit was reached and this program stops instead of waiting. Resume when Claude is available again.' }
    case 'restart':
      return { tone: 'warning', title: 'Paused after a restart of NEXUS', text: 'This program is set to wait for you after a restart. Check where it stands, then resume. Nothing was lost; work that was running was paused safely.' }
    case 'approval':
      return {
        tone: 'warning',
        title: 'Waiting for your approval',
        text: ctx.planProposed ? 'A plan is waiting for your decision below. The program continues when you accept it.' : 'A plan is waiting for your decision.',
      }
    default:
      return { tone: 'neutral', title: 'Paused', text: 'Nothing runs until you resume.' }
  }
}

/** True when the page should say the program was paused by a restart (the recovery state). */
export const pausedByRestart = (program: Pick<Program, 'state' | 'pauseReason'>): boolean => program.state === 'PAUSED' && program.pauseReason === 'restart'

// ───────────────────────────── plan diff ─────────────────────────────

export type DiffKind = 'added' | 'removed' | 'deferred' | 'changed' | 'reordered'
export type DiffGlyph = 'plus' | 'minus' | 'pause' | 'edit' | 'swap'

export interface DiffRow {
  kind: DiffKind
  glyph: DiffGlyph
  /** Always shown: the diff never relies on colour alone. */
  label: string
  key: string | null
  title: string | null
  detail: string | null
  tone: Tone
}

export const DIFF_FIELD_LABEL: Record<string, string> = {
  title: 'title',
  objective: 'objective',
  acceptanceCriteria: 'acceptance criteria',
  dependsOn: 'dependencies',
}
export const diffFieldLabel = (f: string): string => DIFF_FIELD_LABEL[f] ?? f

/** One row per difference, in a stable order: added, changed, deferred, removed, reordered. */
export function planDiffRows(diff: PlanDiff, titleOf: (key: string) => string | null): DiffRow[] {
  const rows: DiffRow[] = []
  for (const key of diff.added)
    rows.push({ kind: 'added', glyph: 'plus', label: 'Added', key, title: titleOf(key), detail: null, tone: 'success' })
  for (const c of diff.changed)
    rows.push({ kind: 'changed', glyph: 'edit', label: 'Changed', key: c.key, title: titleOf(c.key), detail: `Changed: ${c.fields.map(diffFieldLabel).join(', ')}`, tone: 'active' })
  for (const key of diff.deferred)
    rows.push({ kind: 'deferred', glyph: 'pause', label: 'Deferred', key, title: titleOf(key), detail: 'Kept in the roadmap, not worked on.', tone: 'waiting' })
  for (const key of diff.removed)
    rows.push({ kind: 'removed', glyph: 'minus', label: 'Removed', key, title: titleOf(key), detail: null, tone: 'danger' })
  if (diff.reordered) rows.push({ kind: 'reordered', glyph: 'swap', label: 'Reordered', key: null, title: null, detail: 'The order of the remaining milestones changed.', tone: 'review' })
  return rows
}

/** One-line summary: "2 added, 1 removed, order changed", or "No change". */
export function diffSummary(diff: PlanDiff): string {
  const bits: string[] = []
  if (diff.added.length) bits.push(`${diff.added.length} added`)
  if (diff.changed.length) bits.push(`${diff.changed.length} changed`)
  if (diff.deferred.length) bits.push(`${diff.deferred.length} deferred`)
  if (diff.removed.length) bits.push(`${diff.removed.length} removed`)
  if (diff.reordered) bits.push('order changed')
  return bits.length ? bits.join(', ') : 'No change to the remaining plan'
}

export function revisionTriggerText(t: string): string {
  switch (t) {
    case 'initial':
      return 'Initial plan'
    case 'milestone_completed':
      return 'After a completed milestone'
    case 'milestone_rejected':
      return 'After a rejected milestone'
    case 'mission_failed':
      return 'After a failed mission'
    case 'user':
      return 'Requested by you'
    default:
      return t
  }
}

export function revisionStatusInfo(s: 'proposed' | 'accepted' | 'rejected'): StatusInfo {
  if (s === 'proposed') return { label: 'Awaiting decision', tone: 'review' }
  if (s === 'accepted') return { label: 'Accepted', tone: 'success' }
  return { label: 'Rejected', tone: 'neutral' }
}

// ───────────────────────────── decisions, missions, backlog, memory ─────────────────────────────

const DECISION_LABEL: Record<ProgramDecisionKind, string> = {
  created: 'Created',
  plan_proposed: 'Plan proposed',
  plan_accepted: 'Plan accepted',
  plan_rejected: 'Plan rejected',
  milestone_started: 'Milestone started',
  mission_generated: 'Mission generated',
  mission_ended: 'Mission ended',
  milestone_accepted: 'Milestone accepted',
  milestone_rejected: 'Milestone rejected',
  milestone_blocked: 'Milestone blocked',
  replan_requested: 'Reassessment requested',
  replan_kept: 'Plan kept',
  paused: 'Paused',
  resumed: 'Resumed',
  quota_wait: 'Waiting for usage limit',
  quota_resumed: 'Usage limit over',
  window_closed: 'Work window closed',
  window_opened: 'Work window opened',
  blocked: 'Blocked',
  unblocked: 'Unblocked',
  recovered: 'Recovered after restart',
  budget: 'Budget',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
export const decisionLabel = (k: ProgramDecisionKind): string => DECISION_LABEL[k] ?? k

export function missionOutcomeInfo(o: 'running' | 'completed' | 'failed' | 'cancelled'): StatusInfo {
  switch (o) {
    case 'running':
      return { label: 'Running', tone: 'active' }
    case 'completed':
      return { label: 'Completed', tone: 'success' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' }
  }
}

export const BACKLOG_STATUS_LABEL: Record<BacklogStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  scheduled: 'Scheduled',
  done: 'Done',
  rejected: 'Rejected',
  obsolete: 'Obsolete',
}
/** An item is open until someone settles it. */
export const isOpenBacklog = (s: BacklogStatus): boolean => s === 'proposed' || s === 'accepted' || s === 'scheduled'

export const CATEGORY_LABEL: Record<string, string> = {
  bug: 'Bug',
  debt: 'Technical debt',
  test_gap: 'Test gap',
  performance: 'Performance',
  architecture: 'Architecture',
  security: 'Security',
  documentation: 'Documentation',
}
export const categoryLabel = (c: string): string => CATEGORY_LABEL[c] ?? c

export function severityTone(s: string): Tone {
  if (s === 'critical') return 'danger'
  if (s === 'high') return 'warning'
  if (s === 'medium') return 'waiting'
  return 'neutral'
}

export function provenanceText(p: { source: string; runId: string | null; milestoneKey: string | null; jobId: string | null }): string {
  const source: Record<string, string> = {
    agent: 'An agent',
    milestone_verifier: 'Milestone verifier',
    mission_failure: 'A failed mission',
    background_job: 'Background job',
    user: 'You',
  }
  return [source[p.source] ?? p.source, p.milestoneKey ? `milestone ${p.milestoneKey}` : null].filter(Boolean).join(' · ')
}

export const MEMORY_KIND_LABEL: Record<string, string> = {
  architecture_decision: 'Architecture decision',
  rejected_approach: 'Rejected approach',
  hazard: 'Hazard',
  performance_baseline: 'Performance baseline',
  interface: 'Interface',
  security_constraint: 'Security constraint',
  failure: 'Failure',
  user_decision: 'Your decision',
}
export const memoryKindLabel = (k: string): string => MEMORY_KIND_LABEL[k] ?? k

export const EXPERTISE_LABEL: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  reliability: 'Reliability',
  security: 'Security',
  testing: 'Testing',
  architecture: 'Architecture',
}
export const expertiseLabel = (a: string): string => EXPERTISE_LABEL[a] ?? a

export const BACKGROUND_KIND_LABEL: Record<string, string> = {
  dependency_audit: 'Dependency audit',
  flaky_test_analysis: 'Flaky test analysis',
  intelligence_refresh: 'Repository summary',
  dead_code_analysis: 'Dead code analysis',
  test_gap_analysis: 'Test gap analysis',
  performance_baseline: 'Performance baseline',
  architecture_audit: 'Architecture audit',
}
export const backgroundKindLabel = (k: string): string => BACKGROUND_KIND_LABEL[k] ?? k

export function backgroundJobInfo(s: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'): StatusInfo {
  switch (s) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral' }
    case 'running':
      return { label: 'Running', tone: 'active' }
    case 'completed':
      return { label: 'Completed', tone: 'success' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' }
  }
}

// ───────────────────────────── policy summary ─────────────────────────────

export interface PresetSummaryLine {
  label: string
  value: string
}

const APPROVAL_TEXT: Record<ProgramPolicy['approvalPolicy'], string> = {
  plan: 'You approve the first plan and every revision',
  initial: 'You approve the first plan; revisions apply by themselves',
  none: 'No approval; plans and revisions apply by themselves',
}

/** What a policy means, in four lines. Read-only. */
export function presetSummary(p: ProgramPolicy): PresetSummaryLine[] {
  return [
    { label: 'Approval', value: APPROVAL_TEXT[p.approvalPolicy] },
    { label: 'Usage limit', value: p.usageBehavior === 'wait' ? `Waits for the limit to reset (up to ${formatDuration(p.quotaWaitMaxMinutes * 60_000)})` : 'Pauses and waits for you' },
    { label: 'Mission budget', value: `${p.maxTotalMissions} missions in total, ${p.maxMissionsPerMilestone} per milestone, up to ${formatDuration(p.maxDurationMinutes * 60_000)} of active time` },
    { label: 'Strategy', value: `${p.missionStrategy.charAt(0)}${p.missionStrategy.slice(1).toLowerCase()}${p.speculation ? ', speculation allowed' : ''}, up to ${p.maxAgents} agents` },
  ]
}

export const PRESET_LABEL = { conservative: 'Conservative', balanced: 'Balanced', autonomous: 'Autonomous' } as const

// ───────────────────────────── list helpers ─────────────────────────────

/** Programs that are doing or about to do work, for Home. */
export function activePrograms(rows: readonly ProgramSummary[]): ProgramSummary[] {
  return rows.filter((r) => !isTerminalProgram(r.program.state) && r.program.state !== 'DRAFT')
}

/** The current milestone's title, from the roadmap when the detail is known. */
export function currentMilestoneTitle(program: Pick<Program, 'currentMilestoneId'>, roadmap: readonly { id: string; title: string }[]): string | null {
  return roadmap.find((m) => m.id === program.currentMilestoneId)?.title ?? null
}

/** Gate names in plain words. */
export const GATE_LABEL: Record<string, string> = {
  mission_completed: 'Mission completed',
  checks_passed: 'Checks passed',
  no_blocking_findings: 'No blocking review findings',
  mission_verified: 'Mission verified',
  changes_present: 'Changes present',
  criteria_judged: 'Criteria judged',
}
export const gateLabel = (g: string): string => GATE_LABEL[g] ?? g
