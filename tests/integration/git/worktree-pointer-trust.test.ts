import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '@main/modules/git/git-service'

// Under RESTRICTED the code of a task can write in its worktree and in the worktree's entry in the repository
// (`<repo>/.git/worktrees/<name>`). It can replace the `.git` pointer file of the worktree, repoint `commondir`
// and `gitdir` of the entry, and add a `config.worktree`. NEXUS's own git runs as the user, uncontained, so it
// must never let any of that decide where it runs or what configuration it reads. Each case plays the task:
// it plants a repository (or a configuration) whose settings run a marker file for every way git has of running
// something, then lets NEXUS do what it does in a worktree and looks at two things: was a planted program run
// (a marker exists), and did NEXUS refuse or act on the true repository. The payloads write a marker only.

const SCRATCH = resolve('test-results', 'worktree-pointer-trust-tests')
const AUTHOR = { name: 'NEXUS Agent', email: 'nexus-agent@localhost' }
const raw = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const slash = (p: string): string => p.replace(/\\/g, '/')

let n = 0
let base = ''
let repo = ''
let worktree = ''
let entry = ''
let git: GitService
const marker = (name: string): string => join(base, `RAN-${name}`)
const MARKERS = ['fsmonitor', 'filter', 'hook', 'textconv', 'alias', 'sshcommand', 'include']
const ran = (): string[] => MARKERS.filter((m) => existsSync(marker(m)))

beforeEach(async () => {
  n += 1
  base = join(SCRATCH, `case-${n}`)
  repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  raw(repo, 'init', '-q', '-b', 'main', '.')
  raw(repo, 'config', 'user.name', 'User')
  raw(repo, 'config', 'user.email', 'user@example.com')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, '.gitattributes'), '* filter=evil diff=evil\n')
  raw(repo, 'add', '-A')
  raw(repo, 'commit', '-q', '-m', 'initial')
  git = new GitService()
  git.setWorktreesRoot(join(base, 'worktrees'))
  git.setTrustedIndexDir(join(base, 'nexus-index'))
  worktree = join(base, 'worktrees', 'run1', 'task')
  await git.createWorktree(repo, worktree, 'nexus/run1/task', 'main')
  entry = join(repo, '.git', 'worktrees', 'task')
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/** The settings a hostile repository (or `config.worktree`) carries: a program for every way git has of running one. */
function hostileConfig(): string {
  // Quoted for git's configuration syntax: an unquoted `;` starts a comment and would cut the program short.
  const sh = (name: string, prefix = ''): string => `"${prefix}sh -c 'echo ran > \\"${slash(marker(name))}\\"; cat'"`
  return [
    '[core]',
    `\tfsmonitor = ${sh('fsmonitor')}`,
    `\tsshCommand = ${sh('sshcommand')}`,
    '[filter "evil"]',
    `\tclean = ${sh('filter')}`,
    `\tsmudge = ${sh('filter')}`,
    '[diff "evil"]',
    `\ttextconv = ${sh('textconv')}`,
    '[alias]',
    `\tevil = ${sh('alias', '!')}`,
    ''
  ].join('\n')
}

