import type { GitService } from '@main/modules/git/git-service'
import type { ProjectProfile } from '@shared/domain'
import { newId } from '@shared/ids'
import type { FactKind, FactSource, RepositoryFact } from '@shared/v2'
import { analyzeRepository } from './analyze'
import { findStaleFacts } from './fingerprint'

/** Persistence the refresh needs; the SQLite fact repository satisfies it structurally. */
export interface FactStore {
  upsert(fact: RepositoryFact): RepositoryFact
  listByProject(projectId: string, opts?: { includeStale?: boolean; kind?: FactKind }): RepositoryFact[]
  markStale(ids: readonly string[]): void
}

export interface RefreshInput {
  projectId: string
  rootPath: string
  profile: ProjectProfile | null
  git: Pick<GitService, 'isRepository' | 'run'>
  now: string
  store: FactStore
}

export interface RefreshResult {
  facts: number
  stale: number
  added: number
  updated: number
}

const ANALYZED: ReadonlySet<FactSource> = new Set<FactSource>(['manifest', 'static_analysis', 'git'])
const keyOf = (f: { kind: FactKind; subject: string }): string => `${f.kind}\0${f.subject}`

/**
 * Re-analyzes the repository and reconciles stored facts. Analysis-owned facts that are no longer
 * produced become stale; agent, verifier and user facts are never overwritten or deleted, only marked
 * stale when their own supporting files changed.
 */
export async function refreshIntelligence(input: RefreshInput): Promise<RefreshResult> {
  const produced = await analyzeRepository({
    projectId: input.projectId,
    rootPath: input.rootPath,
    profile: input.profile,
    git: input.git,
    now: input.now,
  })
  const existing = input.store.listByProject(input.projectId, { includeStale: true })
  const byKey = new Map(existing.map((f) => [keyOf(f), f]))

  let added = 0
  let updated = 0
  let written = 0
  const reproduced = new Set<string>()
  for (const p of produced) {
    const key = keyOf(p)
    const prev = byKey.get(key)
    if (prev && !ANALYZED.has(prev.source)) continue // user-owned knowledge wins
    reproduced.add(key)
    input.store.upsert({
      ...p,
      id: prev?.id ?? newId(),
      createdAt: prev?.createdAt ?? input.now,
      stale: false,
      verifiedAt: input.now,
    })
    written++
    if (!prev) added++
    else if (
      prev.stale ||
      prev.statement !== p.statement ||
      prev.fingerprint !== p.fingerprint ||
      prev.confidence !== p.confidence ||
      prev.source !== p.source ||
      prev.files.join('\n') !== p.files.join('\n')
    ) {
      updated++
    }
  }

  const toStale = new Set<string>()
  const owned: RepositoryFact[] = []
  for (const f of existing) {
    if (f.stale) continue
    if (ANALYZED.has(f.source)) {
      if (!reproduced.has(keyOf(f))) toStale.add(f.id)
    } else {
      owned.push(f)
    }
  }
  for (const id of await findStaleFacts(input.rootPath, owned)) toStale.add(id)
  if (toStale.size > 0) input.store.markStale([...toStale])

  return { facts: written, stale: toStale.size, added, updated }
}
