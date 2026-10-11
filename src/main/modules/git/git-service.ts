import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { NexusError } from '@shared/result'
import { projectCommandEnv, runProcess } from '../process/run-process'
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
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

const pathKeyOf = (p: string): string => {
  const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A worktree NEXUS created, and the Git directory NEXUS itself found for it in the repository. */
interface TrustedWorktree {
  root: string
  gitDir: string
  /** The branch NEXUS created the worktree on (`nexus/<run>/<task>`); null when the record does not say. */
  branch: string | null
}

/** A worktree's repository and branch, as NEXUS's own record has them. */
export interface WorktreeOrigin {
  repoRoot: string
  branch: string | null
}

/** The git subcommand of an argument list: the first word that is not a global option (`-c name=value` takes a value). */
function subcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-c' || arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') i += 1
    else if (!arg.startsWith('-')) return arg
  }
  return ''
}

/**
 * Settings of every git command NEXUS runs itself. A working tree is written by the code NEXUS runs in it,
 * and that code can put a repository of its own inside (a directory with a `.git`). Measured with git 2.53
 * (tests/integration/git/hostile-index.test.ts): with such an entry in the index, a plain `git status` starts a
 * second git inside the nested repository, under that repository's configuration, and a `filter.<x>.clean`
 * defined there runs as whoever ran the status. With submodules ignored nothing is started there. The
 * untracked cache and the split index are the two index extensions that make git believe a file it did not
 * look at; neither is used.
 */
const SAFE_CONFIG = ['-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false', '-c', 'status.submoduleSummary=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'index.sparse=false', '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false']

/** Subcommands that read or write the index: in a worktree NEXUS created they use NEXUS's own index, never the worktree's. */
const USES_INDEX = new Set(['status', 'diff', 'add', 'commit', 'reset', 'clean', 'merge', 'write-tree', 'read-tree', 'checkout', 'rm', 'ls-files', 'update-index', 'stash', 'cherry-pick', 'rebase', 'revert', 'am', 'checkout-index', 'restore', 'switch'])
/** Of those, the ones after which the worktree's own index is brought in line, so that git run by the task sees what NEXUS did. */
const CHANGES_INDEX = new Set(['commit', 'reset', 'merge', 'checkout', 'read-tree', 'cherry-pick', 'rebase', 'revert', 'am', 'stash', 'restore', 'switch'])

/** What NEXUS committed, and what it meant to: kept as evidence of every commit NEXUS makes in a worktree it created. */
export interface CommitEvidence {
  worktree: string
  branch: string | null
  parent: string
  commit: string
  /** The tree NEXUS built and the tree of the commit: equal, or there is no commit. */
  expectedTree: string
  committedTree: string
  /** `<status>\t<path>` of every file the commit changes, as derived before it and as read back from it. */
  expectedFiles: string[]
  committedFiles: string[]
  /** Nested repositories found in the worktree, which are never committed. */
  skippedNestedRepositories: string[]
  at: string
}

/** Subcommands of NEXUS's own that add to or rewrite the branch a working tree is on. */
const WRITES_BRANCH = new Set(['commit', 'merge', 'reset', 'cherry-pick', 'rebase', 'revert', 'am', 'stash', 'checkout', 'switch'])

/**
 * The empty directory NEXUS names as `core.hooksPath`, so that no hook of a repository runs under NEXUS's own
 * git commands. One per process, with a name nobody can predict, removed when the process ends: a directory
 * per GitService was never removed, and thousands of them were left in the temp directory.
 */
let sharedNoHooksDir: string | null = null
function emptyHooksDir(): string {
  if (sharedNoHooksDir !== null && existsSync(sharedNoHooksDir)) return sharedNoHooksDir
  const dir = mkdtempSync(join(tmpdir(), 'nexus-no-hooks-'))
  sharedNoHooksDir = dir
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The process is ending; an empty directory left behind harms nothing.
    }
  })
  return dir
}

