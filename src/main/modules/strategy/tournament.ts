import type { CandidateEvidence, TournamentComparison } from '@shared/v3'

/**
 * Candidate tournament. Pure: ranks speculative candidates from objective evidence only (did it produce a
 * result, did the checks pass, how many check commands failed, review findings if a review was run, size of
 * the change). No model opinion is an input. Every rule that separated two candidates is recorded.
 */

export interface TournamentEntry {
  label: string
  evidence: CandidateEvidence
}

export interface TournamentResult {
  /** Null when no candidate produced a result. */
  winner: string | null
  /** Labels, best first. */
  ranking: string[]
  comparisons: TournamentComparison[]
  /** decisive: the winner is separated from the runner-up by a correctness rule. */
  confidence: 'decisive' | 'marginal' | 'none'
  reason: string
}

interface Rule {
  name: string
  /** Negative when `a` is better, positive when `b` is, 0 for a tie. */
  compare(a: CandidateEvidence, b: CandidateEvidence): number
  describe(e: CandidateEvidence): string
  /** Rules about correctness make a decision decisive; size and label are only tie-breakers. */
  correctness: boolean
}

/**
 * Every rule maps a candidate to one number, lower is better, so the rules together are a lexicographic key
 * and the ranking is a total order whatever the input order. "Not measured" has a fixed place: for a
 * yes/no rule it sits between yes and no (it is not known to be good, and not known to be bad); for a
 * count it sorts after every measured count.
 */
const flag = (v: boolean | null): number => (v === null ? 0.5 : v ? 0 : 1)
const amount = (v: number | null): number => (v === null ? Number.POSITIVE_INFINITY : v)

const lower = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1)

const yesNo = (v: boolean | null): string => (v === null ? 'not measured' : v ? 'yes' : 'no')
const count = (v: number | null): string => (v === null ? 'not measured' : String(v))

/** In order of precedence. */
export const TOURNAMENT_RULES: readonly Rule[] = [
  {
    name: 'produced a result',
    compare: (a, b) => lower(flag(a.implemented), flag(b.implemented)),
    describe: (e) => yesNo(e.implemented),
    correctness: true,
  },
  {
    name: 'checks passed',
    compare: (a, b) => lower(flag(a.checksPassed), flag(b.checksPassed)),
    describe: (e) => yesNo(e.checksPassed),
    correctness: true,
  },
  {
    name: 'acceptance commands passed',
    compare: (a, b) => lower(flag(a.acceptancePassed), flag(b.acceptancePassed)),
    describe: (e) => yesNo(e.acceptancePassed),
    correctness: true,
  },
  {
    name: 'fewer failing check commands',
    compare: (a, b) => lower(amount(a.checksFailedCount), amount(b.checksFailedCount)),
    describe: (e) => count(e.checksFailedCount),
    correctness: true,
  },
  {
    name: 'fewer critical review findings',
    compare: (a, b) => lower(amount(a.criticalFindings), amount(b.criticalFindings)),
    describe: (e) => count(e.criticalFindings),
    correctness: true,
  },
  {
    name: 'fewer high review findings',
    compare: (a, b) => lower(amount(a.highFindings), amount(b.highFindings)),
    describe: (e) => count(e.highFindings),
    correctness: true,
  },
  {
    name: 'smaller change (lines)',
    compare: (a, b) => lower(amount(a.linesChanged), amount(b.linesChanged)),
    describe: (e) => count(e.linesChanged),
    correctness: false,
  },
  {
    name: 'fewer files changed',
    compare: (a, b) => lower(amount(a.filesChanged), amount(b.filesChanged)),
    describe: (e) => count(e.filesChanged),
    correctness: false,
  },
]

/** The first rule that separates the two, or null when every rule ties. */
function separate(a: TournamentEntry, b: TournamentEntry): { rule: Rule; order: number } | null {
  for (const rule of TOURNAMENT_RULES) {
    const order = rule.compare(a.evidence, b.evidence)
    if (order !== 0) return { rule, order }
  }
  return null
}

export function rankCandidates(entries: readonly TournamentEntry[]): TournamentResult {
  // The label is the final, arbitrary but deterministic tie-breaker.
  const ranked = [...entries].sort((a, b) => separate(a, b)?.order ?? a.label.localeCompare(b.label))
  const comparisons: TournamentComparison[] = []
  for (let i = 0; i + 1 < ranked.length; i++) {
    const better = ranked[i]!
    const worse = ranked[i + 1]!
    const found = separate(better, worse)
    comparisons.push({
      criterion: found ? found.rule.name : 'label (every measured rule tied)',
      better: better.label,
      worse: worse.label,
      detail: found
        ? `${better.label}: ${found.rule.describe(better.evidence)}; ${worse.label}: ${found.rule.describe(worse.evidence)}`
        : 'No objective rule separated the two candidates.',
    })
  }

  const ranking = ranked.map((e) => e.label)
  const best = ranked[0]
  if (!best || !best.evidence.implemented) {
    return { winner: null, ranking, comparisons, confidence: 'none', reason: 'No candidate produced a result.' }
  }
  const runnerUp = ranked[1]
  const top = runnerUp ? separate(best, runnerUp) : null
  const confidence = !runnerUp || top?.rule.correctness ? 'decisive' : 'marginal'
  const reason = !runnerUp
    ? `Candidate ${best.label} was the only candidate.`
    : top
      ? `Candidate ${best.label} selected on "${top.rule.name}" (${comparisons[0]!.detail}).`
      : `Candidates tied on every measured rule; ${best.label} selected by label.`
  return { winner: best.label, ranking, comparisons, confidence, reason }
}
