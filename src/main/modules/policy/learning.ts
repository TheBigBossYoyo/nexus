import { newId } from '@shared/ids'
import {
  CONCRETE_STRATEGIES,
  contextFallbacks,
  type ArenaTrial,
  type ArenaTrialMetrics,
  type ConcreteStrategy,
  type EvidenceLabel,
  type EvidenceKind,
  type EvidenceSummaryRow,
  type MissionOutcome,
  type PolicyCandidate,
  type PolicyConfig,
  type PolicySnapshot,
  type RegressionFlag,
  type ShadowEvaluation,
  type StrategyStatistic,
  type TaskProfile,
} from '@shared/v3'
import { defaultStrategy } from './defaults'
import { applyPromotion, baseStrategyFor, preferenceFor } from './snapshots'
import {
  betterByBand,
  distribution,
  EVIDENCE_THRESHOLDS,
  evidenceLabel,
  intervalsSeparated,
  labelAtLeast,
  mean,
  median,
  recencyWeight,
  wilsonInterval,
} from './stats'

/**
 * Policy learning, pure. Evidence is aggregated into statistics, statistics are summarized along the
 * context fallback chain, and the only output that can lead to a policy change is a PolicyCandidate that a
 * person must promote. Nothing here touches a database or a clock: `now` is an input.
 */

/**
 * Every threshold that decides whether evidence is enough lives here, in one place. They are fixed by the
 * design (docs/V0_3_DESIGN.md, "Learning, candidates, snapshots") and are not tuned to make candidates appear.
 */
export const POLICY_THRESHOLDS = {
  /** A fallback context level is used only if one of its strategies has at least this label. */
  levelSufficient: 'WEAK' as EvidenceLabel,
  /** The challenger needs at least this much evidence... */
  challengerMin: 'MODERATE' as EvidenceLabel,
  /** ...and the incumbent at least this much. */
  incumbentMin: 'WEAK' as EvidenceLabel,
  /** When intervals overlap, both must be at least this. */
  overlapBothMin: 'MODERATE' as EvidenceLabel,
  /** "One band better" on sessions or time: at least 20% lower. */
  efficiencyBand: 0.2,
  /** Suppression: this many effective samples with no success... */
  suppressMinEffectiveSamples: 3,
  /** ...or this many stability failures that are also more than half of the observations. */
  suppressStabilityFailures: 2,
  /** A candidate needs controlled evidence from at least this many distinct Arena cases at its context level... */
  minDistinctCases: 3,
  /** ...and at least this many Arena trials (EVIDENCE_THRESHOLDS.weak). */
  minArenaTrials: EVIDENCE_THRESHOLDS.weak,
  /** Efficiency tie-break: the challenger's Wilson lower bound may not be below the incumbent's by more than this. */
  efficiencyLowerBoundSlack: 0.05,
  /** A rejected candidate is proposed again only after this many more Arena trials for the challenger. */
  reproposeAfterArenaTrials: 5,
} as const

const DAY_MS = 86_400_000

// ───────────────────────────── aggregation ─────────────────────────────

export type EvidenceTrial = ArenaTrial & { metrics: ArenaTrialMetrics | null; contextKey: string }

export interface AggregateInput {
  trials: EvidenceTrial[]
  outcomes: MissionOutcome[]
  config: PolicyConfig
  now: number
  /**
   * Fallback only: role -> configured model alias. Recorded models are resolved ids, so an alias can never be
   * compared with them exactly; it is used only when no evidence item in the window records any model.
   */
  currentModels: Record<string, string>
}

interface Observation {
  contextKey: string
  strategy: ConcreteStrategy
  kind: EvidenceKind
  /** Arena case id (arena) or run id (mission): the unit that counts as independent. */
  unit: string
  success: boolean
  weight: number
  stability: boolean
  durationMs: number | null
  sessions: number | null
  tokens: number | null
  repairs: number | null
  models: Record<string, string>
  at: number
}

