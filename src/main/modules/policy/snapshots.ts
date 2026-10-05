import {
  contextFallbacks,
  type ConcreteStrategy,
  type PolicyCandidate,
  type PolicyConfig,
  type PolicySnapshot,
  type StrategyPreference,
} from '@shared/v3'
import type { PolicyDiff, PolicySnapshotSummary } from '@shared/v3-read'
import { defaultStrategy } from './defaults'

/**
 * Pure operations on immutable policy snapshots. A "change" is always a new snapshot value; nothing here
 * mutates its input.
 */

export const summarizeSnapshot = (s: PolicySnapshot): PolicySnapshotSummary => ({
  id: s.id,
  version: s.version,
  createdAt: s.createdAt,
  origin: s.origin,
  preferences: s.preferences.length,
  note: s.note,
})

/**
 * The preference that applies to a context: the most specific one along the fallback chain. A SPECULATIVE
 * preference is inert while the speculation policy is OFF.
 */
export function preferenceFor(snapshot: PolicySnapshot, contextKey: string): StrategyPreference | null {
  for (const key of contextFallbacks(contextKey)) {
    const pref = snapshot.preferences.find((p) => p.contextKey === key)
    if (!pref) continue
    if (pref.strategy === 'SPECULATIVE' && snapshot.config.speculation === 'OFF') continue
    return pref
  }
  return null
}

/** DEFAULT then EVIDENCE OVERRIDE only: what the snapshot says before exploration and availability. */
export function baseStrategyFor(snapshot: PolicySnapshot, contextKey: string): ConcreteStrategy {
  return preferenceFor(snapshot, contextKey)?.strategy ?? defaultStrategy(contextKey)
}

export interface PromotionOptions {
  id: string
  version: number
  now: string
  routing?: Record<string, string>
  note?: string | null
}

/** The snapshot that results from promoting a candidate on top of `base`. */
export function applyPromotion(
  base: PolicySnapshot,
  candidate: Pick<PolicyCandidate, 'id' | 'contextKey' | 'toStrategy' | 'arenaTrials' | 'missions' | 'label' | 'reason'>,
  opts: PromotionOptions,
): PolicySnapshot {
  const rest = base.preferences.filter((p) => p.contextKey !== candidate.contextKey)
  const replaces = defaultStrategy(candidate.contextKey)
  // Promoting the default itself removes the preference: the default is what an absent preference means.
  const added: StrategyPreference[] =
    candidate.toStrategy === replaces
      ? []
      : [
          {
            contextKey: candidate.contextKey,
            strategy: candidate.toStrategy,
            replaces,
            reason: candidate.reason,
            evidence: { arenaTrials: candidate.arenaTrials, missions: candidate.missions, label: candidate.label },
            candidateId: candidate.id,
          },
        ]
  return {
    id: opts.id,
    version: opts.version,
    createdAt: opts.now,
    origin: 'promotion',
    parentId: base.id,
    preferences: [...rest, ...added].sort((a, b) => a.contextKey.localeCompare(b.contextKey)),
    config: { ...base.config },
    routing: opts.routing ?? { ...base.routing },
    note: opts.note ?? `Promoted ${candidate.toStrategy} for ${candidate.contextKey}`,
  }
}

/** A new snapshot with changed settings (origin `config`). */
export function applyConfig(
  base: PolicySnapshot,
  patch: Partial<PolicyConfig>,
  opts: PromotionOptions,
): PolicySnapshot {
  return {
    id: opts.id,
    version: opts.version,
    createdAt: opts.now,
    origin: 'config',
    parentId: base.id,
    preferences: base.preferences.map((p) => ({ ...p })),
    config: { ...base.config, ...patch },
    routing: opts.routing ?? { ...base.routing },
    note: opts.note ?? null,
  }
}

export function diffSnapshots(a: PolicySnapshot, b: PolicySnapshot): PolicyDiff {
  const byA = new Map(a.preferences.map((p) => [p.contextKey, p]))
  const byB = new Map(b.preferences.map((p) => [p.contextKey, p]))
  const added = b.preferences.filter((p) => !byA.has(p.contextKey))
  const removed = a.preferences.filter((p) => !byB.has(p.contextKey))
  const changed: PolicyDiff['changed'] = []
  for (const [key, pa] of byA) {
    const pb = byB.get(key)
    if (pb && pb.strategy !== pa.strategy) changed.push({ contextKey: key, from: pa.strategy, to: pb.strategy })
  }
  const config: PolicyDiff['config'] = []
  for (const field of Object.keys(b.config) as (keyof PolicyConfig)[]) {
    if (a.config[field] !== b.config[field]) config.push({ field, from: String(a.config[field]), to: String(b.config[field]) })
  }
  return { a: summarizeSnapshot(a), b: summarizeSnapshot(b), added, removed, changed, config }
}
