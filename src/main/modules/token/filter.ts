/**
 * What an agent is shown of a command's output. The raw output is stored by NEXUS and stays retrievable; this
 * decides which part of it goes into a prompt.
 *
 * 0.7.0 showed the last N characters. A failure that was not in the tail was invisible, and a passing run
 * spent the same N characters on passing lines. Two modes replace it:
 *
 *  - `superset` (the default): everything the tail cut showed, plus the failures that lie before the tail.
 *    It can only show more of what matters, so it needs no quality gate.
 *  - `compact`: for a passing run, the summary lines and a short tail instead of the full tail. This shows
 *    less text, so it is used only when the user turns output filtering on.
 */

export type FilterMode = 'tail' | 'superset' | 'compact'

export interface FilteredOutput {
  text: string
  totalChars: number
  shownChars: number
  totalLines: number
  /** Lines recognized as reporting a failure. */
  failureLines: number
  /** Failure lines that are in `text`. Equal to `failureLines` unless the excerpt budget ran out. */
  failureLinesShown: number
  /** True when part of the output is not in `text`. */
  truncated: boolean
}

/** Lines that report a failure, across the test runners and compilers NEXUS's check commands run. */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /\b(FAIL(ED|URE|S)?|ERROR|FATAL|Traceback|Exception|Unhandled|AssertionError|assertion failed|not ok|Segmentation fault|TIMED OUT|timed out)\b/,
  /\b(Error|error|panic|fatal):/,
  /^\s*(✗|✘|×|❯|✖)\s/u,
  /\berror\s+(TS|CS|E|C)\d+/,
  /\b\d+\s+(failed|failing|errors?)\b/i,
  /^\s*(Expected|Received|expected|actual|\+\s+expected|-\s+actual)\b/,
  /^\s*[-+]\s{1,3}\S.*$/,
  /^\s+at\s+\S+.*[:(]\d+/,
  /:\d+:\d+\s*[-:]\s*(error|warning)\b/i,
  /^E\s{2,}\S/,
  /^\s*\d+\s*\|\s/,
  /^\s*\|?\s*\^+\s*$/,
]
/** Lines that only look like failures. */
const NOT_FAILURE: readonly RegExp[] = [/\b0\s+(failed|failing|errors?)\b/i, /\bfail\s+0\b/i, /\bno\s+errors?\b/i, /\berrors?:\s*0\b/i, /^\s*ℹ\s+(fail|cancelled|skipped|todo)\s+0\s*$/u]

/** Lines that summarize a run: counts and totals. */
const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^\s*(Tests?|Test Files|Test Suites|Suites|Snapshots|Duration|Time|Ran)\b.*\d/i,
  /^\s*ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/u,
  /\b\d+\s+(passed|passing|failed|failing|skipped|pending|todo)\b/i,
  /^=+ .*\b(passed|failed|error)\b.* =+$/i,
  /^(ok|FAIL)\s+\S+\s+[\d.]+s/,
  /\bFound \d+ errors?\b/i,
  /\b(\d+ problems?|\d+ errors?, \d+ warnings?)\b/i,
]

export function isFailureLine(line: string): boolean {
  if (NOT_FAILURE.some((p) => p.test(line))) return false
  return FAILURE_PATTERNS.some((p) => p.test(line))
}

export function isSummaryLine(line: string): boolean {
  return SUMMARY_PATTERNS.some((p) => p.test(line))
}

/** Lines of context kept around a failure line. */
const CONTEXT_LINES = 3
/** Characters of failures before the tail that the superset mode may add. */
export const EARLY_FAILURE_BUDGET = 3_000
/** Characters of tail a compact passing run keeps. */
const COMPACT_TAIL = 600

const marker = (lines: number): string => `[... ${lines} lines omitted; the full output is stored ...]`

/**
 * Filter a command's output for a prompt.
 * @param tailChars characters of the tail to keep, as 0.7.0 did (`SECTION_LIMITS.checkItem`)
 */
