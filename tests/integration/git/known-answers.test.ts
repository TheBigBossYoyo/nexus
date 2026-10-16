import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GitService } from '@main/modules/git/git-service'

// 0.9.1: GitService keeps the answers of git that cannot change (the commit an object id peels to, the files of a
// commit, the files of its private index while that file is unchanged) instead of starting git again for them
// (312 git processes for a fake mission of three tasks before, 197 after). What the code in a worktree can change
// must still be read each time: here it moves its branch, packs its refs, and puts a junction where a tracked
// directory was after NEXUS has already looked at that commit.

const SCRATCH = resolve('test-results', 'known-answers-tests')
const AUTHOR = { name: 'NEXUS Agent', email: 'nexus-agent@localhost' }
const raw = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let n = 0
async function fresh(): Promise<{ git: GitService; repo: string; worktree: string; base: string }> {
  n += 1
  const base = join(SCRATCH, `case-${n}`)
  rmSync(base, { recursive: true, force: true })
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'd'), { recursive: true })
  raw(repo, 'init', '-q', '-b', 'main', '.')
  raw(repo, 'config', 'user.name', 'User')
  raw(repo, 'config', 'user.email', 'user@example.com')
  raw(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'd', 'x.txt'), 'x\n')
  raw(repo, 'add', '-A')
  raw(repo, 'commit', '-q', '-m', 'initial')
  const git = new GitService()
  git.setWorktreesRoot(join(base, 'worktrees'))
  git.setTrustedIndexDir(join(base, 'nexus-index'))
  const worktree = join(base, 'worktrees', 'run1', 'task')
  await git.createWorktree(repo, worktree, 'nexus/run1/task', 'main')
  return { git, repo, worktree, base }
}

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

describe('answers of git that GitService keeps', () => {
  it('sees a commit the agent made on its branch, loose and then packed', async () => {
    const { git, repo, worktree } = await fresh()
    writeFileSync(join(worktree, 'b.txt'), 'b\n')
    const first = await git.commitAll(worktree, 'nexus one', AUTHOR)
    expect(first).not.toBeNull()
    // The agent commits by itself: its branch's loose ref moves.
    writeFileSync(join(worktree, 'c.txt'), 'c\n')
    raw(worktree, 'add', 'c.txt')
    raw(worktree, '-c', 'user.name=Agent', '-c', 'user.email=agent@localhost', 'commit', '-q', '-m', 'agent')
    const agentCommit = raw(repo, 'rev-parse', 'nexus/run1/task')
    writeFileSync(join(worktree, 'd.txt'), 'd\n')
    const second = await git.commitAll(worktree, 'nexus two', AUTHOR)
    expect(raw(repo, 'rev-parse', `${second}^`)).toBe(agentCommit)
    expect((await git.status(worktree)).staged).toEqual([])
    // Packed: no loose ref file is left, and git is asked as before.
    raw(repo, 'pack-refs', '--all')
    expect(existsSync(join(repo, '.git', 'refs', 'heads', 'nexus', 'run1', 'task'))).toBe(false)
    writeFileSync(join(worktree, 'e.txt'), 'e\n')
    const third = await git.commitAll(worktree, 'nexus three', AUTHOR)
    expect(raw(repo, 'rev-parse', `${third}^`)).toBe(second)
    expect(raw(repo, 'ls-tree', '--name-only', third ?? '')).toContain('e.txt')
  })

  it('still removes a junction put where a tracked directory was, after that commit was looked at once', async () => {
    const { git, worktree, base } = await fresh()
    await git.resetClean(worktree)
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    rmSync(join(worktree, 'd'), { recursive: true, force: true })
    symlinkSync(outside, join(worktree, 'd'), 'junction')
    await git.resetClean(worktree)
    expect(lstatSync(join(worktree, 'd')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    expect(existsSync(join(worktree, 'd', 'x.txt'))).toBe(true)
  })

  it('refuses an object id the repository does not have, and is not taken in by it later', async () => {
    const { git, worktree } = await fresh()
    await expect(git.resolveCommit(worktree, '0'.repeat(40))).rejects.toThrow(/Unknown revision/)
    const head = raw(worktree, 'rev-parse', 'HEAD')
    expect(await git.resolveCommit(worktree, head)).toBe(head)
    expect(await git.resolveCommit(worktree, head)).toBe(head)
  })
})
