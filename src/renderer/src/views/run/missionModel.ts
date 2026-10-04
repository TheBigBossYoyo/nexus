import type { Run } from '@shared/domain'
import type {
  CandidateResult,
  DecisionLayer,
  EvidenceLabel,
  EvidenceSummaryRow,
  PolicyDecision,
  RunStrategyInfo,
  TournamentDecision,
  UsageOverview,
} from '@shared/v3'
import type { RunPolicyInfo, SpeculativeDetail } from '@shared/v3-read'
import { DASH, formatCount, formatDuration, formatTokens } from '../../lib/format'
import { clockText, exactResetAt, untilText } from '../../lib/usageModel'

/**
 * Pure view models for Mission Control (header, policy popover, candidates, quota state).
 * No DOM, no store: everything is derived from the data the backend returned.
 */

const TITLE_MAX = 96

/** First non-empty line of the prompt, shortened for a page title. */
export function missionTitle(prompt: string): string {
  const line =
    prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'Untitled mission'
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** True when the prompt has more to show than the title does. */
export function promptHasMore(prompt: string): boolean {
  const lines = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.length > 1 || (lines[0]?.length ?? 0) > TITLE_MAX
}

export interface StrategyChip {
  /** Resolved strategy, upper case; null for runs created before 0.3. */
  label: string | null
  /** "requested ADAPTIVE" when what ran differs from what was asked for. */
  hint: string | null
}

export function strategyChip(info: RunStrategyInfo | null | undefined): StrategyChip {
  if (!info) return { label: null, hint: null }
  return {
    label: info.resolved,
    hint: info.requested !== info.resolved ? `requested ${info.requested}` : null,
  }
}

export const LAYER_LABEL: Record<DecisionLayer, string> = {
  default: 'Default policy',
  evidence: 'Evidence',
  exploration: 'Exploration',
  user: 'Chosen by you',
}

export const LAYER_EXPLANATION: Record<DecisionLayer, string> = {
  default: 'No evidence was strong enough, so the built-in default for this kind of task was used.',
  evidence: 'Stored results for similar tasks favoured this strategy.',
  exploration: 'A less-tested strategy was tried on purpose to gather evidence.',
  user: 'The strategy was set explicitly, not by the adaptive policy.',
}

export const EVIDENCE_LABEL_TEXT: Record<EvidenceLabel, string> = {
  INSUFFICIENT: 'Insufficient',
  WEAK: 'Weak',
  MODERATE: 'Moderate',
  STRONG: 'Strong',
}

export interface EvidenceRowView {
  strategy: string
  chosen: boolean
  arena: string
  missions: string
  passRate: string
  label: string
  suppressed: boolean
}

const countText = (n: number, passes: number) => (n === 0 ? DASH : `n=${n}, ${passes} passed`)

/** Arena trials and real missions are shown separately, never pooled. */
export function evidenceRows(summary: readonly EvidenceSummaryRow[], chosen: string): EvidenceRowView[] {
  return summary.map((r) => ({
    strategy: r.strategy,
    chosen: r.strategy === chosen,
    arena: countText(r.arenaN, r.arenaSuccesses),
    missions: countText(r.missionN, r.missionSuccesses),
    passRate: r.passRate === null ? DASH : `${Math.round(r.passRate * 100)}%`,
    label: EVIDENCE_LABEL_TEXT[r.label],
    suppressed: r.suppressed,
  }))
}

export interface PolicyView {
  kind: 'decision' | 'user' | 'none'
  headline: string
  layer: string | null
  layerNote: string | null
  reason: string | null
  version: string | null
  exploration: boolean
  evidence: EvidenceRowView[]
  resourceNotes: string[]
  profile: string | null
}

/** What to show in "Why this strategy?". Says plainly when there is no policy decision. */
export function policyView(info: RunPolicyInfo | null | undefined): PolicyView {
  const strategy = info?.strategy ?? null
  const decision: PolicyDecision | null = info?.decision ?? null
  const empty = {
    layer: null,
    layerNote: null,
    reason: null,
    version: null,
    exploration: false,
    evidence: [],
    resourceNotes: [],
    profile: null,
  }
  if (!decision) {
    if (!strategy) {
      return {
        kind: 'none',
        headline: 'No strategy was recorded for this mission (it was created before NEXUS 0.3).',
        ...empty,
      }
    }
    return {
      kind: 'user',
      headline: `Strategy ${strategy.resolved} was chosen by you. The adaptive policy was not consulted.`,
      ...empty,
    }
  }
  const key = info?.profile?.contextKey ?? decision.contextKey
  const [category, complexity, risk] = key.split('|')
  return {
    kind: 'decision',
    headline: `Policy chose ${decision.strategy}`,
    layer: LAYER_LABEL[decision.layer],
    layerNote: LAYER_EXPLANATION[decision.layer],
    reason: decision.reason,
    version: `Policy v${decision.policyVersion}`,
    exploration: decision.exploration,
    evidence: evidenceRows(decision.evidenceSummary, decision.strategy),
    resourceNotes: decision.resourceNotes,
    profile: category && complexity && risk ? `${category} · ${complexity} complexity · ${risk} risk` : null,
  }
}

// ───────────────────────────── quota-paused state ─────────────────────────────

export interface QuotaStateView {
  title: string
  lines: string[]
}

/** Calm text for a run paused by the Claude usage limit. Reset time only when the runtime reported one. */
export function quotaState(
  run: Pick<Run, 'state' | 'pauseReason'>,
  overview: UsageOverview | null | undefined,
  now: number,
): QuotaStateView | null {
  if (run.state !== 'paused' || run.pauseReason !== 'quota') return null
  const lines: string[] = [
    'No work has been lost. Finished tasks are kept and unfinished work resumes from its last checkpoint.',
  ]
  if (!overview) {
    lines.unshift('Waiting for the Claude usage limit to clear. The reset time is not known yet.')
    return { title: 'Paused: Claude usage limit reached', lines }
  }
  const reset = exactResetAt(overview)
  if (reset) {
    const left = untilText(reset, now)
    lines.unshift(`Claude reports the limit resets at ${clockText(reset, now)}${left ? ` (in ${left})` : ''}.`)
  } else {
    lines.unshift('Claude did not report when the limit resets.')
  }
  const auto = overview.autoResume
  const next = auto.nextCheckAt.value
  if (auto.enabled) {
    lines.push(
      next
        ? `Automatic resume is on. Next check at ${clockText(next, now)}.`
        : 'Automatic resume is on. NEXUS will check periodically.',
    )
  } else {
    lines.push('Automatic resume is off. Resume the mission yourself when you are ready.')
  }
  return { title: 'Paused: Claude usage limit reached', lines }
}

// ───────────────────────────── speculative candidates ─────────────────────────────

export type CandidateOutcome = 'Winner' | 'Rejected' | 'Failed' | 'Running'

export interface CandidateRowView {
  id: string
  label: string
  outcome: CandidateOutcome
  checks: string
  files: string
  lines: string
  duration: string
  tokens: string
  hasDiff: boolean
  diffPatch: string | null
}

export interface ComparisonView {
  criterion: string
  summary: string
  detail: string
}

export interface TournamentView {
  speculativeRunId: string
  taskId: string
  state: string
  candidates: CandidateRowView[]
  decision: null | {
    winner: string
    confidence: string
    reason: string
    comparisons: ComparisonView[]
  }
}

const OUTCOME: Record<CandidateResult['outcome'], CandidateOutcome> = {
  winner: 'Winner',
  rejected: 'Rejected',
  failed: 'Failed',
  pending: 'Running',
}

const CONFIDENCE_TEXT: Record<TournamentDecision['confidence'], string> = {
  decisive: 'Decisive: separated by a correctness rule',
  marginal: 'Marginal: separated only by size or label',
  none: 'No candidate produced a usable result',
}

export function candidateRow(c: CandidateResult): CandidateRowView {
  const e = c.evidence
  const checks =
    e.checksPassed === null
      ? DASH
      : e.checksPassed
        ? 'Passed'
        : `Failed${e.checksFailedCount ? ` (${e.checksFailedCount})` : ''}`
  const tokens =
    e.inputTokens === null && e.outputTokens === null
      ? DASH
      : `${formatTokens(e.inputTokens)} in / ${formatTokens(e.outputTokens)} out`
  return {
    id: c.id,
    label: c.label.toUpperCase(),
    outcome: OUTCOME[c.outcome],
    checks,
    files: e.filesChanged === null ? DASH : formatCount(e.filesChanged),
    lines: e.linesChanged === null ? DASH : formatCount(e.linesChanged),
    duration: formatDuration(e.durationMs),
    tokens,
    hasDiff: c.outcome !== 'winner' && !!c.diffPatch && c.diffPatch.trim().length > 0,
    diffPatch: c.diffPatch,
  }
}

export function tournaments(detail: SpeculativeDetail | null | undefined): TournamentView[] {
  if (!detail) return []
  return detail.runs.map((r) => {
    const candidates = detail.candidates
      .filter((c) => c.speculativeRunId === r.id)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(candidateRow)
    const d = detail.decisions.find((x) => x.speculativeRunId === r.id)
    return {
      speculativeRunId: r.id,
      taskId: r.taskId,
      state: r.state,
      candidates,
      decision: d
        ? {
            winner: d.winnerLabel ? d.winnerLabel.toUpperCase() : 'None',
            confidence: CONFIDENCE_TEXT[d.confidence],
            reason: d.reason,
            comparisons: d.comparisons.map((x) => ({
              criterion: x.criterion,
              summary: `${x.better.toUpperCase()} over ${x.worse.toUpperCase()}`,
              detail: x.detail,
            })),
          }
        : null,
    }
  })
}

// ───────────────────────────── usage tab ─────────────────────────────

export interface UsageRowView {
  key: string
  label: string
  sessions: string
  turns: string
  input: string
  output: string
  duration: string
}

export function usageRows(
  rows: readonly {
    key: string
    label: string
    sessions: number
    turns: number
    inputTokens: number
    outputTokens: number
    durationMs: number
  }[],
): UsageRowView[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    sessions: formatCount(r.sessions),
    turns: formatCount(r.turns),
    input: formatTokens(r.inputTokens),
    output: formatTokens(r.outputTokens),
    duration: formatDuration(r.durationMs),
  }))
}

/** "Resumed · 3 probes · reset 14:20" style summary of one quota pause. */
export function pauseSummary(
  p: {
    probes: number
    resetAt: string | null
    resetConfidence: string
    endedAt: string | null
    endReason: string | null
    resumes: { result: string }[]
  },
  now: number,
): string {
  const parts: string[] = []
  parts.push(
    p.endedAt
      ? p.resumes.some((r) => r.result === 'resumed')
        ? 'Resumed'
        : `Ended${p.endReason ? ` (${p.endReason})` : ''}`
      : 'Waiting',
  )
  parts.push(p.probes === 1 ? '1 probe' : `${p.probes} probes`)
  parts.push(p.resetAt && p.resetConfidence === 'EXACT' ? `reset ${clockText(p.resetAt, now)}` : 'reset time not reported')
  return parts.join(' · ')
}
