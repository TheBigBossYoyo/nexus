/**
 * The quality non-regression gate. An optimization that can change what a model sees or how it reasons
 * becomes a default only when a paired comparison (same repository state, task, evaluator, model, effort,
 * permissions and time budget) shows that quality is non-inferior or better. Saving tokens is never a
 * reason by itself, and too little evidence means the baseline stays.
 */

export interface TrialOutcome {
  /** The case the trial ran; baseline and optimized trials are paired by it. */
  caseKey: string
  /** Hidden evaluation passed. Null when the case has none. */
  hiddenPassed: boolean | null
  acceptancePassed: boolean
  /** First verification passed without a repair. */
  firstPassVerified: boolean
  criticalFindings: number
  highFindings: number
  repairs: number
  regressions: number
  humanInterventions: number
  wallClockMs: number
  /** Uncached input + cache read + cache write. */
  inputTokens: number
  outputTokens: number
  turns: number
}

export interface GateConfig {
  /** Paired cases needed before anything can be concluded. */
  minimumPairs: number
  /** Largest drop in pass rate (as a fraction) that still counts as non-inferior. */
  margin: number
  /** `high` and `critical` profiles need more evidence and tolerate no drop. */
  risk: 'low' | 'medium' | 'high' | 'critical'
}

export const DEFAULT_GATE: GateConfig = { minimumPairs: 8, margin: 0.05, risk: 'medium' }

export type GateVerdict = 'IMPROVED' | 'NON_INFERIOR' | 'INFERIOR' | 'INSUFFICIENT_EVIDENCE'

export interface GateResult {
  verdict: GateVerdict
  /** True only for IMPROVED and NON_INFERIOR. */
  mayBecomeDefault: boolean
  pairs: number
  baselinePassRate: number
  optimizedPassRate: number
  /** Lower bound of a one-sided 95% interval on (optimized − baseline) pass rate, from the paired differences. */
  passRateLowerBound: number | null
  /** Pairs where the baseline passed and the optimized variant did not. */
  regressions: string[]
  /** Pairs where the optimized variant passed and the baseline did not. */
  improvements: string[]
  severityDelta: { critical: number; high: number }
  repairDelta: number
  inputTokenDelta: number
  outputTokenDelta: number
  turnDelta: number
  wallClockDelta: number
  reasons: string[]
}

