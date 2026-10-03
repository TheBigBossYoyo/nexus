import { createHash } from 'node:crypto'
import { rm, rmdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shortId } from '@shared/ids'
import { NexusError, errorMessage } from '@shared/result'
import type { GitService, WorktreeInfo } from './git-service'
import { isPathInside, pathKey } from './paths'

export interface PlannedPaths {
  path: string
  branch: string
}

export interface CreatedWorktree extends PlannedPaths {
  baseCommit: string
}

export interface OrphanReport {
  /** Registered with git under the worktrees root, but not in NEXUS's known set. */
  unknownToNexus: WorktreeInfo[]
  /** Registered with git under the worktrees root, but the directory no longer exists. */
  missingOnDisk: WorktreeInfo[]
  /** Paths NEXUS knows that git has no registration for. */
  knownButUnregistered: string[]
}

export interface CleanupReport {
  /** Orphan worktrees that were clean and have been removed. */
  removed: string[]
  /** Orphans with uncommitted changes, left untouched for the user to decide. */
  skippedDirty: string[]
  failed: { path: string; error: string }[]
  /** Registrations pruned because their directory was missing. */
  pruned: string[]
}

const MAX_KEY_LENGTH = 24
/** Windows device names cannot be file or directory names (with or without an extension). */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

function sanitizeKey(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_LENGTH)
    .replace(/-+$/g, '')
  // Lossy sanitising (or truncation) could make two keys collide, so disambiguate with a hash.
  if (slug !== '' && slug === key && !RESERVED_DEVICE_NAME.test(slug)) return slug
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 4)
  return slug === '' ? `task-${hash}` : `${slug}-${hash}`
}

/** Deterministic, short worktree locations and `nexus/<run>/<task>` branch names. */
export class WorktreeManager {
  constructor(
    private readonly git: GitService,
    private readonly worktreesRoot: string,
  ) {}

  planPaths(runId: string, taskKey: string): PlannedPaths {
    const run = shortId(runId)
    const key = sanitizeKey(taskKey)
    return { path: join(resolve(this.worktreesRoot), run, key), branch: `nexus/${run}/${key}` }
  }

  async createForTask(opts: { repoRoot: string; runId: string; taskKey: string; startPoint: string }): Promise<CreatedWorktree> {
    const plan = this.planPaths(opts.runId, opts.taskKey)
    return this.create(opts.repoRoot, plan, opts.startPoint)
  }

  /** Worktree for the run's integration branch `nexus/<run>/integration`. */
  async createIntegration(opts: { repoRoot: string; runId: string; startPoint: string }): Promise<CreatedWorktree> {
    const run = shortId(opts.runId)
    const plan = { path: join(resolve(this.worktreesRoot), run, 'integration'), branch: `nexus/${run}/integration` }
    return this.create(opts.repoRoot, plan, opts.startPoint)
  }

  private async create(repoRoot: string, plan: PlannedPaths, startPoint: string): Promise<CreatedWorktree> {
    const baseCommit = await this.git.createWorktree(repoRoot, plan.path, plan.branch, startPoint)
    return { ...plan, baseCommit }
  }

  /**
   * Restores a worktree under the root to its HEAD commit and removes untracked files that are not
   * ignored (ignored dependencies and caches survive). Never touches paths outside the root.
   */
  async resetClean(path: string): Promise<void> {
    if (!(await isPathInside(path, this.worktreesRoot))) {
      throw new NexusError('path_violation', `Refusing to reset a worktree outside ${this.worktreesRoot}: ${path}`, { path })
    }
    await this.git.resetClean(path)
  }

  /** Removes a worktree under the root; refuses dirty ones unless `force`. Never touches paths outside the root. */
  async remove(repoRoot: string, path: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!(await isPathInside(path, this.worktreesRoot))) {
      throw new NexusError('path_violation', `Refusing to remove a worktree outside ${this.worktreesRoot}: ${path}`, { path })
    }
    await this.git.removeWorktree(repoRoot, path, opts)
    if (opts.force) {
      // git can leave a directory behind when files were locked; sweep it, retrying on Windows locks.
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    }
    await rmdir(resolve(path, '..')).catch(() => undefined) // drop the run dir once empty
  }

  async findOrphans(repoRoot: string, knownPaths: readonly string[]): Promise<OrphanReport> {
    const registered = await this.git.listWorktrees(repoRoot)
    const known = new Set(await Promise.all(knownPaths.map((p) => pathKey(p))))
    const registeredKeys = new Set<string>()
    const unknownToNexus: WorktreeInfo[] = []
    const missingOnDisk: WorktreeInfo[] = []

    for (const wt of registered) {
      const key = await pathKey(wt.path)
      registeredKeys.add(key)
      if (!(await isPathInside(wt.path, this.worktreesRoot))) continue
      if (!(await dirExists(wt.path))) missingOnDisk.push(wt)
      else if (!known.has(key)) unknownToNexus.push(wt)
    }
    const knownButUnregistered: string[] = []
    for (const p of knownPaths) {
      if (!registeredKeys.has(await pathKey(p))) knownButUnregistered.push(p)
    }
    return { unknownToNexus, missingOnDisk, knownButUnregistered }
  }

  /** Prunes dead registrations and removes only clean, unknown worktrees; dirty ones are reported, not deleted. */
  async cleanupOrphans(repoRoot: string, knownPaths: readonly string[]): Promise<CleanupReport> {
    const report: CleanupReport = { removed: [], skippedDirty: [], failed: [], pruned: [] }
    const { unknownToNexus, missingOnDisk } = await this.findOrphans(repoRoot, knownPaths)
    if (missingOnDisk.length > 0) {
      await this.git.pruneWorktrees(repoRoot)
      report.pruned = missingOnDisk.map((w) => w.path)
    }
    for (const wt of unknownToNexus) {
      try {
        const status = await this.git.status(wt.path)
        if (!status.clean) {
          report.skippedDirty.push(wt.path)
          continue
        }
        await this.remove(repoRoot, wt.path)
        report.removed.push(wt.path)
      } catch (e) {
        report.failed.push({ path: wt.path, error: errorMessage(e) })
      }
    }
    return report
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
