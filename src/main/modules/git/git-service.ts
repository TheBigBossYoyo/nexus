import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { NexusError } from '@shared/result'
import { runProcess } from '../process/run-process'
import type { ProcessResult } from '../process/run-process'

export interface GitAuthor {
  name: string
  email: string
}

export interface StatusEntry {
  path: string
  /** Index (staged) status letter from porcelain v2, '.' when unchanged. */
  index: string
  /** Working-tree status letter, '.' when unchanged. */
  worktree: string
  /** Source path for renames/copies. */
  origPath?: string
}

export interface GitStatus {
  /** No staged, unstaged, untracked or conflicted entries. */
  clean: boolean
  staged: StatusEntry[]
  unstaged: StatusEntry[]
  untracked: string[]
  conflicted: string[]
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed'

export interface DiffFile {
  path: string
  /** Previous path for renames and copies. */
  oldPath?: string
  status: DiffStatus
  additions: number
  deletions: number
  binary: boolean
}

export interface DiffResult {
  files: DiffFile[]
  patch: string
  /** True when the patch exceeded the size cap and was cut (files are always complete). */
  truncated: boolean
}

export interface WorktreeInfo {
  path: string
  head: string | null
  /** Short branch name, null when detached or bare. */
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  /** True when the directory is gone and `git worktree prune` would drop the registration. */
  prunable: boolean
}

export interface CommitInfo {
  sha: string
  authorName: string
  authorEmail: string
  date: string
  subject: string
}

export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[] }

export interface RunGitOptions {
  input?: string
  env?: NodeJS.ProcessEnv
  /** Exit codes treated as success. Default [0]. */
  okCodes?: readonly number[]
  maxOutputBytes?: number
  keep?: 'head' | 'tail'
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_PATCH_BYTES = 1024 * 1024
const LOCK_ERROR = /permission denied|being used by another process|resource busy|directory not empty|unable to (delete|unlink)|failed to delete/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function splitFields(entry: string, count: number): string[] {
  // First `count` space-separated fields, then the remainder (a path that may contain spaces).
  const out: string[] = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    const next = entry.indexOf(' ', pos)
    if (next === -1) break
    out.push(entry.slice(pos, next))
    pos = next + 1
  }
  out.push(entry.slice(pos))
  return out
}

export function parseStatusV2(raw: string): GitStatus {
  const staged: StatusEntry[] = []
  const unstaged: StatusEntry[] = []
  const untracked: string[] = []
  const conflicted: string[] = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry === '') continue
    const kind = entry[0]
    if (kind === '1' || kind === '2') {
      const f = splitFields(entry, kind === '1' ? 8 : 9)
      const xy = f[1] ?? '..'
      const item: StatusEntry = { path: f[f.length - 1]!, index: xy[0] ?? '.', worktree: xy[1] ?? '.' }
      if (kind === '2') item.origPath = parts[++i]
      if (item.index !== '.') staged.push(item)
      if (item.worktree !== '.') unstaged.push(item)
    } else if (kind === 'u') {
      conflicted.push(splitFields(entry, 10).pop()!)
    } else if (kind === '?') {
      untracked.push(entry.slice(2))
    }
    // '#' headers and '!' ignored entries are not requested and not reported.
  }
  return {
    clean: staged.length + unstaged.length + untracked.length + conflicted.length === 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  }
}

function diffStatusFromCode(code: string): DiffStatus {
  switch (code[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'type_changed'
    default:
      return 'modified'
  }
}

export function parseDiffFiles(nameStatusZ: string, numstatZ: string): DiffFile[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const nums = numstatZ.split('\0')
  for (let i = 0; i < nums.length; i++) {
    const tok = nums[i]!
    if (tok === '') continue
    const t1 = tok.indexOf('\t')
    const t2 = tok.indexOf('\t', t1 + 1)
    const add = tok.slice(0, t1)
    const del = tok.slice(t1 + 1, t2)
    let path = tok.slice(t2 + 1)
    if (path === '') {
      i++ // rename/copy: old path follows, then new path
      path = nums[++i] ?? ''
    }
    const binary = add === '-'
    counts.set(path, { additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary })
  }

  const files: DiffFile[] = []
  const toks = nameStatusZ.split('\0')
  for (let i = 0; i < toks.length; i++) {
    const code = toks[i]!
    if (code === '') continue
    const status = diffStatusFromCode(code)
    let file: DiffFile
    if (status === 'renamed' || status === 'copied') {
      const oldPath = toks[++i] ?? ''
      const path = toks[++i] ?? ''
      file = { path, oldPath, status, additions: 0, deletions: 0, binary: false }
    } else {
      file = { path: toks[++i] ?? '', status, additions: 0, deletions: 0, binary: false }
    }
    const c = counts.get(file.path)
    if (c) Object.assign(file, c)
    files.push(file)
  }
  return files
}

export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0)
    if (lines.length === 0) continue
    const info: WorktreeInfo = {
      path: '',
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    }
    for (const line of lines) {
      if (line.startsWith('worktree ')) info.path = resolve(line.slice(9))
      else if (line.startsWith('HEAD ')) info.head = line.slice(5)
      else if (line.startsWith('branch ')) info.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'bare') info.bare = true
      else if (line === 'detached') info.detached = true
      else if (line === 'locked' || line.startsWith('locked ')) info.locked = true
      else if (line === 'prunable' || line.startsWith('prunable ')) info.prunable = true
    }
    if (info.path) result.push(info)
  }
  return result
}

