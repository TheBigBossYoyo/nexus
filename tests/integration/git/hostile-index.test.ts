import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GitService, type CommitEvidence } from '@main/modules/git/git-service'

// The index of a worktree, and everything else in it, is written by the code NEXUS runs there. This corpus
// plays that code: it forges the worktree's index and plants a nested repository, then lets NEXUS do what it
// does in a worktree (status, fingerprint, diff, commit, merge, reset, removal) and looks at two things only:
// whether anything the hostile side prepared was run, and whether NEXUS's commit holds exactly the files as
// they are. Everything is harmless: the "payload" of each case writes a marker file inside the scratch folder.
//
// Each case also records what stock git does with the same state (`stock:` lines in the output), because the
// reason for NEXUS's design is what git does, measured, and not what it is believed to do.

const SCRATCH = resolve('test-results', 'hostile-index-tests')
const AUTHOR = { name: 'NEXUS Agent', email: 'nexus-agent@localhost' }
const raw = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryRaw = (cwd: string, ...args: string[]): string => {
  try {
    return raw(cwd, ...args)
  } catch (e) {
    return `ERROR: ${String((e as { stderr?: string }).stderr ?? e).trim().split('\n')[0]}`
  }
}

let n = 0
let repo = ''
let worktree = ''
let git: GitService
let evidence: CommitEvidence[] = []
const marker = (name: string): string => join(SCRATCH, `case-${n}`, `RAN-${name}`)
const markers = (): string[] => ['filter', 'smudge', 'fsmonitor', 'hook', 'textconv'].filter((m) => existsSync(marker(m)))

/** A repository with one commit, a worktree of it made by NEXUS (so NEXUS knows its Git directory), on its own branch. */
async function fresh(): Promise<void> {
  n += 1
  const base = join(SCRATCH, `case-${n}`)
  repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  raw(repo, 'init', '-q', '-b', 'main', '.')
  raw(repo, 'config', 'user.name', 'User')
  raw(repo, 'config', 'user.email', 'user@example.com')
  raw(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'keep.txt'), 'keep\n')
  raw(repo, 'add', '-A')
  raw(repo, 'commit', '-q', '-m', 'initial')
  git = new GitService()
  git.setWorktreesRoot(join(base, 'worktrees'))
  git.setTrustedIndexDir(join(base, 'nexus-index'))
  evidence = []
  git.onCommitEvidence((e) => void evidence.push(e))
  worktree = join(base, 'worktrees', 'run1', 'task')
  await git.createWorktree(repo, worktree, 'nexus/run1/task', 'main')
}

/** A repository inside the worktree whose own configuration runs a marker for every way git has of running something. */
function plantNestedRepository(dir = 'sub'): string {
  const sub = join(worktree, dir)
  mkdirSync(join(sub, 'hooks'), { recursive: true })
  raw(sub, 'init', '-q', '-b', 'main', '.')
  raw(sub, 'config', 'user.name', 'x')
  raw(sub, 'config', 'user.email', 'x@x')
  writeFileSync(join(sub, 's.txt'), 's\n')
  writeFileSync(join(sub, '.gitattributes'), '* filter=evil diff=evil\n')
  raw(sub, 'add', '-A')
  raw(sub, 'commit', '-q', '-m', 'sub')
  const sh = (name: string): string => `sh -c 'echo ran > "${marker(name).replace(/\\/g, '/')}"; cat'`
  raw(sub, 'config', 'filter.evil.clean', sh('filter'))
  raw(sub, 'config', 'filter.evil.smudge', sh('smudge'))
  raw(sub, 'config', 'diff.evil.textconv', sh('textconv'))
  raw(sub, 'config', 'core.fsmonitor', sh('fsmonitor'))
  raw(sub, 'config', 'core.hooksPath', join(sub, 'hooks').replace(/\\/g, '/'))
  for (const hook of ['pre-commit', 'post-checkout', 'post-merge', 'post-index-change', 'reference-transaction']) writeFileSync(join(sub, 'hooks', hook), `#!/bin/sh\necho ran > "${marker('hook').replace(/\\/g, '/')}"\n`)
  writeFileSync(join(sub, 's.txt'), 's changed\n')
  return raw(sub, 'rev-parse', 'HEAD')
}

