import { TERMINAL_RUN_STATES, type Run } from '@shared/domain'
import {
  usageStatusLabel,
  type Confidence,
  type UsageBreakdownRow,
  type UsageEvent,
  type UsageOverview,
  type UsageStatus,
  type UsageTotals,
  type UsageWindow,
} from '@shared/v3'
import type {
  QuotaPauseWithResumes,
  StrategyEfficiencyRow,
  UsageLimitHistory,
} from '@shared/v3-read'
import { canShowPercent } from '../../lib/measured'
import { exactResetAt } from '../../lib/usageModel'
import type { Tone } from '../../lib/status'

/**
 * Pure view-model for the Usage page. The binding rule: a percentage exists in this model only when the runtime
 * supplied it (EXACT measured value, or a non-null UsageWindow.utilizationPercent). Observed token counts never
 * get a denominator, a percentage or a bar.
 */

export const NOT_EXPOSED = 'Not exposed by Claude runtime'
export const SUBSCRIPTION_NOTE =
  'NEXUS can measure its own observed Claude usage, but this Claude runtime does not expose total subscription capacity.'

// ───────────────────────────── subscription ─────────────────────────────

export type SubscriptionRemaining =
  { kind: 'percent'; percent: number; confidence: Confidence } | { kind: 'unknown'; reason: string }

/** "Subscription remaining": only an EXACT runtime percentage is ever a number. */
export function subscriptionRemaining(o: UsageOverview | null | undefined): SubscriptionRemaining {
  const m = o?.subscriptionUtilizationPercent
  if (m && canShowPercent(m) && m.value !== null && m.value >= 0 && m.value <= 100) {
    return { kind: 'percent', percent: m.value, confidence: 'EXACT' }
  }
  return { kind: 'unknown', reason: NOT_EXPOSED }
}

/** True only when a figure about the plan may be drawn as a percentage or bar. */
export function mayDrawPlanPercent(o: UsageOverview | null | undefined): boolean {
  return subscriptionRemaining(o).kind === 'percent'
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  seven_day_opus: '7-day window (Opus)',
  seven_day_sonnet: '7-day window (Sonnet)',
  overage: 'Overage',
}

export function windowName(limitType: string): string {
  return WINDOW_NAMES[limitType] ?? limitType.replace(/_/g, ' ')
}

const WINDOW_STATUS: Record<UsageWindow['status'], { label: string; tone: Tone }> = {
  allowed: { label: 'Allowed', tone: 'success' },
  allowed_warning: { label: 'Warning', tone: 'warning' },
  rejected: { label: 'Limit reached', tone: 'danger' },
  unknown: { label: 'Not reported', tone: 'neutral' },
}

export interface WindowRow {
  id: string
  name: string
  statusLabel: string
  tone: Tone
  /** Non-null only when the runtime supplied a documented percentage. Drives the bar. */
  percent: number | null
  resetAt: string | null
  confidence: Confidence
  source: UsageWindow['source']
}

export function windowRows(windows: readonly UsageWindow[]): WindowRow[] {
  return windows.map((w) => {
    const st = WINDOW_STATUS[w.status]
    const p = w.utilizationPercent
    return {
      id: w.id,
      name: windowName(w.limitType),
      statusLabel: st.label,
      tone: st.tone,
      percent: typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
      resetAt: w.resetAt,
      confidence: w.confidence,
      source: w.source,
    }
  })
}

// ───────────────────────────── header and status ─────────────────────────────

export interface UsageHeaderModel {
  statusLabel: string
  status: UsageStatus | null
  tone: Tone
  autoResume: 'Enabled' | 'Disabled' | null
  /** The reset time to display, or null (rendered "Unknown"). EXACT only. */
  nextReset: string | null
  waiting: boolean
}

const STATUS_TONE: Record<UsageStatus, Tone> = {
  AVAILABLE: 'success',
  LIMIT_APPROACHING: 'warning',
  THROTTLED: 'warning',
  QUOTA_PAUSED: 'waiting',
  WAITING_FOR_RESET: 'waiting',
  PROBING: 'waiting',
  AUTH_REQUIRED: 'danger',
  RUNTIME_UNAVAILABLE: 'danger',
}

export const isWaitingStatus = (s: UsageStatus): boolean =>
  s === 'QUOTA_PAUSED' || s === 'WAITING_FOR_RESET' || s === 'PROBING'

export function usageHeader(o: UsageOverview | null | undefined): UsageHeaderModel {
  if (!o)
    return {
      statusLabel: 'Status unknown',
      status: null,
      tone: 'neutral',
      autoResume: null,
      nextReset: null,
      waiting: false,
    }
  return {
    statusLabel: usageStatusLabel(o.status),
    status: o.status,
    tone: STATUS_TONE[o.status],
    autoResume: o.autoResume.enabled ? 'Enabled' : 'Disabled',
    nextReset: exactResetAt(o),
    waiting: isWaitingStatus(o.status),
  }
}

