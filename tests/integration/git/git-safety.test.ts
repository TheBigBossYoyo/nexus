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

const AUTHOR = { name: 'NEXUS Test', email: 'nexus@example.invalid' }
/** Git marks a worktree's `.git` file hidden on Windows, which makes it unwritable in place; an agent would replace it. */
const replacePointer = async (path: string, content: string): Promise<void> => {
  await rm(path, { force: true })
  await writeFile(path, content)
}

describe('NEXUS does not write through a worktree whose .git pointer was changed, and runs nothing a repository configures', () => {
  it('refuses to commit, reset or clean through a rewritten .git pointer; the user\'s checkout and the other worktree are untouched', async () => {
    const repo = await makeRepo()
    const manager = new WorktreeManager(git, join(base, `wt-${newId()}`))
    const a = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const b = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'b', startPoint: 'main' })
    const userHead = await sh(repo, 'rev-parse', 'HEAD')
    const bHead = await sh(b.path, 'rev-parse', 'HEAD')
    await writeFile(join(a.path, 'agent.txt'), 'work\n')
    // Intact: NEXUS commits in the worktree as always.
    await git.addAll(a.path)
    await git.commitAll(a.path, 'work of a', AUTHOR)
    const original = await readFile(join(a.path, '.git'), 'utf8')

    // The agent points the worktree at the user's repository.
    await replacePointer(join(a.path, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)
    await writeFile(join(a.path, 'evil.txt'), 'x\n')
    await expect(git.addAll(a.path)).rejects.toThrow(/no longer points at its own Git directory/)
    await expect(git.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/no longer points at its own Git directory/)
    await expect(git.resetClean(a.path)).rejects.toThrow(/no longer points at its own Git directory/)
    expect(await sh(repo, 'rev-parse', 'HEAD')).toBe(userHead)
    expect(await sh(repo, 'status', '--porcelain')).toBe('')

    // The agent points it at another task's worktree directory.
    const otherGitDir = (await sh(b.path, 'rev-parse', '--absolute-git-dir')).replace(/\\/g, '/')
    await replacePointer(join(a.path, '.git'), `gitdir: ${otherGitDir}\n`)
    await expect(git.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/belongs to another working tree/)
    expect(await sh(b.path, 'rev-parse', 'HEAD')).toBe(bHead)

    // Restored, it works again.
    await replacePointer(join(a.path, '.git'), original)
    await git.addAll(a.path)
    await git.commitAll(a.path, 'more work of a', AUTHOR)
    expect(await sh(a.path, 'log', '--oneline', '-1')).toContain('more work of a')
  })

  it('runs no hook, no file system monitor and no pager that the repository configures, and hands git no Claude credential', async () => {
    const repo = await makeRepo()
    const marker = join(base, `marker-${newId()}.txt`).replace(/\\/g, '/')
    // What an agent could leave behind in the shared repository: hooks and exec-capable configuration.
    const hook = `#!/bin/sh\necho ran >> "${marker}"\n`
    for (const name of ['pre-commit', 'post-commit', 'post-checkout', 'pre-merge-commit', 'post-merge', 'reference-transaction', 'prepare-commit-msg', 'commit-msg']) {
      await writeFile(join(repo, '.git', 'hooks', name), hook, { mode: 0o755 })
    }
    await sh(repo, 'config', 'core.fsmonitor', `sh -c 'echo ran >> "${marker}"'`)
    await sh(repo, 'config', 'core.pager', `sh -c 'echo ran >> "${marker}"; cat'`)
    const manager = new WorktreeManager(git, join(base, `wt-${newId()}`))
    const wt = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 't', startPoint: 'main' })
    await writeFile(join(wt.path, 'new.txt'), 'x\n')
    await git.status(wt.path)
    await git.addAll(wt.path)
    await git.commitAll(wt.path, 'commit without hooks', AUTHOR)
    await git.run(wt.path, ['log', '--oneline', '-3'])
    await git.run(wt.path, ['diff', 'HEAD~1'])
    await git.resetClean(wt.path)
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    // The environment git runs in carries none of the withheld credentials.
    const env = (git as unknown as { env: NodeJS.ProcessEnv }).env
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS']) expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain(key)
  })
})