/** What the task writes to turn its worktree into a place where git finds a repository of the task's making. */
function plantRepository(): string {
  const evil = join(worktree, 'evil')
  mkdirSync(join(evil, 'hooks'), { recursive: true })
  raw(evil, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(evil, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\thooksPath = ${slash(join(evil, 'hooks'))}\n${hostileConfig()}`)
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'reference-transaction']) writeFileSync(join(evil, 'hooks', hook), `#!/bin/sh\necho ran > "${slash(marker('hook'))}"\n`)
  return join(evil, '.git')
}

/** Everything NEXUS does in a worktree with git, one after the other; each result is the error or the answer. */
async function nexusUse(): Promise<string[]> {
  const out: string[] = []
  const attempt = async (name: string, f: () => Promise<unknown>): Promise<void> => {
    try {
      await f()
      out.push(`${name}: ok`)
    } catch (e) {
      out.push(`${name}: ${(e as Error).message}`)
    }
  }
  writeFileSync(join(worktree, 'b.txt'), 'b\n')
  await attempt('status', () => git.status(worktree))
  await attempt('workingState', async () => {
    if ((await git.workingState(worktree)) === null) throw new Error('null')
  })
  await attempt('diffWorkingTree', () => git.diffWorkingTree(worktree, 'HEAD'))
  await attempt('addAll', () => git.addAll(worktree))
  await attempt('commitAll', () => git.commitAll(worktree, 'task work', AUTHOR))
  await attempt('headCommit', () => git.headCommit(worktree))
  await attempt('merge', () => git.merge(worktree, 'main', { message: 'merge', author: AUTHOR }))
  await attempt('resetClean', () => git.resetClean(worktree))
  return out
}

/** The pointer file is hidden on Windows, which refuses a write to it; a task replaces it (removes it, writes another). */
function replacePointer(content: string): void {
  rmSync(join(worktree, '.git'), { force: true })
  writeFileSync(join(worktree, '.git'), content)
}

const trueBranchTip =(): string => raw(repo, 'rev-parse', 'refs/heads/nexus/run1/task')

describe('a task rewrites the git state of its worktree', () => {
  it('honest case: everything works and nothing hostile exists to run', async () => {
    const results = await nexusUse()
    expect(results.filter((r) => !r.endsWith(': ok'))).toEqual([])
    expect(ran()).toEqual([])
    expect(raw(repo, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('task work')
  })

  it('a .git file replaced by a pointer to a repository the task made: nothing of it runs, and NEXUS refuses', async () => {
    const evilGit = plantRepository()
    const before = trueBranchTip()
    replacePointer(`gitdir: ${slash(evilGit)}\n`)
    const results = await nexusUse()
    expect(ran()).toEqual([])
    // Every command refused, with the reason named; none acted on the planted repository or on the true one.
    expect(results.every((r) => /git entry of the working tree .* was changed/.test(r) || r.startsWith('workingState: null'))).toBe(true)
    expect(results.some((r) => r.includes('.git file says'))).toBe(true)
    expect(trueBranchTip()).toBe(before)
    expect(existsSync(join(evilGit, 'refs', 'heads', 'nexus'))).toBe(false)
  })

  it('a .git file replaced by a directory holding a repository: refused, nothing runs', async () => {
    const evilGit = plantRepository()
    rmSync(join(worktree, '.git'))
    mkdirSync(join(worktree, '.git'))
    writeFileSync(join(worktree, '.git', 'config'), readFileSync(join(evilGit, 'config'), 'utf8'))
    writeFileSync(join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.some((r) => r.includes('was changed'))).toBe(true)
  })

  it('a pointer to the right entry written another way is still refused only when it differs; the right one is accepted', async () => {
    // Same entry, Windows or POSIX spelling, trailing newline or none: not a change.
    replacePointer(`gitdir: ${slash(entry)}`)
    expect((await nexusUse()).filter((r) => !r.endsWith(': ok'))).toEqual([])
  })

  it('commondir of the entry repointed to a repository the task made: nothing runs, NEXUS refuses', async () => {
    const evilGit = plantRepository()
    writeFileSync(join(entry, 'commondir'), `${slash(evilGit)}\n`)
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.some((r) => r.includes('its commondir names'))).toBe(true)
    expect(results.every((r) => r.includes('was changed') || r.startsWith('workingState: null'))).toBe(true)
  })

  it('gitdir of the entry repointed: refused', async () => {
    writeFileSync(join(entry, 'gitdir'), `${slash(join(base, 'elsewhere', '.git'))}\n`)
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.some((r) => r.includes('its gitdir names'))).toBe(true)
  })

  it('a config.worktree planted while the repository reads per-worktree configuration: nothing runs', async () => {
    raw(repo, 'config', 'extensions.worktreeConfig', 'true')
    writeFileSync(join(entry, 'config.worktree'), hostileConfig())
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.some((r) => r.includes('config.worktree'))).toBe(true)
  })

  it('an include in a planted configuration of the entry is not read', async () => {
    // The entry has no `config` of its own that git reads; this only proves that planting one changes nothing.
    writeFileSync(join(entry, 'config'), `[include]\n\tpath = ${slash(join(base, 'evil.cfg'))}\n`)
    writeFileSync(join(base, 'evil.cfg'), hostileConfig())
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.filter((r) => !r.endsWith(': ok'))).toEqual([])
  })

  it('a second entry claiming the same worktree is not trusted after a restart', async () => {
    // A new service knows nothing of the first one's records: it must find the entry in the repository again.
    mkdirSync(join(repo, '.git', 'worktrees', 'task2'))
    writeFileSync(join(repo, '.git', 'worktrees', 'task2', 'gitdir'), `${slash(join(worktree, '.git'))}\n`)
    const second = new GitService()
    expect(await second.trustWorktree(worktree, repo, 'nexus/run1/task')).toBe(false)
  })

  it('after a restart (a new service that knows the worktree only from NEXUS\'s record) a replaced pointer is refused and runs nothing', async () => {
    const evilGit = plantRepository()
    replacePointer(`gitdir: ${slash(evilGit)}\n`)
    git = new GitService()
    git.setWorktreesRoot(join(base, 'worktrees'))
    git.setTrustedIndexDir(join(base, 'nexus-index'))
    git.setWorktreeResolver(() => ({ repoRoot: repo, branch: 'nexus/run1/task' }))
    const results = await nexusUse()
    expect(ran()).toEqual([])
    expect(results.some((r) => r.includes('.git file says'))).toBe(true)
  })

  it('a worktree NEXUS does not know (no record, outside its root) with a replaced pointer: refused, nothing runs', async () => {
    const evilGit = plantRepository()
    replacePointer(`gitdir: ${slash(evilGit)}\n`)
    const stranger = new GitService() // no worktrees root, no resolver: the pointer is checked against the repository's back-pointer
    await expect(stranger.status(worktree)).rejects.toThrow(/no longer points at its own Git directory/)
    expect(ran()).toEqual([])
  })

  it('a speculative candidate is a clone whose .git/config the task owns: a hostile configuration is refused and runs nothing; the honest clone works', async () => {
    const clone = join(base, 'worktrees', 'run1', 'task-cand-a')
    raw(repo, 'clone', '-q', '--no-hardlinks', '--no-tags', '--no-checkout', repo, clone)
    raw(clone, 'remote', 'remove', 'origin')
    raw(clone, 'checkout', '-q', '-B', 'nexus/run1/task-cand-a', 'main')
    writeFileSync(join(clone, 'c.txt'), 'c\n')
    await git.addAll(clone)
    expect(await git.commitAll(clone, 'candidate work', AUTHOR)).not.toBeNull()
    expect(ran()).toEqual([])
    writeFileSync(join(clone, 'd.txt'), 'd\n')
    writeFileSync(join(clone, '.git', 'config'), `${readFileSync(join(clone, '.git', 'config'), 'utf8')}${hostileConfig()}`)
    for (const f of [() => git.status(clone), () => git.addAll(clone), () => git.diffWorkingTree(clone, 'HEAD'), () => git.headCommit(clone)]) {
      await expect(f()).rejects.toThrow(/has a configuration of its own that NEXUS did not write/)
    }
    expect(ran()).toEqual([])
  })

  // 0.9 (review, CRITICAL G-I-1). The configuration of the clone was checked and nothing else: the two ways
  // below left `.git/config` as git wrote it and had NEXUS's own `add -A` run a filter of the task's choosing.
  function candidateClone(name: string): string {
    const clone = join(base, 'worktrees', 'run1', name)
    raw(repo, 'clone', '-q', '--no-hardlinks', '--no-tags', '--no-checkout', repo, clone)
    raw(clone, 'remote', 'remove', 'origin')
    raw(clone, 'checkout', '-q', '-B', `nexus/run1/${name}`, 'main')
    return clone
  }
  const everyCommand = (clone: string): (() => Promise<unknown>)[] => [() => git.status(clone), () => git.addAll(clone), () => git.diffWorkingTree(clone, 'HEAD'), () => git.headCommit(clone), () => git.commitAll(clone, 'candidate work', AUTHOR), () => git.cloneGitDir(clone)]

  it("a candidate's clone whose .git/commondir names a directory with a configuration of the task's: refused, nothing runs", async () => {
    const clone = candidateClone('task-cand-b')
    const elsewhere = join(clone, '.evil')
    cpSync(join(clone, '.git'), elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'config'), `${readFileSync(join(elsewhere, 'config'), 'utf8')}${hostileConfig()}`)
    writeFileSync(join(clone, '.git', 'commondir'), '../.evil\n')
    writeFileSync(join(clone, '.gitattributes'), '* filter=evil\n')
    writeFileSync(join(clone, 'e.txt'), 'e\n')
    // The clone's own configuration is still the plain one: the old check passed.
    expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).not.toContain('filter')
    for (const f of everyCommand(clone)) await expect(f()).rejects.toThrow(/is not the plain clone NEXUS made \(its \.git holds a commondir/)
    expect(ran()).toEqual([])
  })

  it("a candidate's clone whose .git was replaced by a pointer to a repository the task made, back-pointer included: refused when NEXUS has a record to ask, nothing runs", async () => {
    const clone = candidateClone('task-cand-c')
    const fabricated = join(base, 'fabricated')
    cpSync(join(clone, '.git'), fabricated, { recursive: true })
    writeFileSync(join(fabricated, 'config'), `${readFileSync(join(fabricated, 'config'), 'utf8')}${hostileConfig()}`)
    const entry = join(fabricated, 'worktrees', 'x')
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/nexus/run1/task-cand-c\n')
    writeFileSync(join(entry, 'commondir'), '../..\n')
    writeFileSync(join(entry, 'gitdir'), `${slash(join(clone, '.git'))}\n`)
    rmSync(join(clone, '.git'), { recursive: true, force: true })
    writeFileSync(join(clone, '.git'), `gitdir: ${slash(entry)}\n`)
    writeFileSync(join(clone, '.gitattributes'), '* filter=evil\n')
    writeFileSync(join(clone, 'f.txt'), 'f\n')
    // As the runtime is: a record of NEXUS's worktrees, which does not know this directory.
    const recorded = new GitService()
    recorded.setWorktreesRoot(join(base, 'worktrees'))
    recorded.setWorktreeResolver(() => null)
    for (const f of [() => recorded.status(clone), () => recorded.addAll(clone), () => recorded.headCommit(clone), () => recorded.cloneGitDir(clone)]) await expect(f()).rejects.toThrow(/is not the plain clone NEXUS made \(its \.git is a pointer/)
    expect(ran()).toEqual([])
  })

  it("a candidate's clone with a per-worktree configuration, or with other object stores named: refused", async () => {
    const withConfig = candidateClone('task-cand-d')
    writeFileSync(join(withConfig, '.git', 'config.worktree'), hostileConfig())
    await expect(git.addAll(withConfig)).rejects.toThrow(/holds a config\.worktree/)
    const withAlternates = candidateClone('task-cand-e')
    mkdirSync(join(withAlternates, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(withAlternates, '.git', 'objects', 'info', 'alternates'), `${slash(join(repo, '.git', 'objects'))}\n`)
    await expect(git.status(withAlternates)).rejects.toThrow(/names other object stores/)
    expect(ran()).toEqual([])
  })

  it("the honest clone is named to git by NEXUS: its commits are made, and fetched from its Git directory", async () => {
    const clone = candidateClone('task-cand-f')
    writeFileSync(join(clone, 'g.txt'), 'g\n')
    await git.addAll(clone)
    const commit = await git.commitAll(clone, 'candidate work', AUTHOR)
    expect(commit).not.toBeNull()
    expect(raw(clone, 'log', '-1', '--format=%s')).toBe('candidate work')
    expect(slash(await git.cloneGitDir(clone))).toBe(slash(join(clone, '.git')))
    await git.run(repo, ['-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--quiet', await git.cloneGitDir(clone), 'nexus/run1/task-cand-f'])
    expect(raw(repo, 'rev-parse', 'FETCH_HEAD')).toBe(commit)
    await expect(git.cloneGitDir(join(base, 'elsewhere'))).rejects.toThrow(/is not a candidate's clone/)
  })

  it('stock git, for the record, runs the planted program when the pointer is followed', () => {
    const evilGit = plantRepository()
    replacePointer(`gitdir: ${slash(evilGit)}\n`)
    writeFileSync(join(worktree, 'b.txt'), 'b\n')
    try {
      raw(worktree, 'add', '-A')
      raw(worktree, 'status')
    } catch {
      // The outcome of the command does not matter; whether the planted program ran does.
    }
    console.log(`stock: a replaced .git pointer ran: ${ran().join(',') || 'nothing'}`)
    expect(ran().length).toBeGreaterThan(0)
  })
})
