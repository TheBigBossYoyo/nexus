import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { TrustClass } from '@shared/security'
import { newId, nowIso } from '@shared/ids'
import { canonicalizePath } from './paths'

/**
 * Execution provenance: which files an agent wrote or changed. Two sources are combined.
 *  1. A record of the writes NEXUS saw (Write/Edit/NotebookEdit tool calls and shell redirections), in memory
 *     and optionally persisted.
 *  2. The difference from the worktree's base commit. That survives a restart, and it also catches changes
 *     made by a program an agent ran (a build step, a generator), which no tool call announced.
 */

export interface FileProvenanceRecord {
  id: string
  /** Absolute canonical path of the file. */
  path: string
  worktree: string
  /** sha256 of the content written when it was known at record time (Write tool); null when it was not (Edit, shell). */
  sha256: string | null
  createdByAgentId: string | null
  modifiedByAgentId: string | null
  taskId: string | null
  runId: string | null
  firstSeenAt: string
  updatedAt: string
  trust: TrustClass
}

/** Persistence for provenance records. Optional: without it the tracker keeps them in memory only. */
export interface ProvenanceStore {
  upsert(record: FileProvenanceRecord): void
  listByWorktree(worktree: string): FileProvenanceRecord[]
}

/** Reads a file as it is in the base commit. null: it does not exist there. Throws when the base cannot be read at all. */
export interface BaseFileReader {
  /** Identifies the worktree and base commit this reader reads, so cached base content is never shared across runs or projects. */
  readonly key?: string
  show(relPath: string): Promise<string | null>
}

export type BaseStatus = 'unchanged' | 'modified' | 'new' | 'unknown'

export interface WriteContext {
  agentId: string | null
  taskId: string | null
  runId: string | null
}

const MAX_COMPARE_BYTES = 2 * 1024 * 1024

export function sha256Of(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Line endings differ between a Windows checkout and the stored blob; compare without them. */
const normalizeEol = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, '\n')

const MAX_TRACKED_PER_WORKTREE = 5000

export class ProvenanceTracker {
  private readonly byKey = new Map<string, FileProvenanceRecord>()
  private readonly loaded = new Set<string>()
  private readonly baseCache = new Map<string, string | null | undefined>()
  private readonly readerIds = new WeakMap<object, number>()
  private nextReaderId = 1

  /** Cache key for a base file: worktree root + base commit (or a per-reader id) + path. */
  private cacheKey(base: BaseFileReader, rel: string): string {
    let id = base.key
    if (id === undefined) {
      let n = this.readerIds.get(base)
      if (n === undefined) {
        n = this.nextReaderId++
        this.readerIds.set(base, n)
      }
      id = `reader-${n}`
    }
    return `${id}|${rel}`
  }

  constructor(
    private readonly store?: ProvenanceStore,
    private readonly now: () => string = nowIso,
  ) {}

  private key(file: string): string {
    return process.platform === 'win32' ? file.toLowerCase() : file
  }

  private resolve(file: string, worktree: string): string {
    try {
      return canonicalizePath(file, worktree)
    } catch {
      return path.resolve(worktree, file)
    }
  }

  private ensureLoaded(worktree: string): void {
    const k = this.key(worktree)
    if (this.loaded.has(k)) return
    this.loaded.add(k)
    try {
      for (const r of this.store?.listByWorktree(worktree) ?? []) this.byKey.set(this.key(r.path), r)
    } catch {
      // A store that cannot be read only costs the restart-survival of in-memory records; the base diff still works.
    }
  }

  /** Records that an agent wrote or changed `file`. `content` is the full new content when known. */
  recordWrite(file: string, worktree: string, who: WriteContext, content?: string): FileProvenanceRecord {
    this.ensureLoaded(worktree)
    const abs = this.resolve(file, worktree)
    const k = this.key(abs)
    const t = this.now()
    const prev = this.byKey.get(k)
    const record: FileProvenanceRecord = {
      id: prev?.id ?? newId(),
      path: abs,
      worktree,
      sha256: content === undefined ? null : sha256Of(content),
      createdByAgentId: prev?.createdByAgentId ?? who.agentId,
      modifiedByAgentId: who.agentId,
      taskId: who.taskId,
      runId: who.runId,
      firstSeenAt: prev?.firstSeenAt ?? t,
      updatedAt: t,
      trust: 'UNTRUSTED_AGENT_AUTHORED',
    }
    this.byKey.set(k, record)
    if (this.byKey.size > MAX_TRACKED_PER_WORKTREE * 4) this.trim()
    try {
      this.store?.upsert(record)
    } catch {
      // Provenance persistence must never block a tool call.
    }
    return record
  }