export class GitService {
  private readonly env: NodeJS.ProcessEnv
  /** An empty directory NEXUS owns: its git commands look for hooks there, so they run none. */
  private noHooksDir: string | null = null
  /** Worktree pointer files that were verified, by what identified them then. */
  private readonly verifiedPointers = new Map<string, string>()
  /**
   * The worktrees NEXUS created, by path. For these, NEXUS's git commands name the Git directory themselves and
   * never read the `.git` file in the worktree, which an agent working there can rewrite.
   */
  private readonly trusted = new Map<string, TrustedWorktree>()
  private readonly notOurs = new Set<string>()
  private worktreesRoot: string | null = null
  /** A directory only NEXUS writes: one index file per worktree NEXUS created. Null: the worktree's own index is used (0.7 behaviour). */
  private trustedIndexDir: string | null = null
  /** The commit each private index was last made to match, by index file. */
  private readonly indexBase = new Map<string, string>()
  private commitEvidenceSink: ((evidence: CommitEvidence) => void) | null = null
  private repositoryOf: ((worktreePath: string) => WorktreeOrigin | string | null | Promise<WorktreeOrigin | string | null>) | null = null

  constructor(private readonly gitPath: string = 'git') {
    // Git needs none of the credentials NEXUS withholds from project commands, and a program that a
    // repository's configuration makes git run must not find them in its environment.
    const env: NodeJS.ProcessEnv = { ...projectCommandEnv(process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no' }
    // Inherited repo-scoping variables (e.g. when launched from a git hook) would redirect every call.
    for (const key of Object.keys(env)) {
      if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'].includes(key.toUpperCase())) {
        delete env[key]
      }
    }
    this.env = env
  }

  // ---- the Git directory of a NEXUS worktree ----

  /**
   * 0.8. The index of a worktree is written by the code that runs in it: it can stage what is not in the files,
   * hide a file that changed (skip-worktree, assume-unchanged), and name a nested repository. NEXUS's own
   * commands in a worktree it created therefore never read that index. They use one NEXUS keeps here, in a
   * directory contained code cannot write, built from the branch's commit and the files as they are.
   */
  setTrustedIndexDir(dir: string): void {
    this.trustedIndexDir = resolve(dir)
    mkdirSync(this.trustedIndexDir, { recursive: true })
  }

  /** Told of every commit NEXUS makes in a worktree it created, with what it meant to commit and what it did. */
  onCommitEvidence(sink: (evidence: CommitEvidence) => void): void {
    this.commitEvidenceSink = sink
  }

  private privateIndexOf(own: TrustedWorktree): string | null {
    if (this.trustedIndexDir === null) return null
    return join(this.trustedIndexDir, `${createHash('sha256').update(pathKeyOf(own.root)).digest('hex').slice(0, 24)}.index`)
  }

  /** The commit the worktree's branch names, read from the repository: never from what the worktree says of itself. */
  private async tipOf(own: TrustedWorktree): Promise<string | null> {
    const ref = own.branch !== null ? `refs/heads/${own.branch}` : 'HEAD'
    const r = await this.exec(own, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], {}, this.privateIndexOf(own))
    const sha = r.stdout.trim()
    return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
  }

  /** Makes NEXUS's index of a worktree match the branch's commit, unless it already does. The files are then compared against it. */
  private async freshIndex(own: TrustedWorktree, index: string): Promise<void> {
    const tip = await this.tipOf(own)
    if (tip === null) return
    if (this.indexBase.get(index) === tip && existsSync(index)) return
    await this.exec(own, ['read-tree', tip], {}, index)
    // Stat data for every file, once: without it each later status would read every file again.
    await this.exec(own, ['update-index', '-q', '--refresh'], {}, index)
    this.indexBase.set(index, tip)
  }

  /** After NEXUS changed the index (a commit, a merge, a reset): the worktree's own index is replaced by NEXUS's, so that git run by the task agrees. */
  private async publishIndex(own: TrustedWorktree, index: string): Promise<void> {
    const tip = await this.tipOf(own)
    if (tip !== null) this.indexBase.set(index, tip)
    try {
      await copyFile(index, join(own.gitDir, 'index'))
    } catch {
      // The task's view is stale until its next git command refreshes it; nothing of NEXUS's depends on it.
    }
  }

