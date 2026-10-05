import { humanizeKeys, strategyWord } from '../../lib/wording'
import type { RunMode } from '@shared/domain'
import { DEFAULT_SPECULATIVE_CANDIDATES, STRATEGIES, type Strategy } from '@shared/v3'
import type { PolicyPreview } from '@shared/v3-read'

export interface StrategyOption {
  value: Strategy
  label: string
  description: string
}

export const STRATEGY_OPTIONS: readonly StrategyOption[] = [
  { value: 'ADAPTIVE', label: 'Adaptive (recommended)', description: 'NEXUS picks the strategy from the task and the evidence it has measured so far.' },
  { value: 'SINGLE', label: 'Single', description: 'One worker implements the whole mission directly. No planner. Cheapest in Claude usage.' },
  { value: 'BUILD', label: 'Build', description: 'A planner makes a small task graph, then implement, review and verify each task.' },
  { value: 'SWARM', label: 'Swarm', description: 'The planner splits the work as widely as file boundaries allow, for more parallelism.' },
  { value: 'CONSENSUS', label: 'Consensus', description: 'Several planners plan independently and a synthesizer merges them. Uses more sessions.' },
  { value: 'SPECULATIVE', label: 'Speculative', description: 'Two or three candidates implement the same task in parallel; objective checks pick the winner.' },
]

export const STRATEGY_BY_VALUE: Readonly<Record<Strategy, StrategyOption>> = Object.fromEntries(
  STRATEGY_OPTIONS.map((o) => [o.value, o]),
) as Record<Strategy, StrategyOption>

export const DEFAULT_STRATEGY: Strategy = 'ADAPTIVE'
export const SPECULATIVE_USAGE_NOTE = 'Speculative runs implement the same task several times, so it uses more Claude usage.'
export const ADAPTIVE_FALLBACK_TEXT = 'Adaptive picks a strategy when the mission starts.'

export function isStrategy(v: string): v is Strategy {
  return (STRATEGIES as readonly string[]).includes(v)
}

/** Ask and audit are read-only and have no strategy. */
export function strategyApplies(mode: RunMode): boolean {
  return mode !== 'ask' && mode !== 'audit'
}

/** Fields to merge into runs.create. Empty for read-only modes. */
export function strategyFields(
  mode: RunMode,
  strategy: Strategy,
  candidates: number,
): { strategy?: Strategy; speculativeCandidates?: number } {
  if (!strategyApplies(mode)) return {}
  const out: { strategy?: Strategy; speculativeCandidates?: number } = { strategy }
  if (strategy === 'SPECULATIVE') out.speculativeCandidates = Math.min(3, Math.max(DEFAULT_SPECULATIVE_CANDIDATES, Math.round(candidates)))
  return out
}

export interface PreviewText {
  headline: string
  evidence: string | null
  reason: string | null
}

/** Text for the Adaptive preview. Null preview (loading, error, unavailable) degrades to the fallback line. */
export function previewText(preview: PolicyPreview | null | undefined): PreviewText {
  if (!preview) return { headline: ADAPTIVE_FALLBACK_TEXT, evidence: null, reason: null }
  const d = preview.decision
  const row = d.evidenceSummary.find((r) => r.strategy === d.strategy)
  const evidence =
    row && !row.suppressed && row.label !== 'INSUFFICIENT' ? `Evidence: ${row.label.toLowerCase()}` : 'No evidence yet, default policy'
  return { headline: `Adaptive would choose ${strategyWord(d.strategy)}`, evidence, reason: humanizeKeys(d.reason) }
}
