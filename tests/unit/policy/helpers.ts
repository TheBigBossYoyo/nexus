import { DEFAULT_SETTINGS } from '@shared/settings'
import {
  DEFAULT_POLICY_CONFIG,
  type ConcreteStrategy,
  type PolicyConfig,
  type PolicySnapshot,
  type StrategyPreference,
  type StrategyStatistic,
} from '@shared/v3'
import { aggregateEvidence, featuresForContext, syntheticTrial, type DecideInput, type EvidenceTrial } from '@main/modules/policy'

export const NOW = Date.UTC(2026, 5, 1)
export const DAY = 86_400_000

export interface Cell {
  pass: number
  fail: number
  sessions?: number
  durationMs?: number
  /** Days before NOW. */
  ageDays?: number
  crashed?: number
  /** Blocked by the harness (excluded from evidence). */
  infra?: number
  /** Distinct Arena cases the trials rotate through (default 5). */
  cases?: number
  models?: Record<string, string>
}

/** Arena trials for one context, from a compact spec. */
export function trialsFor(contextKey: string, spec: Partial<Record<ConcreteStrategy, Cell>>, prefix = 't'): EvidenceTrial[] {
  const out: EvidenceTrial[] = []
  for (const [strategy, cell] of Object.entries(spec) as [ConcreteStrategy, Cell][]) {
    const at = NOW - (cell.ageDays ?? 0) * DAY
    const total = cell.pass + cell.fail + (cell.crashed ?? 0) + (cell.infra ?? 0)
    for (let i = 0; i < total; i++) {
      const crashed = i >= cell.pass + cell.fail && i < cell.pass + cell.fail + (cell.crashed ?? 0)
      const infrastructure = i >= cell.pass + cell.fail + (cell.crashed ?? 0)
      out.push(
        syntheticTrial({
          id: `${prefix}-${contextKey}-${strategy}-${i}`,
          contextKey,
          strategy,
          passed: i < cell.pass,
          crashed,
          infrastructure,
          caseId: `case-${contextKey}-${i % (cell.cases ?? 5)}`,
          sessions: cell.sessions,
          durationMs: cell.durationMs,
          at,
          models: cell.models,
        }),
      )
    }
  }
  return out
}

export function statsFor(
  contextKey: string,
  spec: Partial<Record<ConcreteStrategy, Cell>>,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
): StrategyStatistic[] {
  return aggregateEvidence({ trials: trialsFor(contextKey, spec), outcomes: [], config, now: NOW, currentModels: {} })
}

export function snapshot(over: Partial<PolicySnapshot> = {}, prefs: StrategyPreference[] = [], config: Partial<PolicyConfig> = {}): PolicySnapshot {
  return {
    id: 'snap-test',
    version: 1,
    createdAt: new Date(NOW).toISOString(),
    origin: 'default',
    parentId: null,
    preferences: prefs,
    config: { ...DEFAULT_POLICY_CONFIG, exploration: 'off', ...config },
    routing: {},
    note: null,
    ...over,
  }
}

export const pref = (contextKey: string, strategy: ConcreteStrategy, replaces: ConcreteStrategy = 'BUILD'): StrategyPreference => ({
  contextKey,
  strategy,
  replaces,
  reason: 'test',
  evidence: { arenaTrials: 20, missions: 0, label: 'MODERATE' },
  candidateId: null,
})

export function decideInput(contextKey: string, over: Partial<DecideInput> = {}): DecideInput {
  return {
    profile: { id: 'p1', projectId: 'proj', runId: null, contextKey, features: featuresForContext(contextKey) },
    snapshot: snapshot(),
    stats: [],
    seed: 1,
    usageStatus: 'AVAILABLE',
    recentLimit: false,
    preset: 'balanced',
    settings: DEFAULT_SETTINGS,
    id: 'd1',
    now: NOW,
    ...over,
  }
}
