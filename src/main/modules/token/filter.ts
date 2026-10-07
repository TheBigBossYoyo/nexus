/**
 * What an agent is shown of a command's output. The raw output is stored by NEXUS and stays retrievable; this
 * decides which part of it goes into a prompt.
 *
 * 0.7.0 showed the last N characters. A failure that was not in the tail was invisible, and a passing run
 * spent the same N characters on passing lines. Two modes replace it:
 *
 *  - `superset` (the default): exactly the characters the 0.7.0 tail showed, and before them the failures
 *    that lie outside the tail. It can only show more of what matters, so it needs no quality gate.
 *  - `compact`: for a passing run, the summary lines and a short tail instead of the full tail. This shows
 *    less text, so it is used only when the user turns output filtering on.
 *
 * Bounds that hold for any output, including one enormous line: the tail is at most `tailChars` characters,
 * what is added before it is at most `earlyBudget` characters plus one closing marker (`MAX_EARLY_CHARS`),
 * and no pattern is run on more than `MATCH_CHARS` characters of a line.
 */

export type FilterMode = 'tail' | 'superset' | 'compact'

export interface FilteredOutput {
  text: string
  totalChars: number
  shownChars: number
  totalLines: number
  /** Lines recognized as reporting a failure. */
  failureLines: number
  /** Failure lines that are in `text`, whole or as their clamped form. */
  failureLinesShown: number
  /** True when part of the output is not in `text`. */
  truncated: boolean
}

/** A line is matched on at most this many characters (its start and its end): the patterns can never run long. */
const MATCH_CHARS = 1_000
/** A line shown before the tail is cut to this length, with a marker saying how much was left out. */
const EARLY_LINE_CHARS = 400

const forMatching = (line: string): string => (line.length > MATCH_CHARS ? `${line.slice(0, MATCH_CHARS / 2)} ${line.slice(-MATCH_CHARS / 2)}` : line)
const clampLine = (line: string): string => (line.length > EARLY_LINE_CHARS ? `${line.slice(0, EARLY_LINE_CHARS - 60)} [... ${line.length - EARLY_LINE_CHARS + 60} characters of this line omitted ...]` : line)

/** Lines that report a failure, across the test runners and compilers NEXUS's check commands run. */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /\b(FAIL(ED|URE|S)?|ERROR|FATAL|Traceback|Exception|Unhandled|AssertionError|assertion failed|not ok|Segmentation fault|TIMED OUT|timed out)\b/,
  /\b(Error|error|panic|fatal):/,
  /^\s*(✗|✘|×|❯|✖)\s/u,
  /\berror\s+(TS|CS|E|C)\d+/,
  /\b\d+\s+(failed|failing|errors?)\b/i,
  /^\s*(Expected|Received|expected|actual)\b/,
  /^\s+at\s\S[^:(]*[:(]\d+/,
  /:\d+:\d+\s*[-:]\s*(error|warning)\b/i,
  /^E\s{2,}\S/,
]
/** Lines that only look like failures. */
const NOT_FAILURE: readonly RegExp[] = [/\b0\s+(failed|failing|errors?)\b/i, /\bfail\s+0\b/i, /\bno\s+errors?\b/i, /\berrors?:\s*0\b/i, /^\s*ℹ\s+(fail|cancelled|skipped|todo)\s+0\s*$/u]

/** Lines that summarize a run: counts and totals. */
const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^\s*(Tests?|Test Files|Test Suites|Suites|Snapshots|Duration|Time|Ran)\b[^\d]*\d/i,
  /^\s*ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/u,
  /\b\d+\s+(passed|passing|failed|failing|skipped|pending|todo)\b/i,
  /^=+ [^=]*\b(passed|failed|error)\b[^=]* =+$/i,
  /^(ok|FAIL)\s+\S+\s+[\d.]+s/,
  /\bFound \d+ errors?\b/i,
  /\b(\d+ problems?|\d+ errors?, \d+ warnings?)\b/i,
  /^#\s+(pass|fail|tests|skip|todo)\s+\d/i,
]

export function isFailureLine(line: string): boolean {
  const l = forMatching(line)
  if (NOT_FAILURE.some((p) => p.test(l))) return false
  return FAILURE_PATTERNS.some((p) => p.test(l))
}

export function isSummaryLine(line: string): boolean {
  const l = forMatching(line)
  return SUMMARY_PATTERNS.some((p) => p.test(l))
}

/** Charged to the budget for every group of lines kept: the marker that may precede it. */
const MARKER_COST = 64
/** Lines of context kept around a failure line. */
const CONTEXT_LINES = 3
/** Characters of failures before the tail that the superset mode may add. */
export const EARLY_FAILURE_BUDGET = 3_000
/** The most the superset mode adds before the tail, whatever the output. */
export const MAX_EARLY_CHARS = EARLY_FAILURE_BUDGET + 2 * MARKER_COST
/** Characters of tail a compact passing run keeps. */
const COMPACT_TAIL = 600
/** Summary lines kept from before the tail. */
const MAX_SUMMARY_LINES = 12