/** True when a recorded role->model map differs from the current one, compared exactly (resolved ids, no substring matching). */
export function modelDrifted(recorded: Record<string, string>, current: Record<string, string>): boolean {
  return Object.entries(recorded).some(([role, model]) => {
    const now = current[role]
    return now !== undefined && now !== model
  })
}

const sumTokens = (input: number | null, output: number | null): number | null =>
  input === null && output === null ? null : (input ?? 0) + (output ?? 0)

type RawObservation = Omit<Observation, 'weight'> & { base: number }

/**
 * Whether an Arena trial is evidence about its strategy, and how it counts. Infrastructure blocks (and legacy
 * blocked rows with no block kind and no ended run) say nothing about the strategy and are excluded entirely.
 */
function trialCounts(t: EvidenceTrial): { counts: boolean; passed: boolean; stability: boolean } {
  if (t.state === 'cancelled' || t.state === 'queued' || t.state === 'running' || t.state === 'provisioning' || t.state === 'evaluating') {
    return { counts: false, passed: false, stability: false }
  }
  const m = t.metrics
  if (t.state === 'blocked') {
    const kind = t.blockKind ?? (m !== null && t.runId !== null ? 'run' : 'infrastructure')
    if (kind === 'infrastructure') return { counts: false, passed: false, stability: false }
  }
  // A trial that passed is never a stability failure, whatever happened to an agent on the way (a recovered crash).
  const passed = m?.hiddenPassed === true
  const stability = !passed && (t.blockKind === 'run' || (m ? m.crashedAgents > 0 || m.schedulerFailures > 0 : false))
  return { counts: true, passed, stability }
}

function observe(input: AggregateInput): Observation[] {
  const { config, now } = input
  const windowMs = config.evidenceWindowDays * DAY_MS
  const raw: RawObservation[] = []
  for (const t of input.trials) {
    const c = trialCounts(t)
    if (!c.counts) continue
    const at = Date.parse(t.finishedAt ?? t.createdAt)
    if (now - at > windowMs) continue
    const m = t.metrics
    // Efficiency figures describe passing runs only: a fast failure is not efficient.
    raw.push({
      contextKey: t.contextKey,
      strategy: t.strategy,
      kind: 'arena',
      unit: t.caseId,
      success: c.passed,
      base: 1,
      stability: c.stability,
      durationMs: c.passed ? (m?.wallClockMs ?? null) : null,
      sessions: c.passed && m ? m.sessions : null,
      tokens: c.passed && m ? sumTokens(m.inputTokens, m.outputTokens) : null,
      repairs: m ? m.repairs : null,
      models: t.models,
      at,
    })
  }
  for (const o of input.outcomes) {
    if (o.isArena || o.terminal === 'cancelled') continue
    const at = Date.parse(o.createdAt)
    if (now - at > windowMs) continue
    raw.push({
      contextKey: o.contextKey,
      strategy: o.strategy,
      kind: 'mission',
      unit: o.runId,
      success: o.success,
      base: config.missionWeight,
      stability: !o.success && o.terminal === 'blocked',
      durationMs: o.success ? o.elapsedMs : null,
      sessions: o.success ? o.sessions : null,
      tokens: o.success ? sumTokens(o.inputTokens, o.outputTokens) : null,
      repairs: o.repairs,
      models: o.models,
      at,
    })
  }
  // The models "currently" in use are the resolved ones recorded on the newest evidence item that records any.
  // An item that records none is unknown, never down-weighted.
  let newest: RawObservation | null = null
  for (const r of raw) if (Object.keys(r.models).length > 0 && (!newest || r.at > newest.at)) newest = r
  const current = newest ? newest.models : input.currentModels
  return raw.map(({ base, ...r }) => ({
    ...r,
    weight: base * recencyWeight((now - r.at) / DAY_MS, config.recencyHalfLifeDays) * (modelDrifted(r.models, current) ? config.modelDriftWeight : 1),
  }))
}

