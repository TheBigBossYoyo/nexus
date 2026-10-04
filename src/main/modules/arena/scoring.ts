import {
  CONCRETE_STRATEGIES,
  DEFAULT_SCORING,
  type ArenaCaseDefinition,
  type ArenaCell,
  type ArenaEvaluation,
  type ArenaTrial,
  type ArenaTrialMetrics,
  type ConcreteStrategy,
  type Interval,
  type RegressionFlag,
  type ScoringConfig,
  type StrategyComparisonRow,
  type TrialState,
} from '@shared/v3'
import { betterByBand, evidenceLabel, intervalsSeparated, mean, median, wilsonInterval } from '../policy/stats'

/** `score-v1`. Pure: no clock, no I/O. */

/** The part of a trial that ranking and scoring read. */
export interface RankedTrial {
  hiddenPassed: boolean
  metrics: Pick<
    ArenaTrialMetrics,
    | 'criticalFindings'
    | 'highFindings'
    | 'buildPassed'
    | 'typecheckPassed'
    | 'testsPassed'
    | 'verifierPassed'
    | 'repairs'
    | 'wallClockMs'
    | 'inputTokens'
    | 'outputTokens'
    | 'sessions'
  >
}

export function mergeScoring(base: ScoringConfig, override: ArenaCaseDefinition['scoring'] | undefined): ScoringConfig {
  return {
    band: override?.band ?? base.band,
    passBase: base.passBase,
    weights: { ...base.weights, ...(override?.weights ?? {}) },
  }
}

export const defaultScoring = (override?: ArenaCaseDefinition['scoring']): ScoringConfig => mergeScoring(DEFAULT_SCORING, override)

const unresolvedCriticalHigh = (m: RankedTrial['metrics']): number => m.criticalFindings + m.highFindings

/** Mission verification counts as passed when nothing that was measured failed; unmeasured parts are not failures. */
export function verificationPassed(m: RankedTrial['metrics']): boolean {
  return m.verifierPassed !== false && m.buildPassed !== false && m.typecheckPassed !== false && m.testsPassed !== false
}

/** Observed tokens of a trial; null when the runtime reported none. */
export function observedTokens(m: Pick<ArenaTrialMetrics, 'inputTokens' | 'outputTokens'>): number | null {
  if (m.inputTokens === null && m.outputTokens === null) return null
  return (m.inputTokens ?? 0) + (m.outputTokens ?? 0)
}