/** A trial passes when its hidden evaluation (where there is one) and its acceptance both pass and nothing critical stands. */
export function passed(t: TrialOutcome): boolean {
  return t.hiddenPassed !== false && t.acceptancePassed && t.criticalFindings === 0
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

/** Relative change of a total; 0 when the baseline total is 0. */
const rel = (base: number, opt: number): number => (base === 0 ? 0 : (opt - base) / base)

export function evaluateGate(baseline: readonly TrialOutcome[], optimized: readonly TrialOutcome[], config: Partial<GateConfig> = {}): GateResult {
  const cfg = { ...DEFAULT_GATE, ...config }
  const strict = cfg.risk === 'high' || cfg.risk === 'critical'
  const minimumPairs = strict ? cfg.minimumPairs * 2 : cfg.minimumPairs
  const margin = strict ? 0 : cfg.margin

  // Pair by case: repetitions of a case are averaged on each side, so a case counts once.
  const group = (trials: readonly TrialOutcome[]): Map<string, TrialOutcome[]> => {
    const m = new Map<string, TrialOutcome[]>()
    for (const t of trials) m.set(t.caseKey, [...(m.get(t.caseKey) ?? []), t])
    return m
  }
  const b = group(baseline)
  const o = group(optimized)
  const keys = [...b.keys()].filter((k) => o.has(k)).sort()
  const diffs: number[] = []
  const regressions: string[] = []
  const improvements: string[] = []
  const sums = { bPass: 0, oPass: 0, bCrit: 0, oCrit: 0, bHigh: 0, oHigh: 0, bRep: 0, oRep: 0, bIn: 0, oIn: 0, bOut: 0, oOut: 0, bTurns: 0, oTurns: 0, bWall: 0, oWall: 0 }
  for (const key of keys) {
    const bs = b.get(key) as TrialOutcome[]
    const os = o.get(key) as TrialOutcome[]
    const bp = mean(bs.map((t) => (passed(t) ? 1 : 0)))
    const op = mean(os.map((t) => (passed(t) ? 1 : 0)))
    diffs.push(op - bp)
    if (bp > op) regressions.push(key)
    if (op > bp) improvements.push(key)
    sums.bPass += bp
    sums.oPass += op
    sums.bCrit += mean(bs.map((t) => t.criticalFindings))
    sums.oCrit += mean(os.map((t) => t.criticalFindings))
    sums.bHigh += mean(bs.map((t) => t.highFindings))
    sums.oHigh += mean(os.map((t) => t.highFindings))
    sums.bRep += mean(bs.map((t) => t.repairs + t.regressions))
    sums.oRep += mean(os.map((t) => t.repairs + t.regressions))
    sums.bIn += mean(bs.map((t) => t.inputTokens))
    sums.oIn += mean(os.map((t) => t.inputTokens))
    sums.bOut += mean(bs.map((t) => t.outputTokens))
    sums.oOut += mean(os.map((t) => t.outputTokens))
    sums.bTurns += mean(bs.map((t) => t.turns))
    sums.oTurns += mean(os.map((t) => t.turns))
    sums.bWall += mean(bs.map((t) => t.wallClockMs))
    sums.oWall += mean(os.map((t) => t.wallClockMs))
  }
  const n = keys.length
  const baselinePassRate = n > 0 ? sums.bPass / n : 0
  const optimizedPassRate = n > 0 ? sums.oPass / n : 0
  const reasons: string[] = []

  // One-sided 95% lower bound of the mean paired difference, by the normal approximation. For small n this
  // bound is too optimistic (a t quantile is larger), and with no variance it equals the mean: it is one
  // check among several, never the only one. The minimum-pairs rule and the checks below carry the rest.
  let lower: number | null = null
  if (n >= 2) {
    const d = mean(diffs)
    const variance = diffs.reduce((a, x) => a + (x - d) ** 2, 0) / (n - 1)
    lower = d - 1.645 * Math.sqrt(variance / n)
  }

  const base = {
    pairs: n,
    baselinePassRate,
    optimizedPassRate,
    passRateLowerBound: lower,
    regressions,
    improvements,
    severityDelta: { critical: sums.oCrit - sums.bCrit, high: sums.oHigh - sums.bHigh },
    repairDelta: sums.oRep - sums.bRep,
    inputTokenDelta: rel(sums.bIn, sums.oIn),
    outputTokenDelta: rel(sums.bOut, sums.oOut),
    turnDelta: rel(sums.bTurns, sums.oTurns),
    wallClockDelta: rel(sums.bWall, sums.oWall),
  }

  const unpaired = [...b.keys()].filter((k) => !o.has(k)).sort()
  if (unpaired.length > 0) {
    reasons.push(`${unpaired.length} baseline case(s) have no optimized trial (${unpaired.slice(0, 5).join(', ')}${unpaired.length > 5 ? ', …' : ''}). A case that was not run cannot be assumed to pass. The baseline stays the default.`)
    return { ...base, verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false, reasons }
  }
  if (n < minimumPairs) {
    reasons.push(`${n} paired cases; ${minimumPairs} are needed${strict ? ` for ${cfg.risk}-risk work` : ''}. The baseline stays the default.`)
    return { ...base, verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false, reasons }
  }
  if (base.severityDelta.critical > 0) reasons.push(`Critical findings rose by ${base.severityDelta.critical.toFixed(2)} across the cases.`)
  if (strict && regressions.length > 0) reasons.push(`${regressions.length} case(s) passed on the baseline and failed when optimized; ${cfg.risk}-risk work tolerates none.`)
  // The bound guards against a drop, so it is asked only when some case is worse. With none worse it used to
  // refuse on the spread of the improvements alone: one case going from failing to passing among eight equal
  // ones gives a mean of +12.5 points and a lower bound of -8.1, and a variant that is worse on no case was
  // called inferior. How far the cases seen speak for those not seen is the minimum-pairs rule's question.
  if (lower !== null && lower < -margin && regressions.length > 0) reasons.push(`The pass rate may be lower by more than ${(margin * 100).toFixed(0)} points (lower bound ${(lower * 100).toFixed(1)}).`)
  if (base.repairDelta > n * 0.25) reasons.push(`Repairs and regressions rose by ${base.repairDelta.toFixed(2)} across ${n} cases.`)
  if (reasons.length > 0) return { ...base, verdict: 'INFERIOR', mayBecomeDefault: false, reasons }
  if (baselinePassRate === 0 && optimizedPassRate === 0) {
    reasons.push(`No case passed on either side over ${n} paired cases: nothing shows that quality is kept. The baseline stays the default.`)
    return { ...base, verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false, reasons }
  }

  if (optimizedPassRate > baselinePassRate && lower !== null && lower > 0) {
    reasons.push(`Pass rate ${(baselinePassRate * 100).toFixed(0)}% to ${(optimizedPassRate * 100).toFixed(0)}% over ${n} paired cases.`)
    return { ...base, verdict: 'IMPROVED', mayBecomeDefault: true, reasons }
  }
  reasons.push(`Pass rate ${(baselinePassRate * 100).toFixed(0)}% against ${(optimizedPassRate * 100).toFixed(0)}% over ${n} paired cases, within the margin; no rise in critical findings or repairs.`)
  return { ...base, verdict: 'NON_INFERIOR', mayBecomeDefault: true, reasons }
}

// ───────────────────────────── retrieval quality ─────────────────────────────

export interface RetrievalCase {
  key: string
  /** Paths of the nodes the task cannot be done well without. */
  required: string[]
  /** Paths that would be wrong to present as current (stale, superseded, another program's). */
  forbidden: string[]
}

export interface RetrievalScore {
  recall: number
  precision: number
  /** Required nodes that were not retrieved. */
  missed: string[]
  /** Forbidden nodes that were retrieved as if current. */
  wrong: string[]
  retrieved: number
  tokens: number
}

/** Recall and precision of one retrieval against a case. Precision counts a retrieved node as relevant when it is required or explicitly listed as acceptable. */
export function scoreRetrieval(testCase: RetrievalCase, retrieved: readonly { path: string; warned: boolean }[], tokens: number, acceptable: readonly string[] = []): RetrievalScore {
  const got = new Set(retrieved.map((r) => r.path))
  const missed = testCase.required.filter((p) => !got.has(p))
  // A forbidden node shown with a warning (a conflict, a historical record that was asked for) is not "presented as current".
  const wrong = retrieved.filter((r) => testCase.forbidden.includes(r.path) && !r.warned).map((r) => r.path)
  const relevant = new Set([...testCase.required, ...acceptable])
  const hits = retrieved.filter((r) => relevant.has(r.path)).length
  return {
    recall: testCase.required.length === 0 ? 1 : (testCase.required.length - missed.length) / testCase.required.length,
    precision: retrieved.length === 0 ? 1 : hits / retrieved.length,
    missed,
    wrong,
    retrieved: retrieved.length,
    tokens,
  }
}
