import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'
import { GitService, WorktreeManager, isPathInside } from '@main/modules/git'
import { runProcess } from '@main/modules/process'

const git = new GitService()
const author = { name: 'Nexus Test', email: 'nexus@example.com' }
let base: string
let counter = 0

// core.autocrlf may be on for the developer running the tests
const lf = (s: string): string => s.replaceAll('\r\n', '\n')

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function makeRepo(name = 'repo'): Promise<string> {
  const dir = join(base, `${name}-${++counter}`)
  await mkdir(dir, { recursive: true })
  await sh(dir, 'init', '-b', 'main')
  await sh(dir, 'config', 'user.name', 'Local User')
  await sh(dir, 'config', 'user.email', 'local@example.com')
  await sh(dir, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3\n')
  await writeFile(join(dir, 'b.txt'), 'bee\n')
  await writeFile(join(dir, 'doomed.txt'), 'delete me\n')
  await writeFile(join(dir, 'moved.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  await sh(dir, 'add', '-A')
  await sh(dir, 'commit', '-m', 'initial')
  return realpath(dir)
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexus git test-')))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
})

describe('repository basics', () => {
  it('reports version, repository detection and root', async () => {
    const repo = await makeRepo()
    expect(await git.version()).toMatch(/^\d+\.\d+/)
    expect(await git.isRepository(repo)).toBe(true)
    expect(await git.isRepository(base)).toBe(false)
    expect(await git.isRepository(join(base, 'does-not-exist'))).toBe(false)
    await mkdir(join(repo, 'sub dir'))
    expect((await git.repoRoot(join(repo, 'sub dir'))).toLowerCase()).toBe(repo.toLowerCase())
    await expect(git.repoRoot(base)).rejects.toMatchObject({ code: 'not_a_repository' })
    await expect(git.status(base)).rejects.toMatchObject({ code: 'not_a_repository' })
  })

  it('reads branch and head, null branch when detached', async () => {
    const repo = await makeRepo()
    const head = await git.headCommit(repo)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.currentBranch(repo)).toBe('main')
    await sh(repo, 'checkout', '--detach')
    expect(await git.currentBranch(repo)).toBeNull()
  })
})

describe('status and dirty-repository protection', () => {
  it('parses staged, unstaged, untracked, renamed and conflicted entries', async () => {
    const repo = await makeRepo()
    expect((await git.status(repo)).clean).toBe(true)
    await git.assertClean(repo)

    await writeFile(join(repo, 'a.txt'), 'changed\n')
    await writeFile(join(repo, 'b.txt'), 'staged change\n')
    await sh(repo, 'add', 'b.txt')
    await writeFile(join(repo, 'new file.txt'), 'x')
    await sh(repo, 'mv', 'moved.txt', 'renamed target.txt')
    const s = await git.status(repo)
    expect(s.clean).toBe(false)
    expect(s.unstaged.map((e) => e.path)).toEqual(['a.txt'])
    expect(s.staged.map((e) => e.path).sort()).toEqual(['b.txt', 'renamed target.txt'])
    expect(s.staged.find((e) => e.path === 'renamed target.txt')?.origPath).toBe('moved.txt')
    expect(s.untracked).toEqual(['new file.txt'])
    await expect(git.assertClean(repo)).rejects.toMatchObject({ code: 'dirty_repository' })
  })

  it('assertClean can ignore untracked files only when asked', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'scratch.txt'), 'x')
    await expect(git.assertClean(repo)).rejects.toMatchObject({ code: 'dirty_repository' })
    await expect(git.assertClean(repo, { ignoreUntracked: true })).resolves.toBeUndefined()
  })
})

