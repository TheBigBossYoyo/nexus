import type { Preset } from '@shared/domain'
import { presetRolePolicy, type Settings } from '@shared/settings'
import {
  CONCRETE_STRATEGIES,
  EXPLORATION_RATES,
  type ConcreteStrategy,
  type EvidenceSummaryRow,
  type PolicyDecision,
  type PolicySnapshot,
  type StrategyStatistic,
  type TaskProfileFeatures,
  type UsageStatus,
} from '@shared/v3'
import { configureStrategy } from '@main/modules/strategy/strategies'
import { defaultReason, defaultStrategy } from './defaults'
import { compareSentence, summarize, suppressedStrategies } from './learning'
import { preferenceFor } from './snapshots'
import { mulberry32, sampleBeta } from './stats'

/**
 * The adaptive policy engine, pure. Layers, in order: DEFAULT, EVIDENCE OVERRIDE (a promoted preference),
 * EXPLORATION (seeded Thompson sampling), RESOURCE AVAILABILITY. Given the same input, including the
 * seed, it returns the same decision. It never reads a remaining-capacity number: availability arrives
 * only as a status and a "a limit was hit recently" flag.
 */

export interface DecideInput {
  /** Identity and features of the task. Nothing else about the task is needed. */
  profile: { id: string | null; projectId: string | null; runId: string | null; contextKey: string; features: TaskProfileFeatures }
  snapshot: PolicySnapshot
  stats: StrategyStatistic[]
  seed: number
  usageStatus: UsageStatus
  /** A usage limit was hit within the last hour. */
  recentLimit: boolean
  preset: Preset
  settings: Settings
  /** Requested candidate count for SPECULATIVE. */
  candidates?: number
  /** A strategy the user forced: skips every other layer. */
  forced?: ConcreteStrategy | null
  /** Decision id and clock, supplied by the caller so the function stays pure. */
  id: string
  now: number
}

/** Tie-break order when several strategies are otherwise equal. */
const STRATEGY_ORDER: readonly ConcreteStrategy[] = ['BUILD', 'CONSENSUS', 'SINGLE', 'SWARM', 'SPECULATIVE']

/** Resource rule: THROTTLED or LIMIT_APPROACHING halves the worker count (minimum 1). */
export const THROTTLE_WORKER_DIVISOR = 2
export const THROTTLED_STATUSES: readonly UsageStatus[] = ['THROTTLED', 'LIMIT_APPROACHING']

const percent = (rate: number): string => `${Math.round(rate * 100)}%`

/** Strategies the engine may choose at all under this snapshot. */
export function allowedStrategies(snapshot: PolicySnapshot): ConcreteStrategy[] {
  return CONCRETE_STRATEGIES.filter((s) => s !== 'SPECULATIVE' || snapshot.config.speculation !== 'OFF')
}

/** The best remaining strategy by posterior mean of the pass proportion, ties by STRATEGY_ORDER. */
function bestRemaining(candidates: ConcreteStrategy[], rows: EvidenceSummaryRow[]): ConcreteStrategy | null {
  let best: { s: ConcreteStrategy; score: number } | null = null
  for (const s of STRATEGY_ORDER) {
    if (!candidates.includes(s)) continue
    const row = rows.find((r) => r.strategy === s)
    const n = row?.effectiveN ?? 0
    const successes = (row?.passRate ?? 0) * n
    const score = (1 + successes) / (2 + n)
    if (!best || score > best.score + 1e-12) best = { s, score }
  }
  return best?.s ?? null
}