/**
 * One row per (context, strategy, kind), for the exact context and for each fallback level. Raw counts and
 * weighted counts are kept side by side; the Wilson interval and label are on the raw counts. Efficiency means
 * cover passed runs only. `stabilityFailures` is weighted like the effective counts (recency, model drift,
 * mission weight), so old crashes fade the same way old results do.
 */
export function aggregateEvidence(input: AggregateInput): StrategyStatistic[] {
  const groups = new Map<string, { contextKey: string; strategy: ConcreteStrategy; kind: EvidenceKind; obs: Observation[] }>()
  for (const o of observe(input)) {
    for (const level of contextFallbacks(o.contextKey)) {
      const key = `${level}\u0000${o.strategy}\u0000${o.kind}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { contextKey: level, strategy: o.strategy, kind: o.kind, obs: [] }))
      g.obs.push(o)
    }
  }
  const computedAt = new Date(input.now).toISOString()
  const nums = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null)
  const rows: StrategyStatistic[] = []
  for (const g of groups.values()) {
    const n = g.obs.length
    const successes = g.obs.filter((o) => o.success).length
    const interval = wilsonInterval(successes, n)
    const times = g.obs.map((o) => o.at)
    rows.push({
      id: `stat:${g.contextKey}:${g.strategy}:${g.kind}`,
      contextKey: g.contextKey,
      strategy: g.strategy,
      kind: g.kind,
      n,
      successes,
      distinctUnits: new Set(g.obs.map((o) => o.unit)).size,
      effectiveN: g.obs.reduce((a, o) => a + o.weight, 0),
      effectiveSuccesses: g.obs.reduce((a, o) => a + (o.success ? o.weight : 0), 0),
      passRate: n > 0 ? successes / n : null,
      passInterval: interval,
      medianDurationMs: median(nums(g.obs.map((o) => o.durationMs))),
      meanDurationMs: mean(nums(g.obs.map((o) => o.durationMs))),
      meanSessions: mean(nums(g.obs.map((o) => o.sessions))),
      meanObservedTokens: mean(nums(g.obs.map((o) => o.tokens))),
      meanRepairs: mean(nums(g.obs.map((o) => o.repairs))),
      repairDistribution: distribution(nums(g.obs.map((o) => o.repairs))),
      stabilityFailures: g.obs.reduce((a, o) => a + (o.stability ? o.weight : 0), 0),
      label: evidenceLabel(n, interval),
      newestAt: new Date(Math.max(...times)).toISOString(),
      oldestAt: new Date(Math.min(...times)).toISOString(),
      computedAt,
    })
  }
  const order = (s: ConcreteStrategy): number => CONCRETE_STRATEGIES.indexOf(s)
  return rows.sort(
    (a, b) =>
      a.contextKey.localeCompare(b.contextKey) || order(a.strategy) - order(b.strategy) || a.kind.localeCompare(b.kind),
  )
}

// ───────────────────────────── suppression ─────────────────────────────

export interface Suppressible {
  effectiveN: number
  effectiveSuccesses: number
  /** Weighted like effectiveN. */
  stabilityFailures: number
}

/**
 * Evaluated on one context level's own evidence. Either at least 3 effective samples and no success, or at
 * least 2 (weighted) stability failures that are also more than half of the effective observations: a
 * strategy that crashes twice among thirty good runs is not unstable.
 */
export function isSuppressed(row: Suppressible): boolean {
  return (
    (row.effectiveN >= POLICY_THRESHOLDS.suppressMinEffectiveSamples && row.effectiveSuccesses <= 0) ||
    (row.stabilityFailures >= POLICY_THRESHOLDS.suppressStabilityFailures && row.stabilityFailures > row.effectiveN / 2)
  )
}

// ───────────────────────────── summaries ─────────────────────────────

const LABEL_ORDER: EvidenceLabel[] = ['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG']

/** Controlled evidence from fewer distinct cases than this caps the Arena label at WEAK. */
function capLabel(label: EvidenceLabel, row: { arenaN: number; arenaCases: number }): EvidenceLabel {
  if (row.arenaN > 0 && row.arenaCases < POLICY_THRESHOLDS.minDistinctCases && LABEL_ORDER.indexOf(label) > 1) return 'WEAK'
  return label
}

/** "evidence comes from 1 case" when the caveat applies, else null. */
export function caseCaveat(row: { arenaN: number; arenaCases: number }): string | null {
  if (row.arenaN > 0 && row.arenaCases < POLICY_THRESHOLDS.minDistinctCases) {
    return `evidence comes from ${row.arenaCases} case${row.arenaCases === 1 ? '' : 's'}`
  }
  return null
}

function poolRow(strategy: ConcreteStrategy, arena: StrategyStatistic | undefined, mission: StrategyStatistic | undefined): EvidenceSummaryRow & Suppressible {
  const effectiveN = (arena?.effectiveN ?? 0) + (mission?.effectiveN ?? 0)
  const effectiveSuccesses = (arena?.effectiveSuccesses ?? 0) + (mission?.effectiveSuccesses ?? 0)
  // Efficiency figures come from controlled Arena evidence when there is any; the mission figure is the fallback.
  const first = <T>(pick: (s: StrategyStatistic) => T | null): T | null => {
    const a = arena && arena.n > 0 ? pick(arena) : null
    if (a !== null) return a
    return mission && mission.n > 0 ? pick(mission) : null
  }
  // The point estimate used for ranking is the weighted pass rate; the interval used for "separated" is the Wilson
  // interval on RAW Arena counts (controlled evidence), because a Wilson interval on fractional weighted counts
  // would claim a precision the data does not have. Mission-only rows use their raw counts.
  const interval =
    arena && arena.n > 0 ? wilsonInterval(arena.successes, arena.n) : mission && mission.n > 0 ? wilsonInterval(mission.successes, mission.n) : null
  const stabilityFailures = (arena?.stabilityFailures ?? 0) + (mission?.stabilityFailures ?? 0)
  const pooled: Suppressible = { effectiveN, effectiveSuccesses, stabilityFailures }
  const arenaN = arena?.n ?? 0
  const arenaCases = arena?.distinctUnits ?? 0
  return {
    strategy,
    arenaN,
    arenaCases,
    arenaSuccesses: arena?.successes ?? 0,
    missionN: mission?.n ?? 0,
    missionSuccesses: mission?.successes ?? 0,
    effectiveN,
    passRate: effectiveN > 0 ? effectiveSuccesses / effectiveN : null,
    passInterval: interval,
    meanSessions: first((s) => s.meanSessions),
    meanObservedTokens: first((s) => s.meanObservedTokens),
    medianDurationMs: first((s) => s.medianDurationMs),
    label: capLabel(evidenceLabel(effectiveN, interval), { arenaN, arenaCases }),
    suppressed: isSuppressed(pooled),
    effectiveSuccesses,
    stabilityFailures,
  }
}

/** Pooled rows (Arena and mission kept as separate counts) for exactly one context key. */
export function rowsAt(stats: StrategyStatistic[], contextKey: string): (EvidenceSummaryRow & Suppressible)[] {
  const rows: (EvidenceSummaryRow & Suppressible)[] = []
  for (const strategy of CONCRETE_STRATEGIES) {
    const arena = stats.find((s) => s.contextKey === contextKey && s.strategy === strategy && s.kind === 'arena')
    const mission = stats.find((s) => s.contextKey === contextKey && s.strategy === strategy && s.kind === 'mission')
    if (arena || mission) rows.push(poolRow(strategy, arena, mission))
  }
  return rows
}

/** The context level a decision for `contextKey` takes its evidence from: the first level with sufficient evidence. */
export function evidenceLevelOf(stats: StrategyStatistic[], contextKey: string): string | null {
  for (const level of contextFallbacks(contextKey)) {
    if (rowsAt(stats, level).some((r) => labelAtLeast(r.label, POLICY_THRESHOLDS.levelSufficient))) return level
  }
  return null
}

/**
 * Strategies suppressed for a decision in `contextKey`. Each level is judged on its own evidence, and only the
 * levels the decision uses count: the exact context (always) and the evidence level it falls back to. There is
 * no union over other levels, so a catastrophe in one context never suppresses a strategy in an unrelated one.
 */
export function suppressedStrategies(stats: StrategyStatistic[], contextKey: string): Set<ConcreteStrategy> {
  const out = new Set<ConcreteStrategy>()
  const levels = new Set([contextKey, evidenceLevelOf(stats, contextKey) ?? contextKey])
  for (const level of levels) for (const r of rowsAt(stats, level)) if (r.suppressed) out.add(r.strategy)
  return out
}

export interface EvidenceSummary {
  /** The context the rows come from. Null when no level has sufficient evidence (rows are then the exact level's). */
  evidenceContextKey: string | null
  rows: EvidenceSummaryRow[]
}

const toPublicRow = (r: EvidenceSummaryRow & Suppressible, suppressed: boolean): EvidenceSummaryRow => ({
  strategy: r.strategy,
  arenaN: r.arenaN,
  arenaCases: r.arenaCases,
  arenaSuccesses: r.arenaSuccesses,
  missionN: r.missionN,
  missionSuccesses: r.missionSuccesses,
  effectiveN: Math.round(r.effectiveN * 100) / 100,
  passRate: r.passRate,
  passInterval: r.passInterval,
  meanSessions: r.meanSessions,
  meanObservedTokens: r.meanObservedTokens,
  medianDurationMs: r.medianDurationMs,
  label: r.label,
  suppressed,
})

/** Evidence for a context along the fallback chain; a fallback level counts only with its own sufficient evidence. */
export function summarize(stats: StrategyStatistic[], contextKey: string): EvidenceSummary {
  const suppressed = suppressedStrategies(stats, contextKey)
  const level = evidenceLevelOf(stats, contextKey)
  return {
    evidenceContextKey: level,
    rows: rowsAt(stats, level ?? contextKey).map((r) => toPublicRow(r, suppressed.has(r.strategy))),
  }
}

// ───────────────────────────── wording ─────────────────────────────

const ofCount = (s: number, n: number): string => `${Math.round(s)} of ${Math.round(n)}`
const ratio = (x: number): string => `${(Math.round(x * 10) / 10).toFixed(1)}x`

/** "18 of 21 Arena trials and 4 of 6 real missions (observational)". Arena and mission counts are never added. */
export function describeCounts(row: EvidenceSummaryRow): string {
  const parts: string[] = []
  if (row.arenaN > 0) parts.push(`${ofCount(row.arenaSuccesses, row.arenaN)} Arena trials`)
  if (row.missionN > 0) parts.push(`${ofCount(row.missionSuccesses, row.missionN)} real missions (observational)`)
  return parts.length > 0 ? parts.join(' and ') : 'no recorded evidence'
}

/** One sentence comparing a strategy with the strongest other one. Counts, never invented precision. */
export function compareSentence(contextKey: string, chosen: EvidenceSummaryRow, other: EvidenceSummaryRow | null): string {
  let text = `For ${contextKey}, ${chosen.strategy} passed ${describeCounts(chosen)}`
  if (other) {
    text += ` versus ${describeCounts(other).replace(/^no recorded evidence$/, 'nothing recorded')} for ${other.strategy}`
    if (chosen.meanSessions && other.meanSessions) {
      const r = other.meanSessions / chosen.meanSessions
      if (r >= 1.25) text += `; ${other.strategy} also averaged ${ratio(r)} the sessions`
      else if (r <= 0.8) text += `; ${chosen.strategy} averaged ${ratio(1 / r)} the sessions of ${other.strategy}`
    }
  }
  return `${text}. Evidence: ${chosen.label}.`
}

// ───────────────────────────── candidates ─────────────────────────────

export interface ProposeInput {
  stats: StrategyStatistic[]
  active: PolicySnapshot
  /** Context keys to examine, exact and wildcard ones alike. Each is judged on its own level's evidence. */
  knownContexts: string[]
  now: number
  /** Id source; the default is random, tests and the simulator pass a counter. */
  newId?: () => string
}

export interface ProposeResult {
  candidates: Omit<PolicyCandidate, 'shadow'>[]
  notes: string[]
}

interface Verdict {
  ok: boolean
  rule: 'separated' | 'overlap-efficiency' | null
  why: string
}

const emptyRow = (strategy: ConcreteStrategy): EvidenceSummaryRow & Suppressible => poolRow(strategy, undefined, undefined)

/** The decision rule for one challenger against the incumbent. */
export function judgeChallenger(
  challenger: EvidenceSummaryRow,
  incumbent: EvidenceSummaryRow,
): Verdict {
  const T = POLICY_THRESHOLDS
  if (challenger.suppressed) return { ok: false, rule: null, why: `${challenger.strategy} is suppressed by its failures` }
  // A candidate needs controlled evidence. Missions count toward the comparison but can never produce one alone.
  if (challenger.arenaN < T.minArenaTrials)
    return {
      ok: false,
      rule: null,
      why:
        challenger.missionN > 0
          ? `${challenger.strategy}: only observational evidence; run an Arena campaign for this context (${describeCounts(challenger)})`
          : `${challenger.strategy} has ${challenger.arenaN} Arena trial${challenger.arenaN === 1 ? '' : 's'}; at least ${T.minArenaTrials} are required`,
    }
  if (challenger.arenaCases < T.minDistinctCases)
    return {
      ok: false,
      rule: null,
      why: `${challenger.strategy}: ${caseCaveat(challenger)}, and at least ${T.minDistinctCases} distinct cases are required (repetitions of one case are not independent)`,
    }
  if (!labelAtLeast(challenger.label, T.challengerMin))
    return {
      ok: false,
      rule: null,
      why: `${challenger.strategy} has ${challenger.label} evidence (${describeCounts(challenger)}); ${T.challengerMin} is required`,
    }
  if (!labelAtLeast(incumbent.label, T.incumbentMin))
    return {
      ok: false,
      rule: null,
      why: `the incumbent ${incumbent.strategy} has ${incumbent.label} evidence (${describeCounts(incumbent)}); ${T.incumbentMin} is required`,
    }
  const ci = challenger.passInterval
  const ii = incumbent.passInterval
  if (ci && ii && ci.low > ii.high) return { ok: true, rule: 'separated', why: 'the intervals do not overlap and the challenger is higher' }
  if (intervalsSeparated(ci, ii))
    return { ok: false, rule: null, why: `${challenger.strategy}'s pass interval lies below ${incumbent.strategy}'s` }
  // Overlapping intervals: evidence does not separate them on correctness.
  if (!labelAtLeast(challenger.label, T.overlapBothMin) || !labelAtLeast(incumbent.label, T.overlapBothMin))
    return { ok: false, rule: null, why: `the pass intervals overlap and both strategies need ${T.overlapBothMin} evidence to compare efficiency` }
  const passOk = (challenger.passRate ?? 0) >= (incumbent.passRate ?? 0)
  if (!passOk) return { ok: false, rule: null, why: `the pass intervals overlap and ${challenger.strategy}'s pass proportion is lower` }
  // Efficiency only breaks a tie: a challenger whose lower bound sits clearly below the incumbent's is not "as good".
  if (ci && ii && ci.low < ii.low - T.efficiencyLowerBoundSlack)
    return { ok: false, rule: null, why: `the pass intervals overlap and ${challenger.strategy}'s lower bound is more than ${T.efficiencyLowerBoundSlack} below ${incumbent.strategy}'s` }
  const sessions = betterByBand(challenger.meanSessions, incumbent.meanSessions, T.efficiencyBand)
  const time = betterByBand(challenger.medianDurationMs, incumbent.medianDurationMs, T.efficiencyBand)
  if (sessions || time) return { ok: true, rule: 'overlap-efficiency', why: 'the intervals overlap, but the challenger is at least one band better on sessions or time with no lower pass proportion' }
  return { ok: false, rule: null, why: `the pass intervals overlap and ${challenger.strategy} is not at least ${Math.round(T.efficiencyBand * 100)}% better on sessions or time` }
}

function expectedLines(ch: EvidenceSummaryRow, inc: EvidenceSummaryRow): string[] {
  const lines = [
    `${ch.strategy} passed ${describeCounts(ch)}; ${inc.strategy} passed ${describeCounts(inc)}`,
  ]
  if (ch.meanSessions && inc.meanSessions) {
    lines.push(`Mean sessions: ${ch.strategy} ${ch.meanSessions.toFixed(1)}, ${inc.strategy} ${inc.meanSessions.toFixed(1)}`)
  }
  if (ch.medianDurationMs && inc.medianDurationMs) {
    lines.push(
      `Median time: ${ch.strategy} ${Math.round(ch.medianDurationMs / 1000)} s, ${inc.strategy} ${Math.round(inc.medianDurationMs / 1000)} s`,
    )
  }
  return lines
}

export function proposeCandidates(input: ProposeInput): ProposeResult {
  const { stats, active, now } = input
  const makeId = input.newId ?? newId
  const candidates: Omit<PolicyCandidate, 'shadow'>[] = []
  const notes: string[] = []
  const contexts = [...new Set(input.knownContexts)].sort()
  for (const contextKey of contexts) {
    const rows = rowsAt(stats, contextKey)
    if (rows.length === 0) continue
    const incumbentStrategy = preferenceFor(active, contextKey)?.strategy ?? defaultStrategy(contextKey)
    const incumbent = rows.find((r) => r.strategy === incumbentStrategy) ?? emptyRow(incumbentStrategy)
    // Judged on this level's own evidence only.
    const suppressed = new Set(rows.filter((r) => r.suppressed).map((r) => r.strategy))
    const pub = (r: EvidenceSummaryRow & Suppressible): EvidenceSummaryRow => toPublicRow(r, suppressed.has(r.strategy))
    const incPub = pub(incumbent)

    let best: { row: EvidenceSummaryRow & Suppressible; verdict: Verdict } | null = null
    const failures: string[] = []
    for (const row of rows) {
      if (row.strategy === incumbentStrategy) continue
      if (row.strategy === 'SPECULATIVE' && active.config.speculation === 'OFF') {
        failures.push('SPECULATIVE is not eligible while the speculation policy is OFF')
        continue
      }
      const verdict = judgeChallenger(pub(row), incPub)
      if (!verdict.ok) {
        failures.push(verdict.why)
        continue
      }
      const better =
        !best ||
        (verdict.rule === 'separated' && best.verdict.rule !== 'separated') ||
        (verdict.rule === best.verdict.rule && (row.passRate ?? 0) > (best.row.passRate ?? 0))
      if (better) best = { row, verdict }
    }
    if (!best) {
      notes.push(
        failures.length > 0
          ? `${contextKey}: no candidate. ${failures.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join('. ')}.`
          : `${contextKey}: no candidate. Only ${incumbentStrategy} has evidence here, so there is nothing to compare it with.`,
      )
      continue
    }
    const ch = pub(best.row)
    const other = incPub
    candidates.push({
      id: makeId(),
      contextKey,
      fromStrategy: incumbentStrategy,
      toStrategy: ch.strategy,
      arenaTrials: ch.arenaN,
      missions: ch.missionN,
      label: ch.label,
      expected: expectedLines(ch, other),
      reason: `${compareSentence(contextKey, ch, other)} Rule: ${best.verdict.why}.`,
      evidence: rows.map(pub),
      status: 'proposed',
      baseSnapshotId: active.id,
      createdAt: new Date(now).toISOString(),
      resolvedAt: null,
    })
  }
  return { candidates, notes }
}

// ───────────────────────────── shadow evaluation ─────────────────────────────

/**
 * Replays stored task profiles through the snapshot the candidate would create and counts how many
 * decisions (default plus evidence layers only) would change. A sanity check, not an effect estimate.
 */
export function shadowEvaluate(
  candidate: Omit<PolicyCandidate, 'shadow'>,
  profiles: TaskProfile[],
  outcomes: MissionOutcome[],
  base: PolicySnapshot,
): ShadowEvaluation {
  const after = applyPromotion(base, candidate, { id: 'shadow', version: base.version + 1, now: new Date(0).toISOString() })
  // Arena profiles describe benchmark cases, not the work this user actually does.
  const real = profiles.filter((p) => p.arenaTrialId === null)
  let changed = 0
  let known = 0
  for (const p of real) {
    const before = baseStrategyFor(base, p.contextKey)
    const next = baseStrategyFor(after, p.contextKey)
    if (before === next) continue
    changed += 1
    if (outcomes.some((o) => !o.isArena && o.contextKey === p.contextKey && o.strategy === next)) known += 1
  }
  return {
    profilesReplayed: real.length,
    decisionsChanged: changed,
    changedWithKnownOutcome: known,
    note:
      'Sanity check, not an effect estimate: this replays stored task profiles through the candidate and counts how many would be routed to a different strategy. It says nothing about whether those missions would have gone better.',
  }
}

// ───────────────────────────── regressions ─────────────────────────────

export interface RegressionGroup {
  /** Label of the group, e.g. its (NEXUS version, model signature). */
  group: string
  nexusVersion?: string
  /** Resolved models of the group, e.g. sorted role=model pairs. */
  modelSignature?: string
  /** Older groups have a lower order. */
  order: number
  strategy: ConcreteStrategy
  /** Identifies the set of cases (or pass `caseIds`): only groups with the same case set are compared. */
  caseKey?: string
  /** The case ids behind the group; order does not matter. Takes precedence over `caseKey`. */
  caseIds?: string[]
  n: number
  successes: number
}

/** Compares consecutive groups of the same strategy and case set. Nothing is reported unless the newer one is lower. */
export function detectRegressions(groups: RegressionGroup[]): RegressionFlag[] {
  const flags: RegressionFlag[] = []
  const buckets = new Map<string, RegressionGroup[]>()
  for (const g of groups) {
    const cases = g.caseIds ? [...new Set(g.caseIds)].sort().join(',') : (g.caseKey ?? '')
    const key = `${g.strategy}|${cases}`
    buckets.set(key, [...(buckets.get(key) ?? []), g])
  }
  for (const list of buckets.values()) {
    const sorted = [...list].sort((a, b) => a.order - b.order)
    for (let i = 1; i < sorted.length; i++) {
      const older = sorted[i - 1]!
      const newer = sorted[i]!
      if (older.group === newer.group) continue // the same group is not a comparison
      const oi = wilsonInterval(older.successes, older.n)
      const ni = wilsonInterval(newer.successes, newer.n)
      if (!oi || !ni) continue
      const op = older.successes / older.n
      const np = newer.successes / newer.n
      if (!(np < op)) continue
      const established = ni.high < oi.low
      flags.push({
        strategy: newer.strategy,
        baseline: { group: older.group, n: older.n, passRate: op, interval: oi },
        current: { group: newer.group, n: newer.n, passRate: np, interval: ni },
        verdict: established ? 'established' : 'lower',
        label: established ? 'ORCHESTRATION REGRESSION' : 'Lower, not established',
      })
    }
  }
  return flags
}
