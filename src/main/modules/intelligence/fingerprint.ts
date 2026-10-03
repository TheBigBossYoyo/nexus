import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepositoryFact } from '@shared/v2'
import { isSecretPath } from './walk'

/** At most this many supporting files contribute to one fingerprint. */
export const FINGERPRINT_FILE_CAP = 50

export type StatCache = Map<string, string>

async function stateOf(root: string, rel: string, cache?: StatCache): Promise<string> {
  const hit = cache?.get(rel)
  if (hit !== undefined) return hit
  let state: string
  if (rel.startsWith('..') || rel.includes('\0') || isSecretPath(rel)) {
    state = 'missing'
  } else {
    try {
      const st = await lstat(join(root, ...rel.split('/')))
      state = st.isFile() ? `${st.size}:${st.mtimeMs}` : 'missing'
    } catch {
      state = 'missing'
    }
  }
  cache?.set(rel, state)
  return state
}

/**
 * Stable hash over each supporting file's relative path, size and mtime (a missing file contributes a
 * marker). Only metadata is read, never content. Files are deduplicated, sorted and capped.
 */
export async function fingerprintFiles(
  rootPath: string,
  files: readonly string[],
  cache?: StatCache,
): Promise<string> {
  const sorted = [...new Set(files.map((f) => f.replace(/\\/g, '/')))]
    .sort()
    .slice(0, FINGERPRINT_FILE_CAP)
  const lines = await Promise.all(
    sorted.map(async (rel) => `${rel}\0${await stateOf(rootPath, rel, cache)}`),
  )
  return createHash('sha1').update(lines.join('\n')).digest('hex')
}

/** Ids of facts whose supporting files no longer match their stored fingerprint. */
export async function findStaleFacts(
  rootPath: string,
  facts: readonly Pick<RepositoryFact, 'id' | 'files' | 'fingerprint'>[],
): Promise<string[]> {
  const cache: StatCache = new Map()
  const out: string[] = []
  for (const f of facts) {
    if ((await fingerprintFiles(rootPath, f.files, cache)) !== f.fingerprint) out.push(f.id)
  }
  return out
}