  /** One git process, with NEXUS's settings and, in a worktree NEXUS created, its Git directory and index named. No checks: `run` makes them. */
  private async exec(own: TrustedWorktree | null, args: readonly string[], opts: RunGitOptions, index: string | null, cwd?: string): Promise<ProcessResult> {
    this.noHooksDir ??= emptyHooksDir()
    const scope = own ? [`--git-dir=${own.gitDir}`, `--work-tree=${own.root}`] : []
    const fullArgs = ['--no-replace-objects', ...scope, '-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${this.noHooksDir}`, '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never', ...SAFE_CONFIG, ...args]
    const where = cwd ?? own?.root ?? process.cwd()
    const ceiling = this.worktreesRoot && isWithin(this.worktreesRoot, where) ? { GIT_CEILING_DIRECTORIES: this.worktreesRoot } : {}
    const common = own ? { GIT_COMMON_DIR: dirname(dirname(own.gitDir)) } : {}
    return runProcess(this.gitPath, fullArgs, {
      cwd: where,
      env: { ...this.env, ...ceiling, ...common, ...(index !== null ? { GIT_INDEX_FILE: index } : {}), ...(opts.env ?? {}) },
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes,
      keep: opts.keep,
      input: opts.input,
    })
  }

  /** The directory under which NEXUS creates its worktrees (`<root>/<run>/<task>`). */
  setWorktreesRoot(root: string): void {
    this.worktreesRoot = resolve(root)
  }

  /**
   * How a worktree found on disk after a restart is traced back to its repository: from NEXUS's own records,
   * never from anything inside the worktree. Returns the repository's path, or null when NEXUS does not know
   * the directory as one of its worktrees.
   */
  setWorktreeResolver(resolver: (worktreePath: string) => WorktreeOrigin | string | null | Promise<WorktreeOrigin | string | null>): void {
    this.repositoryOf = resolver
    this.notOurs.clear()
  }

  /**
   * Records the Git directory of a worktree, found by asking the repository: the entry under
   * `<common dir>/worktrees/` whose back-pointer names this worktree. Nothing inside the worktree is read.
   * False when the repository has no such entry.
   */
  async trustWorktree(worktreePath: string, repoRoot: string, branch: string | null = null): Promise<boolean> {
    const root = resolve(worktreePath)
    const shown = await runProcess(this.gitPath, ['rev-parse', '--git-common-dir'], { cwd: repoRoot, env: this.env, timeoutMs: 15_000 })
    if (shown.exitCode !== 0 || shown.stdout.trim() === '') return false
    const common = resolve(repoRoot, shown.stdout.trim())
    let names: string[]
    try {
      names = await readdir(join(common, 'worktrees'))
    } catch {
      return false
    }
    for (const name of names) {
      const gitDir = join(common, 'worktrees', name)
      let back: string
      try {
        back = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()
      } catch {
        continue
      }
      if (!samePath(resolve(gitDir, back), join(root, '.git'))) continue
      this.trusted.set(pathKeyOf(root), { root, gitDir, branch })
      this.notOurs.delete(pathKeyOf(root))
      return true
    }
    return false
  }

  /**
   * 0.8: where the git data of a worktree NEXUS created is, from NEXUS's own record and the repository's entry
   * for it, never from the `.git` file in the worktree (which an agent can rewrite). Null when the directory
   * is not such a worktree. `writable` lists what a contained git must be able to write to commit on the
   * worktree's own branch and nothing else: the worktree's entry, the object store, and the directory of its
   * branch among the refs and their logs.
   */
  async ownedGitLayout(worktree: string): Promise<{ gitDir: string; commonDir: string; branch: string | null; writable: string[] } | null> {
    const own = await this.trustedFor(worktree).catch(() => null)
    if (own === null) return null
    const commonDir = dirname(dirname(own.gitDir))
    const writable = [own.gitDir, join(commonDir, 'objects')]
    if (own.branch !== null && own.branch.includes('/')) {
      const namespace = own.branch.split('/').slice(0, -1)
      writable.push(join(commonDir, 'refs', 'heads', ...namespace), join(commonDir, 'logs', 'refs', 'heads', ...namespace))
      // The branch itself and its log, as files: the only refs the task may change. The directories above are
      // where git makes its lock files; a sibling task's branch is in them and is not this task's to write.
      writable.push(join(commonDir, 'refs', 'heads', ...own.branch.split('/')), join(commonDir, 'logs', 'refs', 'heads', ...own.branch.split('/')))
    }
    return { gitDir: own.gitDir, commonDir, branch: own.branch, writable }
  }

  /** The record for `cwd` when it is, or lies inside, a worktree NEXUS created. */
  private async trustedFor(cwd: string): Promise<TrustedWorktree | null> {
    const key = pathKeyOf(cwd)
    for (const [root, entry] of this.trusted) if (key === root || key.startsWith(`${root}/`)) return entry
    if (!this.worktreesRoot || !this.repositoryOf || !isWithin(this.worktreesRoot, cwd)) return null
    // Under the root a worktree is `<root>/<run>/<task>`.
    const parts = relative(this.worktreesRoot, resolve(cwd)).split(/[\\/]/).filter((p) => p !== '')
    if (parts.length < 2) return null
    const candidate = join(this.worktreesRoot, parts[0] as string, parts[1] as string)
    const candidateKey = pathKeyOf(candidate)
    if (this.notOurs.has(candidateKey)) return null
    const origin = await this.repositoryOf(candidate)
    const repoRoot = typeof origin === 'string' ? origin : (origin?.repoRoot ?? null)
    const branch = typeof origin === 'string' ? null : (origin?.branch ?? null)
    if (repoRoot && (await this.trustWorktree(candidate, repoRoot, branch))) return this.trusted.get(candidateKey) ?? null
    if (repoRoot) {
      // NEXUS knows this directory as a worktree of that repository, and the repository has no entry for it:
      // nothing git finds from inside it can be the right Git directory.
      throw new NexusError('invalid_state', `The repository at ${repoRoot} no longer has a worktree entry for ${candidate}. NEXUS will not run git there.`, { cwd })
    }
    this.notOurs.add(candidateKey)
    return null
  }

  /**
   * A worktree NEXUS created stays on the branch NEXUS created it on. An agent working there can turn its HEAD
   * to another branch with an ordinary git command (`git symbolic-ref HEAD refs/heads/main`, `git checkout main`);
   * a commit of NEXUS's would then advance that branch, which may be the user's. Before a command that adds to
   * or rewrites the current branch, HEAD is read from the worktree's Git directory in the repository and must
   * name the recorded branch.
   */
  private async assertOnOwnBranch(own: TrustedWorktree): Promise<void> {
    if (own.branch === null) return
    const head = await readFile(join(own.gitDir, 'HEAD'), 'utf8').then((text) => text.trim()).catch(() => '')
    if (head === `ref: refs/heads/${own.branch}`) {
      // The branch itself must be a branch: as a symbolic ref to another branch, a commit "on" it would advance
      // that one. A loose ref file holds a commit id; only a symbolic ref begins with `ref:`.
      const loose = await readFile(join(dirname(dirname(own.gitDir)), 'refs', 'heads', ...own.branch.split('/')), 'utf8').then((text) => text.trim()).catch(() => '')
      if (!loose.startsWith('ref:')) return
      throw new NexusError('invalid_state', `The branch ${own.branch} of the working tree at ${own.root} was turned into a reference to ${loose.slice(4).trim()}. NEXUS will not commit or merge there.`, { cwd: own.root, branch: own.branch })
    }
    const now = head.startsWith('ref: ') ? head.slice(5) : head === '' ? 'nothing readable' : `the commit ${head.slice(0, 12)}`
    throw new NexusError('invalid_state', `The working tree at ${own.root} is no longer on its branch ${own.branch} (its HEAD names ${now}). NEXUS will not commit or merge there.`, { cwd: own.root, branch: own.branch })
  }

  /** Puts a worktree NEXUS created back on its own branch. Only before a reset that discards everything anyway. */
  private async restoreOwnBranch(worktree: string): Promise<void> {
    const own = await this.trustedFor(worktree)
    if (!own || own.branch === null) return
    const head = await readFile(join(own.gitDir, 'HEAD'), 'utf8').then((text) => text.trim()).catch(() => '')
    if (head === `ref: refs/heads/${own.branch}`) return
    // `symbolic-ref` moves no branch and touches no file; the reset that follows makes the tree match.
    await this.run(worktree, ['symbolic-ref', 'HEAD', `refs/heads/${own.branch}`])
  }

  // ---- plumbing ----

  /**
   * A linked worktree finds its repository through a one-line `.git` file. An agent that rewrites that file
   * could point the directory at another repository or another worktree, and NEXUS's next commit, reset or
   * clean there would act on that one. Before any command that changes something, the pointer is checked
   * against Git's own back-pointer (`<gitdir>/gitdir` names the worktree's `.git` file), which lives in the
   * repository where no agent writes.
   */
  private async assertOwnGitDir(cwd: string): Promise<void> {
    const dotGit = join(cwd, '.git')
    let info
    try {
      info = await lstat(dotGit)
    } catch {
      return // Not at the top of a working tree; git decides by itself what the directory is.
    }
    if (info.isDirectory()) return // The repository's own checkout.
    // A pointer file that has not changed since it was last verified is not verified again: the check costs a
    // process, and NEXUS runs many git commands. Any rewrite changes the file's identity, size or change time.
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    if (this.verifiedPointers.get(cwd) === stamp) return
    const refuse = (why: string): never => {
      throw new NexusError('invalid_state', `The working tree at ${cwd} no longer points at its own Git directory (${why}). NEXUS will not write through it.`, { cwd })
    }
    if (!info.isFile()) refuse('its .git is neither a file nor a directory')
    const shown = await runProcess(this.gitPath, ['rev-parse', '--absolute-git-dir'], { cwd, env: this.env, timeoutMs: 15_000 })
    const gitDir = shown.stdout.trim()
    if (shown.exitCode !== 0 || gitDir === '') refuse('git cannot resolve it')
    let back = ''
    try {
      back = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()
    } catch {
      refuse('the Git directory it names is not a worktree directory')
    }
    if (!samePath(resolve(gitDir, back), dotGit)) refuse('the Git directory it names belongs to another working tree')
    // The back-pointer alone proves nothing when whoever rewrote the pointer also wrote the directory it names.
    // A real worktree directory lives in its repository, at `<common dir>/worktrees/<name>`, and never inside
    // the working tree itself.
    if (isWithin(cwd, gitDir)) refuse('the Git directory it names lies inside the working tree')
    let common = ''
    try {
      common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim())
    } catch {
      refuse('the Git directory it names has no common directory')
    }
    if (isWithin(cwd, common)) refuse('the repository it names lies inside the working tree')
    if (basename(dirname(gitDir)).toLowerCase() !== 'worktrees' || !samePath(dirname(dirname(gitDir)), common)) refuse('the Git directory it names is not a worktree directory of its repository')
    this.verifiedPointers.set(cwd, stamp)
  }

