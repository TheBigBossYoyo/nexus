import { SEVERITIES, type ReviewFinding } from '@shared/domain'
import type { ArbiterOutput } from '@shared/v2'

export interface FindingSet {
  reviewer: string
  findings: ReviewFinding[]
}

export interface DedupedFinding {
  finding: ReviewFinding
  reportedBy: string[]
}

/** Findings this many lines apart (or fewer) in one file count as the same spot. */
const LINE_PROXIMITY = 3
const TITLE_SIMILARITY = 0.6

const CONFIDENCE_ORDER: readonly ReviewFinding['confidence'][] = ['low', 'medium', 'high']
const severityRank = (s: ReviewFinding['severity']): number => SEVERITIES.indexOf(s)
const confidenceRank = (c: ReviewFinding['confidence']): number => CONFIDENCE_ORDER.indexOf(c)

const normalizeFile = (file: string | null): string | null =>
  file === null ? null : file.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((t) => t.length > 0),
  )
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

function lineRange(f: ReviewFinding): [number, number] | null {
  if (f.lineStart === null) return null
  const end = f.lineEnd ?? f.lineStart
  return [Math.min(f.lineStart, end), Math.max(f.lineStart, end)]
}

function isDuplicate(a: ReviewFinding, b: ReviewFinding): boolean {
  const fileA = normalizeFile(a.file)
  const fileB = normalizeFile(b.file)
  if (fileA !== fileB) return false
  const ra = lineRange(a)
  const rb = lineRange(b)
  if (ra && rb) {
    // Same file only (file-less findings with lines are not comparable by position).
    if (fileA === null) return false
    return ra[0] <= rb[1] + LINE_PROXIMITY && rb[0] <= ra[1] + LINE_PROXIMITY
  }
  if (ra || rb) return false
  return a.category === b.category && jaccard(titleTokens(a.title), titleTokens(b.title)) >= TITLE_SIMILARITY
}

function merge(members: readonly ReviewFinding[]): ReviewFinding {
  // The first member with the highest severity supplies the wording.
  let lead = members[0] as ReviewFinding
  for (const m of members) if (severityRank(m.severity) < severityRank(lead.severity)) lead = m
  let confidence = lead.confidence
  let evidence = lead.evidence
  let lineStart = lead.lineStart
  let lineEnd = lead.lineEnd
  for (const m of members) {
    if (confidenceRank(m.confidence) > confidenceRank(confidence)) confidence = m.confidence
    if (m.evidence.length > evidence.length) evidence = m.evidence
    const range = lineRange(m)
    if (range) {
      lineStart = lineStart === null ? range[0] : Math.min(lineStart, range[0])
      lineEnd = lineEnd === null ? range[1] : Math.max(lineEnd, range[1], lineStart)
    }
  }
  return { ...lead, confidence, evidence, lineStart, lineEnd }
}

/**
 * Merge findings that several reviewers reported about the same spot. Duplicates share a file with
 * overlapping or near (within 3 lines) ranges, or have no line info and near-identical titles
 * (token Jaccard >= 0.6) in the same file (or both file-less) and category. A merged finding keeps
 * the highest severity and confidence and the longer evidence. Output is ordered by severity, then
 * first appearance.
 */
export function dedupeFindings(sets: readonly FindingSet[]): DedupedFinding[] {
  const groups: { members: ReviewFinding[]; reviewers: string[] }[] = []
  for (const set of sets) {
    for (const finding of set.findings) {
      let group = groups.find((g) => g.members.some((m) => isDuplicate(m, finding)))
      if (!group) {
        group = { members: [], reviewers: [] }
        groups.push(group)
      }
      group.members.push(finding)
      if (!group.reviewers.includes(set.reviewer)) group.reviewers.push(set.reviewer)
    }
  }
  return groups
    .map((g, index) => ({ finding: merge(g.members), reportedBy: g.reviewers, index }))
    .sort((a, b) => severityRank(a.finding.severity) - severityRank(b.finding.severity) || a.index - b.index)
    .map(({ finding, reportedBy }) => ({ finding, reportedBy }))
}

/**
 * Split findings by the arbiter's verdicts (`findingIndex` points into `deduped`). Fail-safe: a
 * finding the arbiter did not rule on is accepted only when it is critical or high severity with
 * high confidence, so a silent arbiter can neither drop a serious finding nor let noise block a task.
 * If an index is decided more than once, the first decision wins; out-of-range indexes are ignored.
 */
export function applyArbitration(
  deduped: readonly DedupedFinding[],
  decisions: ArbiterOutput['decisions'],
): { accepted: ReviewFinding[]; rejected: { finding: ReviewFinding; reason: string }[] } {
  const byIndex = new Map<number, ArbiterOutput['decisions'][number]>()
  for (const d of decisions) if (!byIndex.has(d.findingIndex)) byIndex.set(d.findingIndex, d)
  const accepted: ReviewFinding[] = []
  const rejected: { finding: ReviewFinding; reason: string }[] = []
  deduped.forEach(({ finding }, index) => {
    const decision = byIndex.get(index)
    if (decision) {
      if (decision.accepted) accepted.push(finding)
      else rejected.push({ finding, reason: decision.reason })
    } else if ((finding.severity === 'critical' || finding.severity === 'high') && finding.confidence === 'high') {
      accepted.push(finding)
    } else {
      rejected.push({ finding, reason: 'no arbiter decision' })
    }
  })
  return { accepted, rejected }
}