  private trim(): void {
    const sorted = [...this.byKey.entries()].sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
    for (const [k] of sorted.slice(0, Math.floor(sorted.length / 2))) this.byKey.delete(k)
  }

  /** The record for a file an agent wrote through a tool call or redirection, or null. */
  recorded(file: string, worktree: string): FileProvenanceRecord | null {
    this.ensureLoaded(worktree)
    return this.byKey.get(this.key(this.resolve(file, worktree))) ?? null
  }

  /**
   * How the file compares to the base commit: unchanged, modified, new (not in the base) or unknown
   * (no base available or git failed). Compared on text with line endings normalised.
   */
  async statusVsBase(file: string, worktree: string, base: BaseFileReader | undefined): Promise<BaseStatus> {
    if (base === undefined) return 'unknown'
    const rel = path.relative(worktree, file).replace(/\\/g, '/')
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return 'unknown'
    let current: string
    try {
      if (statSync(file).size > MAX_COMPARE_BYTES) return 'unknown'
      current = readFileSync(file, 'utf8')
    } catch {
      return 'unknown'
    }
    let atBase: string | null
    try {
      const ck = this.cacheKey(base, rel)
      const cached = this.baseCache.get(ck)
      atBase = cached !== undefined ? cached : await base.show(rel)
      this.baseCache.set(ck, atBase)
    } catch {
      return 'unknown'
    }
    if (atBase === null) return 'new'
    return normalizeEol(atBase) === normalizeEol(current) ? 'unchanged' : 'modified'
  }

  /** The base content of a file (cached, since the base commit never changes). */
  async baseContent(rel: string, base: BaseFileReader | undefined): Promise<string | null | undefined> {
    if (base === undefined) return undefined
    const key = rel.replace(/\\/g, '/')
    const ck = this.cacheKey(base, key)
    if (this.baseCache.has(ck)) return this.baseCache.get(ck)
    try {
      const v = await base.show(key)
      this.baseCache.set(ck, v)
      return v
    } catch {
      return undefined
    }
  }
}

export type OriginKind = 'agent_authored' | 'agent_modified' | 'repository_unmodified' | 'unknown'

export interface FileOrigin {
  kind: OriginKind
  /** Why NEXUS believes that, for the decision log. */
  evidence: string
}

/**
 * Decides whether an in-worktree file is agent-authored. A recorded write wins unless the content provably
 * equals the base (an Edit that was reverted); otherwise the base diff decides.
 */
export async function originOf(file: string, worktree: string, tracker: ProvenanceTracker | undefined, base: BaseFileReader | undefined): Promise<FileOrigin> {
  const status = await (tracker ?? new ProvenanceTracker()).statusVsBase(file, worktree, base)
  const rec = tracker?.recorded(file, worktree) ?? null
  if (status === 'unchanged') return { kind: 'repository_unmodified', evidence: 'identical to the base commit' }
  if (status === 'new') return { kind: 'agent_authored', evidence: rec ? `written by agent ${rec.createdByAgentId ?? 'unknown'}; not in the base commit` : 'not in the base commit' }
  if (status === 'modified') return { kind: 'agent_modified', evidence: rec ? `modified by agent ${rec.modifiedByAgentId ?? 'unknown'}; differs from the base commit` : 'differs from the base commit' }
  if (rec !== null) return { kind: 'agent_authored', evidence: `written by agent ${rec.createdByAgentId ?? 'unknown'} (no base commit to compare with)` }
  return { kind: 'unknown', evidence: 'no write was recorded and no base commit is available' }
}

/** A BaseFileReader on top of a function that runs git (the GitService's `run`, hardened the same way). */
export function gitBaseReader(
  runGit: (cwd: string, args: readonly string[]) => Promise<{ exitCode: number | null; stdout: string }>,
  cwd: string,
  baseRef: string,
): BaseFileReader {
  return {
    key: `${cwd}|${baseRef}`,
    async show(relPath: string): Promise<string | null> {
      if (relPath.startsWith('-') || /[\0\r\n]/.test(relPath)) throw new Error('unsafe path')
      const exists = await runGit(cwd, ['cat-file', '-e', `${baseRef}:${relPath}`])
      if (exists.exitCode !== 0) return null
      const r = await runGit(cwd, ['show', `${baseRef}:${relPath}`])
      if (r.exitCode !== 0) throw new Error('git show failed')
      return r.stdout
    },
  }
}