/** Negative when `a` ranks better, positive when `b` does, 0 for a tie. */
function lowerIsBetter(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function lowerByBand(a: number | null, b: number | null, band: number): number {
  if (betterByBand(a, b, band)) return -1
  if (betterByBand(b, a, band)) return 1
  return 0
}

/**
 * Lexicographic order of `score-v1`:
 * 1 hidden evaluation passed; 2 fewer unresolved critical/high findings; 3 verification passed;
 * 4 fewer repair cycles; 5 shorter wall clock (bands); 6 fewer observed tokens (bands), then fewer sessions.
 * Step 1 comes first, so a failing trial never ranks above a passing one whatever its cost.
 */
export function compareTrials(a: RankedTrial, b: RankedTrial, config: ScoringConfig = DEFAULT_SCORING): number {
  if (a.hiddenPassed !== b.hiddenPassed) return a.hiddenPassed ? -1 : 1
  const steps = [
    lowerIsBetter(unresolvedCriticalHigh(a.metrics), unresolvedCriticalHigh(b.metrics)),
    verificationPassed(a.metrics) === verificationPassed(b.metrics) ? 0 : verificationPassed(a.metrics) ? -1 : 1,
    lowerIsBetter(a.metrics.repairs, b.metrics.repairs),
    lowerByBand(a.metrics.wallClockMs, b.metrics.wallClockMs, config.band),
    lowerByBand(observedTokens(a.metrics), observedTokens(b.metrics), config.band),
    lowerIsBetter(a.metrics.sessions, b.metrics.sessions),
  ]
  return steps.find((s) => s !== 0) ?? 0
}

export interface ScoreResult {
  /** 0 to 100, two decimals. Always 0 when the hidden evaluation failed. */
  score: number
  /** Points per part; sums to `score` (to rounding). All zero when the evaluation failed. */
  breakdown: Record<string, number>
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Credit for a measure where lower is better. Within `band` of the best peer (the lowest value among trials
 * that passed) earns the full weight; further away the credit falls in proportion best/own. An unmeasured
 * value earns nothing: it is neither rewarded nor invented.
 */
function relativeCredit(own: number | null, best: number | null, band: number): number {
  if (own === null || best === null) return 0
  if (own <= best * (1 + band)) return 1
  return best / own
}

/**
 * The convenience score. Never replaces the raw metrics and cannot hide a correctness failure:
 * hidden evaluation failed -> 0. Otherwise `passBase` (default 60) plus up to the sum of the weights
 * (default 40):
 *   findings      15  full with no unresolved critical/high finding, else 1/(1+n)
 *   verification  10  full when no measured check or verifier failed
 *   repairs        5  full with no repair cycle, else 1/(1+repairs)
 *   time           5  wall clock relative to the fastest passing peer (band tolerance), see relativeCredit
 *   usage          5  observed tokens relative to the cheapest passing peer, see relativeCredit
 * `peers` are the metrics of the passing trials of the same case (the trial itself may be included).
 * When a case override pushes the total above 100 every part is scaled down so the maximum stays 100.
 */
export function scoreTrial(
  metrics: RankedTrial['metrics'],
  hiddenPassed: boolean,
  peers: readonly RankedTrial['metrics'][],
  config: ScoringConfig = DEFAULT_SCORING,
): ScoreResult {
  const zero = { passBase: 0, findings: 0, verification: 0, repairs: 0, time: 0, usage: 0 }
  if (!hiddenPassed) return { score: 0, breakdown: zero }
  const w = config.weights
  const pool = [metrics, ...peers]
  const times = pool.map((m) => m.wallClockMs).filter((v): v is number => v !== null && v > 0)
  const tokens = pool.map(observedTokens).filter((v): v is number => v !== null && v > 0)
  const bestTime = times.length > 0 ? Math.min(...times) : null
  const bestTokens = tokens.length > 0 ? Math.min(...tokens) : null
  const tokensOwn = observedTokens(metrics)

  const findingsCount = unresolvedCriticalHigh(metrics)
  const parts = {
    passBase: config.passBase,
    findings: w.findings * (findingsCount === 0 ? 1 : 1 / (1 + findingsCount)),
    verification: verificationPassed(metrics) ? w.verification : 0,
    repairs: w.repairs * (metrics.repairs === 0 ? 1 : 1 / (1 + metrics.repairs)),
    time: w.time * relativeCredit(metrics.wallClockMs !== null && metrics.wallClockMs > 0 ? metrics.wallClockMs : null, bestTime, config.band),
    usage: w.usage * relativeCredit(tokensOwn !== null && tokensOwn > 0 ? tokensOwn : null, bestTokens, config.band),
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0)
  const scale = total > 100 ? 100 / total : 1
  const breakdown: Record<string, number> = {}
  for (const [k, v] of Object.entries(parts)) breakdown[k] = round2(v * scale)
  const score = round2(Object.values(breakdown).reduce((a, b) => a + b, 0))
  return { score, breakdown }
}

// ───────────────────────────── comparison ─────────────────────────────

/** One finished and evaluated trial, as the statistics see it. */
export interface ComparisonTrial {
  strategy: ConcreteStrategy
  passed: boolean
  metrics: ArenaTrialMetrics | null
}

const STRATEGY_ORDER = new Map<string, number>(CONCRETE_STRATEGIES.map((s, i) => [s, i]))
const byStrategy = (a: ConcreteStrategy, b: ConcreteStrategy): number => (STRATEGY_ORDER.get(a) ?? 99) - (STRATEGY_ORDER.get(b) ?? 99)

/** Trials in these states carry an evaluation and count in pass proportions (cancelled and queued ones do not). */
export const COUNTED_STATES: readonly TrialState[] = ['passed', 'failed', 'blocked']

export function compareStrategies(rows: readonly ComparisonTrial[]): StrategyComparisonRow[] {
  const groups = new Map<ConcreteStrategy, ComparisonTrial[]>()
  for (const r of rows) groups.set(r.strategy, [...(groups.get(r.strategy) ?? []), r])
  return [...groups.keys()].sort(byStrategy).map((strategy) => {
    const trials = groups.get(strategy)!
    const n = trials.length
    const passed = trials.filter((t) => t.passed).length
    const interval = wilsonInterval(passed, n)
    const metrics = trials.flatMap((t) => (t.metrics ? [t.metrics] : []))
    const tokens = metrics.map(observedTokens).filter((v): v is number => v !== null)
    return {
      strategy,
      n,
      passed,
      passRate: n > 0 ? passed / n : null,
      passInterval: interval,
      medianWallClockMs: median(metrics.map((m) => m.wallClockMs).filter((v): v is number => v !== null)),
      meanSessions: mean(metrics.map((m) => m.sessions)),
      meanObservedTokens: mean(tokens),
      meanRepairs: mean(metrics.map((m) => m.repairs)),
      criticalHighFindings: metrics.reduce((sum, m) => sum + m.criticalFindings + m.highFindings, 0),
      quotaPauses: metrics.reduce((sum, m) => sum + m.quotaPauses, 0),
      label: evidenceLabel(n, interval),
    }
  })
}

/** Matrix of (case x strategy) cells with the trial states and scores. Sorted by case id, strategy, repetition. */
export function buildMatrix(
  trials: readonly Pick<ArenaTrial, 'id' | 'caseId' | 'strategy' | 'state' | 'repetition'>[],
  evaluations: readonly Pick<ArenaEvaluation, 'trialId' | 'score'>[],
): ArenaCell[] {
  const scoreByTrial = new Map(evaluations.map((e) => [e.trialId, e.score]))
  const cells = new Map<string, ArenaCell>()
  for (const t of trials) {
    const key = `${t.caseId}\0${t.strategy}`
    const cell = cells.get(key) ?? { caseId: t.caseId, strategy: t.strategy, trials: [] }
    cell.trials.push({ id: t.id, state: t.state, repetition: t.repetition, score: scoreByTrial.get(t.id) ?? null })
    cells.set(key, cell)
  }
  const out = [...cells.values()]
  for (const c of out) c.trials.sort((a, b) => a.repetition - b.repetition)
  return out.sort((a, b) => a.caseId.localeCompare(b.caseId) || byStrategy(a.strategy, b.strategy))
}

const pct = (v: number): string => `${Math.round(v * 100)}%`
const range = (i: Interval): string => `${pct(i.low)}-${pct(i.high)}`

/**
 * Plain-language statements about what the rows do and do not show. Two strategies are called different only
 * when their Wilson intervals do not overlap; below five trials nothing is concluded.
 */
export function resultNotes(rows: readonly StrategyComparisonRow[]): string[] {
  if (rows.length === 0) return ['No finished trials yet; nothing is concluded.']
  const notes: string[] = []
  const thin = rows.filter((r) => r.label === 'INSUFFICIENT')
  if (thin.length > 0) {
    notes.push(`n is below 5 for ${thin.map((r) => `${r.strategy} (n=${r.n})`).join(', ')}; nothing is concluded for ${thin.length === 1 ? 'it' : 'them'}.`)
  }
  const usable = rows.filter((r) => r.label !== 'INSUFFICIENT' && r.passInterval)
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!
      const b = usable[j]!
      if (intervalsSeparated(a.passInterval, b.passInterval)) {
        const [hi, lo] = a.passInterval!.low > b.passInterval!.high ? [a, b] : [b, a]
        notes.push(
          `${hi.strategy} passes more often than ${lo.strategy} (${pct(hi.passRate!)} vs ${pct(lo.passRate!)}; 95% intervals ${range(hi.passInterval!)} and ${range(lo.passInterval!)} do not overlap).`,
        )
      } else {
        notes.push(`The evidence does not separate ${a.strategy} and ${b.strategy} on pass rate (intervals overlap).`)
      }
    }
  }
  if (usable.length === 1 && thin.length === 0) notes.push('Only one strategy has results; there is nothing to compare.')
  return notes
}