export function decide(input: DecideInput): PolicyDecision {
  const { profile, snapshot, stats, settings, preset } = input
  const contextKey = profile.contextKey
  const features = profile.features
  const config = snapshot.config
  const allowed = allowedStrategies(snapshot)
  const summary = summarize(stats, contextKey)
  const suppressed = suppressedStrategies(stats, contextKey)
  const ok = (s: ConcreteStrategy): boolean => allowed.includes(s) && !suppressed.has(s)
  const rowOf = (s: ConcreteStrategy): EvidenceSummaryRow | null => summary.rows.find((r) => r.strategy === s) ?? null
  const reasons: string[] = []
  const resourceNotes: string[] = []

  let strategy: ConcreteStrategy
  let layer: PolicyDecision['layer'] = 'default'
  let exploration = false
  let seed: number | null = null

  if (input.forced) {
    strategy = input.forced
    layer = 'user'
    reasons.push(`Strategy ${strategy} was chosen by the user; the policy did not decide it.`)
  } else {
    // DEFAULT
    const def = defaultStrategy(features)
    strategy = def
    reasons.push(`No promoted preference applies to ${contextKey}; ${defaultReason(features)}.`)

    // EVIDENCE OVERRIDE: only a promoted preference changes the strategy.
    const pref = preferenceFor(snapshot, contextKey)
    if (pref && ok(pref.strategy)) {
      strategy = pref.strategy
      layer = 'evidence'
      reasons.length = 0
      const chosen = rowOf(strategy)
      const others = summary.rows.filter((r) => r.strategy !== strategy && r.effectiveN > 0).sort((a, b) => b.effectiveN - a.effectiveN)
      reasons.push(
        chosen
          ? compareSentence(summary.evidenceContextKey ?? contextKey, chosen, others[0] ?? null)
          : `Promoted preference for ${pref.contextKey}: ${strategy}.`,
      )
      reasons.push(`Promoted in policy snapshot ${snapshot.version}, replacing the default ${pref.replaces}.`)
    } else if (pref) {
      reasons.push(`The promoted preference ${pref.strategy} was not used because current evidence suppresses it or it is not allowed.`)
    }

    // SAFETY: a suppressed strategy is never chosen, whatever layer produced it.
    if (!ok(strategy)) {
      const replacement = bestRemaining(allowed.filter((s) => !suppressed.has(s)), summary.rows)
      const was = rowOf(strategy)
      if (replacement) {
        reasons.push(
          `${strategy} is suppressed (${was ? describe(was) : 'repeated failures'}); using ${replacement} instead.`,
        )
        strategy = replacement
        layer = 'evidence'
      } else {
        reasons.push(`Every strategy is suppressed by recent failures; keeping the default ${strategy}.`)
      }
    }

    // EXPLORATION
    const rate = EXPLORATION_RATES[config.exploration]
    const highRisk = features.risk.value === 'high'
    if (rate > 0 && (!highRisk || config.exploration === 'research')) {
      seed = input.seed >>> 0
      const rand = mulberry32(seed)
      if (rand() < rate) {
        const pool = allowed.filter((s) => !suppressed.has(s))
        let best: { s: ConcreteStrategy; draw: number } | null = null
        for (const s of STRATEGY_ORDER) {
          if (!pool.includes(s)) continue
          const row = rowOf(s)
          const n = row?.effectiveN ?? 0
          const successes = (row?.passRate ?? 0) * n
          const draw = sampleBeta(1 + successes, 1 + Math.max(0, n - successes), rand)
          if (!best || draw > best.draw) best = { s, draw }
        }
        if (best) {
          exploration = true
          layer = 'exploration'
          reasons.push(
            `Exploration (${config.exploration} mode, ${percent(rate)} of decisions): a seeded draw over the allowed strategies selected ${best.s}${best.s === strategy ? ', the same as the exploiting choice' : ` instead of ${strategy}`}.`,
          )
          strategy = best.s
        }
      }
    } else if (rate > 0 && highRisk) {
      reasons.push(`No exploration: this task is high risk and exploration mode is ${config.exploration}, not research.`)
    }
  }

  // RESOURCE AVAILABILITY
  const available = input.usageStatus === 'AVAILABLE' && !input.recentLimit
  if (!input.forced && !available) {
    const why = input.recentLimit ? 'a usage limit was hit within the last hour' : `the usage status is ${input.usageStatus}`
    if (strategy === 'SPECULATIVE' || strategy === 'SWARM') {
      const chain: ConcreteStrategy[] =
        strategy === 'SWARM' ? ['BUILD', 'SINGLE', 'CONSENSUS'] : [defaultStrategy(features), 'BUILD', 'SINGLE', 'CONSENSUS']
      const replacement = chain.find((s) => s !== 'SPECULATIVE' && s !== 'SWARM' && ok(s))
      if (replacement) {
        resourceNotes.push(`${strategy} deferred to ${replacement}: ${why}.`)
        strategy = replacement
      } else if (strategy === 'SPECULATIVE') {
        // Speculation is never allowed without availability; the default is used even if evidence disfavours it.
        const fallback = defaultStrategy(features)
        resourceNotes.push(`SPECULATIVE deferred to ${fallback}: ${why}; every other strategy is suppressed by failures.`)
        strategy = fallback
      } else {
        resourceNotes.push(`SWARM could not be deferred: ${why}, but every alternative is suppressed by failures.`)
      }
    }
  }

  const plan = configureStrategy(strategy, { preset, settings, candidates: input.candidates })
  let workerCount = plan.maxParallelAgents
  if (!input.forced && THROTTLED_STATUSES.includes(input.usageStatus) && workerCount > 1) {
    const reduced = Math.max(1, Math.floor(workerCount / THROTTLE_WORKER_DIVISOR))
    resourceNotes.push(`Worker count reduced from ${workerCount} to ${reduced}: the usage status is ${input.usageStatus}.`)
    workerCount = reduced
  }
  if (resourceNotes.length > 0) reasons.push(`Availability: ${resourceNotes.join(' ')}`)

  return {
    id: input.id,
    runId: profile.runId,
    projectId: profile.projectId,
    taskProfileId: profile.id,
    snapshotId: snapshot.id,
    policyVersion: snapshot.version,
    contextKey,
    evidenceContextKey: summary.evidenceContextKey,
    strategy,
    planningMode: plan.planning,
    workerCount,
    reviewDepth: plan.reviewMode,
    speculativeCandidates: plan.speculativeCandidates,
    modelPolicies: { ...presetRolePolicy(preset, settings.models.rolePolicy) },
    layer,
    exploration,
    seed,
    reason: reasons.join(' '),
    evidenceSummary: summary.rows,
    resourceNotes,
    usageStatus: input.usageStatus,
    createdAt: new Date(input.now).toISOString(),
  }
}

function describe(row: EvidenceSummaryRow): string {
  return `${row.arenaN + row.missionN > 0 ? `${Math.round(row.arenaSuccesses + row.missionSuccesses)} passes in ${row.arenaN + row.missionN} observations` : 'no passes'}`
}
