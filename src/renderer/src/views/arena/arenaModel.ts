import {
  ARENA_BUDGET_DEFAULTS,
  TERMINAL_TRIAL_STATES,
  type ArenaBudgetPreset,
  type ArenaCell,
  type ArenaTrialMetrics,
  type CampaignState,
  type ConcreteStrategy,
  type EvidenceLabel,
  type Interval,
  type StrategyComparisonRow,
  type TrialState,
} from '@shared/v3'
import type { Tone } from '../../lib/status'
import { formatDuration, formatTokens } from '../../lib/format'

/** Pure presentation rules for the Arena pages. Correctness dominates; raw metrics are never replaced by the score. */

export const strategyName = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase()

export const ARENA_STRATEGIES: readonly ConcreteStrategy[] = [
  'SINGLE',
  'BUILD',
  'SWARM',
  'CONSENSUS',
  'SPECULATIVE',
]

export const STRATEGY_HINT: Record<ConcreteStrategy, string> = {
  SINGLE: 'One agent does the whole task',
  BUILD: 'Plan, one worker, review',
  SWARM: 'Parallel workers on a task graph',
  CONSENSUS: 'Several plans reconciled first',
  SPECULATIVE: 'Competing candidates, best wins',
}

// ───────────────────────────── evidence ─────────────────────────────

export const evidenceText = (l: EvidenceLabel): string => l.charAt(0) + l.slice(1).toLowerCase()

/** Evidence strength is not a verdict on the strategy, so it never uses success or danger colours. */
export function evidenceTone(l: EvidenceLabel): Tone {
  return l === 'MODERATE' || l === 'STRONG' ? 'active' : 'neutral'
}

export const pct = (rate: number | null | undefined): string =>
  typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—'

/** "62%–91%". Em dash without an interval. */
export function intervalText(i: Interval | null | undefined): string {
  return i ? `${pct(i.low)}–${pct(i.high)}` : '—'
}

/** "7/9 (78%)". */
export function passText(passed: number, n: number, rate: number | null): string {
  return n === 0 ? '0/0' : `${passed}/${n} (${pct(rate)})`
}

export function intervalsOverlap(a: Interval | null, b: Interval | null): boolean {
  if (!a || !b) return true
  return a.low <= b.high && b.low <= a.high
}

/**
 * Ordered by the lower bound of the pass-rate interval, so one lucky trial (1 of 1) does not sit above a
 * well-measured strategy (18 of 20); then by pass rate, then by observations. Unmeasured rows last. Cost is
 * never part of the order: a cheaper strategy never outranks a more correct one.
 */
export function sortComparison(rows: readonly StrategyComparisonRow[]): StrategyComparisonRow[] {
  return [...rows].sort((a, b) => {
    const al = a.passInterval?.low ?? -1
    const bl = b.passInterval?.low ?? -1
    if (al !== bl) return bl - al
    const ar = a.passRate ?? -1
    const br = b.passRate ?? -1
    if (ar !== br) return br - ar
    return b.n - a.n
  })
}