export function filterOutput(output: string, options: { failed: boolean; tailChars: number; mode?: FilterMode; earlyBudget?: number }): FilteredOutput {
  const text = output.replace(/\r\n?/g, '\n').trim()
  const lines = text === '' ? [] : text.split('\n')
  const mode = options.mode ?? 'superset'
  const failure = lines.map(isFailureLine)
  const failureLines = failure.filter(Boolean).length
  const base = { totalChars: text.length, totalLines: lines.length, failureLines }

  if (text.length <= options.tailChars && !(mode === 'compact' && !options.failed)) {
    return { ...base, text, shownChars: text.length, failureLinesShown: failureLines, truncated: false }
  }

  // The tail, on a line boundary: the first whole line that fits in the last `tailChars` characters.
  const tailStart = (limit: number): number => {
    let used = 0
    let i = lines.length
    while (i > 0) {
      const len = (lines[i - 1] as string).length + 1
      if (used + len > limit && i < lines.length) break
      used += len
      i--
      if (used >= limit) break
    }
    return i
  }

  if (mode === 'tail') {
    const start = tailStart(options.tailChars)
    const shown = lines.slice(start).join('\n')
    const head = start > 0 ? `${marker(start)}\n` : ''
    return { ...base, text: `${head}${shown}`, shownChars: shown.length, failureLinesShown: failure.slice(start).filter(Boolean).length, truncated: start > 0 }
  }

  if (mode === 'compact' && !options.failed && failureLines === 0) {
    // A passing run: what it ran and that it passed. A line that looks like a failure cancels the compaction (handled below).
    const start = tailStart(COMPACT_TAIL)
    const summary = lines.slice(0, start).filter(isSummaryLine)
    const parts = [...(summary.length > 0 ? [...new Set(summary)].slice(0, 12) : []), ...(start > 0 ? [marker(start - summary.length)] : []), ...lines.slice(start)]
    const shown = parts.join('\n')
    return { ...base, text: shown, shownChars: shown.length, failureLinesShown: 0, truncated: start > 0 }
  }

  // Superset: the whole tail, and before it the failures with a little context, in their original order.
  const start = tailStart(options.tailChars)
  const keep = new Array<boolean>(start).fill(false)
  let budget = options.earlyBudget ?? EARLY_FAILURE_BUDGET
  let shownEarly = 0
  for (let i = 0; i < start && budget > 0; i++) {
    if (!failure[i]) continue
    const from = Math.max(0, i - CONTEXT_LINES)
    const to = Math.min(start - 1, i + CONTEXT_LINES)
    let cost = 0
    for (let j = from; j <= to; j++) if (!keep[j]) cost += (lines[j] as string).length + 1
    if (cost > budget && shownEarly > 0) continue
    for (let j = from; j <= to; j++) keep[j] = true
    budget -= cost
    shownEarly++
  }
  // Summary lines before the tail are short and say what the run was.
  for (let i = 0; i < start; i++) if (!keep[i] && isSummaryLine(lines[i] as string) && budget > 0) {
    keep[i] = true
    budget -= (lines[i] as string).length + 1
  }
  const out: string[] = []
  let gap = 0
  for (let i = 0; i < start; i++) {
    if (keep[i]) {
      if (gap > 0) out.push(marker(gap))
      gap = 0
      out.push(lines[i] as string)
    } else gap++
  }
  if (gap > 0) out.push(marker(gap))
  out.push(...lines.slice(start))
  const shown = out.join('\n')
  const failureLinesShown = failure.filter((f, i) => f && (i >= start || keep[i])).length
  return { ...base, text: shown, shownChars: shown.length, failureLinesShown, truncated: start > 0 }
}

/** One line that says what a check did, for the first level of progressive disclosure. */
export function summarizeOutput(output: string, exitCode: number | null, timedOut: boolean): string {
  const lines = output.replace(/\r\n?/g, '\n').split('\n')
  const status = timedOut ? 'timed out' : exitCode === 0 ? 'passed' : `failed (exit ${exitCode ?? 'none'})`
  const summary = [...new Set(lines.filter(isSummaryLine).map((l) => l.trim()))].slice(-4)
  const failures = lines.filter(isFailureLine).length
  return `${status}; ${lines.length} lines${failures > 0 ? `, ${failures} failure lines` : ''}${summary.length > 0 ? `; ${summary.join('; ')}` : ''}`
}