// ───────────────────────────── regression ─────────────────────────────

export interface RegressionGroup {
  /** Label of the group (e.g. a NEXUS version). */
  group: string
  trials: ComparisonTrial[]
}

/**
 * Compares the same strategy across two groups (older vs newer). Flags `ORCHESTRATION REGRESSION` only when the
 * newer group's upper Wilson bound is below the older group's lower bound; a lower rate inside overlapping
 * intervals is reported as "Lower, not established". Groups with fewer than 5 trials are skipped.
 */
export function detectRegressions(older: RegressionGroup, newer: RegressionGroup): RegressionFlag[] {
  const out: RegressionFlag[] = []
  for (const strategy of CONCRETE_STRATEGIES) {
    const a = older.trials.filter((t) => t.strategy === strategy)
    const b = newer.trials.filter((t) => t.strategy === strategy)
    if (a.length < 5 || b.length < 5) continue
    const ia = wilsonInterval(a.filter((t) => t.passed).length, a.length)
    const ib = wilsonInterval(b.filter((t) => t.passed).length, b.length)
    if (!ia || !ib) continue
    const ra = a.filter((t) => t.passed).length / a.length
    const rb = b.filter((t) => t.passed).length / b.length
    if (rb >= ra) continue
    const established = ib.high < ia.low
    out.push({
      strategy,
      baseline: { group: older.group, n: a.length, passRate: ra, interval: ia },
      current: { group: newer.group, n: b.length, passRate: rb, interval: ib },
      verdict: established ? 'established' : 'lower',
      label: established ? 'ORCHESTRATION REGRESSION' : 'Lower, not established',
    })
  }
  return out
}