export const meanText = (v: number | null | undefined, digits = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'

// ───────────────────────────── trials ─────────────────────────────

export type TrialGlyph = 'pass' | 'fail' | 'running' | 'queued' | 'blocked' | 'cancelled'

export interface TrialStateInfo {
  label: string
  glyph: TrialGlyph
  tone: Tone
  terminal: boolean
}

const TRIAL_INFO: Record<TrialState, TrialStateInfo> = {
  queued: { label: 'Queued', glyph: 'queued', tone: 'neutral', terminal: false },
  provisioning: { label: 'Running', glyph: 'running', tone: 'active', terminal: false },
  running: { label: 'Running', glyph: 'running', tone: 'active', terminal: false },
  evaluating: { label: 'Running', glyph: 'running', tone: 'active', terminal: false },
  passed: { label: 'Pass', glyph: 'pass', tone: 'success', terminal: true },
  failed: { label: 'Fail', glyph: 'fail', tone: 'danger', terminal: true },
  blocked: { label: 'Blocked', glyph: 'blocked', tone: 'warning', terminal: true },
  cancelled: { label: 'Cancelled', glyph: 'cancelled', tone: 'neutral', terminal: true },
}

export const trialStateInfo = (s: TrialState): TrialStateInfo => TRIAL_INFO[s]

/** Finer wording for the trial table and drawer. */
export const TRIAL_STATE_DETAIL: Record<TrialState, string> = {
  queued: 'Queued',
  provisioning: 'Preparing repository',
  running: 'Running',
  evaluating: 'Evaluating',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

export interface CellChip {
  id: string
  repetition: number
  info: TrialStateInfo
  /** For the accessible name only; a score is never shown in the matrix. */
  detail: string
}

export interface CellModel {
  chips: CellChip[]
  summary: string
  /** One chip: show the word next to the icon. */
  single: boolean
}

export function cellModel(cell: ArenaCell | undefined): CellModel {
  const trials = [...(cell?.trials ?? [])].sort((a, b) => a.repetition - b.repetition)
  const chips = trials.map((t) => ({
    id: t.id,
    repetition: t.repetition,
    info: TRIAL_INFO[t.state],
    detail: TRIAL_STATE_DETAIL[t.state],
  }))
  const count = (g: TrialGlyph) => chips.filter((c) => c.info.glyph === g).length
  const parts: string[] = []
  for (const [g, word] of [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['running', 'running'],
    ['queued', 'queued'],
    ['blocked', 'blocked'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const n = count(g)
    if (n > 0) parts.push(`${n} ${word}`)
  }
  return { chips, summary: parts.join(' · '), single: chips.length === 1 }
}

export const matrixCell = (
  matrix: readonly ArenaCell[],
  caseId: string,
  strategy: ConcreteStrategy,
): ArenaCell | undefined => matrix.find((c) => c.caseId === caseId && c.strategy === strategy)

// ───────────────────────────── campaigns ─────────────────────────────

export interface CampaignStateInfo {
  label: string
  tone: Tone
  /** Calm one-liner for the paused-for-quota case. */
  note: string | null
}

export function campaignStateInfo(
  state: CampaignState,
  pauseReason: string | null,
): CampaignStateInfo {
  switch (state) {
    case 'draft':
      return { label: 'Not started', tone: 'neutral', note: null }
    case 'running':
      return { label: 'Running', tone: 'active', note: null }
    case 'paused':
      if (pauseReason === 'quota')
        return {
          label: 'Paused for usage limit',
          tone: 'waiting',
          note: 'Paused for Claude usage limit. Resumes automatically.',
        }
      if (pauseReason === 'budget')
        return {
          label: 'Paused at budget',
          tone: 'waiting',
          note: 'The campaign budget was reached.',
        }
      if (pauseReason === 'restart')
        return {
          label: 'Paused after restart',
          tone: 'waiting',
          note: 'NEXUS restarted. Resume to continue the remaining trials.',
        }
      return { label: 'Paused', tone: 'waiting', note: null }
    case 'completed':
      return { label: 'Completed', tone: 'success', note: null }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', note: null }
    case 'failed':
      return { label: 'Failed', tone: 'danger', note: null }
  }
}

export interface CampaignProgress {
  passed: number
  failed: number
  running: number
  queued: number
  /** Blocked or cancelled. */
  other: number
  total: number
  finished: number
}

export function campaignProgress(
  counts: Partial<Record<TrialState, number>>,
  total: number,
): CampaignProgress {
  const c = (s: TrialState) => counts[s] ?? 0
  const passed = c('passed')
  const failed = c('failed')
  const running = c('provisioning') + c('running') + c('evaluating')
  const queued = c('queued')
  const other = c('blocked') + c('cancelled')
  return { passed, failed, running, queued, other, total, finished: passed + failed + other }
}

export function canStart(state: CampaignState): boolean {
  return state === 'draft'
}
export const canPause = (state: CampaignState): boolean => state === 'running'
export const canResume = (state: CampaignState): boolean => state === 'paused'
export const canCancel = (state: CampaignState): boolean =>
  state === 'draft' || state === 'running' || state === 'paused'

export const trialCount = (cases: number, strategies: number, repetitions: number): number =>
  Math.max(0, cases) * Math.max(0, strategies) * Math.max(0, repetitions)

export interface BudgetLine {
  preset: ArenaBudgetPreset
  label: string
  summary: string
  maxTrials: number
}

export function budgetLine(preset: ArenaBudgetPreset): BudgetLine {
  const b = ARENA_BUDGET_DEFAULTS[preset]
  const hours = b.maxWallClockMinutes / 60
  return {
    preset,
    label: preset === 'eco' ? 'Eco' : preset === 'balanced' ? 'Balanced' : 'Research',
    summary: `Up to ${b.maxTrials} trials, ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h, ${b.maxAgentSessions} sessions, ${b.maxConcurrentTrials} at a time`,
    maxTrials: b.maxTrials,
  }
}

export interface CreateCheck {
  ok: boolean
  /** Blocking problem, if any. */
  error: string | null
  /** Non-blocking note, e.g. the plan exceeds the preset's trial budget. */
  warning: string | null
}

export function checkCampaign(input: {
  name: string
  cases: number
  strategies: number
  repetitions: number
  preset: ArenaBudgetPreset
}): CreateCheck {
  if (!input.name.trim()) return { ok: false, error: 'Give the campaign a name.', warning: null }
  if (input.cases === 0) return { ok: false, error: 'Select at least one case.', warning: null }
  if (input.strategies === 0)
    return { ok: false, error: 'Select at least one strategy.', warning: null }
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 20)
    return { ok: false, error: 'Repetitions must be between 1 and 20.', warning: null }
  const trials = trialCount(input.cases, input.strategies, input.repetitions)
  const max = ARENA_BUDGET_DEFAULTS[input.preset].maxTrials
  return {
    ok: true,
    error: null,
    warning:
      trials > max
        ? `This plan has ${trials} trials but the ${budgetLine(input.preset).label} budget stops after ${max}. Later trials will not run.`
        : null,
  }
}

// ───────────────────────────── charts ─────────────────────────────

export interface Whisker {
  strategy: ConcreteStrategy
  x: number
  low: number
  high: number
  rate: number | null
  hasInterval: boolean
  n: number
}

/** Horizontal positions (0..width) of a pass-rate dot and its Wilson whisker. Scale is always 0 to 100%. */
export function whiskers(rows: readonly StrategyComparisonRow[], width: number): Whisker[] {
  const sx = (v: number) => Math.max(0, Math.min(1, v)) * width
  return rows.map((r) => ({
    strategy: r.strategy,
    x: r.passRate === null ? 0 : sx(r.passRate),
    low: r.passInterval ? sx(r.passInterval.low) : 0,
    high: r.passInterval ? sx(r.passInterval.high) : 0,
    rate: r.passRate,
    hasInterval: !!r.passInterval && r.passRate !== null,
    n: r.n,
  }))
}

// ───────────────────────────── trial metrics ─────────────────────────────

export interface MetricItem {
  label: string
  /** Text value; "Not measured" for nulls. */
  value: string
  measured: boolean
  /** Failure-bearing values get a warning emphasis in addition to their text. */
  bad: boolean
}
export interface MetricGroup {
  title: string
  items: MetricItem[]
}

const NOT_MEASURED = 'Not measured'
const flag = (label: string, v: boolean | null): MetricItem => ({
  label,
  value: v === null ? NOT_MEASURED : v ? 'Passed' : 'Failed',
  measured: v !== null,
  bad: v === false,
})
const num = (
  label: string,
  v: number | null,
  fmt: (n: number) => string = String,
  badWhenPositive = false,
): MetricItem => ({
  label,
  value: v === null ? NOT_MEASURED : fmt(v),
  measured: v !== null,
  bad: badWhenPositive && v !== null && v > 0,
})

/** All raw metrics, grouped. The composite score is deliberately not part of this list. */
export function metricGroups(m: ArenaTrialMetrics | null): MetricGroup[] {
  if (!m) return []
  return [
    {
      title: 'Correctness',
      items: [
        flag('Hidden evaluation', m.hiddenPassed),
        flag('Build', m.buildPassed),
        flag('Typecheck', m.typecheckPassed),
        flag('Tests', m.testsPassed),
        flag('Verifier', m.verifierPassed),
        {
          label: 'Acceptance criteria',
          value:
            m.acceptanceTotal === null || m.acceptancePassed === null
              ? NOT_MEASURED
              : `${m.acceptancePassed} of ${m.acceptanceTotal}`,
          measured: m.acceptanceTotal !== null && m.acceptancePassed !== null,
          bad:
            m.acceptanceTotal !== null &&
            m.acceptancePassed !== null &&
            m.acceptancePassed < m.acceptanceTotal,
        },
      ],
    },
    {
      title: 'Quality',
      items: [
        num('Critical findings', m.criticalFindings, String, true),
        num('High findings', m.highFindings, String, true),
        num('Medium findings', m.mediumFindings),
        num('Repairs', m.repairs),
      ],
    },
    {
      title: 'Efficiency',
      items: [
        num('Wall-clock time', m.wallClockMs, formatDuration),
        num('Sessions', m.sessions),
        num('Turns', m.turns),
        num('Input tokens', m.inputTokens, formatTokens),
        num('Output tokens', m.outputTokens, formatTokens),
        num('Tool calls', m.toolCalls),
      ],
    },
    {
      title: 'Autonomy',
      items: [
        num('Human interventions', m.humanInterventions),
        num('Approvals', m.approvals),
        num('Manual retries', m.manualRetries),
        num('Blockers', m.blockers),
      ],
    },
    {
      title: 'Stability',
      items: [
        num('Crashed agents', m.crashedAgents, String, true),
        num('Recovered sessions', m.recoveredSessions),
        num('Scheduler failures', m.schedulerFailures, String, true),
        num('Unfinished tasks', m.unfinishedTasks, String, true),
      ],
    },
    {
      title: 'Limit behaviour',
      items: [
        num('Quota pauses', m.quotaPauses),
        num('Quota wait', m.quotaWaitMs, formatDuration),
        num('Auto-resume successes', m.autoResumeSuccesses),
        num('Throttle events', m.throttleEvents),
      ],
    },
  ]
}

export const isTerminalTrial = (s: TrialState): boolean => TERMINAL_TRIAL_STATES.includes(s)

export interface StrategyProgress {
  strategy: string
  passed: number
  finished: number
  total: number
}

/** Passed and finished trials per strategy, from the matrix the page already loaded. Order follows `strategies`. */
export function strategyProgress(
  matrix: readonly ArenaCell[],
  strategies: readonly string[],
): StrategyProgress[] {
  return strategies.map((strategy) => {
    let passed = 0
    let finished = 0
    let total = 0
    for (const cell of matrix) {
      if (cell.strategy !== strategy) continue
      for (const t of cell.trials) {
        total += 1
        if (t.state === 'passed') passed += 1
        if (TERMINAL_TRIAL_STATES.includes(t.state)) finished += 1
      }
    }
    return { strategy, passed, finished, total }
  })
}