const marker = (lines: number): string => `[... ${lines} lines omitted; the full output is stored ...]`

/**
 * Filter a command's output for a prompt.
 * @param tailChars characters of the tail to keep, as 0.7.0 did (`SECTION_LIMITS.checkItem`)
 */
export function filterOutput(output: string, options: { failed: boolean; tailChars: number; mode?: FilterMode; earlyBudget?: number }): FilteredOutput {
  const text = output.replace(/\r\n?/g, '\n').trim()
  const mode = options.mode ?? 'superset'
  const lines = text === '' ? [] : text.split('\n')
  const failure = lines.map(isFailureLine)
  const failureLines = failure.filter(Boolean).length
  const base = { totalChars: text.length, totalLines: lines.length, failureLines }

  const compacting = mode === 'compact' && !options.failed && failureLines === 0
  if (text.length <= options.tailChars && !compacting) {
    return { ...base, text, shownChars: text.length, failureLinesShown: failureLines, truncated: false }
  }

  // The tail is a character slice, exactly what 0.7.0 showed. `firstTailLine` is the first line that lies wholly
  // or partly in it; the lines before it are the "early" part.
  const tailChars = compacting ? Math.min(COMPACT_TAIL, options.tailChars) : options.tailChars
  const cut = Math.max(0, text.length - tailChars)
  const tail = text.slice(cut)
  let firstTailLine = lines.length
  for (let i = lines.length - 1, end = text.length; i >= 0; i--) {
    const start = end - (lines[i] as string).length
    if (end > cut) firstTailLine = i
    if (start <= cut) break
    end = start - 1
  }
  const tailFailures = failure.slice(firstTailLine).filter(Boolean).length

  if (mode === 'tail') {
    return { ...base, text: firstTailLine > 0 ? `${marker(firstTailLine)}\n${tail}` : tail, shownChars: tail.length, failureLinesShown: tailFailures, truncated: cut > 0 }
  }

  const keep = new Array<boolean>(firstTailLine).fill(false)
  let budget = compacting ? EARLY_LINE_CHARS * 4 : (options.earlyBudget ?? EARLY_FAILURE_BUDGET)
  const cost = (i: number): number => Math.min((lines[i] as string).length, EARLY_LINE_CHARS + 60) + 1
  let earlyFailuresShown = 0
  if (!compacting) {
    // Failures before the tail, each with a little context, in their original order, while the budget lasts.
    for (let i = 0; i < firstTailLine && budget > 0; i++) {
      if (!failure[i]) continue
      const from = Math.max(0, i - CONTEXT_LINES)
      const to = Math.min(firstTailLine - 1, i + CONTEXT_LINES)
      let need = 0
      for (let j = from; j <= to; j++) if (!keep[j]) need += cost(j)
      if (need > 0) need += MARKER_COST
      if (need > budget) {
        // The window does not fit: the failure line itself may still.
        if (keep[i] || cost(i) + MARKER_COST > budget) continue
        keep[i] = true
        budget -= cost(i) + MARKER_COST
      } else {
        for (let j = from; j <= to; j++) keep[j] = true
        budget -= need
      }
      earlyFailuresShown++
    }
  }
  // Summary lines before the tail are short and say what the run was.
  let summaries = 0
  for (let i = 0; i < firstTailLine && summaries < MAX_SUMMARY_LINES; i++) {
    if (keep[i] || !isSummaryLine(lines[i] as string) || cost(i) + MARKER_COST > budget) continue
    keep[i] = true
    budget -= cost(i) + MARKER_COST
    summaries++
  }
  const out: string[] = []
  let gap = 0
  for (let i = 0; i < firstTailLine; i++) {
    if (keep[i]) {
      if (gap > 0) out.push(marker(gap))
      gap = 0
      out.push(clampLine(lines[i] as string))
    } else gap++
  }
  if (gap > 0) out.push(marker(gap))
  const early = out.join('\n')
  const shown = early === '' ? tail : `${early}\n${tail}`
  return { ...base, text: shown, shownChars: shown.length, failureLinesShown: tailFailures + earlyFailuresShown, truncated: cut > 0 }
}

/** One line that says what a check did, for the first level of progressive disclosure. */
export function summarizeOutput(output: string, exitCode: number | null, timedOut: boolean): string {
  const lines = output.replace(/\r\n?/g, '\n').split('\n')
  const status = timedOut ? 'timed out' : exitCode === 0 ? 'passed' : `failed (exit ${exitCode ?? 'none'})`
  const summary = [...new Set(lines.filter(isSummaryLine).map((l) => clampLine(l.trim())))].slice(-4)
  const failures = lines.filter(isFailureLine).length
  return `${status}; ${lines.length} lines${failures > 0 ? `, ${failures} failure lines` : ''}${summary.length > 0 ? `; ${summary.join('; ')}` : ''}`
}