/** Account mode as the runtime reported it, in plain words. */
export function accountModeText(o: UsageOverview): string | null {
  const v = o.accountMode.value
  if (!v) return null
  const map: Record<string, string> = {
    subscription: 'Subscription',
    api_key: 'API key',
    third_party: 'Third-party provider',
    unknown: 'Unknown',
  }
  return map[v] ?? v
}

export function subscriptionTypeText(o: UsageOverview): string | null {
  const v = o.subscriptionType.value
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : null
}

export function isEmptyTotals(t: UsageTotals): boolean {
  return (
    t.sessions === 0 &&
    t.turns === 0 &&
    t.inputTokens === 0 &&
    t.outputTokens === 0 &&
    t.limitEvents === 0
  )
}

// ───────────────────────────── current run ─────────────────────────────

/** The selected run, else the most recent active run, else null. */
export function pickCurrentRun(selectedRunId: string | null, runs: readonly Run[]): string | null {
  if (selectedRunId) return selectedRunId
  const active = runs
    .filter((r) => !TERMINAL_RUN_STATES.includes(r.state))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return active[0]?.id ?? null
}

// ───────────────────────────── history chart ─────────────────────────────

export const HISTORY_RANGES = [7, 30, 90] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

export interface DayPoint {
  day: string
  inputTokens: number
  outputTokens: number
  /** Observed input + output. Never compared with a capacity. */
  total: number
  sessions: number
  limitEvents: number
}

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** One point per local day, oldest first, ending today. Days without observations are zeros. */
export function dailySeries(
  rows: readonly UsageBreakdownRow[],
  sinceDays: number,
  today: Date,
): DayPoint[] {
  const byDay = new Map(rows.map((r) => [r.key, r]))
  const out: DayPoint[] = []
  for (let i = sinceDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const day = dayKey(d)
    const r = byDay.get(day)
    out.push({
      day,
      inputTokens: r?.inputTokens ?? 0,
      outputTokens: r?.outputTokens ?? 0,
      total: (r?.inputTokens ?? 0) + (r?.outputTokens ?? 0),
      sessions: r?.sessions ?? 0,
      limitEvents: r?.limitEvents ?? 0,
    })
  }
  return out
}

/** Round a maximum up to 1, 2, 2.5, 5 x 10^k so axis ticks are readable. 0 maps to 1. */
export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const exp = Math.floor(Math.log10(max))
  const base = 10 ** exp
  const m = max / base
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return step * base
}

export interface ChartGeometry {
  max: number
  ticks: number[]
  bars: { x: number; y: number; w: number; h: number; day: string; index: number }[]
  /** Indices of days that get an x-axis label. */
  labelIndices: number[]
}

/** Bar geometry inside a plot area. Pure arithmetic; heights are relative to the visible axis maximum only. */
export function chartGeometry(
  points: readonly DayPoint[],
  plotW: number,
  plotH: number,
): ChartGeometry {
  const max = niceCeil(Math.max(0, ...points.map((p) => p.total)))
  const n = Math.max(1, points.length)
  const slot = plotW / n
  const w = Math.max(2, Math.min(28, slot * 0.62))
  const bars = points.map((p, index) => {
    const h = p.total <= 0 ? 0 : Math.max(1.5, (p.total / max) * plotH)
    return { x: index * slot + (slot - w) / 2, y: plotH - h, w, h, day: p.day, index }
  })
  const every = n <= 7 ? 1 : n <= 30 ? 5 : 15
  const labelIndices = points.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0)
  return { max, ticks: [0, max / 2, max], bars, labelIndices }
}

// ───────────────────────────── breakdown tabs ─────────────────────────────

export const BREAKDOWN_TABS = [
  { id: 'run', label: 'By mission' },
  { id: 'model', label: 'By model' },
  { id: 'strategy', label: 'By strategy' },
  { id: 'role', label: 'By role' },
] as const
export type BreakdownTab = (typeof BREAKDOWN_TABS)[number]['id']

/** Sort by observed tokens, largest first. Does not mutate. */
export function sortBreakdown(rows: readonly UsageBreakdownRow[]): UsageBreakdownRow[] {
  return [...rows].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
}

export function breakdownLabel(by: BreakdownTab, row: UsageBreakdownRow): string {
  if (by === 'strategy')
    return row.label ? row.label.charAt(0) + row.label.slice(1).toLowerCase() : 'No strategy'
  if (by === 'role') return row.label ? row.label.replace(/_/g, ' ') : 'No role'
  return row.label || row.key || 'Unknown'
}

