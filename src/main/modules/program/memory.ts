import type { Milestone, ProgramMemoryEntry, MemoryProposal } from '@shared/program'

/**
 * Program memory: a small set of validated, durable facts (decisions, hazards, interfaces, rejected
 * approaches). Never a transcript. A mission gets only the entries relevant to its milestone.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'should', 'when', 'have', 'has', 'are', 'was', 'not', 'all', 'any', 'can', 'its', 'use', 'used', 'will', 'each', 'new', 'add', 'make'])

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    // A crude stem keeps "tests" and "test", "caching" and "cache" together.
    out.add(raw.replace(/(ing|ed|es|s)$/, '').slice(0, 24) || raw)
  }
  return out
}

/** Kinds that constrain later work are worth more than a record of what happened. */
const KIND_WEIGHT: Record<ProgramMemoryEntry['kind'], number> = {
  security_constraint: 3,
  hazard: 3,
  interface: 2.5,
  architecture_decision: 2.5,
  rejected_approach: 2,
  user_decision: 2,
  performance_baseline: 1.5,
  failure: 1.5,
}

export interface ScoredMemory {
  entry: ProgramMemoryEntry
  score: number
  /** Words shared with the milestone, for the record of why it was selected. */
  matched: string[]
}

/** Relevance of an entry to a milestone: shared words in title, tags and content, weighted by kind. */
export function scoreMemory(entry: ProgramMemoryEntry, milestone: Pick<Milestone, 'key' | 'title' | 'objective' | 'acceptanceCriteria' | 'expertise'>): ScoredMemory {
  const wanted = tokens([milestone.title, milestone.objective, ...milestone.acceptanceCriteria, milestone.expertise].join(' '))
  const title = tokens(entry.title)
  const tags = tokens(entry.tags.join(' '))
  const content = tokens(entry.content)
  const matched = new Set<string>()
  let overlap = 0
  for (const word of wanted) {
    if (title.has(word)) {
      overlap += 2
      matched.add(word)
    } else if (tags.has(word)) {
      overlap += 2
      matched.add(word)
    } else if (content.has(word)) {
      overlap += 1
      matched.add(word)
    }
  }
  // An entry recorded while working on the same milestone (an earlier, rejected attempt) is always relevant.
  const sameMilestone = entry.milestoneKey === milestone.key ? 4 : 0
  const score = overlap === 0 && sameMilestone === 0 ? 0 : (overlap + sameMilestone) * KIND_WEIGHT[entry.kind]
  return { entry, score, matched: [...matched].sort() }
}

export const MEMORY_PER_MISSION = 6

/** The entries a mission on `milestone` receives: relevant ones only, best first, at most `limit`. */
export function selectMemory(entries: readonly ProgramMemoryEntry[], milestone: Parameters<typeof scoreMemory>[1], limit = MEMORY_PER_MISSION): ScoredMemory[] {
  return entries
    .filter((e) => e.status === 'active')
    .map((e) => scoreMemory(e, milestone))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.createdAt.localeCompare(b.entry.createdAt))
    .slice(0, limit)
}

export type MemoryRejection = 'transcript' | 'no_evidence' | 'duplicate' | 'instruction'

/**
 * Validation of a proposed entry beyond its schema. A memory is a fact with evidence: a pasted transcript,
 * an entry whose evidence only repeats it, an instruction addressed to a future agent, or a fact already
 * stored is refused.
 */
export function validateMemory(proposal: MemoryProposal, existing: readonly ProgramMemoryEntry[]): MemoryRejection | null {
  const content = proposal.content
  const speakerTurns = (content.match(/^(user|assistant|human|agent|claude)\s*:/gim) ?? []).length
  if (speakerTurns >= 2 || content.split('\n').length > 25) return 'transcript'
  if (/\b(ignore (all|any|the|previous)|disregard (all|the|previous)|you must now|system prompt|shutdown \/|rm -rf)\b/i.test(`${proposal.title} ${content}`)) return 'instruction'
  const evidence = proposal.evidence.trim().toLowerCase()
  if (evidence.length < 8 || evidence === content.trim().toLowerCase() || evidence === proposal.title.trim().toLowerCase()) return 'no_evidence'
  const title = proposal.title.trim().toLowerCase()
  const words = tokens(content)
  for (const e of existing) {
    if (e.status !== 'active') continue
    if (e.title.trim().toLowerCase() === title) return 'duplicate'
    const other = tokens(e.content)
    const shared = [...words].filter((w) => other.has(w)).length
    if (words.size >= 6 && shared / words.size > 0.85 && e.kind === proposal.kind) return 'duplicate'
  }
  return null
}