/**
 * Thin, safe wrapper over the git CLI. Deliberately exposes no force-push, `branch -D` or checkout:
 * NEXUS only ever creates branches/worktrees, commits, merges with abort, and removes worktrees. The one
 * hard reset (resetClean) is for NEXUS-owned worktrees only.
 */
export class GitService {
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly gitPath: string = 'git') {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no' }
    // Inherited repo-scoping variables (e.g. when launched from a git hook) would redirect every call.
    for (const key of Object.keys(env)) {
      if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'].includes(key.toUpperCase())) {
        delete env[key]
      }
    }
    this.env = env
  }

  // ---- plumbing ----

  /** Runs git; throws NexusError unless the exit code is in okCodes. */
  async run(cwd: string, args: readonly string[], opts: RunGitOptions = {}): Promise<ProcessResult> {
    const fullArgs = ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args]
    const result = await runProcess(this.gitPath, fullArgs, {
      cwd,
      env: opts.env ? { ...this.env, ...opts.env } : this.env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes,
      keep: opts.keep,
      input: opts.input,
    })
    const okCodes = opts.okCodes ?? [0]
    if (result.exitCode !== null && okCodes.includes(result.exitCode) && !result.timedOut) return result
    const text = (result.stderr.trim() || result.stdout.trim()).slice(-2000)
    const detail = { args: [...args], cwd, exitCode: result.exitCode, stderr: text, timedOut: result.timedOut }
    if (/not a git repository/i.test(result.stderr)) {
      throw new NexusError('not_a_repository', `${cwd} is not a git repository`, detail)
    }
    const why = result.timedOut ? 'timed out' : `failed (exit ${result.exitCode})`
    throw new NexusError('git_failed', `git ${args[0] ?? ''} ${why}: ${text}`, detail)
  }

  private async out(cwd: string, args: readonly string[], opts?: RunGitOptions): Promise<string> {
    return (await this.run(cwd, args, opts)).stdout.trim()
  }

  private assertRevision(rev: string, what: string): void {
    if (rev.length === 0 || rev.startsWith('-') || /[\0\r\n]/.test(rev)) {
      throw new NexusError('invalid_input', `Invalid ${what}: ${JSON.stringify(rev)}`)
    }
  }

  /** Resolves any revision to a full commit sha. Throws git_failed when it does not exist. */
  async resolveCommit(repo: string, rev: string): Promise<string> {
    this.assertRevision(rev, 'revision')
    const r = await this.run(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [0, 1] })
    const sha = r.stdout.trim()
    if (r.exitCode !== 0 || sha === '') throw new NexusError('git_failed', `Unknown revision: ${rev}`, { rev })
    return sha
  }

  // ---- repository ----

  async version(): Promise<string> {
    const r = await runProcess(this.gitPath, ['--version'], { cwd: tmpdir(), env: this.env, timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new NexusError('git_failed', `git --version failed: ${r.stderr.trim()}`)
    return r.stdout.trim().replace(/^git version\s+/, '')
  }

  async isRepository(path: string): Promise<boolean> {
    try {
      const r = await this.run(path, ['rev-parse', '--is-inside-work-tree'], { okCodes: [0, 128] })
      return r.exitCode === 0 && r.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  /** Top-level directory of the working tree containing `path` (a worktree returns its own root). */
  async repoRoot(path: string): Promise<string> {
    if (!(await exists(path))) throw new NexusError('not_found', `Path does not exist: ${path}`, { path })
    return resolve(await this.out(path, ['rev-parse', '--show-toplevel']))
  }

  /** Current branch short name, or null when HEAD is detached. */
  async currentBranch(repo: string): Promise<string | null> {
    const r = await this.run(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }

  async headCommit(repo: string): Promise<string> {
    return this.resolveCommit(repo, 'HEAD')
  }

  async status(repo: string): Promise<GitStatus> {
    const r = await this.run(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
    return parseStatusV2(r.stdout)
  }

  /** Throws dirty_repository unless the working tree is clean. */
  async assertClean(repo: string, opts: { ignoreUntracked?: boolean } = {}): Promise<void> {
    const s = await this.status(repo)
    const untracked = opts.ignoreUntracked ? [] : s.untracked
    if (s.staged.length + s.unstaged.length + untracked.length + s.conflicted.length === 0) return
    throw new NexusError(
      'dirty_repository',
      `Working tree at ${repo} has uncommitted changes (${s.staged.length} staged, ${s.unstaged.length} unstaged, ${untracked.length} untracked, ${s.conflicted.length} conflicted)`,
      { repo, staged: s.staged.length, unstaged: s.unstaged.length, untracked: untracked.length, conflicted: s.conflicted.length },
    )
  }

  // ---- branches ----

  async isValidBranchName(repo: string, name: string): Promise<boolean> {
    if (name.length === 0 || name.startsWith('-') || name.startsWith('@') || /[\0\r\n]/.test(name)) return false
    const r = await this.run(repo, ['check-ref-format', '--branch', name], { okCodes: [0, 1, 128] })
    return r.exitCode === 0 && r.stdout.trim() === name
  }

  async assertValidBranchName(repo: string, name: string): Promise<void> {
    if (!(await this.isValidBranchName(repo, name))) {
      throw new NexusError('invalid_input', `Invalid branch name: ${JSON.stringify(name)}`, { name })
    }
  }

  async branchExists(repo: string, name: string): Promise<boolean> {
    await this.assertValidBranchName(repo, name)
    const r = await this.run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { okCodes: [0, 1] })
    return r.exitCode === 0
  }

  /** Creates a branch at startPoint without checking it out. Returns the start commit sha. */
  async createBranch(repo: string, name: string, startPoint: string): Promise<string> {
    await this.assertValidBranchName(repo, name)
    const sha = await this.resolveCommit(repo, startPoint)
    await this.run(repo, ['branch', '--no-track', '--', name, sha])
    return sha
  }

  /** True when `ancestor` is `descendant` or one of its ancestors. */
  async isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
    this.assertRevision(ancestor, 'revision')
    this.assertRevision(descendant, 'revision')
    const r = await this.run(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [0, 1] })
    return r.exitCode === 0
  }

  /**
   * Fast-forwards a branch that is not checked out to `to`. Refused when the branch is checked out in any
   * worktree (moving it would change what that working tree is on), when `to` does not descend from the
   * branch's tip (it would drop commits), or when the tip is no longer `from` (somebody else moved it).
   */
  async fastForwardBranch(repo: string, branch: string, to: string, from: string): Promise<void> {
    await this.assertValidBranchName(repo, branch)
    const target = await this.resolveCommit(repo, to)
    const current = await this.resolveCommit(repo, `refs/heads/${branch}`)
    if (current !== from) throw new NexusError('git_failed', `Branch ${branch} is at ${current.slice(0, 10)}, not at ${from.slice(0, 10)}: it was moved outside NEXUS.`)
    if ((await this.listWorktrees(repo)).some((w) => w.branch === branch)) throw new NexusError('git_failed', `Branch ${branch} is checked out in a working tree; it is not moved.`)
    if (!(await this.isAncestor(repo, current, target))) throw new NexusError('git_failed', `${target.slice(0, 10)} does not contain the current tip of ${branch}; moving the branch would drop commits.`)
    if (current === target) return
    // The old value makes the update fail if the ref changed since it was read.
    await this.run(repo, ['update-ref', `refs/heads/${branch}`, target, current])
  }

  /** Deletes a branch with `-d`: git refuses when it is not fully merged. */
  async deleteBranch(repo: string, name: string): Promise<void> {
    await this.assertValidBranchName(repo, name)
    await this.run(repo, ['branch', '-d', '--', name])
  }

  // ---- worktrees ----

  /** Creates `branch` at startPoint and checks it out in a new worktree at `path`. Returns the base commit sha. */
  async createWorktree(repo: string, path: string, branch: string, startPoint: string): Promise<string> {
    await this.assertValidBranchName(repo, branch)
    const sha = await this.resolveCommit(repo, startPoint)
    const abs = resolve(path)
    await mkdir(dirname(abs), { recursive: true })
    const branchExisted = await this.branchExists(repo, branch)
    try {
      await this.run(repo, ['worktree', 'add', '--no-track', '-b', branch, '--', abs, sha])
    } catch (e) {
      // `worktree add -b` can leave the new branch behind when the checkout fails (e.g. an uncreatable path).
      if (!branchExisted && (await this.branchExists(repo, branch))) {
        await this.run(repo, ['update-ref', '-d', `refs/heads/${branch}`], { okCodes: [0, 1] }).catch(() => undefined)
      }
      throw e
    }
    return sha
  }

  /**
   * Restores tracked files to HEAD, clears any merge in progress and removes untracked files that are
   * not ignored (never `clean -x`, so ignored dependencies survive). Destructive: callers must only
   * point it at a NEXUS-owned worktree, never at the user's checkout (WorktreeManager.resetClean
   * enforces that).
   */
  async resetClean(worktree: string): Promise<void> {
    await this.run(worktree, ['reset', '--hard', '--quiet', 'HEAD'])
    await this.run(worktree, ['clean', '-f', '-d', '--quiet'])
  }

  /**
   * Removes a worktree. Refuses (dirty_repository) when it has any uncommitted or untracked
   * changes unless `force` is explicitly true. Retries briefly on Windows file-lock errors.
   */
  async removeWorktree(repo: string, path: string, opts: { force?: boolean } = {}): Promise<void> {
    const abs = resolve(path)
    const force = opts.force === true
    if (!(await exists(abs))) {
      await this.pruneWorktrees(repo)
      return
    }
    if (!force) await this.assertClean(abs)
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), '--', abs]
    const attempts = 6
    for (let attempt = 1; ; attempt++) {
      try {
        await this.run(repo, args)
        return
      } catch (e) {
        const stderr = e instanceof NexusError ? String(e.detail?.['stderr'] ?? '') : ''
        if (attempt >= attempts || !LOCK_ERROR.test(stderr)) throw e
        await sleep(250 * attempt)
      }
    }
  }

  async listWorktrees(repo: string): Promise<WorktreeInfo[]> {
    const r = await this.run(repo, ['worktree', 'list', '--porcelain'])
    return parseWorktreeList(r.stdout)
  }

  async pruneWorktrees(repo: string): Promise<void> {
    await this.run(repo, ['worktree', 'prune'])
  }

  // ---- commits ----

  async addAll(worktree: string): Promise<void> {
    await this.run(worktree, ['add', '-A'])
  }

  /**
   * Stages everything and commits. Returns the new sha, or null when there was nothing to commit.
   * Identity is passed per invocation; hooks and signing are skipped because these are automated
   * checkpoints (NEXUS runs its own verification commands).
   */
  async commitAll(worktree: string, message: string, author: GitAuthor): Promise<string | null> {
    if (message.trim() === '') throw new NexusError('invalid_input', 'Commit message must not be empty')
    this.assertAuthor(author)
    await this.addAll(worktree)
    const diff = await this.run(worktree, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] })
    if (diff.exitCode === 0) return null
    await this.run(worktree, [...this.identityArgs(author), 'commit', '--no-verify', '-m', message])
    return this.headCommit(worktree)
  }

  private assertAuthor(author: GitAuthor): void {
    if (author.name.trim() === '' || author.email.trim() === '' || /[\0\r\n<>]/.test(author.name + author.email)) {
      throw new NexusError('invalid_input', 'Invalid commit author')
    }
  }

  private identityArgs(author: GitAuthor): string[] {
    return ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, '-c', 'commit.gpgsign=false']
  }

  async log(repo: string, range: string, limit = 50): Promise<CommitInfo[]> {
    this.assertRevision(range, 'range')
    const r = await this.run(repo, [
      'log', '-z', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '-n', String(Math.max(1, Math.floor(limit))), range, '--',
    ])
    return r.stdout
      .split('\0')
      .filter((e) => e.trim() !== '')
      .map((e) => {
        const [sha = '', authorName = '', authorEmail = '', date = '', subject = ''] = e.trim().split('\x1f')
        return { sha, authorName, authorEmail, date, subject }
      })
  }

  async commitCount(repo: string, base: string, head: string): Promise<number> {
    const [b, h] = await Promise.all([this.resolveCommit(repo, base), this.resolveCommit(repo, head)])
    return Number(await this.out(repo, ['rev-list', '--count', `${b}..${h}`]))
  }

  /** Common ancestor sha, or null when the histories are unrelated. */
  async mergeBase(repo: string, a: string, b: string): Promise<string | null> {
    const [x, y] = await Promise.all([this.resolveCommit(repo, a), this.resolveCommit(repo, b)])
    const r = await this.run(repo, ['merge-base', x, y], { okCodes: [0, 1] })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }

  // ---- diff ----

  /** Diff between two commits (base vs head), rename aware. */
  async diff(repo: string, base: string, head: string, opts: { maxPatchBytes?: number } = {}): Promise<DiffResult> {
    const [b, h] = await Promise.all([this.resolveCommit(repo, base), this.resolveCommit(repo, head)])
    return this.diffTrees(repo, b, h, opts.maxPatchBytes)
  }

  /** Diff of `base` against the worktree's current contents, including uncommitted and untracked files. */
  async diffWorkingTree(worktree: string, base: string, opts: { maxPatchBytes?: number } = {}): Promise<DiffResult> {
    const b = await this.resolveCommit(worktree, base)
    // Snapshot into a throwaway index so the worktree's real index is never modified.
    const indexPath = resolve(worktree, await this.out(worktree, ['rev-parse', '--git-path', 'index']))
    const tmp = await mkdtemp(join(tmpdir(), 'nexus-idx-'))
    const tmpIndex = join(tmp, 'index')
    try {
      try {
        await copyFile(indexPath, tmpIndex)
      } catch {
        // no index yet: start empty
      }
      const env = { GIT_INDEX_FILE: tmpIndex }
      await this.run(worktree, ['add', '-A'], { env })
      const tree = await this.out(worktree, ['write-tree'], { env })
      return await this.diffTrees(worktree, b, tree, opts.maxPatchBytes)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }

  private async diffTrees(cwd: string, a: string, b: string, maxPatchBytes = DEFAULT_PATCH_BYTES): Promise<DiffResult> {
    const common = ['diff', '--no-ext-diff', '--no-color', '-M']
    const [nameStatus, numstat, patch] = await Promise.all([
      this.run(cwd, [...common, '--name-status', '-z', a, b, '--']),
      this.run(cwd, [...common, '--numstat', '-z', a, b, '--']),
      this.run(cwd, [...common, a, b, '--'], { maxOutputBytes: maxPatchBytes, keep: 'head' }),
    ])
    return {
      files: parseDiffFiles(nameStatus.stdout, numstat.stdout),
      patch: patch.stdout,
      truncated: patch.truncated,
    }
  }

  /** Paths (new names for renames) that differ between base and head. */
  async changedFiles(repo: string, base: string, head: string): Promise<string[]> {
    const [b, h] = await Promise.all([this.resolveCommit(repo, base), this.resolveCommit(repo, head)])
    const r = await this.run(repo, ['diff', '--no-ext-diff', '-M', '--name-only', '-z', b, h, '--'])
    return r.stdout.split('\0').filter((p) => p !== '')
  }

  // ---- merge ----

  /**
   * `merge --no-ff` of `branch` into the worktree's current branch. On conflict the conflicted
   * paths are collected and the merge is aborted so the worktree is left clean.
   */
  async merge(worktree: string, branch: string, opts: { message: string; author: GitAuthor }): Promise<MergeResult> {
    if (opts.message.trim() === '') throw new NexusError('invalid_input', 'Merge message must not be empty')
    this.assertAuthor(opts.author)
    if (await this.isMergeInProgress(worktree)) {
      throw new NexusError('invalid_state', `A merge is already in progress in ${worktree}`)
    }
    await this.assertClean(worktree)
    const sha = await this.resolveCommit(worktree, branch)
    const r = await this.run(
      worktree,
      [...this.identityArgs(opts.author), 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', opts.message, sha],
      { okCodes: [0, 1] },
    )
    if (r.exitCode === 0) return { ok: true, commit: await this.headCommit(worktree) }

    const unmerged = await this.run(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])
    const conflicts = unmerged.stdout.split('\0').filter((p) => p !== '')
    const inProgress = await this.isMergeInProgress(worktree)
    if (inProgress) await this.abortMerge(worktree)
    if (conflicts.length > 0) return { ok: false, conflicts }
    const text = (r.stderr.trim() || r.stdout.trim()).slice(-2000)
    throw new NexusError('git_failed', `git merge failed: ${text}`, { stderr: text, branch })
  }

  async isMergeInProgress(worktree: string): Promise<boolean> {
    const r = await this.run(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], { okCodes: [0, 1] })
    return r.exitCode === 0
  }

  /** Aborts an in-progress merge. Returns false when there was none. */
  async abortMerge(worktree: string): Promise<boolean> {
    if (!(await this.isMergeInProgress(worktree))) return false
    await this.run(worktree, ['merge', '--abort'])
    return true
  }
}
