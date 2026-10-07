import { existsSync } from 'node:fs'
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
  it('ignores a rewritten .git pointer in a worktree NEXUS created: commits stay on the worktree\'s own branch, the user\'s checkout and the other worktree are untouched', async () => {
    const repo = await makeRepo()
    const manager = new WorktreeManager(git, join(base, `wt-${newId()}`))
    const a = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const b = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'b', startPoint: 'main' })
    const userHead = await sh(repo, 'rev-parse', 'HEAD')
    const bHead = await sh(b.path, 'rev-parse', 'HEAD')
    const branchOfA = (): Promise<string> => sh(repo, 'rev-parse', `refs/heads/${a.branch}`)
    await writeFile(join(a.path, 'agent.txt'), 'work\n')
    await git.addAll(a.path)
    const first = await git.commitAll(a.path, 'work of a', AUTHOR)
    expect(await branchOfA()).toBe(first)
    const original = await readFile(join(a.path, '.git'), 'utf8')
    const untouched = async (): Promise<void> => {
      expect(await sh(repo, 'rev-parse', 'HEAD')).toBe(userHead)
      expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)
      expect(await sh(repo, 'status', '--porcelain')).toBe('')
      expect(await sh(repo, 'rev-parse', `refs/heads/${b.branch}`)).toBe(bHead)
    }
    let n = 0
    /** One more commit of NEXUS's in worktree a: it must land on a's branch whatever the pointer says. */
    const commitInA = async (): Promise<void> => {
      n += 1
      await writeFile(join(a.path, `file-${n}.txt`), `${n}\n`)
      expect((await git.status(a.path)).clean).toBe(false)
      await git.addAll(a.path)
      const sha = await git.commitAll(a.path, `commit ${n}`, AUTHOR)
      expect(await branchOfA()).toBe(sha)
      expect((await git.status(a.path)).clean).toBe(true)
      await untouched()
    }

    // The agent points the worktree at the user's repository.
    await replacePointer(join(a.path, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)
    await commitInA()

    // At another task's worktree directory.
    const otherGitDir = (await sh(b.path, 'rev-parse', '--absolute-git-dir')).replace(/\\/g, '/')
    await replacePointer(join(a.path, '.git'), `gitdir: ${otherGitDir}\n`)
    await commitInA()

    // At a Git directory the agent made itself inside the worktree, whose back-pointer names the worktree and
    // whose common directory is the user's repository: the form that passed the check of 0.6.
    const fake = join(a.path, '.nxfake')
    await mkdir(fake, { recursive: true })
    await writeFile(join(fake, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(fake, 'commondir'), `${join(repo, '.git').replace(/\\/g, '/')}\n`)
    await writeFile(join(fake, 'gitdir'), `${join(a.path, '.git').replace(/\\/g, '/')}\n`)
    await replacePointer(join(a.path, '.git'), `gitdir: ${fake.replace(/\\/g, '/')}\n`)
    await commitInA()
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)

    // The pointer is gone altogether: git would look further up for a repository.
    await rm(join(a.path, '.git'), { force: true })
    await commitInA()

    // A reset and clean of NEXUS's stays in the worktree too.
    await writeFile(join(a.path, 'junk.txt'), 'x\n')
    await git.resetClean(a.path)
    await untouched()

    // Restored, nothing has changed for NEXUS.
    await writeFile(join(a.path, '.git'), original)
    await commitInA()
    expect(await sh(a.path, 'log', '--oneline', '-1')).toContain(`commit ${n}`)
  })

  it('runs no filter of a private repository an agent put behind the pointer, also for a read', async () => {
    const repo = await makeRepo()
    const manager = new WorktreeManager(git, join(base, `wt-${newId()}`))
    const a = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const marker = join(base, `filter-${newId()}.txt`).replace(/\\/g, '/')
    // A repository of the agent's own inside the worktree, with a clean filter that leaves a mark, and the
    // worktree's pointer turned towards it.
    const priv = join(a.path, 'priv')
    await mkdir(priv, { recursive: true })
    await sh(priv, 'init', '-q', '-b', 'main')
    await sh(priv, 'config', 'filter.x.clean', `sh -c 'echo ran >> "${marker}"; cat'`)
    await writeFile(join(a.path, '.gitattributes'), '* filter=x\n')
    // The private repository itself is not content of the worktree.
    await writeFile(join(a.path, '.gitignore'), 'ignored/\npriv/\n')
    await writeFile(join(a.path, 'tracked.txt'), 'changed\n')
    await replacePointer(join(a.path, '.git'), `gitdir: ${join(priv, '.git').replace(/\\/g, '/')}\n`)

    expect((await git.status(a.path)).clean).toBe(false)
    await git.workingState(a.path)
    await git.addAll(a.path)
    await git.commitAll(a.path, 'with attributes', AUTHOR)
    expect(existsSync(marker)).toBe(false)

    // A Git service that has no record of the worktree (another process) refuses it instead, for a read as for a write.
    const stranger = new GitService()
    await expect(stranger.status(a.path)).rejects.toThrow(/no longer points at its own Git directory/)
    await expect(stranger.addAll(a.path)).rejects.toThrow(/no longer points at its own Git directory/)
    expect(existsSync(marker)).toBe(false)
  })

  it('a Git service without a record refuses the self-made Git directory that passed the check of 0.6', async () => {
    const repo = await makeRepo()
    const manager = new WorktreeManager(git, join(base, `wt-${newId()}`))
    const a = await manager.createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const userHead = await sh(repo, 'rev-parse', 'refs/heads/main')
    const stranger = new GitService()
    // Intact, a stranger may work there: the pointer names a worktree directory of its repository.
    expect((await stranger.status(a.path)).clean).toBe(true)

    const fake = join(a.path, '.nxfake')
    await mkdir(fake, { recursive: true })
    await writeFile(join(fake, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(fake, 'commondir'), `${join(repo, '.git').replace(/\\/g, '/')}\n`)
    await writeFile(join(fake, 'gitdir'), `${join(a.path, '.git').replace(/\\/g, '/')}\n`)
    await replacePointer(join(a.path, '.git'), `gitdir: ${fake.replace(/\\/g, '/')}\n`)
    await writeFile(join(a.path, 'evil.txt'), 'x\n')
    await expect(stranger.addAll(a.path)).rejects.toThrow(/lies inside the working tree/)
    await expect(stranger.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/lies inside the working tree/)
    await expect(stranger.status(a.path)).rejects.toThrow(/lies inside the working tree/)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)

    // The same directory outside the worktree is not a worktree directory of the repository either.
    const outside = join(base, `nxfake-${newId()}`)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(outside, 'commondir'), `${join(repo, '.git').replace(/\\/g, '/')}\n`)
    await writeFile(join(outside, 'gitdir'), `${join(a.path, '.git').replace(/\\/g, '/')}\n`)
    await replacePointer(join(a.path, '.git'), `gitdir: ${outside.replace(/\\/g, '/')}\n`)
    await expect(stranger.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/not a worktree directory of its repository/)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)
  })

  it('after a restart finds the Git directory of a worktree through NEXUS\'s own record of its repository, and refuses a worktree the repository no longer has', async () => {
    const repo = await makeRepo()
    const root = join(base, `wt-${newId()}`)
    const a = await new WorktreeManager(git, root).createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const userHead = await sh(repo, 'rev-parse', 'refs/heads/main')
    const original = await readFile(join(a.path, '.git'), 'utf8')
    // The agent turned the pointer towards the user's repository while NEXUS was not running.
    await replacePointer(join(a.path, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)

    const restarted = new GitService()
    restarted.setWorktreesRoot(root)
    const asked: string[] = []
    restarted.setWorktreeResolver((path) => {
      asked.push(path)
      return path.toLowerCase() === a.path.toLowerCase() ? repo : null
    })
    await writeFile(join(a.path, 'after.txt'), 'x\n')
    await restarted.addAll(a.path)
    const sha = await restarted.commitAll(a.path, 'after the restart', AUTHOR)
    expect(await sh(repo, 'rev-parse', `refs/heads/${a.branch}`)).toBe(sha)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)
    // Asked once, then remembered.
    await restarted.status(a.path)
    expect(asked).toHaveLength(1)

    // The repository's entry for the worktree is gone: nothing found from inside the directory can be right.
    await rm(join(a.path, '.git'), { force: true })
    await writeFile(join(a.path, '.git'), original)
    await sh(repo, 'worktree', 'remove', '--force', a.path)
    await mkdir(a.path, { recursive: true })
    await writeFile(join(a.path, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)
    const later = new GitService()
    later.setWorktreesRoot(root)
    later.setWorktreeResolver(() => repo)
    await expect(later.status(a.path)).rejects.toThrow(/no longer has a worktree entry/)
    await expect(later.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/no longer has a worktree entry/)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(userHead)
  })

  it('does not commit or merge in a worktree whose HEAD an agent turned to another branch, and puts it back before a reset', async () => {
    const repo = await makeRepo()
    // The user works on a branch of their own, so `main` is free to be checked out elsewhere.
    await sh(repo, 'checkout', '-q', '-b', 'user-work')
    const root = join(base, `wt-${newId()}`)
    const a = await new WorktreeManager(git, root).createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const main = await sh(repo, 'rev-parse', 'refs/heads/main')
    const own = await sh(repo, 'rev-parse', `refs/heads/${a.branch}`)

    for (const turn of [
      ['symbolic-ref', 'HEAD', 'refs/heads/main'],
      ['checkout', '-q', 'main'],
      ['checkout', '-q', '--detach'],
      ['checkout', '-q', '-b', 'side'],
    ]) {
      await sh(a.path, 'symbolic-ref', 'HEAD', `refs/heads/${a.branch}`)
      await sh(a.path, 'reset', '-q', '--hard')
      // What an agent's own git command does in its worktree.
      await sh(a.path, ...turn)
      await writeFile(join(a.path, 'evil.txt'), 'x\n')
      await git.addAll(a.path)
      await expect(git.commitAll(a.path, 'evil', AUTHOR), turn.join(' ')).rejects.toThrow(/no longer on its branch/)
      await expect(git.run(a.path, ['merge', '--no-ff', '-m', 'm', 'main']), turn.join(' ')).rejects.toThrow(/no longer on its branch/)
      expect(await sh(repo, 'rev-parse', 'refs/heads/main'), turn.join(' ')).toBe(main)
      expect(await sh(repo, 'rev-parse', `refs/heads/${a.branch}`)).toBe(own)
      // A reset of NEXUS's discards everything anyway: it first puts the worktree back on its branch.
      await git.resetClean(a.path)
      expect(await sh(a.path, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${a.branch}`)
      expect((await git.status(a.path)).clean).toBe(true)
    }
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(main)

    // Back on its branch NEXUS commits as always.
    await writeFile(join(a.path, 'work.txt'), 'x\n')
    await git.addAll(a.path)
    const sha = await git.commitAll(a.path, 'work', AUTHOR)
    expect(await sh(repo, 'rev-parse', `refs/heads/${a.branch}`)).toBe(sha)

    // The branch itself turned into a reference to the user's branch (what code an agent runs could do): HEAD
    // still names the task branch, and a commit "on" it would advance main.
    const tip = await sh(repo, 'rev-parse', `refs/heads/${a.branch}`)
    await sh(a.path, 'symbolic-ref', `refs/heads/${a.branch}`, 'refs/heads/main')
    await writeFile(join(a.path, 'symref.txt'), 'x\n')
    await git.addAll(a.path)
    await expect(git.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/turned into a reference to refs\/heads\/main/)
    await expect(git.run(a.path, ['merge', '--no-ff', '-m', 'm', 'user-work'])).rejects.toThrow(/turned into a reference/)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(main)
    await sh(repo, 'symbolic-ref', '--delete', `refs/heads/${a.branch}`)
    await sh(repo, 'update-ref', `refs/heads/${a.branch}`, tip)
    await sh(a.path, 'reset', '-q', '--hard')

    // After a restart the branch comes from NEXUS's record of the worktree.
    const restarted = new GitService()
    restarted.setWorktreesRoot(root)
    restarted.setWorktreeResolver(() => ({ repoRoot: repo, branch: a.branch }))
    await sh(a.path, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    await writeFile(join(a.path, 'late.txt'), 'x\n')
    await restarted.addAll(a.path)
    await expect(restarted.commitAll(a.path, 'evil', AUTHOR)).rejects.toThrow(/no longer on its branch/)
    expect(await sh(repo, 'rev-parse', 'refs/heads/main')).toBe(main)
  })

  it('reads the commit it names, not a replacement an agent registered for it', async () => {
    const repo = await makeRepo()
    const a = await new WorktreeManager(git, join(base, `wt-${newId()}`)).createForTask({ repoRoot: repo, runId: newId(), taskKey: 'a', startPoint: 'main' })
    const baseCommit = await sh(repo, 'rev-parse', 'main')
    await writeFile(join(a.path, 'tracked.txt'), 'the agent\'s own content\n')
    await sh(a.path, 'commit', '-q', '-am', 'agent', '--author', 'A <a@example.invalid>')
    const agentCommit = await sh(a.path, 'rev-parse', 'HEAD')
    await sh(a.path, 'replace', baseCommit, agentCommit)
    // Plain git now shows the agent's content under the base commit's name.
    expect((await sh(a.path, 'show', `${baseCommit}:tracked.txt`)).trim()).toBe('the agent\'s own content')
    // NEXUS does not.
    expect((await git.run(a.path, ['show', `${baseCommit}:tracked.txt`])).stdout.trim()).toBe('original')
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
