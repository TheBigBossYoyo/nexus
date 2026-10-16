import type { RepositoryFact } from '@shared/v2'

export interface TaskForSelection {
  title: string
  description: string
  suggestedFiles: string[]
}

export interface SelectedFact {
  fact: RepositoryFact
  reason: string
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'will', 'should', 'must', 'are', 'not',
  'all', 'any', 'can', 'add', 'use', 'new', 'has', 'have', 'its', 'when', 'then', 'also', 'each', 'make',
])
const CONFIDENCE: Record<RepositoryFact['confidence'], number> = { high: 0, medium: 1, low: 2 }

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t)
  return out
}

/** Paths a fact refers to: its evidence files plus subject paths (both ends of `a -> b`). */
function factPaths(f: RepositoryFact): string[] {
  const subjects = f.subject.split(' -> ').map((s) => s.replace(/\/$/, ''))
  return [...f.files, ...subjects.filter((s) => s.includes('/') || /\.[a-z0-9]+$/i.test(s))]
}

/** How many folders above a task's file a fact's folder may be and still be about it. */
const NEAR_FOLDER = 2
const depth = (p: string): number => p.split('/').length
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

interface PathMatch {
  rank: number
  reason: string
}

function matchPaths(f: RepositoryFact, suggested: readonly string[]): PathMatch | null {
  let best: PathMatch | null = null
  const consider = (rank: number, reason: string): void => {
    if (best === null || rank < best.rank) best = { rank, reason }
  }
  for (const p of factPaths(f)) {
    for (const s of suggested) {
      if (p === s) consider(0, `supporting file ${p} is one of the task's suggested files`)
      // 0.9.1: only a folder near the file says something about it. `src/main` "contains" every file of an
      // Electron app's main process, and its facts (import relations of whole folders) filled real workers' packs.
      else if (s.startsWith(`${p}/`) && depth(s) - depth(p) <= NEAR_FOLDER) consider(1, `${p} contains the task's suggested file ${s}`)
      else if (p.startsWith(`${s}/`)) consider(1, `${p} is inside the task's suggested path ${s}`)
      // A file of the same folder; a module as wide as `src/main` matched files that had nothing in common.
      else if (p.includes('/') && dirOf(p) !== '' && dirOf(p) === dirOf(s)) consider(2, `${p} is in ${dirOf(p)}, the folder of suggested file ${s}`)
    }
  }
  return best
}

/**
 * Pure, deterministic relevance selection. Stale facts are never returned. Order: facts that share a
 * path or module with the task's suggested files, then command facts, then facts whose text overlaps
 * the task title and description.
 */
export function selectFactsForTask(
  facts: readonly RepositoryFact[],
  task: TaskForSelection,
  limit: number,
): SelectedFact[] {
  if (limit <= 0) return []
  const suggested = [...new Set(task.suggestedFiles.map(norm).filter((s) => s !== ''))]
  const taskTokens = tokens(`${task.title} ${task.description}`)

  interface Scored extends SelectedFact {
    tier: number
    sub: number
  }
  const scored: Scored[] = []
  for (const fact of facts) {
    if (fact.stale) continue
    const pm = suggested.length > 0 ? matchPaths(fact, suggested) : null
    if (pm) {
      scored.push({ fact, reason: pm.reason, tier: 0, sub: pm.rank })
      continue
    }
    if (fact.kind === 'command') {
      scored.push({ fact, reason: `${fact.subject} command is always relevant to implementers`, tier: 1, sub: 0 })
      continue
    }
    if (taskTokens.size === 0) continue
    const subjectTokens = tokens(fact.subject)
    const allTokens = tokens(`${fact.subject} ${fact.statement}`)
    const shared = [...allTokens].filter((t) => taskTokens.has(t)).sort()
    const inSubject = [...subjectTokens].some((t) => taskTokens.has(t))
    if (shared.length >= 2 || (shared.length >= 1 && inSubject)) {
      scored.push({
        fact,
        reason: `mentions terms from the task: ${shared.slice(0, 5).join(', ')}`,
        tier: 2,
        sub: -shared.length,
      })
    }
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.sub - b.sub ||
      CONFIDENCE[a.fact.confidence] - CONFIDENCE[b.fact.confidence] ||
      (a.fact.kind < b.fact.kind ? -1 : a.fact.kind > b.fact.kind ? 1 : 0) ||
      (a.fact.subject < b.fact.subject ? -1 : a.fact.subject > b.fact.subject ? 1 : 0) ||
      (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0),
  )
  return scored.slice(0, limit).map(({ fact, reason }) => ({ fact, reason }))
}
