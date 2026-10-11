import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '@main/modules/git/git-service'
import { gitOnlyScript, grantedPushScript } from '@main/modules/isolation/execution-broker'
import { grantedPushOf, renderGrantedPush, renderUserGitScript, userGitOf, userGitOfPowerShell } from '@main/modules/policies/git-pipeline'

// 0.8, after the second independent audit of the git path. A command of an agent that is git and nothing else
// runs as the user (at low integrity) even in an ISOLATED session. What it works on, the worktree, is written by
// code that runs as the sandbox account. This corpus plays that code: it prepares the worktree and its index the
// way the audit did, then runs the script NEXUS writes for an agent's command, with the environment NEXUS gives
// it, under real bash and real git, and looks at what was run, read and written. The `stock:` lines record what
// git does with the same state without NEXUS's script, because that is the reason for each measure.
//
// The integrity level is not part of this test (the script runs as the test does): what is shown is that the
// script and its environment alone keep git from the hostile state. Everything stays inside the scratch folder.

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const d = process.platform === 'win32' && existsSync(BASH) ? describe : describe.skip
const SCRATCH = resolve('test-results', 'user-git-tests')
const raw = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const slash = (path: string): string => path.replace(/\\/g, '/')

let n = 0
let base = ''
let repo = ''
let worktree = ''
let entry = ''
const marker = (name: string): string => join(base, `RAN-${name}`)
const markers = (): string[] => ['filter', 'smudge', 'fsmonitor', 'hook', 'textconv'].filter((m) => existsSync(marker(m)))
const payload = (name: string): string => `sh -c 'echo ran > "${slash(marker(name))}"; cat'`

function fresh(): void {
  n += 1
  base = join(SCRATCH, `case-${n}`)
  repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  raw(repo, 'init', '-q', '-b', 'main', '.')
  raw(repo, 'config', 'user.name', 'User')
  raw(repo, 'config', 'user.email', 'user@example.com')
  raw(repo, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'src', 'b.txt'), 'b\n')
  raw(repo, 'add', '-A')
  raw(repo, 'commit', '-q', '-m', 'initial')
  worktree = join(base, 'worktrees', 'task')
  raw(repo, 'worktree', 'add', '-q', '-b', 'nexus/run1/task', worktree, 'main')
  entry = join(repo, '.git', 'worktrees', 'task')
}

/** The environment NEXUS gives a git-only command (ExecutionBroker.gitHardening and gitPins), with an index of its own as in an ISOLATED session. */
function pinnedEnv(ownIndex = true): NodeJS.ProcessEnv {
  const hooks = join(base, 'no-hooks')
  mkdirSync(hooks, { recursive: true })
  const empty = join(base, 'gitconfig-empty')
  writeFileSync(empty, '')
  const config: [string, string][] = [
    ['core.hooksPath', hooks],
    ['core.fsmonitor', 'false'],
    ['core.pager', 'cat'],
    ['protocol.ext.allow', 'never'],
    ['core.sshCommand', 'false'],
    ['credential.helper', ''],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['diff.ignoreSubmodules', 'all'],
    ['submodule.recurse', 'false'],
    ['status.submoduleSummary', 'false'],
  ]
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: String(config.length), GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: '1', GIT_DIR: entry, GIT_COMMON_DIR: join(repo, '.git'), GIT_WORK_TREE: worktree }
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  if (ownIndex) env['GIT_INDEX_FILE'] = join(base, 'git-index')
  return env
}