// ───────────────────────────── limit events ─────────────────────────────

export interface LimitRow {
  id: string
  kind: 'pause' | 'signal'
  at: string
  run: string
  /** Plain state text. */
  state: string
  tone: Tone
  /** "14:05" only when the reset was reported as EXACT; null renders "Not reported". */
  resetAt: string | null
  pausedMs: number | null
  probes: number
  methods: string[]
  result: string
}

const PAUSE_STATE: Record<QuotaPauseWithResumes['state'], { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting for reset', tone: 'waiting' },
  probing: { label: 'Checking availability', tone: 'waiting' },
  resumed: { label: 'Resumed', tone: 'success' },
  ended: { label: 'Ended', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

const METHOD_LABEL = {
  usage_report: 'Usage report',
  minimal_session: 'Minimal session',
  none: 'None',
} as const
const RESULT_LABEL = {
  available: 'Claude available',
  still_limited: 'Still limited',
  resumed: 'Resumed automatically',
  failed: 'Check failed',
  skipped: 'Skipped',
} as const

export function pauseRow(p: QuotaPauseWithResumes, now: number): LimitRow {
  const st = PAUSE_STATE[p.state]
  const probes = p.resumes.filter((r) => r.kind === 'probe')
  const methods = [
    ...new Set(p.resumes.filter((r) => r.method !== 'none').map((r) => METHOD_LABEL[r.method])),
  ]
  const last = [...p.resumes].sort(
    (a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt),
  )[0]
  let result: string
  if (p.state === 'resumed') result = last ? RESULT_LABEL[last.result] : 'Resumed'
  else if (p.state === 'waiting' || p.state === 'probing')
    result = last ? `Last check: ${RESULT_LABEL[last.result].toLowerCase()}` : 'No check yet'
  else result = p.endReason ? `Ended: ${p.endReason}` : 'Ended without resume'
  const end = p.endedAt ? Date.parse(p.endedAt) : now
  const start = Date.parse(p.pausedAt)
  return {
    id: p.id,
    kind: 'pause',
    at: p.pausedAt,
    run: p.runId ? (p.runLabel ?? 'Mission') : 'All runs',
    state: st.label,
    tone: st.tone,
    // A reset time is shown only when the runtime reported it.
    resetAt: p.resetConfidence === 'EXACT' ? p.resetAt : null,
    pausedMs: Number.isFinite(end - start) ? Math.max(0, end - start) : null,
    probes: Math.max(p.probes, probes.length),
    methods,
    result,
  }
}

const SIGNAL_TEXT: Partial<Record<UsageEvent['eventType'], { label: string; tone: Tone }>> = {
  limit_warning: { label: 'Limit warning', tone: 'warning' },
  throttle: { label: 'Throttled', tone: 'warning' },
  auth: { label: 'Sign-in required', tone: 'danger' },
  runtime_error: { label: 'Runtime unavailable', tone: 'danger' },
}

export function limitRows(pages: readonly UsageLimitHistory[], now: number): LimitRow[] {
  const rows = new Map<string, LimitRow>()
  for (const page of pages) {
    for (const p of page.pauses) rows.set(p.id, pauseRow(p, now))
    for (const e of page.events) {
      const s = SIGNAL_TEXT[e.eventType]
      // A rejection is already the start of a pause row; only other signals appear on their own.
      if (!s) continue
      rows.set(e.id, {
        id: e.id,
        kind: 'signal',
        at: e.createdAt,
        run: e.runId ? 'Mission' : 'Application',
        state: s.label,
        tone: s.tone,
        resetAt: e.confidence === 'EXACT' ? e.resetAt : null,
        pausedMs: null,
        probes: 0,
        methods: [],
        result: '—',
      })
    }
  }
  return [...rows.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

// ───────────────────────────── efficiency ─────────────────────────────

export function strategyTitle(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase()
}

export interface EfficiencyGroup {
  kind: 'arena' | 'mission'
  title: string
  rows: StrategyEfficiencyRow[]
}

/** Arena trials (controlled) and real missions (observational) are separate groups, never pooled. */
export function efficiencyGroups(rows: readonly StrategyEfficiencyRow[]): EfficiencyGroup[] {
  const order = ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE']
  const by = (kind: 'arena' | 'mission') =>
    rows
      .filter((r) => r.kind === kind)
      .sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy))
  const groups: EfficiencyGroup[] = [
    { kind: 'arena', title: 'Arena: controlled experiments', rows: by('arena') },
    { kind: 'mission', title: 'Real missions: observational evidence', rows: by('mission') },
  ]
  return groups.filter((g) => g.rows.length > 0)
}
