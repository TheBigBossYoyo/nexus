import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'
import { GitService, WorktreeManager } from '@main/modules/git'
import { runProcess } from '@main/modules/process'

const git = new GitService()
let base: string
let counter = 0

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function makeRepo(): Promise<string> {
  const dir = join(base, `repo-${++counter}`)
  await mkdir(dir, { recursive: true })
  await sh(dir, 'init', '-b', 'main')
  await sh(dir, 'config', 'user.name', 'Local User')
  await sh(dir, 'config', 'user.email', 'local@example.com')
  await sh(dir, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(dir, '.gitignore'), 'ignored/\n')
  await writeFile(join(dir, 'tracked.txt'), 'original\n')
  await sh(dir, 'add', '-A')
  await sh(dir, 'commit', '-m', 'initial')
  return realpath(dir)
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexus git safety-')))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
})

describe('worktree names on Windows', () => {
  const mgr = new WorktreeManager(git, join(tmpdir(), 'nexus-unused-root'))
  const runId = newId()

  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'CON', 'con.txt', 'aux.', 'nul ', 'com1.log'])(
    'plans a creatable name for the task key %j',
    (key) => {
      const { path, branch } = mgr.planPaths(runId, key)
      const name = branch.split('/')[2] ?? ''
      expect(name).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i)
      expect(name).not.toMatch(/[. ]$/)
      expect(path.toLowerCase().endsWith(name.toLowerCase())).toBe(true)
    },
  )

  it('keeps ordinary keys unchanged and reserved names distinct from similar keys', () => {
    expect(mgr.planPaths(runId, 'console').branch.endsWith('/console')).toBe(true)
    expect(mgr.planPaths(runId, 'con').branch).toMatch(/\/con-[0-9a-f]{4}$/)
    expect(mgr.planPaths(runId, 'con').branch).not.toBe(mgr.planPaths(runId, 'CON').branch)
    expect(mgr.planPaths(runId, 'con')).toEqual(mgr.planPaths(runId, 'con'))
  })

  it('really creates worktrees for reserved device names', async () => {
    const repo = await makeRepo()
    const real = new WorktreeManager(git, join(base, `wt-${counter}`))
    for (const key of ['con', 'aux', 'nul', 'com1', 'lpt1']) {
      const created = await real.createForTask({ repoRoot: repo, runId: newId(), taskKey: key, startPoint: 'main' })
      expect(await git.currentBranch(created.path)).toBe(created.branch)
    }
  })
})

describe('createWorktree failure', () => {
  it('does not leave the new branch behind when the checkout fails', async () => {
    const repo = await makeRepo()
    // A file where the worktree directory must go makes `worktree add` fail after the branch is chosen.
    const blocked = join(base, `blocked-${counter}`)
    await writeFile(blocked, 'in the way')
    await expect(git.createWorktree(repo, blocked, 'nexus/abc/blocked', 'main')).rejects.toBeDefined()
    expect(await git.branchExists(repo, 'nexus/abc/blocked')).toBe(false)
  })

  it('never deletes a branch that existed before', async () => {
    const repo = await makeRepo()
    await git.createBranch(repo, 'nexus/abc/keep', 'main')
    const blocked = join(base, `blocked-${++counter}`)
    await writeFile(blocked, 'in the way')
    await expect(git.createWorktree(repo, blocked, 'nexus/abc/keep', 'main')).rejects.toBeDefined()
    expect(await git.branchExists(repo, 'nexus/abc/keep')).toBe(true)
  })
})

describe('resetClean', () => {
  it('restores tracked files, removes untracked files and keeps ignored ones; refuses paths outside the root', async () => {
    const repo = await makeRepo()
    const root = join(base, `wt-root-${counter}`)
    const mgr = new WorktreeManager(git, root)
    const wt = await mgr.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'dirty', startPoint: 'main' })
    await writeFile(join(wt.path, 'tracked.txt'), 'rewritten\n')
    await writeFile(join(wt.path, 'report.tmp'), 'x')
    await mkdir(join(wt.path, 'ignored'), { recursive: true })
    await writeFile(join(wt.path, 'ignored', 'deps.txt'), 'keep me')
    expect((await git.status(wt.path)).clean).toBe(false)

    await mgr.resetClean(wt.path)
    expect((await git.status(wt.path)).clean).toBe(true)
    expect((await readFile(join(wt.path, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('original\n')
    expect(await readFile(join(wt.path, 'ignored', 'deps.txt'), 'utf8')).toBe('keep me')

    // The user's own checkout is never reset.
    await writeFile(join(repo, 'tracked.txt'), 'user edit\n')
    await expect(mgr.resetClean(repo)).rejects.toMatchObject({ code: 'path_violation' })
    expect((await readFile(join(repo, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('user edit\n')
  })
})