/** Everything NEXUS does in a worktree, once. Returns the commit it made (or null). */
async function everythingNexusDoes(): Promise<string | null> {
  await git.status(worktree)
  await git.workingState(worktree)
  await git.diffWorkingTree(worktree, 'main')
  const commit = await git.commitAll(worktree, 'task: work', AUTHOR)
  await git.status(worktree)
  await git.isMergeInProgress(worktree)
  await git.merge(worktree, 'main', { message: 'merge main', author: AUTHOR }).catch(() => undefined)
  await git.resetClean(worktree)
  return commit
}

const committedFiles = (commit: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of raw(repo, 'ls-tree', '-r', '--full-tree', commit).split('\n').filter((l) => l !== '')) {
    const [meta, path] = line.split('\t') as [string, string]
    const [mode, , sha] = meta.split(' ') as [string, string, string]
    out[path] = mode === '160000' ? `gitlink:${sha}` : raw(repo, 'cat-file', '-p', sha)
  }
  return out
}

/** A version-2 index file with the given entries, written byte by byte: the paths are not checked by anything. */
function forgedIndex(entries: { path: string; sha: string; mode?: number; flags?: number }[]): Buffer {
  const parts: Buffer[] = []
  const header = Buffer.alloc(12)
  header.write('DIRC', 0, 'ascii')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(entries.length, 8)
  parts.push(header)
  for (const e of [...entries].sort((x, y) => (x.path < y.path ? -1 : 1))) {
    const fixed = Buffer.alloc(62)
    fixed.writeUInt32BE(e.mode ?? 0o100644, 24)
    Buffer.from(e.sha, 'hex').copy(fixed, 40)
    const name = Buffer.from(e.path, 'utf8')
    fixed.writeUInt16BE((e.flags ?? 0) | Math.min(name.length, 0xfff), 60)
    const size = 62 + name.length
    parts.push(fixed, name, Buffer.alloc(8 - (size % 8)))
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}
const indexFile = (): string => join(repo, '.git', 'worktrees', 'task', 'index')

describe('hostile index and worktree state against the git commands NEXUS runs itself', () => {
  beforeEach(fresh)
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  it('a nested repository named in the index: nothing of it runs, and it is not committed', async () => {
    const subHead = plantNestedRepository()
    raw(worktree, 'update-index', '--add', '--cacheinfo', `160000,${subHead},sub`)
    writeFileSync(join(worktree, 'a.txt'), 'a\nwork of the task\n')

    // What stock git does with this state, for the record: a status as git ships starts a git inside `sub`.
    const copy = join(SCRATCH, `case-${n}`, 'stock-index')
    writeFileSync(copy, readFileSync(indexFile()))
    execFileSync('git', ['status', '--porcelain'], { cwd: worktree, env: { ...process.env, GIT_INDEX_FILE: copy }, windowsHide: true, stdio: 'ignore' })
    const stockRan = markers()
    console.info(`stock: git status with a gitlink to a nested repository ran: ${stockRan.join(', ') || 'nothing'}`)
    for (const m of stockRan) rmSync(marker(m))

    const commit = await everythingNexusDoes()
    expect(markers(), 'nothing the nested repository configured was run').toEqual([])
    expect(commit).not.toBeNull()
    const files = committedFiles(commit as string)
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'keep.txt'])
    expect(files['a.txt']).toBe('a\nwork of the task')
    expect(evidence[0]?.skippedNestedRepositories).toEqual(['sub'])
    // Removing the worktree does not look into it either.
    await git.removeWorktree(repo, worktree, { force: true })
    expect(markers()).toEqual([])
    // The measurement that made this design necessary still holds for the git on this machine, or git changed.
    if (stockRan.length === 0) console.info('stock: this git did not run the nested filter; the design does not depend on that')
  }, 120_000)

  it('a nested repository that is only lying in the worktree (nothing forged): same', async () => {
    plantNestedRepository('vendor/lib')
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    const commit = await everythingNexusDoes()
    expect(markers()).toEqual([])
    expect(Object.keys(committedFiles(commit as string)).sort()).toEqual(['a.txt', 'keep.txt', 'new.txt'])
    expect(evidence[0]?.skippedNestedRepositories).toEqual(['vendor/lib'])
  }, 120_000)

  it('a nested repository already in the branch, with a .gitmodules that says "ignore = none" (audit finding A1)', async () => {
    // The task commits the link itself, with its own git, and says in .gitmodules that the nested repository is
    // to be looked into. Configuration given to git does not outrank that; the command line does.
    const subHead = plantNestedRepository('nested')
    raw(worktree, 'update-index', '--add', '--cacheinfo', `160000,${subHead},nested`)
    writeFileSync(join(worktree, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tignore = none\n')
    raw(worktree, 'add', '.gitmodules')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'the task commits a link'], { cwd: worktree, windowsHide: true, stdio: 'ignore' })
    for (const m of markers()) rmSync(marker(m))
    execFileSync('git', ['-c', 'diff.ignoreSubmodules=all', 'status', '--porcelain'], { cwd: worktree, windowsHide: true, stdio: 'ignore' })
    console.info(`stock: status with diff.ignoreSubmodules=all as configuration and "ignore = none" in .gitmodules ran: ${markers().join(', ') || 'nothing'}`)
    for (const m of markers()) rmSync(marker(m))
    writeFileSync(join(worktree, 'a.txt'), 'a\nmore work\n')
    const commit = await everythingNexusDoes()
    expect(markers(), 'nothing the nested repository configured was run').toEqual([])
    expect(commit).not.toBeNull()
    await git.removeWorktree(repo, worktree, { force: true })
    expect(markers()).toEqual([])
  }, 120_000)

  it('a configuration file in the worktree entry, in a repository that reads such files (audit finding A2)', async () => {
    // `extensions.worktreeConfig` is the user's own setting (git's sparse-checkout switches it on). With it, git
    // reads `config.worktree` from the worktree's entry, which the task can write unless it was made unwritable.
    raw(repo, 'config', 'extensions.worktreeConfig', 'true')
    const entry = join(repo, '.git', 'worktrees', 'task')
    const sh = `sh -c 'echo ran > "${marker('filter').replace(/\\/g, '/')}"; cat'`
    writeFileSync(join(entry, 'config.worktree'), `[filter "evil"]\n\tclean = ${sh}\n\tsmudge = ${sh}\n[core]\n\tfsmonitor = ${sh}\n\thooksPath = ${join(entry, 'hooks').replace(/\\/g, '/')}\n[merge "evil"]\n\tdriver = ${sh}\n[diff]\n\texternal = ${sh}\n`)
    mkdirSync(join(entry, 'hooks'), { recursive: true })
    for (const hook of ['pre-commit', 'post-checkout', 'post-merge', 'reference-transaction', 'post-index-change']) writeFileSync(join(entry, 'hooks', hook), `#!/bin/sh\necho ran > "${marker('hook').replace(/\\/g, '/')}"\n`)
    writeFileSync(join(worktree, '.gitattributes'), '* filter=evil merge=evil\n')
    writeFileSync(join(worktree, 'a.txt'), 'a\nchanged\n')
    execFileSync('git', ['status', '--porcelain'], { cwd: worktree, windowsHide: true, stdio: 'ignore' })
    console.info(`stock: status with a planted config.worktree ran: ${markers().join(', ') || 'nothing'}`)
    for (const m of markers()) rmSync(marker(m))
    await expect(everythingNexusDoes()).rejects.toThrow(/configuration of its own|config\.worktree/)
    expect(markers(), 'nothing the planted configuration names was run').toEqual([])
  }, 120_000)

  it('a link in the worktree to a directory elsewhere: removing the worktree removes the link, not what it leads to (audit finding A5)', async () => {
    const victim = join(SCRATCH, `case-${n}`, 'victim')
    mkdirSync(join(victim, 'deep'), { recursive: true })
    writeFileSync(join(victim, 'keep.txt'), 'keep\n')
    writeFileSync(join(victim, 'deep', 'also.txt'), 'also\n')
    mkdirSync(join(worktree, 'src'), { recursive: true })
    symlinkSync(victim, join(worktree, 'src', 'jn'), 'junction')
    symlinkSync(victim, join(worktree, 'top-jn'), 'junction')
    await git.resetClean(worktree)
    expect(existsSync(join(victim, 'keep.txt')), 'after a reset and clean').toBe(true)
    symlinkSync(victim, join(worktree, 'again'), 'junction')
    await git.removeWorktree(repo, worktree, { force: true })
    expect(existsSync(worktree)).toBe(false)
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(existsSync(join(victim, 'deep', 'also.txt'))).toBe(true)
  }, 60_000)

  it('the index stages content that is not in the file: the commit holds the file', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worktree, input: 'STAGED AND NOT VISIBLE\n', encoding: 'utf8', windowsHide: true }).trim()
    raw(worktree, 'update-index', '--cacheinfo', `100644,${blob},a.txt`)
    raw(worktree, 'update-index', '--assume-unchanged', 'a.txt')
    console.info(`stock: add -A then diff --cached names: ${tryRaw(worktree, 'diff', '--cached', '--name-only') || 'nothing'}; staged a.txt is: ${tryRaw(worktree, 'show', ':a.txt')}`)
    writeFileSync(join(worktree, 'visible.txt'), 'the only change\n')
    const commit = await git.commitAll(worktree, 'task: work', AUTHOR)
    const files = committedFiles(commit as string)
    expect(files['a.txt']).toBe('a')
    expect(files['visible.txt']).toBe('the only change')
    expect(JSON.stringify(files)).not.toContain('STAGED AND NOT VISIBLE')
    expect(evidence[0]?.committedFiles).toEqual(['A\tvisible.txt'])
    expect(evidence[0]?.expectedFiles).toEqual(evidence[0]?.committedFiles)
    expect(evidence[0]?.expectedTree).toBe(evidence[0]?.committedTree)
  }, 60_000)

  it('index flags hide a changed file: NEXUS sees it and commits it', async () => {
    raw(worktree, 'update-index', '--skip-worktree', 'a.txt')
    raw(worktree, 'update-index', '--assume-unchanged', 'keep.txt')
    writeFileSync(join(worktree, 'a.txt'), 'a\nHIDDEN 1\n')
    writeFileSync(join(worktree, 'keep.txt'), 'keep\nHIDDEN 2\n')
    console.info(`stock: status with skip-worktree and assume-unchanged shows ${tryRaw(worktree, 'status', '--porcelain').split('\n').filter((l) => l !== '').length} changes of 2`)
    const status = await git.status(worktree)
    expect(status.clean).toBe(false)
    const diff = await git.diffWorkingTree(worktree, 'main')
    expect(diff.files.map((f) => f.path).sort()).toEqual(['a.txt', 'keep.txt'])
    const files = committedFiles((await git.commitAll(worktree, 'task: work', AUTHOR)) as string)
    expect(files['a.txt']).toContain('HIDDEN 1')
    expect(files['keep.txt']).toContain('HIDDEN 2')
  }, 60_000)

  it('the index stages the deletion of a file that is there, and a file that is not: the commit follows the files', async () => {
    raw(worktree, 'rm', '-q', '--cached', 'keep.txt')
    const ghost = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worktree, input: 'ghost\n', encoding: 'utf8', windowsHide: true }).trim()
    raw(worktree, 'update-index', '--add', '--cacheinfo', `100755,${ghost},bin/ghost.sh`)
    raw(worktree, 'update-index', '--add', '--cacheinfo', `120000,${ghost},link-to-somewhere`)
    writeFileSync(join(worktree, 'intent.txt'), 'x\n')
    raw(worktree, 'add', '-N', 'intent.txt')
    const files = committedFiles((await git.commitAll(worktree, 'task: work', AUTHOR)) as string)
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'intent.txt', 'keep.txt'])
  }, 60_000)

  it('index entries that name objects that do not exist, or the wrong kind of object', async () => {
    raw(worktree, 'update-index', '--add', '--cacheinfo', `100644,${'ab'.repeat(20)},phantom.txt`)
    raw(worktree, 'update-index', '--cacheinfo', `100644,${raw(worktree, 'rev-parse', 'HEAD^{tree}')},a.txt`)
    console.info(`stock: write-tree with an entry for a missing object: ${tryRaw(worktree, 'write-tree').slice(0, 80)}`)
    writeFileSync(join(worktree, 'real.txt'), 'real\n')
    const files = committedFiles((await everythingNexusDoes()) as string)
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'keep.txt', 'real.txt'])
  }, 120_000)

  it('index extensions that make git believe a file it did not look at: split index, untracked cache, fsmonitor bits, sparse', async () => {
    raw(worktree, 'update-index', '--split-index')
    tryRaw(worktree, 'update-index', '--untracked-cache')
    tryRaw(worktree, 'update-index', '--fsmonitor-valid', 'a.txt')
    writeFileSync(join(worktree, 'a.txt'), 'a\nchanged after the bits were set\n')
    mkdirSync(join(worktree, 'deep', 'er'), { recursive: true })
    writeFileSync(join(worktree, 'deep', 'er', 'untracked.txt'), 'u\n')
    const status = await git.status(worktree)
    expect(status.clean).toBe(false)
    const files = committedFiles((await everythingNexusDoes()) as string)
    expect(files['a.txt']).toContain('changed after the bits were set')
    expect(files['deep/er/untracked.txt']).toBe('u')
    expect(files['keep.txt']).toBe('keep')
  }, 120_000)

  it('a sparse checkout set up from inside the worktree: it writes a configuration into the entry, and NEXUS stops', async () => {
    // Stock git removes the files from disk when it is told this, and writes `config.worktree` to remember it.
    // In the product that file is empty and unwritable for project code from the moment the worktree exists;
    // where it was written all the same, NEXUS does not read past it.
    tryRaw(worktree, 'sparse-checkout', 'set', '--no-cone', '/nothing-at-all')
    console.info(`stock: after a sparse checkout of nothing, on disk: ${['a.txt', 'keep.txt'].filter((f) => existsSync(join(worktree, f))).join(', ') || 'no file'}`)
    writeFileSync(join(worktree, 'a.txt'), 'a\nput back by the task\n')
    await expect(git.commitAll(worktree, 'task: work', AUTHOR)).rejects.toThrow(/configuration of its own/)
    await expect(git.status(worktree)).rejects.toThrow(/configuration of its own/)
  }, 60_000)

  it('an index that is garbage, cut short, or has a wrong checksum', async () => {
    for (const [name, bytes] of [
      ['garbage', Buffer.from('this is not an index at all')],
      ['truncated', readFileSync(indexFile()).subarray(0, 40)],
      ['bad checksum', Buffer.concat([readFileSync(indexFile()).subarray(0, -20), Buffer.alloc(20, 7)])],
      ['empty', Buffer.alloc(0)],
      ['huge count', Buffer.concat([Buffer.from('DIRC'), Buffer.from([0, 0, 0, 2, 0xff, 0xff, 0xff, 0xff])])],
    ] as const) {
      writeFileSync(indexFile(), bytes)
      console.info(`stock: status with an index that is ${name}: ${tryRaw(worktree, 'status', '--porcelain').slice(0, 70) || 'no output'}`)
      writeFileSync(join(worktree, `${name.replace(' ', '-')}.txt`), `${name}\n`)
      const commit = await git.commitAll(worktree, `task: ${name}`, AUTHOR)
      expect(commit, name).not.toBeNull()
      expect((await git.status(worktree)).clean, name).toBe(true)
    }
    expect(Object.keys(committedFiles(raw(repo, 'rev-parse', 'nexus/run1/task'))).sort()).toEqual(['a.txt', 'bad-checksum.txt', 'empty.txt', 'garbage.txt', 'huge-count.txt', 'keep.txt', 'truncated.txt'])
  }, 180_000)

  it('index entries whose paths leave the worktree or enter its Git directory (written byte by byte)', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worktree, input: 'payload\n', encoding: 'utf8', windowsHide: true }).trim()
    const escaped = join(SCRATCH, `case-${n}`, 'worktrees', 'run1', 'escaped.txt')
    const aSha = raw(worktree, 'rev-parse', 'HEAD:a.txt')
    // An absolute path, kept inside the scratch folder: stock git writes where such an entry says (it did, to C:/Windows/Temp, when this corpus was first run).
    const absoluteTarget = join(SCRATCH, `case-${n}`, 'absolute-target.txt')
    const absolute = absoluteTarget.split('\\').join('/')
    const pointer = readFileSync(join(worktree, '.git'), 'utf8')
    for (const path of ['../escaped.txt', '.git/hooks/pre-commit', '.GIT/config', 'git~1/config', 'a/../../x', absolute, 'x.txt:stream', 'dir/', '/abs.txt', 'con', 'trailing. ']) {
      writeFileSync(indexFile(), forgedIndex([{ path, sha: blob }, { path: 'a.txt', sha: aSha }]))
      const stock = [tryRaw(worktree, 'status', '--porcelain'), tryRaw(worktree, 'checkout-index', '-a', '-f')].map((s) => s.split('\n')[0]?.slice(0, 60)).join(' | ')
      // Stock git, given that index, may have written where the entry says. Recorded, then undone: what is
      // asserted below is what NEXUS's commands do with the same index.
      const pointerGone = !existsSync(join(worktree, '.git')) || !statSync(join(worktree, '.git')).isFile()
      console.info(`stock: index entry ${JSON.stringify(path)}: ${stock}${existsSync(escaped) ? ' | WROTE OUTSIDE THE WORKTREE' : ''}${pointerGone ? " | REPLACED THE WORKTREE'S .git" : ''}`)
      if (existsSync(absoluteTarget)) console.info('stock: an absolute path in the index was written to')
      rmSync(absoluteTarget, { force: true })
      rmSync(escaped, { force: true })
      rmSync(join(repo, '.git', 'worktrees', 'task', 'hooks'), { recursive: true, force: true })
      if (pointerGone) {
        rmSync(join(worktree, '.git'), { recursive: true, force: true })
        writeFileSync(join(worktree, '.git'), pointer)
      }
      writeFileSync(indexFile(), forgedIndex([{ path, sha: blob }, { path: 'a.txt', sha: aSha }]))
      await git.status(worktree)
      await git.resetClean(worktree)
      await git.merge(worktree, 'main', { message: 'm', author: AUTHOR }).catch(() => undefined)
      expect(existsSync(escaped), path).toBe(false)
      expect(existsSync(absoluteTarget), path).toBe(false)
      expect(existsSync(join(repo, '.git', 'worktrees', 'task', 'hooks')), path).toBe(false)
    }
    // After all of it the worktree is the branch's commit and nothing else, and NEXUS can still commit there.
    writeFileSync(join(worktree, 'after.txt'), 'after\n')
    const files = committedFiles((await git.commitAll(worktree, 'task: after', AUTHOR)) as string)
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'after.txt', 'keep.txt'])
  }, 240_000)

  it('a commit that is not what NEXUS staged is undone, and NEXUS says so', async () => {
    // The only way to make the commit differ here is to stand in for git between the two steps: a commit made
    // behind NEXUS's back on the same branch, between its staging and its own commit, moves the parent.
    writeFileSync(join(worktree, 'mine.txt'), 'mine\n')
    const original = git.run.bind(git)
    let raced = false
    git.run = async (cwd, args, opts) => {
      if (!raced && args.includes('commit-tree')) {
        raced = true
        // Another writer advances the branch with a file of its own just before NEXUS commits.
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'smuggled\n', encoding: 'utf8', windowsHide: true }).trim()
        const baseTree = raw(repo, 'rev-parse', 'nexus/run1/task^{tree}')
        const tree = execFileSync('git', ['mktree'], { cwd: repo, input: `${raw(repo, 'ls-tree', baseTree)}\n100644 blob ${blob}\tsmuggled.txt\n`, encoding: 'utf8', windowsHide: true }).trim()
        const commit = execFileSync('git', ['commit-tree', tree, '-p', raw(repo, 'rev-parse', 'nexus/run1/task'), '-m', 'smuggled'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } }).trim()
        raw(repo, 'update-ref', 'refs/heads/nexus/run1/task', commit)
      }
      return original(cwd, args, opts)
    }
    await expect(git.commitAll(worktree, 'task: work', AUTHOR)).rejects.toThrow(/moved while NEXUS was committing/)
    expect(evidence).toEqual([])
    // The other writer's commit is where the branch is; NEXUS added nothing on top of something it did not see.
    expect(raw(repo, 'log', '--format=%s', '-1', 'nexus/run1/task')).toBe('smuggled')
  }, 60_000)
})