  /** Runs git; throws NexusError unless the exit code is in okCodes. */
  async run(cwd: string, args: readonly string[], opts: RunGitOptions = {}): Promise<ProcessResult> {
    // NEXUS's own git commands do not run what a repository's configuration could make git run: no file
    // system monitor, no hooks, no pager, no `ext::` transport, nothing inside a nested repository. Agents work
    // in these repositories; a configuration key, a hook or a repository one of them left behind must not
    // execute in NEXUS's process context.
    // In a worktree NEXUS created, the Git directory is the one NEXUS found in the repository, named explicitly:
    // the `.git` file in the worktree is not read, so rewriting it redirects nothing, for any command. Replacement
    // objects are never used: a ref an agent could write must not stand in for a commit NEXUS names.
    const own = await this.trustedFor(cwd)
    const sub = subcommandOf(args)
    // Anywhere else a linked worktree's pointer is verified before every command, not only before a write: a
    // read runs the filters and drivers of whatever repository the pointer names.
    if (!own) await this.assertOwnGitDir(cwd)
    else if (WRITES_BRANCH.has(sub)) await this.assertOnOwnBranch(own)
    // The index: NEXUS's own, made to match the branch before it is used. A caller that names an index of its
    // own (a throwaway one for a diff) keeps it.
    const callerIndex = opts.env?.['GIT_INDEX_FILE'] !== undefined
    // Every command names it, not only those that stage or compare: git opens the index for commands that seem
    // to have no use for it (measured: `diff-tree` between two commits fails on a damaged one).
    const index = own && !callerIndex ? this.privateIndexOf(own) : null
    // Made to match the branch before a command that compares against it or builds on it. Not before the two
    // that consume what was just staged.
    if (own && index !== null && USES_INDEX.has(sub) && sub !== 'read-tree' && sub !== 'commit' && sub !== 'write-tree') await this.freshIndex(own, index)
    const result = await this.exec(own, args, opts, index, cwd)
    if (own && index !== null && CHANGES_INDEX.has(sub) && result.exitCode === 0) await this.publishIndex(own, index)
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

  /**
   * A fingerprint of a working directory: HEAD, the status of every path and the content of every change to a
   * tracked file. Two equal fingerprints mean nothing was committed, staged, edited, added or removed in
   * between (an edit inside a file that was already untracked is the one thing it cannot see). Null when the
   * directory is not a Git working tree.
   */
  async workingState(cwd: string): Promise<string | null> {
    try {
      const head = await this.run(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1, 128] })
      const status = await this.run(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { okCodes: [0, 128] })
      if (status.exitCode !== 0) return null
      const diff = await this.run(cwd, ['--no-optional-locks', 'diff', '--no-ext-diff', '--binary', 'HEAD'], { okCodes: [0, 1, 128], maxOutputBytes: 64 * 1024 * 1024 })
      return createHash('sha256').update(head.stdout).update('\0').update(status.stdout).update('\0').update(diff.stdout).digest('hex')
    } catch {
      return null
    }
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
    // From here on NEXUS's git commands in this worktree use the Git directory the repository has for it.
    if (!(await this.trustWorktree(abs, repo, branch))) throw new NexusError('git_failed', `git created the worktree at ${abs} but the repository has no entry for it`, { path: abs })
    return sha
  }

  /**
   * Restores tracked files to HEAD, clears any merge in progress and removes untracked files that are
   * not ignored (never `clean -x`, so ignored dependencies survive). Destructive: callers must only
   * point it at a NEXUS-owned worktree, never at the user's checkout (WorktreeManager.resetClean
   * enforces that).
   */
  async resetClean(worktree: string): Promise<void> {
    await this.restoreOwnBranch(worktree)
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
    // Always forced: whether the worktree is clean was just established by NEXUS's own status. git's check before
    // a removal looks into nested repositories with their own configuration, whatever it is told.
    const args = ['worktree', 'remove', '--force', '--', abs]
    const attempts = 6
    for (let attempt = 1; ; attempt++) {
      try {
        await this.run(repo, args)
        this.trusted.delete(pathKeyOf(abs))
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
    const own = await this.trustedFor(worktree)
    // As before 0.8: a worktree whose HEAD was turned to another branch is not committed in, although the commit
    // below is made on the recorded branch by name and could not advance another.
    if (own) await this.assertOnOwnBranch(own)
    await this.addAll(worktree)
    // A directory with a repository of its own is staged by git as a link to that repository's commit. NEXUS
    // commits files. A link that the branch does not already have is taken out again, and named in the record.
    const skipped = own ? await this.unstageNewGitlinks(worktree) : []
    const diff = await this.run(worktree, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] })
    if (diff.exitCode === 0) return null
    if (!own) {
      await this.run(worktree, [...this.identityArgs(author), 'commit', '--no-verify', '-m', message])
      return this.headCommit(worktree)
    }
    // What is about to be committed, said before the commit: the tree, and every file that differs from the parent.
    const parent = await this.tipOf(own)
    if (parent === null) throw new NexusError('invalid_state', `The branch of the working tree at ${worktree} names no commit. NEXUS will not commit there.`, { cwd: worktree })
    const expectedTree = (await this.run(worktree, ['write-tree'])).stdout.trim()
    const expectedFiles = await this.treeChanges(worktree, parent, expectedTree)
    this.assertTreePaths(worktree, expectedFiles)
    // The commit is made from that tree and that parent, by name, and the branch moves to it only if it still
    // names the parent: nothing that happened in the worktree or to the branch in between is picked up.
    let commit: string | null
    if (own.branch !== null) {
      const made = await this.run(worktree, ['commit-tree', expectedTree, '-p', parent, '-m', message], { env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email } })
      const sha = made.stdout.trim()
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new NexusError('git_failed', 'git commit-tree gave no commit', { cwd: worktree })
      const moved = await this.run(worktree, ['update-ref', '-m', `commit: ${message.split('\n')[0]?.slice(0, 120) ?? ''}`, `refs/heads/${own.branch}`, sha, parent], { okCodes: [0, 1, 128] })
      if (moved.exitCode !== 0) throw new NexusError('invalid_state', `The branch ${own.branch} moved while NEXUS was committing in ${worktree}. Nothing was committed.`, { cwd: worktree, branch: own.branch, parent })
      commit = sha
      const index = this.privateIndexOf(own)
      if (index !== null) await this.publishIndex(own, index)
    } else {
      await this.run(worktree, [...this.identityArgs(author), 'commit', '--no-verify', '-m', message])
      commit = await this.tipOf(own)
    }
    const committedTree = commit !== null ? (await this.run(worktree, ['rev-parse', '--verify', `${commit}^{tree}`])).stdout.trim() : ''
    const committedParent = commit !== null ? (await this.run(worktree, ['rev-parse', '--verify', '-q', `${commit}^`], { okCodes: [0, 1] })).stdout.trim() : ''
    const committedFiles = commit !== null ? await this.treeChanges(worktree, parent, commit) : []
    const same = commit !== null && commit !== parent && committedParent === parent && committedTree === expectedTree && committedFiles.join('\n') === expectedFiles.join('\n')
    if (!same) {
      // The commit is not what NEXUS built: the branch goes back to where it was, and nothing downstream sees it.
      if (commit !== null && commit !== parent && own.branch !== null) await this.run(worktree, ['update-ref', `refs/heads/${own.branch}`, parent, commit], { okCodes: [0, 1, 128] }).catch(() => undefined)
      throw new NexusError('invalid_state', `The commit in ${worktree} does not hold what NEXUS staged for it (tree ${committedTree.slice(0, 12) || 'none'}, expected ${expectedTree.slice(0, 12)}). It was undone.`, { cwd: worktree, expectedTree, committedTree })
    }
    try {
      this.commitEvidenceSink?.({ worktree: own.root, branch: own.branch, parent, commit: commit as string, expectedTree, committedTree, expectedFiles, committedFiles, skippedNestedRepositories: skipped, at: new Date().toISOString() })
    } catch {
      // The record is evidence; the commit stands without it.
    }
    return commit
  }

  /** Entries of NEXUS's index that are links to a nested repository and that the branch's commit does not have: removed from the index. Returns their paths. */
  private async unstageNewGitlinks(worktree: string): Promise<string[]> {
    const staged = (await this.run(worktree, ['ls-files', '-s', '-z'])).stdout.split('\0').filter((line) => line.startsWith('160000 '))
    if (staged.length === 0) return []
    const known = new Set((await this.run(worktree, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { okCodes: [0, 128] })).stdout.split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1)))
    const fresh = staged.map((line) => line.slice(line.indexOf('\t') + 1)).filter((path) => !known.has(path))
    for (const path of fresh) await this.run(worktree, ['update-index', '--force-remove', '--', path])
    return fresh
  }

  /** `<status>\t<path>` for every file that differs between two commits or trees, read from the objects alone. */
  private async treeChanges(cwd: string, from: string, to: string): Promise<string[]> {
    const r = await this.run(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', '--ignore-submodules=all', from, to, '--'])
    const parts = r.stdout.split('\0').filter((p) => p !== '')
    const out: string[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) out.push(`${parts[i]}\t${parts[i + 1]}`)
    return out.sort()
  }

  /** A path NEXUS commits is a path inside the worktree, by its spelling: no `..`, no `.git`, nothing Windows reads as something else. */
  private assertTreePaths(cwd: string, changes: readonly string[]): void {
    for (const change of changes) {
      const path = change.slice(change.indexOf('\t') + 1)
      const bad = path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..' || /^\.git$/i.test(part.replace(/[. ]+$/, '')) || /^git~\d+$/i.test(part) || part.includes(':'))
      if (bad) throw new NexusError('invalid_state', `NEXUS will not commit the path ${JSON.stringify(path.slice(0, 200))} in ${cwd}: it is not a plain path inside the working tree.`, { cwd, path })
    }
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
    // Snapshot into a throwaway index, which starts from the base commit: the worktree's own index is neither
    // modified nor read (it is the task's, and can say anything).
    const tmp = await mkdtemp(join(tmpdir(), 'nexus-idx-'))
    const tmpIndex = join(tmp, 'index')
    try {
      const env = { GIT_INDEX_FILE: tmpIndex }
      await this.run(worktree, ['read-tree', b], { env })
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