describe('branches', () => {
  it('validates names and never lets option-like input through', async () => {
    const repo = await makeRepo()
    expect(await git.isValidBranchName(repo, 'nexus/abc/task-1')).toBe(true)
    for (const bad of ['', '-x', '--force', 'a b', 'a..b', 'x.lock', '@{-1}', 'a~1', 'ends/']) {
      expect(await git.isValidBranchName(repo, bad)).toBe(false)
    }
    await expect(git.createBranch(repo, '--delete', 'main')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(git.createBranch(repo, 'ok', '--orphan')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(git.createBranch(repo, 'ok2', 'no-such-ref')).rejects.toMatchObject({ code: 'git_failed' })
  })

  it('creates, detects and deletes merged branches but refuses unmerged ones', async () => {
    const repo = await makeRepo()
    const sha = await git.createBranch(repo, 'feature/one', 'main')
    expect(sha).toBe(await git.headCommit(repo))
    expect(await git.branchExists(repo, 'feature/one')).toBe(true)
    expect(await git.branchExists(repo, 'feature/two')).toBe(false)
    await git.deleteBranch(repo, 'feature/one')
    expect(await git.branchExists(repo, 'feature/one')).toBe(false)

    await git.createBranch(repo, 'feature/unmerged', 'main')
    const wt = join(base, 'wt unmerged')
    await git.createWorktree(repo, wt, 'feature/work', 'main')
    await writeFile(join(wt, 'work.txt'), 'w')
    await git.commitAll(wt, 'work', author)
    await git.removeWorktree(repo, wt)
    await expect(git.deleteBranch(repo, 'feature/work')).rejects.toMatchObject({ code: 'git_failed' })
    expect(await git.branchExists(repo, 'feature/work')).toBe(true)
  })
})

describe('worktrees and commits', () => {
  it('creates a worktree (path with spaces) and lists it', async () => {
    const repo = await makeRepo('my repo')
    const wt = join(base, 'work trees', 'one two')
    const sha = await git.createWorktree(repo, wt, 'nexus/t/one', 'main')
    expect(sha).toBe(await git.headCommit(repo))
    expect(await git.currentBranch(wt)).toBe('nexus/t/one')
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toContain('line2')

    const list = await git.listWorktrees(repo)
    expect(list).toHaveLength(2)
    const found = list.find((w) => w.branch === 'nexus/t/one')
    expect(found?.path.toLowerCase()).toBe((await realpath(wt)).toLowerCase())
    expect(found?.head).toBe(sha)
    // the user's own working tree was never written to
    await git.assertClean(repo)
  })

  it('lets two branches commit independently', async () => {
    const repo = await makeRepo()
    const w1 = join(base, 'par1')
    const w2 = join(base, 'par2')
    await Promise.all([
      git.createWorktree(repo, w1, 'nexus/p/one', 'main'),
      git.createWorktree(repo, w2, 'nexus/p/two', 'main'),
    ])
    await writeFile(join(w1, 'one.txt'), '1')
    await writeFile(join(w2, 'two.txt'), '2')
    const [c1, c2] = await Promise.all([
      git.commitAll(w1, 'task one', author),
      git.commitAll(w2, 'task two', author),
    ])
    expect(c1).toMatch(/^[0-9a-f]{40}$/)
    expect(c2).toMatch(/^[0-9a-f]{40}$/)
    expect(c1).not.toBe(c2)
    expect(await git.changedFiles(repo, 'main', 'nexus/p/one')).toEqual(['one.txt'])
    expect(await git.changedFiles(repo, 'main', 'nexus/p/two')).toEqual(['two.txt'])
    expect(await git.commitCount(repo, 'main', 'nexus/p/one')).toBe(1)
    expect(await git.mergeBase(repo, 'nexus/p/one', 'nexus/p/two')).toBe(await git.headCommit(repo))
  })

  it('commits with the given identity only and returns null when nothing changed', async () => {
    const repo = await makeRepo()
    const wt = join(base, 'commit-wt')
    await git.createWorktree(repo, wt, 'nexus/c/one', 'main')
    expect(await git.commitAll(wt, 'nothing', author)).toBeNull()
    await writeFile(join(wt, 'x.txt'), 'x')
    const sha = await git.commitAll(wt, 'add x\n\nbody -with dash', author)
    expect(sha).not.toBeNull()
    const [entry] = await git.log(wt, 'HEAD', 1)
    expect(entry).toMatchObject({ sha, authorName: author.name, authorEmail: author.email, subject: 'add x' })
    expect(await sh(repo, 'config', 'user.name')).toBe('Local User')
    expect((await git.log(wt, 'main..HEAD', 10)).map((c) => c.sha)).toEqual([sha])
    await expect(git.commitAll(wt, '  ', author)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('removeWorktree refuses dirty worktrees unless force is explicit', async () => {
    const repo = await makeRepo()
    const wt = join(base, 'dirty-wt')
    await git.createWorktree(repo, wt, 'nexus/d/one', 'main')
    await writeFile(join(wt, 'precious.txt'), 'unsaved work')
    await expect(git.removeWorktree(repo, wt)).rejects.toMatchObject({ code: 'dirty_repository' })
    expect(await readFile(join(wt, 'precious.txt'), 'utf8')).toBe('unsaved work')
    await git.removeWorktree(repo, wt, { force: true })
    expect((await git.listWorktrees(repo)).map((w) => w.branch)).toEqual(['main'])

    const clean = join(base, 'clean-wt')
    await git.createWorktree(repo, clean, 'nexus/d/two', 'main')
    await git.removeWorktree(repo, clean)
    expect((await git.listWorktrees(repo)).length).toBe(1)
  })

  it('removeWorktree on an already-deleted directory prunes the registration', async () => {
    const repo = await makeRepo()
    const wt = join(base, 'gone-wt')
    await git.createWorktree(repo, wt, 'nexus/g/one', 'main')
    await rm(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    expect((await git.listWorktrees(repo)).find((w) => w.branch === 'nexus/g/one')?.prunable).toBe(true)
    await git.removeWorktree(repo, wt)
    expect((await git.listWorktrees(repo)).length).toBe(1)
  })
})

describe('diff', () => {
  let repo: string
  beforeEach(async () => {
    repo = await makeRepo()
  })

  it('reports added, modified, deleted and renamed files with numstat', async () => {
    const wt = join(base, `diff-wt-${counter}`)
    await git.createWorktree(repo, wt, 'nexus/df/one', 'main')
    await writeFile(join(wt, 'added file.txt'), 'a\nb\n')
    await writeFile(join(wt, 'a.txt'), 'line1\nLINE2\nline3\nline4\n')
    await rm(join(wt, 'doomed.txt'))
    await rename(join(wt, 'moved.txt'), join(wt, 'moved again.txt'))
    await git.commitAll(wt, 'many changes', author)

    const d = await git.diff(repo, 'main', 'nexus/df/one')
    const byPath = new Map(d.files.map((f) => [f.path, f]))
    expect(byPath.get('added file.txt')).toMatchObject({ status: 'added', additions: 2, deletions: 0, binary: false })
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    expect(byPath.get('doomed.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    expect(byPath.get('moved again.txt')).toMatchObject({ status: 'renamed', oldPath: 'moved.txt', additions: 0, deletions: 0 })
    expect(d.files).toHaveLength(4)
    expect(d.truncated).toBe(false)
    expect(d.patch).toContain('+LINE2')
    expect(d.patch).toContain('rename from moved.txt')
  })

  it('flags binary files and truncates oversized patches', async () => {
    const wt = join(base, `diff-bin-${counter}`)
    await git.createWorktree(repo, wt, 'nexus/df/bin', 'main')
    await writeFile(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]))
    await writeFile(join(wt, 'big.txt'), 'x'.repeat(200) + '\n')
    await git.commitAll(wt, 'bin', author)
    const d = await git.diff(repo, 'main', 'nexus/df/bin', { maxPatchBytes: 100 })
    expect(d.files.find((f) => f.path === 'blob.bin')).toMatchObject({ binary: true, additions: 0, deletions: 0 })
    expect(d.truncated).toBe(true)
    expect(d.patch.length).toBe(100)
  })

  it('diffWorkingTree includes uncommitted and untracked changes without touching the index', async () => {
    const wt = join(base, `diff-wip-${counter}`)
    const baseCommit = await git.createWorktree(repo, wt, 'nexus/df/wip', 'main')
    await writeFile(join(wt, 'committed.txt'), 'c')
    await git.commitAll(wt, 'c', author)
    await writeFile(join(wt, 'a.txt'), 'dirty\n')
    await writeFile(join(wt, 'untracked.txt'), 'u\n')
    await rm(join(wt, 'b.txt'))

    const before = await git.status(wt)
    const d = await git.diffWorkingTree(wt, baseCommit)
    expect(d.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['a.txt', 'modified'],
      ['b.txt', 'deleted'],
      ['committed.txt', 'added'],
      ['untracked.txt', 'added'],
    ])
    expect(d.patch).toContain('+dirty')
    expect(await git.status(wt)).toEqual(before)
    expect((await git.status(wt)).staged).toEqual([])
  })
})

describe('merge', () => {
  it('performs a clean --no-ff merge', async () => {
    const repo = await makeRepo()
    const integ = join(base, `merge-integ-${counter}`)
    const taskWt = join(base, `merge-task-${counter}`)
    await git.createWorktree(repo, integ, 'nexus/m/integration', 'main')
    await git.createWorktree(repo, taskWt, 'nexus/m/task', 'main')
    await writeFile(join(taskWt, 'feature.txt'), 'f\n')
    const taskCommit = await git.commitAll(taskWt, 'feature', author)

    const result = await git.merge(integ, 'nexus/m/task', { message: 'Merge task', author })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parents = (await sh(integ, 'rev-list', '--parents', '-n', '1', result.commit)).split(' ')
    expect(parents).toHaveLength(3) // --no-ff: a real merge commit
    expect(parents).toContain(taskCommit)
    expect(lf(await readFile(join(integ, 'feature.txt'), 'utf8'))).toBe('f\n')
    expect((await git.log(integ, 'HEAD', 1))[0]?.subject).toBe('Merge task')
    await git.assertClean(integ)
  })

  it('detects conflicts, reports the paths and leaves the worktree clean', async () => {
    const repo = await makeRepo()
    const integ = join(base, `conf-integ-${counter}`)
    const t1 = join(base, `conf-t1-${counter}`)
    const t2 = join(base, `conf-t2-${counter}`)
    await git.createWorktree(repo, integ, 'nexus/x/integration', 'main')
    await git.createWorktree(repo, t1, 'nexus/x/one', 'main')
    await git.createWorktree(repo, t2, 'nexus/x/two', 'main')
    await writeFile(join(t1, 'a.txt'), 'line1\nONE\nline3\n')
    await writeFile(join(t2, 'a.txt'), 'line1\nTWO\nline3\n')
    await git.commitAll(t1, 'one', author)
    await git.commitAll(t2, 'two', author)

    expect((await git.merge(integ, 'nexus/x/one', { message: 'm1', author })).ok).toBe(true)
    const headBefore = await git.headCommit(integ)
    const r = await git.merge(integ, 'nexus/x/two', { message: 'm2', author })
    expect(r).toEqual({ ok: false, conflicts: ['a.txt'] })
    expect(await git.isMergeInProgress(integ)).toBe(false)
    expect((await git.status(integ)).clean).toBe(true)
    expect(await git.headCommit(integ)).toBe(headBefore)
    expect(lf(await readFile(join(integ, 'a.txt'), 'utf8'))).toBe('line1\nONE\nline3\n')
    expect(await git.abortMerge(integ)).toBe(false)
  })

  it('refuses to merge into a dirty worktree and supports manual abort of a started merge', async () => {
    const repo = await makeRepo()
    const integ = join(base, `abort-integ-${counter}`)
    const t1 = join(base, `abort-t1-${counter}`)
    await git.createWorktree(repo, integ, 'nexus/y/integration', 'main')
    await git.createWorktree(repo, t1, 'nexus/y/one', 'main')
    await writeFile(join(t1, 'a.txt'), 'theirs\n')
    await git.commitAll(t1, 'one', author)

    await writeFile(join(integ, 'scratch.txt'), 'x')
    await expect(git.merge(integ, 'nexus/y/one', { message: 'm', author })).rejects.toMatchObject({
      code: 'dirty_repository',
    })
    await rm(join(integ, 'scratch.txt'))

    await writeFile(join(integ, 'a.txt'), 'ours\n')
    await git.commitAll(integ, 'ours', author)
    await sh(integ, 'merge', '--no-ff', '--no-edit', 'nexus/y/one').catch(() => undefined)
    expect(await git.isMergeInProgress(integ)).toBe(true)
    expect(await git.abortMerge(integ)).toBe(true)
    expect(await git.isMergeInProgress(integ)).toBe(false)
    expect((await git.status(integ)).clean).toBe(true)
  })
})

describe('WorktreeManager', () => {
  let repo: string
  let root: string
  let mgr: WorktreeManager

  beforeEach(async () => {
    repo = await makeRepo()
    root = join(base, `wt root ${counter}`)
    mgr = new WorktreeManager(git, root)
  })

  it('plans deterministic short, sanitized paths and branches', () => {
    const runId = newId()
    const a = mgr.planPaths(runId, 'Task 1: Add Login!')
    expect(mgr.planPaths(runId, 'Task 1: Add Login!')).toEqual(a)
    const short = runId.replace(/-/g, '').slice(0, 8)
    expect(a.branch).toMatch(new RegExp(`^nexus/${short}/task-1-add-login-[0-9a-f]{4}$`))
    expect(a.path.toLowerCase()).toBe(join(root, short, a.branch.split('/')[2]!).toLowerCase())
    expect(mgr.planPaths(runId, 'simple-key').branch).toBe(`nexus/${short}/simple-key`)
    expect(mgr.planPaths(runId, 'A B').branch).not.toBe(mgr.planPaths(runId, 'a-b').branch)
    expect(mgr.planPaths(runId, '!!!').branch).toMatch(/\/task-[0-9a-f]{4}$/)
    const long = mgr.planPaths(runId, 'x'.repeat(200))
    expect(long.branch.length).toBeLessThan(60)
  })

  it('creates task and integration worktrees from a start point', async () => {
    const runId = newId()
    const integ = await mgr.createIntegration({ repoRoot: repo, runId, startPoint: 'main' })
    const task = await mgr.createForTask({ repoRoot: repo, runId, taskKey: 'T-1', startPoint: integ.branch })
    expect(integ.branch).toMatch(/^nexus\/[0-9a-f]{8}\/integration$/)
    expect(task.baseCommit).toBe(await git.headCommit(repo))
    expect(await git.currentBranch(task.path)).toBe(task.branch)
    expect(await isPathInside(task.path, root)).toBe(true)
    await mgr.remove(repo, task.path)
    await mgr.remove(repo, integ.path)
    expect((await git.listWorktrees(repo)).length).toBe(1)
  })

  it('refuses to remove paths outside its root', async () => {
    await expect(mgr.remove(repo, repo)).rejects.toMatchObject({ code: 'path_violation' })
  })

  it('finds orphans and cleans only the clean ones', async () => {
    const runId = newId()
    const known = await mgr.createForTask({ repoRoot: repo, runId, taskKey: 'known', startPoint: 'main' })
    const cleanOrphan = await mgr.createForTask({ repoRoot: repo, runId, taskKey: 'clean-orphan', startPoint: 'main' })
    const dirtyOrphan = await mgr.createForTask({ repoRoot: repo, runId, taskKey: 'dirty-orphan', startPoint: 'main' })
    const missing = await mgr.createForTask({ repoRoot: repo, runId, taskKey: 'missing', startPoint: 'main' })
    await writeFile(join(dirtyOrphan.path, 'wip.txt'), 'unsaved')
    await rm(missing.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    // a worktree outside the NEXUS root is never an orphan
    const foreign = join(base, `foreign-${counter}`)
    await git.createWorktree(repo, foreign, 'user/foreign', 'main')

    const knownPaths = [known.path.toUpperCase(), join(root, 'ghost')]
    const report = await mgr.findOrphans(repo, knownPaths)
    const key = (p: string): string => p.toLowerCase()
    expect(report.unknownToNexus.map((w) => key(w.path)).sort()).toEqual(
      [cleanOrphan.path, dirtyOrphan.path].map(key).sort(),
    )
    expect(report.missingOnDisk.map((w) => key(w.path))).toEqual([key(missing.path)])
    expect(report.knownButUnregistered).toEqual([join(root, 'ghost')])

    const cleanup = await mgr.cleanupOrphans(repo, [known.path])
    expect(cleanup.removed.map(key)).toEqual([key(cleanOrphan.path)])
    expect(cleanup.skippedDirty.map(key)).toEqual([key(dirtyOrphan.path)])
    expect(cleanup.pruned.map(key)).toEqual([key(missing.path)])
    expect(cleanup.failed).toEqual([])
    expect(await readFile(join(dirtyOrphan.path, 'wip.txt'), 'utf8')).toBe('unsaved')
    const remaining = (await git.listWorktrees(repo)).map((w) => key(w.path))
    expect(remaining).toContain(key(known.path))
    expect(remaining).toContain(key(dirtyOrphan.path))
    expect(remaining).toContain(key(foreign))
    expect(remaining).not.toContain(key(cleanOrphan.path))
    expect(remaining).not.toContain(key(missing.path))
  })
})

describe('isPathInside', () => {
  it('compares real paths, case-insensitively on Windows, and rejects siblings and traversal', async () => {
    const parent = join(base, 'inside-parent')
    await mkdir(join(parent, 'child'), { recursive: true })
    expect(await isPathInside(join(parent, 'child'), parent)).toBe(true)
    expect(await isPathInside(join(parent, 'not', 'yet', 'created'), parent)).toBe(true)
    expect(await isPathInside(parent, parent)).toBe(true)
    expect(await isPathInside(join(parent, '..', 'inside-parent-sibling'), parent)).toBe(false)
    expect(await isPathInside(join(parent, 'child', '..', '..'), parent)).toBe(false)
    if (process.platform === 'win32') {
      expect(await isPathInside(join(parent, 'child').toUpperCase(), parent.toLowerCase())).toBe(true)
    }
  })
})