/** Runs what NEXUS would run for the agent's `command`: the written script, whole, under bash. Fails the test when the command does not qualify. */
function asUser(command: string, options: { powershell?: boolean; ownIndex?: boolean; cwd?: string } = {}): { code: number | null; out: string } {
  const parsed = options.powershell === true ? userGitOfPowerShell(command) : userGitOf(command)
  if (parsed === null) throw new Error(`does not qualify: ${command}`)
  const script = join(base, `nx-${createHash('sha1').update(`${command}${Math.random()}`).digest('hex').slice(0, 10)}.sh`)
  writeFileSync(script, gitOnlyScript(renderUserGitScript(parsed), 'nexus/run1/task'))
  const r = spawnSync(BASH, ['--noprofile', '--norc', script], { cwd: options.cwd ?? worktree, env: pinnedEnv(options.ownIndex !== false), encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

/** The same without blocking this process, for a case in which this process is also the server the command might call. */
function asUserAsync(command: string): Promise<string> {
  const parsed = userGitOf(command)
  if (parsed === null) throw new Error(`does not qualify: ${command}`)
  const script = join(base, `nx-${createHash('sha1').update(`${command}${Math.random()}`).digest('hex').slice(0, 10)}.sh`)
  writeFileSync(script, gitOnlyScript(renderUserGitScript(parsed), 'nexus/run1/task'))
  return new Promise((done) => execFile(BASH, ['--noprofile', '--norc', script], { cwd: worktree, env: pinnedEnv(true), encoding: 'utf8', windowsHide: true, timeout: 120_000 }, (_error, stdout, stderr) => done(`${stdout}${stderr}`)))
}

/** A repository inside the worktree whose own configuration runs a marker for every way git has of running something. */
function plantNestedRepository(dir = 'sub'): void {
  const sub = join(worktree, dir)
  mkdirSync(join(sub, 'hooks'), { recursive: true })
  raw(sub, 'init', '-q', '-b', 'main', '.')
  raw(sub, 'config', 'user.name', 'x')
  raw(sub, 'config', 'user.email', 'x@x')
  writeFileSync(join(sub, 's.txt'), 's\n')
  writeFileSync(join(sub, '.gitattributes'), '* filter=evil diff=evil\n')
  raw(sub, 'add', '-A')
  raw(sub, 'commit', '-q', '-m', 'sub')
  raw(sub, 'config', 'filter.evil.clean', payload('filter'))
  raw(sub, 'config', 'filter.evil.smudge', payload('smudge'))
  raw(sub, 'config', 'diff.evil.textconv', payload('textconv'))
  raw(sub, 'config', 'core.fsmonitor', payload('fsmonitor'))
  raw(sub, 'config', 'core.hooksPath', slash(join(sub, 'hooks')))
  for (const hook of ['pre-commit', 'post-checkout', 'post-merge', 'post-index-change', 'reference-transaction']) writeFileSync(join(sub, 'hooks', hook), `#!/bin/sh\necho ran > "${slash(marker('hook'))}"\n`)
}
/** The nested repository's file changes without changing size: only looking inside it would notice. */
const touchNested = (dir = 'sub'): void => writeFileSync(join(worktree, dir, 's.txt'), `${Math.random() < 2 ? 't' : 's'}\n`)

/** A version-2 index file with the given entries, written byte by byte: the paths are not checked by anything. */
function forgedIndex(entries: { path: string; sha: string; mode?: number }[]): Buffer {
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
    fixed.writeUInt16BE(Math.min(name.length, 0xfff), 60)
    const size = 62 + name.length
    parts.push(fixed, name, Buffer.alloc(8 - (size % 8)))
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}

d('the script NEXUS writes for git as the user, against a worktree prepared by hostile code', () => {
  beforeEach(fresh)
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  it('runs the everyday commands: stage, commit on the task branch, look, from bash and from PowerShell text, from a subdirectory too', () => {
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    writeFileSync(join(worktree, 'a.txt'), 'a changed\n')
    const first = asUser('git add -A && git commit -q -m "agent: work" 2>&1 && git status --short && git log --oneline -1')
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain('agent: work')
    expect(raw(repo, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('agent: work')
    expect(raw(repo, 'ls-tree', '-r', '--name-only', 'nexus/run1/task').split('\n').sort()).toEqual(['a.txt', 'new.txt', 'src/b.txt'])
    // The worktree's own index is a copy of the one the command used: a git of the task sees a clean tree.
    expect(raw(worktree, 'status', '--porcelain')).toBe('')
    // From a subdirectory `-A` still means the whole tree.
    writeFileSync(join(worktree, 'top.txt'), 'top\n')
    writeFileSync(join(worktree, 'src', 'c.txt'), 'c\n')
    const second = asUser("git add -A; git commit -q -m 'from a subdirectory'; git status --short", { powershell: true, cwd: join(worktree, 'src') })
    expect(second.code, second.out).toBe(0)
    expect(raw(repo, 'ls-tree', '-r', '--name-only', 'nexus/run1/task').split('\n')).toEqual(expect.arrayContaining(['top.txt', 'src/c.txt']))
    // The exit code of the command is the script's.
    expect(asUser('git rev-parse --verify -q no-such-branch').code).not.toBe(0)
    expect(asUser('git rev-parse --verify -q no-such-branch || git status --short').code).toBe(0)
  }, 120_000)

  it('second audit, finding 3: an index forged in the worktree is not the index the command reads', () => {
    const secret = join(base, 'secret.txt')
    writeFileSync(secret, 'SECRETDATA\n')
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'PLANTED\n', encoding: 'utf8', windowsHide: true }).trim()
    const a = raw(repo, 'rev-parse', 'HEAD:a.txt')
    const forged = forgedIndex([
      { path: 'a.txt', sha: a },
      { path: '../escaped.txt', sha },
      { path: `${slash(base)}/absolute.txt`, sha },
      { path: '../secret.txt', sha },
    ])
    writeFileSync(join(entry, 'index'), forged)
    // What stock git does with that index, in a copy of the state (so that the measurement does not disturb the case).
    const stockEnv = { ...pinnedEnv(false) }
    const stock = spawnSync('git', ['diff', '--no-ext-diff'], { cwd: worktree, env: stockEnv, encoding: 'utf8', windowsHide: true })
    console.info(`stock: git diff with the forged index prints the outside file: ${`${stock.stdout}`.includes('SECRETDATA')}`)
    spawnSync('git', ['restore', '.'], { cwd: worktree, env: stockEnv, encoding: 'utf8', windowsHide: true })
    console.info(`stock: git restore . with the forged index writes ../escaped.txt: ${existsSync(join(base, 'worktrees', 'escaped.txt'))}; the absolute path: ${existsSync(join(base, 'absolute.txt'))}`)
    rmSync(join(base, 'worktrees', 'escaped.txt'), { force: true })
    rmSync(join(base, 'absolute.txt'), { force: true })
    writeFileSync(secret, 'SECRETDATA\n')
    writeFileSync(join(entry, 'index'), forged)

    const r = asUser('git status --short; git diff; git diff --cached; git restore .; git checkout -- .; git ls-files -s; git add -A; git rm -r -q --cached .; git reset -q --hard')
    expect(r.out).not.toContain('SECRETDATA')
    expect(r.out).not.toContain('escaped.txt')
    expect(r.out).not.toContain('absolute.txt')
    expect(existsSync(join(base, 'worktrees', 'escaped.txt')), 'nothing written beside the worktree').toBe(false)
    expect(existsSync(join(base, 'absolute.txt')), 'nothing written at the absolute path').toBe(false)
    expect(readFileSync(secret, 'utf8')).toBe('SECRETDATA\n')
    // And the forged index is gone from the worktree's entry: what is there now is the copy of the command's own.
    expect(raw(worktree, 'ls-files').split('\n').sort()).toEqual(['a.txt', 'src/b.txt'])
  }, 120_000)

  it('second audit, finding 6: a nested repository is never entered, by add, rm, stash, status, diff or commit', () => {
    plantNestedRepository()
    // The control: stock `git add -A` twice, in a copy of the index. The second one enters the nested repository.
    const controlEnv = { ...pinnedEnv(false), GIT_INDEX_FILE: join(base, 'control-index') }
    spawnSync('git', ['read-tree', 'HEAD'], { cwd: worktree, env: controlEnv, windowsHide: true })
    spawnSync('git', ['add', '-A'], { cwd: worktree, env: controlEnv, windowsHide: true })
    touchNested()
    writeFileSync(join(worktree, 'sub', 's.txt'), 'x\n')
    spawnSync('git', ['add', '-A'], { cwd: worktree, env: controlEnv, windowsHide: true })
    console.info(`stock: a second git add -A with the nested repository in the index ran: ${markers().join(', ') || 'nothing'}`)
    const stockRan = markers()
    for (const m of ['filter', 'smudge', 'fsmonitor', 'hook', 'textconv']) rmSync(marker(m), { force: true })
    writeFileSync(join(worktree, 'sub', 's.txt'), 's\n')

    // The same through NEXUS's script. The first add names the nested repository in the index; from then on it is left out.
    const first = asUser('git add -A && git status --short')
    expect(first.code, first.out).toBe(0)
    expect(raw(worktree, 'ls-files', '-s').split('\n').some((line) => line.startsWith('160000')), 'the nested repository is in the index now').toBe(true)
    writeFileSync(join(worktree, 'sub', 's.txt'), 'y\n')
    writeFileSync(join(worktree, 'other.txt'), 'other\n')
    const second = asUser('git add -A; git add .; git add -u; git add sub; git status; git diff; git diff --cached; git stash; git stash push -u; git commit -q -m "with the entry"')
    const third = asUser('git add -A; git log -p -1; git show --stat HEAD; git rm -r -q --cached .; git add -A; git status --short')
    expect(third.out).not.toContain('NEXUS:')
    expect(markers(), `nothing of the nested repository ran. Output: ${second.out.slice(-600)}`).toEqual([])
    expect(second.out).toContain('git stash is not run here')
    // The file beside it was staged and committed all the same.
    expect(raw(repo, 'ls-tree', '-r', '--name-only', 'nexus/run1/task').split('\n')).toContain('other.txt')
    // The control shows that the test can see a nested repository being entered at all.
    expect(stockRan.length, 'stock git enters the nested repository on the second add').toBeGreaterThan(0)
  }, 180_000)

  it('second audit, finding 4: no conversion or comparison program named by a .gitattributes of the worktree runs', () => {
    // A driver the repository's own configuration defines (as the machine's git configuration defines some), selected by the worktree.
    raw(repo, 'config', 'diff.evil.textconv', payload('textconv'))
    raw(repo, 'config', 'diff.evil.command', payload('filter'))
    writeFileSync(join(worktree, '.gitattributes'), '* diff=evil\n')
    writeFileSync(join(worktree, 'a.txt'), 'a changed\n')
    const stock = spawnSync('git', ['diff'], { cwd: worktree, env: pinnedEnv(false), encoding: 'utf8', windowsHide: true })
    void stock
    console.info(`stock: a plain git diff ran: ${markers().join(', ') || 'nothing'}`)
    const stockRan = markers()
    for (const m of ['filter', 'textconv']) rmSync(marker(m), { force: true })
    const r = asUser('git diff; git diff --stat; git add -A; git diff --cached; git commit -q -m "change"; git log -p -1; git show HEAD; git show --stat HEAD')
    expect(markers(), r.out.slice(-400)).toEqual([])
    expect(r.out).toContain('a changed')
    expect(stockRan.length, 'stock git runs the driver').toBeGreaterThan(0)
  }, 120_000)

  const lfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', windowsHide: true }).status === 0
  ;(lfs ? it : it.skip)('second audit, finding 4: Git LFS downloads nothing from an address the worktree names, for the command and for NEXUS itself', async () => {
    const hits: string[] = []
    const server: Server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const port = (server.address() as AddressInfo).port
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'ab'.repeat(32)}\nsize 12345\n`
      const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: pointer, encoding: 'utf8', windowsHide: true }).trim()
      writeFileSync(join(worktree, '.gitattributes'), 'f.bin filter=lfs\n')
      writeFileSync(join(worktree, '.lfsconfig'), `[lfs]\n\turl = http://127.0.0.1:${port}/x\n`)
      // The repository uses LFS, as `git lfs install` sets it up.
      raw(repo, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f')
      raw(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process')
      raw(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f')
      raw(repo, 'config', 'filter.lfs.required', 'true')
      const env = pinnedEnv(true)
      spawnSync('git', ['read-tree', 'HEAD'], { cwd: worktree, env, windowsHide: true })
      spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},f.bin`], { cwd: worktree, env, windowsHide: true })
      const out = await asUserAsync('git add .gitattributes .lfsconfig; git commit -q -m "lfs"; git restore f.bin; git checkout -- .; git reset -q --hard; git status --short')
      expect(hits, `as the user. Output: ${out.slice(-300)}`).toEqual([])
      expect(readFileSync(join(worktree, 'f.bin'), 'utf8'), 'the file stays a pointer').toContain('git-lfs.github.com')
      // NEXUS's own git in the same worktree: a reset and a fresh checkout of the branch.
      const git = new GitService()
      rmSync(join(worktree, 'f.bin'), { force: true })
      await git.run(worktree, ['reset', '--hard', '--quiet', 'HEAD'])
      await git.run(worktree, ['checkout', '--force', '--quiet', 'HEAD', '--', '.'])
      expect(hits, 'by NEXUS').toEqual([])
      // The control: without the switch the same reset asks the address the worktree named.
      rmSync(join(worktree, 'f.bin'), { force: true })
      const { GIT_LFS_SKIP_SMUDGE: _off, ...without } = pinnedEnv(false)
      await new Promise<void>((done) => execFile('git', ['-c', 'credential.helper=', 'reset', '--hard', '--quiet', 'HEAD'], { cwd: worktree, env: without, windowsHide: true, timeout: 60_000 }, () => done()))
      console.info(`stock: git reset --hard with the LFS filter asked the address in .lfsconfig ${hits.length} time(s)`)
      expect(hits.length, 'stock git asks the address').toBeGreaterThan(0)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  }, 180_000)

  it('third review: a junction where a tracked directory was stops every git of the script; nothing is written, deleted or read through it', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'precious.txt'), 'precious\n')
    // What stock git does with it, in a copy of the state: the tracked file is written into the junction's target.
    rmSync(join(worktree, 'src'), { recursive: true, force: true })
    symlinkSync(outside, join(worktree, 'src'), 'junction')
    spawnSync('git', ['reset', '-q', '--hard', 'HEAD'], { cwd: worktree, env: pinnedEnv(false), windowsHide: true })
    console.info(`stock: git reset --hard wrote src/b.txt through a junction into its target: ${existsSync(join(outside, 'b.txt'))}`)
    expect(existsSync(join(outside, 'b.txt')), 'stock git writes through the junction (the reason for the measure)').toBe(true)
    rmSync(join(outside, 'b.txt'), { force: true })
    writeFileSync(join(outside, 'extra.txt'), 'extra\n')

    for (const command of ['git reset -q --hard HEAD', 'git checkout -- .', 'git restore .', 'git rm -r -q -f .', 'git clean -fdq', 'git stash', 'git add -A', 'git status --short', 'git diff']) {
      const r = asUser(command)
      expect(r.code, `${command}: ${r.out}`).toBe(128)
      expect(r.out, command).toContain('src is a link to another place')
    }
    expect(readdirSync(outside).sort(), 'the target is as it was').toEqual(['extra.txt', 'precious.txt'])
    // Without the link everything works again.
    rmSync(join(worktree, 'src'), { recursive: false, force: true })
    expect(asUser('git reset -q --hard HEAD && git status --short').code).toBe(0)
    expect(readFileSync(join(worktree, 'src', 'b.txt'), 'utf8')).toBe('b\n')
  }, 120_000)

  it('third review: the worktree stays on its own branch; a forged HEAD or a configuration planted in the entry stops git', () => {
    raw(repo, 'branch', 'release', 'main')
    const release = raw(repo, 'rev-parse', 'release')
    // No command that changes the branch qualifies at all.
    for (const command of ['git checkout -B release', 'git checkout -b other', 'git checkout release', 'git switch release', 'git switch -c other', 'git checkout -q -B release && git commit -m x']) expect(userGitOf(command), command).toBeNull()
    // The entry's HEAD, rewritten as the task's code can: stock git would now commit on that branch.
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    const head = readFileSync(join(entry, 'HEAD'), 'utf8')
    writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/release\n')
    const r = asUser('git add -A && git commit -q -m "on the wrong branch"; git status --short; git log --oneline -1')
    expect(r.out).toContain('no longer on its own branch')
    expect(r.code).toBe(128)
    expect(raw(repo, 'rev-parse', 'release'), 'the other branch did not move').toBe(release)
    writeFileSync(join(entry, 'HEAD'), head)
    // A configuration of the worktree's own, planted in the entry.
    writeFileSync(join(entry, 'config.worktree'), '[core]\n\tfsmonitor = calc\n')
    const planted = asUser('git status --short')
    expect(planted.code).toBe(128)
    expect(planted.out).toContain('configuration of its own')
    rmSync(join(entry, 'config.worktree'))
    expect(asUser('git add -A && git commit -q -m "on its own branch" && git log --oneline -1').code).toBe(0)
    expect(raw(repo, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('on its own branch')
  }, 120_000)

  it('third review: "stash -m list" is a push with a message, and is stopped like any other while a nested repository is in the index', () => {
    plantNestedRepository()
    expect(asUser('git add -A').code).toBe(0)
    writeFileSync(join(worktree, 'sub', 's.txt'), 'y\n')
    for (const command of ['git stash -m list', 'git stash -m drop', 'git stash push -m list', 'git stash -u']) {
      const r = asUser(command)
      expect(r.out, command).toContain('git stash is not run here')
    }
    expect(markers(), 'nothing of the nested repository ran').toEqual([])
    expect(asUser('git stash list').out).not.toContain('NEXUS:')
  }, 120_000)

  it('a push the user allowed: it arrives, on the branch of the worktree, and no hook, forged HEAD or planted configuration has a say', () => {
    const remote = join(base, 'remote.git')
    raw(base, 'init', '-q', '--bare', '-b', 'main', remote)
    raw(repo, 'remote', 'add', 'origin', remote)
    raw(repo, 'branch', 'secret-work', 'main')
    // A hook of the repository that would run before a push, and one in the entry.
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho ran > "${slash(marker('hook'))}"\n`)
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    expect(asUser('git add -A && git commit -q -m "work to publish"').code).toBe(0)
    const hooksDir = join(base, 'granted-no-hooks')
    mkdirSync(hooksDir, { recursive: true })
    const push = (command: string): { code: number | null; out: string } => {
      const invocation = grantedPushOf(command)
      if (invocation === null) throw new Error(`does not qualify: ${command}`)
      const script = join(base, `push-${Math.random().toString(16).slice(2, 10)}.sh`)
      writeFileSync(script, grantedPushScript({ pushLine: renderGrantedPush(invocation, 'nexus/run1/task'), gitDir: entry, worktree, hooksDir }))
      // As the agent's shell would start it: with the user's environment, not the contained one.
      const r = spawnSync(BASH, ['--noprofile', '--norc', script], { cwd: worktree, env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, 'gitconfig-empty') }, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      return { code: r.status, out: `${r.stdout}${r.stderr}` }
    }
    // The entry's HEAD forged to another branch of the user's: `HEAD` on the line still means the worktree's own branch.
    const head = readFileSync(join(entry, 'HEAD'), 'utf8')
    writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/secret-work\n')
    const first = push('git push origin HEAD 2>&1')
    writeFileSync(join(entry, 'HEAD'), head)
    expect(first.code, first.out).toBe(0)
    expect(raw(remote, 'for-each-ref', '--format=%(refname)').split('\n')).toEqual(['refs/heads/nexus/run1/task'])
    expect(raw(remote, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('work to publish')
    expect(markers(), 'no hook ran').toEqual([])
    // A configuration planted in the entry: the push is not made.
    writeFileSync(join(entry, 'config.worktree'), '[core]\n\tsshCommand = calc\n')
    writeFileSync(join(worktree, 'more.txt'), 'more\n')
    rmSync(join(entry, 'config.worktree'))
    expect(asUser('git add -A && git commit -q -m "more"').code).toBe(0)
    writeFileSync(join(entry, 'config.worktree'), '[core]\n\tsshCommand = calc\n')
    const refused = push('git push origin HEAD')
    expect(refused.code).toBe(128)
    expect(refused.out).toContain('the push was not made')
    expect(raw(remote, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('work to publish')
    rmSync(join(entry, 'config.worktree'))
    expect(push('git push -u origin HEAD').code).toBe(0)
    expect(raw(remote, 'log', '-1', '--format=%s', 'nexus/run1/task')).toBe('more')
  }, 180_000)
})
