import type {
  ConcreteStrategy,
  DecisionLayer,
  EvidenceSummaryRow,
  ExplorationMode,
  PolicyPromotion,
  SpeculationPolicy,
  StrategyPreference,
} from '@shared/v3'
import type { PolicyDiff, PolicySnapshotSummary } from '@shared/v3-read'
import { strategyName } from '../arena/arenaModel'
import { contextWords } from '../../lib/wording'

/** Pure presentation rules for the Adaptive policy page. */


/** `bugfix|medium|low` becomes "Bugfix · medium complexity · low risk". Wildcards read as "any". */
export const formatContextKey = contextWords

export const EXPLORATION_OPTIONS: readonly { value: ExplorationMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'conservative', label: 'Conservative' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'research', label: 'Research' },
]

export const EXPLORATION_HINT: Record<ExplorationMode, string> = {
  off: 'Always use the preferred strategy.',
  conservative: 'Occasionally (about 5%) tries another strategy to keep evidence fresh.',
  balanced: 'Tries another strategy about 15% of the time.',
  research: 'Tries another strategy about 40% of the time. Gathers evidence fastest, costs more.',
}

export const SPECULATION_OPTIONS: readonly { value: SpeculationPolicy; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'ALWAYS_FOR_HIGH_RISK', label: 'Always for high risk' },
]

export const LAYER_LABEL: Record<DecisionLayer, string> = {
  default: 'Default',
  evidence: 'Evidence',
  exploration: 'Exploration',
  user: 'User',
}

/** "SWARM → BUILD" reads as "Swarm → Build". */
export const switchText = (from: ConcreteStrategy, to: ConcreteStrategy): string =>
  `${strategyName(from)} → ${strategyName(to)}`

export const EPISTEMIC_LINE =
  'Arena: controlled experiment · Mission history: observational evidence'

export function evidenceRowText(r: EvidenceSummaryRow): { arena: string; missions: string } {
  return {
    arena: r.arenaN === 0 ? '—' : `${r.arenaSuccesses}/${r.arenaN}`,
    missions: r.missionN === 0 ? '—' : `${r.missionSuccesses}/${r.missionN}`,
  }
}

const ACTION_TEXT: Record<PolicyPromotion['action'], string> = {
  promote: 'Promoted a candidate',
  reject: 'Rejected a candidate',
  rollback: 'Rolled back',
  pin: 'Pinned a snapshot',
  unpin: 'Unpinned',
  config: 'Changed settings',
}
export const actionText = (a: PolicyPromotion['action']): string => ACTION_TEXT[a]

export function snapshotLabel(s: PolicySnapshotSummary): string {
  return `v${s.version} · ${s.origin}`
}

export interface DiffLine {
  kind: 'added' | 'removed' | 'changed' | 'config'
  text: string
}

export function diffLines(d: PolicyDiff): DiffLine[] {
  const pref = (p: StrategyPreference) =>
    `${formatContextKey(p.contextKey)}: ${strategyName(p.strategy)}`
  return [
    ...d.added.map((p): DiffLine => ({ kind: 'added', text: pref(p) })),
    ...d.removed.map((p): DiffLine => ({ kind: 'removed', text: pref(p) })),
    ...d.changed.map((c): DiffLine => ({
      kind: 'changed',
      text: `${formatContextKey(c.contextKey)}: ${switchText(c.from, c.to)}`,
    })),
    ...d.config.map((c): DiffLine => ({ kind: 'config', text: `${c.field}: ${c.from} → ${c.to}` })),
  ]
}

/** Rollback needs a previous snapshot that differs from the active one. */
export function canRollback(pointer: { activeId: string; previousId: string | null }): boolean {
  return !!pointer.previousId && pointer.previousId !== pointer.activeId
}

export const SHADOW_NOTE = 'A sanity check on stored task profiles, not an effect estimate.'
