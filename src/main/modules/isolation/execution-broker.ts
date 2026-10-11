import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { containedEnv } from '@main/modules/process/contained-env'
import { tokenizeCommandLine } from '@main/modules/process/command-line'
import { runProcess, type ProcessResult, type RunProcessOptions } from '@main/modules/process/run-process'
import { quoteArg, type ContainmentCheck, type ContainmentProfile, type Launcher, type LaunchSpec, type SandboxAccountRef } from './launcher'
import { prepareSandboxLauncher, type SandboxAccount } from './sandbox-account'
import { mirrorMsys } from './tools'

/**
 * 0.8: the execution broker. Whoever wants project code run (an agent's shell tool, NEXUS's own check and setup
 * commands, an application under test) asks here and gets back how it will run: under which profile, in
 * which directories, with which environment, through the launcher. A caller never gets a bare spawn by asking.
 *
 * Profiles, honestly:
 *  ISOLATED    the command runs as the machine's sandbox account, at low integrity, in a job object its tree
 *              cannot leave. That account has no access to the user's profile, credential vault or keys;
 *              Windows Firewall lets none of its traffic out, so the loopback proxy NEXUS gives it is its only
 *              network. It writes in the directories of its session and reads the system and its own tools.
 *              Needs the one-time elevated setup of the account. Not contained: loopback services other than
 *              the proxy, and whatever every local account may read.
 *  RESTRICTED  the command runs as the user, at low integrity, in the same kind of job. It can write only
 *              where NEXUS labeled a directory for it and cannot read what NEXUS marked protected. It keeps the
 *              user's network, credential vault and every file nobody protected.
 *  STANDARD    no containment: the 0.7 behaviour. Never chosen as a fallback for the other two.
 */

export type ExecutionProfileName = 'ISOLATED' | 'RESTRICTED' | 'STANDARD'

export interface SessionRoots {
  /** The task worktree: writable by the contained command. */
  worktree: string
  /** The session's temporary directory. */
  temp: string
  /** A home directory of its own: tools find no configuration of the user's there, and write theirs there. */
  home: string
  /** Package-manager caches of the project, shared by its tasks. */
  cache: string
}

export interface ExecutionBrokerDeps {
  launcher: Launcher
  /** NEXUS's directory for the state of RESTRICTED sessions and for verification scratch, inside its data directory. */
  sandboxDir: string
  /** The sandbox account as the setup recorded it; null when the setup was not run. Read when needed, so a setup made while NEXUS runs is seen. */
  account: () => SandboxAccount | null
  /**
   * Why the sandbox account that is on record may not be used, or null. Set when NEXUS's verification of the
   * account, its folder and the machine's record did not pass at this start: a name on record proves nothing.
   */
  accountProblem?: () => string | null
  /** The environment the allowlist is applied to (the runtime's own). */
  baseEnv: () => NodeJS.ProcessEnv
  /** Directories dropped from PATH: NEXUS's own install directory. */
  nexusPathEntries?: () => string[]
  /** Variables a project's settings add to the allowlist. */
  extraEnvNames?: (projectId: string) => string[]
  /** The commit identity for git commands an agent runs: with a home of its own git finds no user configuration. */
  gitIdentity?: () => { name: string; email: string }
  /**
   * Under ISOLATED: PATH entries that replace the user's own for tools the account cannot read where they are
   * installed (a mirror in the sandbox root). Absent: the PATH is used as it is.
   */
  toolPath?: (profile: ContainmentProfile, path: string) => string
  /** Variables of the network a session is given: the proxy it must use. */
  networkEnv?: (session: { projectId: string; sessionKey: string; profile: ContainmentProfile }) => Record<string, string>
  /** Told when a containment that was asked for could not be made. */
  onFailure?: (info: { projectId: string | null; profile: ContainmentProfile; detail: string }) => void
  /** Limits of one command's process tree. */
  limits?: { maxProcesses?: number; maxJobMemoryBytes?: number }
}

export type ShellKind = 'bash' | 'powershell'

export type ContainResult =
  | { ok: true; profile: ContainmentProfile; file: string; args: string[]; specPath: string; roots: SessionRoots; withheldEnv: string[] }
  | { ok: false; reason: string }

/** How a long-running program is started inside the containment: the launcher, its arguments, and the environment the launcher itself needs. */
export type ContainProgramResult =
  | { ok: true; profile: ContainmentProfile; file: string; args: string[]; specPath: string; roots: SessionRoots; launcherEnv: Record<string, string> }
  | { ok: false; reason: string }

export interface ContainSession {
  profile: ContainmentProfile
  projectId: string
  /** What identifies the session among those of its project: a run and a task. */
  sessionKey: string
  worktree: string
}

const DEFAULT_MAX_PROCESSES = 512
/**
 * The job's UI limits for a program with a window. Everything but the limit on handles of other processes'
 * windows and objects, which a browser engine needs for its own processes: the clipboard is not read or
 * written, no system parameter or display setting is changed, no global atom is used, no desktop is made or
 * switched to, the session is not ended. The application's desktop is made by the launcher before the job
 * applies, under both profiles, so the limit on desktops stays on.
 */
const UI_LIMIT_HANDLES = 0x1
const WINDOW_UI_LIMITS = 0xff & ~UI_LIMIT_HANDLES
const GIT_HINT =
  'nexus: in the isolated profile this git command runs only as a command of its own: git alone, with no pipe and no other program on the line (several git commands joined by && or ; are fine). Run it separately; nothing was changed.'
/** git subcommands that change a ref, and so need to run where the directories above the repository can be seen. */
const REF_CHANGING = ['commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'branch', 'tag', 'stash', 'cherry-pick', 'revert', 'pull', 'am', 'update-ref', 'symbolic-ref', 'worktree', 'fetch', 'push', 'gc', 'pack-refs', 'notes', 'replace', 'bisect']

/**
 * After every commit git removes a leftover of merges (`AUTO_MERGE`), and for that it tries to lock the
 * repository's `packed-refs`, which a contained git may not create. git goes on and the commit stands, but it
 * prints "error: Unable to create '…/packed-refs.lock': Permission denied", which reads as a failure and is
 * none (traced with GIT_TRACE_REFS, git 2.53). That one line is left out by the `git` function of the script
 * (bashGitGuardian); git's exit code is its own.
 */

/**
 * Around the script of a git-only command that has an index of its own (see gitPins): the index is made from
 * the branch's commit when it is not there yet, the invocations run as one function, and afterwards the
 * worktree's own index file is replaced by a copy, so that a git the task runs as the sandbox account sees
 * what was staged. The copy is for reading only: nothing of the user's git reads it back.
 */
const BASH_OWN_INDEX_BEFORE = `if [ -n "$GIT_INDEX_FILE" ] && [ ! -s "$GIT_INDEX_FILE" ]; then nx_guard && command git read-tree HEAD || { echo 'NEXUS: the index for this command could not be made, so it was not run.' >&2; exit 128; }; fi\nnx_main() {\n`
const BASH_OWN_INDEX_AFTER = `}\nnx_main\nnx_rc=$?\nif [ -n "$GIT_INDEX_FILE" ] && [ -s "$GIT_INDEX_FILE" ] && [ -n "$GIT_DIR" ]; then cp -f "$GIT_INDEX_FILE" "$GIT_DIR/index" 2>/dev/null; fi\nexit $nx_rc\n`

/**
 * Looked at before every git of a git-only script, by the script itself:
 *  - the worktree is on the branch NEXUS made for it. `HEAD` in the worktree's entry is a file the task's code
 *    may be able to replace; a git that commits "on HEAD" would then move whatever branch it names;
 *  - the entry has no configuration of its own (`config.worktree`), which a repository that reads such files
 *    would take filters, drivers and programs from;
 *  - no directory on the way to a tracked file is a link: Git for Windows writes, deletes and reads through a
 *    junction that stands where a tracked directory was.
 * When one does not hold, git is not run and the command fails with 128. These are checks made a moment before
 * the use, not locks: what cannot be replaced at all is said where the entry's access is set (grantGit).
 */
function bashGitGuardian(branch: string): string {
  return [
    `nx_guard() {`,
    `  local head; head=$(cat "$GIT_DIR/HEAD" 2>/dev/null)`,
    `  if [ "$head" != 'ref: refs/heads/${branch}' ]; then echo "NEXUS: this worktree is no longer on its own branch (${branch}), so git was not run here." >&2; return 1; fi`,
    `  if [ -s "$GIT_DIR/config.worktree" ] || [ -L "$GIT_DIR/config.worktree" ] || [ -d "$GIT_DIR/config.worktree" ]; then echo 'NEXUS: the worktree has a configuration of its own that NEXUS did not write, so git was not run here.' >&2; return 1; fi`,
    `  local p d; local -A seen=()`,
    `  while IFS= read -r -d '' p; do d="$p"; while [[ "$d" == */* ]]; do d="\${d%/*}"; [ -n "\${seen[$d]:-}" ] && break; seen[$d]=1; if [ -L "$GIT_WORK_TREE/$d" ]; then echo "NEXUS: $d is a link to another place where a directory of tracked files should be, so git was not run here. Remove the link." >&2; return 1; fi; done; done < <(command git ls-files -z --full-name -- ':(top)' 2>/dev/null)`,
    `  return 0`,
    `}`,
    `git() { nx_guard || return 128; command git "$@" 2> >(grep -v "packed-refs.lock': Permission denied" >&2); local rc=$?; wait $! 2>/dev/null; return $rc; }`,
    '',
  ].join('\n')
}

const bashQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The whole bash script of a push the user allowed. It runs as the user, outside the containment, so everything
 * it depends on is said in it and nothing is taken from the worktree: the Git directory and the repository
 * NEXUS recorded, an empty hooks directory (a `pre-push` hook is a program of the repository), no file-system
 * monitor, no `ext` transport, no entering of nested repositories. The user's own git configuration applies:
 * it is where the remote's address and the way of signing in to it are. `pushLine` is what NEXUS rendered from
 * the parsed command.
 */
export function grantedPushScript(input: { pushLine: string; gitDir: string; worktree: string; hooksDir: string; gitCmdDir?: string }): string {
  const config: [string, string][] = [
    ['core.hooksPath', input.hooksDir],
    ['core.fsmonitor', 'false'],
    ['core.pager', 'cat'],
    ['protocol.ext.allow', 'never'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['submodule.recurse', 'false'],
    ['push.recurseSubmodules', 'no'],
  ]
  const lines = [
    ...(input.gitCmdDir !== undefined ? [`PATH="$(cygpath -u ${bashQuote(input.gitCmdDir)}):$PATH"`] : []),
    `export GIT_DIR=${bashQuote(input.gitDir)} GIT_COMMON_DIR=${bashQuote(resolve(input.gitDir, '..', '..'))} GIT_WORK_TREE=${bashQuote(input.worktree)}`,
    `export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_LFS_SKIP_SMUDGE=1 GIT_EDITOR=true GIT_PAGER=cat GIT_CONFIG_COUNT=${config.length}`,
    'unset GIT_INDEX_FILE GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS GIT_EXEC_PATH GIT_PROXY_COMMAND',
    ...config.map(([key, value], i) => `export GIT_CONFIG_KEY_${i}=${bashQuote(key)} GIT_CONFIG_VALUE_${i}=${bashQuote(value)}`),
    // A repository that reads per-worktree configuration would take programs from a file in the entry, which the task's code may have put there.
    `if [ -s "$GIT_DIR/config.worktree" ] || [ -L "$GIT_DIR/config.worktree" ] || [ -d "$GIT_DIR/config.worktree" ]; then echo 'NEXUS: the worktree has a configuration of its own that NEXUS did not write, so the push was not made.' >&2; exit 128; fi`,
    input.pushLine,
    'exit $?',
    '',
  ]
  return lines.join('\n')
}

/** The whole bash script of a git-only command: `invocations` is what NEXUS rendered from the parsed command, `branch` the worktree's own branch. */
export function gitOnlyScript(invocations: string, branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch) || branch.includes('..')) throw new Error('The worktree has no branch of its own that can be named.')
  return `${bashGitGuardian(branch)}${BASH_OWN_INDEX_BEFORE}${invocations}\n${BASH_OWN_INDEX_AFTER}`
}

/** A `git` function for the command's script: it stops the subcommands that cannot work here and says what to do, and passes the rest to git. */
function bashGitGuard(kind: 'all' | 'refs'): string {
  const refuse = `echo ${JSON.stringify(GIT_HINT)} >&2; return 128`
  if (kind === 'all') return `git() { ${refuse}; }\n`
  return `git() { local a; for a in "$@"; do case "$a" in -*) continue;; ${REF_CHANGING.join('|')}) ${refuse};; *) break;; esac; done; command git "$@"; }\n`
}

function powershellGitGuard(kind: 'all' | 'refs'): string {
  const refuse = `[Console]::Error.WriteLine(${JSON.stringify(GIT_HINT)}); $global:LASTEXITCODE = 128; return`
  if (kind === 'all') return `function git { ${refuse} }\n`
  return `function git { foreach ($a in $args) { if ("$a".StartsWith('-')) { continue }; if (@(${REF_CHANGING.map((c) => `'${c}'`).join(',')}) -contains "$a") { ${refuse} }; break }; & (Get-Command git -CommandType Application | Select-Object -First 1).Source @args }\n`
}

function shortHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16)
}

const within = (root: string, path: string): boolean => {
  const r = resolve(root).toLowerCase()
  const p = resolve(path).toLowerCase()
  return p === r || p.startsWith(`${r}\\`)
}

export class ExecutionBroker {
  private readonly labeled = new Set<string>()
  private shells: { gitRoot: string | null; powershell: string } | null = null
  private readonly msys = new Map<ContainmentProfile, { bash: string; binDir: string } | null>()
  private sandboxRef: { root: string; ref: SandboxAccountRef } | null = null
  private readonly counts = { shell: 0, commands: 0, programs: 0, refused: 0 }
  /** Paths of repositories the sandbox account was given access to at this start, by path and kind of access. */
  private readonly granted = new Set<string>()

  constructor(private readonly deps: ExecutionBrokerDeps) {}

  /** What ISOLATED needs of the account, with the launcher copy in place. Null when there is no account. */
  private sandbox(): { account: SandboxAccount; ref: SandboxAccountRef } | null {
    const account = this.deps.account()
    if (account === null) return null
    if (this.sandboxRef === null || this.sandboxRef.root !== account.root) this.sandboxRef = { root: account.root, ref: prepareSandboxLauncher(account, this.deps.launcher.executable) }
    return { account, ref: this.sandboxRef.ref }
  }

  /** Where the worktrees of ISOLATED sessions must be: a directory of the sandbox root. Null when there is no account. */
  isolatedWorktreesRoot(): string | null {
    const account = this.deps.account()
    return account === null ? null : join(account.root, 'worktrees')
  }

  /** Runs a profile's containment once to see that it holds here. See Launcher.verify. */
  async verify(profile: ContainmentProfile, force = false): Promise<ContainmentCheck> {
    if (profile === 'RESTRICTED') return this.deps.launcher.verify('RESTRICTED', { scratchRoot: join(this.deps.sandboxDir, 'verify') }, force)
    const problem = this.deps.accountProblem?.() ?? null
    if (problem !== null) return this.deps.launcher.verify('ISOLATED', { scratchRoot: join(this.deps.sandboxDir, 'verify'), sandboxError: problem }, force)
    let sandbox: ReturnType<ExecutionBroker['sandbox']>
    try {
      sandbox = this.sandbox()
    } catch (e) {
      return this.deps.launcher.verify('ISOLATED', { scratchRoot: join(this.deps.sandboxDir, 'verify'), sandboxError: e instanceof Error ? e.message : String(e) }, force)
    }
    if (sandbox === null) return this.deps.launcher.verify('ISOLATED', { scratchRoot: join(this.deps.sandboxDir, 'verify') }, force)
    return this.deps.launcher.verify('ISOLATED', { scratchRoot: join(sandbox.account.root, 'verify'), userOnlyRoot: join(this.deps.sandboxDir, 'verify-user'), sandbox: sandbox.ref }, force)
  }

  status(profile: ContainmentProfile): ContainmentCheck | null {
    return this.deps.launcher.status(profile)
  }

  /**
   * Whether a profile can be used now. ISOLATED and RESTRICTED must have been verified at this start; when
   * one was not, or did not hold, the answer is no, with the reason. There is no downgrade here.
   */
  usable(profile: ExecutionProfileName): { usable: boolean; detail: string } {
    if (profile === 'STANDARD') return { usable: true, detail: 'No containment: commands run as you.' }
    const check = this.status(profile)
    if (check === null) return { usable: false, detail: 'The containment has not been verified at this start.' }
    return { usable: check.available, detail: check.detail }
  }

  private grantsRecord(): string {
    return join(this.deps.sandboxDir, 'git-grants.json')
  }

  private readGrants(): Record<string, string[]> {
    try {
      return JSON.parse(readFileSync(this.grantsRecord(), 'utf8')) as Record<string, string[]>
    } catch {
      return {}
    }
  }

  private async icacls(args: string[]): Promise<void> {
    const system32 = join(this.deps.baseEnv()['SystemRoot'] ?? 'C:\\Windows', 'System32')
    const result = await runProcess(join(system32, 'icacls.exe'), args, { cwd: system32, env: this.launcherEnv(), timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 })
    if (result.exitCode !== 0) throw new Error(`icacls ${args.slice(1).join(' ')}: ${(result.stderr.trim() || result.stdout.trim()).slice(-300)}`)
  }

  /**
   * Under ISOLATED: gives the sandbox account what git needs of an enrolled project's repository to read it
   * and to stage: the repository's Git data to read, objects to add, and the Git directory of its own worktree
   * and the refs of its own mission to change. It gets no way to change another branch, the configuration, the
   * hooks or an object that is already there. Each grant is on record (by repository) and is taken back by
   * `revokeGit`.
   *
   * It does not make a commit possible for that account. Before git changes a ref it looks at every directory
   * above it, and the account can see none of the user's above the repository (measured: "cannot lock ref
   * 'HEAD': unable to create directory"; a junction from the sandbox root does not help, git resolves it).
   * Giving the account rights on the user's own folders is not something NEXUS does. So a command that is git
   * alone still runs as the user at low integrity, and a ref-changing git inside a larger command is told so.
   */
  async grantGit(layout: { commonDir: string; writable: readonly string[] }): Promise<void> {
    const sandbox = this.sandbox()
    if (sandbox === null) throw new Error('The sandbox account is not set up on this machine.')
    const sid = `*${sandbox.account.sid}`
    const record = this.readGrants()
    const key = resolve(layout.commonDir).toLowerCase()
    const paths = new Set(record[key] ?? [])
    const once = async (path: string, kind: string, grants: string[]): Promise<void> => {
      const mark = `${kind}|${resolve(path).toLowerCase()}`
      if (this.granted.has(mark) || !existsSync(path)) return
      await this.icacls([path, ...grants.flatMap((g) => ['/grant', g]), '/Q'])
      this.granted.add(mark)
      paths.add(resolve(path))
    }
    await once(layout.commonDir, 'read', [`${sid}:(OI)(CI)(RX)`])
    // What the account may do in a directory it is let into: read everything, add files and directories, and do
    // what it likes with what it added itself (the entry for the creator). It is given no right to write into,
    // delete or replace a file somebody else put there. Measured for 0.8: a mandatory label does not give that
    // (code at low integrity deletes and replaces a file labeled medium in a directory labeled low, through the
    // directory's own rights), and a right to write that is inherited by files lets every existing object and
    // every other task's branch be overwritten in place. So the right to add is inherited by directories only.
    const addOnly = async (path: string): Promise<void> => {
      const mark = `add-only|${resolve(path).toLowerCase()}`
      if (this.granted.has(mark) || !existsSync(path)) return
      // An entry from an earlier version (write inherited by files, or modify) is taken out first.
      await this.icacls([path, '/remove:g', sid, '/Q'])
      await this.icacls([path, '/grant', `${sid}:(OI)(CI)(RX)`, '/grant', `${sid}:(CI)(WD,AD)`, '/grant', '*S-1-3-0:(OI)(CI)(IO)(F)', '/Q'])
      this.granted.add(mark)
      paths.add(resolve(path))
    }
    const common = resolve(layout.commonDir).toLowerCase()
    for (const path of layout.writable) {
      const isFile = existsSync(path) && statSync(path).isFile()
      const isEntry = !isFile && basename(dirname(path)).toLowerCase() === 'worktrees' && resolve(path, '..', '..').toLowerCase() === common
      if (isFile) {
        // The task's own branch and its log: these two files, and no other ref, may be rewritten.
        await once(path, 'modify-file', [`${sid}:(M)`])
        continue
      }
      // A path that names a branch that does not exist yet as a file is not made into a directory.
      if (!existsSync(path) && !isEntry && basename(path).toLowerCase() !== 'objects' && layout.writable.some((other) => other !== path && resolve(other).toLowerCase() === resolve(dirname(path)).toLowerCase())) continue
      if (!existsSync(path)) mkdirSync(path, { recursive: true })
      // Everywhere the account may add and not replace: objects are only ever added; among the refs it makes git's
      // lock files, which it then owns, beside branches of other tasks that it cannot touch; and in the worktree's
      // own entry it finds `HEAD`, `commondir`, `gitdir` and `config.worktree` as NEXUS left them and cannot put
      // others in their place.
      await addOnly(path)
      // The one file of the entry the account's own git rewrites: the index it stages into. Nothing of the
      // user's git or of NEXUS's reads that index back (each has its own).
      if (isEntry && existsSync(join(path, 'index'))) await once(join(path, 'index'), 'modify-file', [`${sid}:(M)`])
      await this.ensureLow(path)
      if (isEntry) await this.pinWorktreeEntry(path)
      if (basename(path).toLowerCase() === 'objects') await this.pinObjectStore(path)
    }
    if (paths.size !== (record[key] ?? []).length) {
      record[key] = [...paths]
      mkdirSync(this.deps.sandboxDir, { recursive: true })
      writeFileSync(this.grantsRecord(), JSON.stringify(record, null, 2))
    }
  }

  /**
   * The three files of a worktree's entry that say where the repository is and what configuration applies are
   * not the task's to write: `commondir`, `gitdir`, and `config.worktree` (made empty if it is not there, so
   * that it cannot be made). Each gets a label of its own, above the one of the directory: code at low
   * integrity, whichever account it runs as, can read them and not replace them.
   */
  private async pinWorktreeEntry(entry: string): Promise<void> {
    const mark = `pinned|${resolve(entry).toLowerCase()}`
    if (this.granted.has(mark)) return
    const config = join(entry, 'config.worktree')
    if (!existsSync(config)) writeFileSync(config, '')
    for (const name of ['commondir', 'gitdir', 'config.worktree']) {
      const file = join(entry, name)
      if (existsSync(file)) await this.deps.launcher.label('medium', file)
    }
    this.granted.add(mark)
  }

  /**
   * Contained code adds objects one file at a time, in the two-letter directories. It has no business in the
   * places from which git takes whole sets of objects on trust: a pack with an index of its own making can
   * stand in for an object the repository already has, `info/alternates` names another object store, and a
   * commit-graph answers which commit descends from which. Those directories carry a label of their own:
   * code at low integrity reads them and writes nothing there, under either profile.
   */
  private async pinObjectStore(objects: string): Promise<void> {
    const mark = `objects|${resolve(objects).toLowerCase()}`
    if (this.granted.has(mark)) return
    for (const name of ['pack', 'info']) {
      const dir = join(objects, name)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await this.deps.launcher.label('medium', dir)
    }
    this.granted.add(mark)
  }

  /**
   * Pins a worktree's entry and its repository's object store (see pinWorktreeEntry, pinObjectStore). Called
   * when NEXUS creates a worktree in an enrolled project, before any code of the project runs there, and again
   * before every contained command.
   */
  async pinGit(gitDir: string): Promise<void> {
    if (!existsSync(gitDir)) return
    await this.pinWorktreeEntry(gitDir)
    const objects = join(resolve(gitDir, '..', '..'), 'objects')
    if (existsSync(objects)) await this.pinObjectStore(objects)
  }

  /** Takes back the access to every repository on record that is not one of `keep` (the Git directories of the projects still enrolled). */
  async revokeGitExcept(keep: readonly string[]): Promise<void> {
    const kept = new Set(keep.map((dir) => resolve(dir).toLowerCase()))
    for (const key of Object.keys(this.readGrants())) if (!kept.has(key)) await this.revokeGit(key)
  }

  /** Takes back what `grantGit` gave for a repository (every repository on record when none is named). */
  async revokeGit(commonDir?: string): Promise<void> {
    const account = this.deps.account()
    const record = this.readGrants()
    const keys = commonDir === undefined ? Object.keys(record) : [resolve(commonDir).toLowerCase()]
    for (const key of keys) {
      const left: string[] = []
      // Deepest first, so that a directory's own entry goes before its parent's inherited one is recomputed.
      for (const path of [...(record[key] ?? [])].sort((a, b) => b.length - a.length)) {
        if (!existsSync(path)) continue
        try {
          if (account !== null) await this.icacls([path, '/remove', `*${account.sid}`, '/Q'])
          if (basename(path).toLowerCase() === 'objects') await this.icacls([path, '/remove', '*S-1-3-0', '/Q']).catch(() => undefined)
          await this.deps.launcher.label('clear', path).catch(() => undefined)
          for (const mark of [...this.granted]) if (mark.endsWith(`|${path.toLowerCase()}`)) this.granted.delete(mark)
          this.labeled.delete(path.toLowerCase())
        } catch {
          left.push(path)
        }
      }
      if (left.length > 0) record[key] = left
      else delete record[key]
    }
    if (existsSync(this.grantsRecord())) writeFileSync(this.grantsRecord(), JSON.stringify(record, null, 2))
  }

  private async ensureLow(dir: string): Promise<void> {
    const key = dir.toLowerCase()
    if (this.labeled.has(key)) return
    mkdirSync(dir, { recursive: true })
    await this.deps.launcher.label('low', dir)
    this.labeled.add(key)
  }

  /**
   * The directories of a session, created and labeled so that a contained command may write in them. Under
   * ISOLATED they are in the sandbox root, and so must the worktree be: the account can reach nothing else.
   */
  async roots(session: ContainSession): Promise<SessionRoots> {
    let stateRoot = this.deps.sandboxDir
    if (session.profile === 'ISOLATED') {
      const sandbox = this.sandbox()
      if (sandbox === null) throw new Error('The sandbox account is not set up on this machine.')
      if (!within(sandbox.account.root, session.worktree)) throw new Error(`The worktree is not inside the sandbox root (${sandbox.account.root}), so the sandbox account cannot work in it.`)
      stateRoot = sandbox.account.root
    }
    // By instance: the sandbox root is the machine's, and two NEXUS instances (an installed one and a development
    // one, or two test processes) each sweep only what is their own.
    const base = join(stateRoot, 'sessions', shortHash(this.deps.sandboxDir), shortHash(`${session.projectId}|${session.sessionKey}|${session.worktree}`))
    const roots: SessionRoots = { worktree: session.worktree, temp: join(base, 'tmp'), home: join(base, 'home'), cache: join(stateRoot, 'cache', shortHash(session.projectId)) }
    await this.ensureLow(roots.worktree)
    await this.ensureLow(base)
    for (const dir of [roots.temp, join(roots.home, 'AppData', 'Roaming'), join(roots.home, 'AppData', 'Local'), roots.cache]) mkdirSync(dir, { recursive: true })
    await this.ensureLow(roots.cache)
    return roots
  }

  /** A worktree was removed or re-created: its label is set again the next time it is used. */
  forget(worktree: string): void {
    this.labeled.delete(worktree.toLowerCase())
  }

  environment(session: ContainSession, roots: SessionRoots, set: Record<string, string> = {}): { env: Record<string, string>; withheld: string[] } {
    const identity = this.deps.gitIdentity?.()
    const built = containedEnv(this.deps.baseEnv(), {
      tempDir: roots.temp,
      extraNames: this.deps.extraEnvNames?.(session.projectId) ?? [],
      dropPathEntries: this.deps.nexusPathEntries?.() ?? [],
      set: {
        USERPROFILE: roots.home,
        HOME: roots.home,
        APPDATA: join(roots.home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(roots.home, 'AppData', 'Local'),
        // Package managers keep their caches where the contained command may write, and read no token from the user's own configuration.
        npm_config_cache: join(roots.cache, 'npm'),
        // "Global" is the session's: a global install lands in its home, and npm's own launchers look for a newer npm there, not in the user's profile.
        npm_config_prefix: join(roots.home, 'npm-global'),
        npm_config_store_dir: join(roots.cache, 'pnpm-store'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        YARN_CACHE_FOLDER: join(roots.cache, 'yarn'),
        PIP_CACHE_DIR: join(roots.cache, 'pip'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        ELECTRON_CACHE: join(roots.cache, 'electron'),
        GIT_TERMINAL_PROMPT: '0',
        ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}),
        ...(this.deps.networkEnv?.({ projectId: session.projectId, sessionKey: session.sessionKey, profile: session.profile }) ?? {}),
        ...set,
      },
    })
    const key = Object.keys(built.env).find((k) => k.toLowerCase() === 'path')
    if (key !== undefined) {
      if (this.deps.toolPath) built.env[key] = this.deps.toolPath(session.profile, built.env[key] as string)
      // The user's own MSYS tools cannot run contained (see mirrorMsys): a PATH entry that holds them is left out,
      // so that `whoami` or `find` is the Windows program and not a tool that dies at its first step.
      built.env[key] = (built.env[key] as string)
        .split(';')
        .filter((entry) => entry !== '' && !existsSync(join(entry, 'msys-2.0.dll')))
        .join(';')
    }
    return built
  }

  /**
   * Bash for a profile: a copy of Git's MSYS runtime of the profile's own (see mirrorMsys), in a directory the
   * contained process can read. Null when Git for Windows is not installed.
   */
  /**
   * A push the user allowed, as a command for the agent's shell: Git Bash on a script NEXUS wrote, as the user
   * and outside the containment (see grantedPushScript). The script lies where no contained code writes: in
   * NEXUS's own data, which is closed to code at low integrity and is not the sandbox account's.
   */
  async grantedPush(input: { projectId: string; worktree: string; gitDir: string; pushLine: string }): Promise<{ ok: true; bash: string; script: string } | { ok: false; reason: string }> {
    const { gitRoot } = await this.findShells()
    const bash = gitRoot === null ? null : [join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe')].find((candidate) => existsSync(candidate))
    if (gitRoot === null || bash === undefined || bash === null) return { ok: false, reason: 'Git Bash was not found, so the push that was allowed cannot be run by NEXUS.' }
    if (!existsSync(input.gitDir)) return { ok: false, reason: 'The Git directory of the worktree is gone, so the push was not made.' }
    try {
      const dir = join(this.deps.sandboxDir, 'granted')
      const hooksDir = join(dir, 'no-hooks')
      mkdirSync(hooksDir, { recursive: true })
      // Scripts of earlier pushes are not kept.
      const cutoff = Date.now() - 3_600_000
      for (const name of readdirSync(dir)) {
        if (!/^nx-[0-9a-f]{16}\.sh$/.test(name)) continue
        try {
          if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true })
        } catch {
          // gone already
        }
      }
      const script = join(dir, `nx-${randomBytes(8).toString('hex')}.sh`)
      writeFileSync(script, grantedPushScript({ pushLine: input.pushLine, gitDir: input.gitDir, worktree: input.worktree, hooksDir, gitCmdDir: join(gitRoot, 'cmd') }), { flag: 'wx' })
      return { ok: true, bash, script }
    } catch (e) {
      return { ok: false, reason: `The push that was allowed could not be prepared: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Whether a bash script can run under this profile: Git Bash was found and its copy for the profile could be made. */
  async hasBash(profile: ContainmentProfile): Promise<boolean> {
    return (await this.bashFor(profile).catch(() => null)) !== null
  }

  private async bashFor(profile: ContainmentProfile): Promise<{ bash: string; binDir: string; gitRoot: string } | null> {
    const { gitRoot } = await this.findShells()
    if (gitRoot === null) return null
    if (!this.msys.has(profile)) {
      const toolsRoot = profile === 'ISOLATED' ? join((this.sandbox() as { account: SandboxAccount }).account.root, 'tools') : join(this.deps.sandboxDir, 'tools')
      const copy = mirrorMsys({ toolsRoot, gitRoot })
      // Readable and not writable for contained code, whatever the directory above it is labeled: the tools are
      // shared by sessions, and one session must not be able to change what the next one runs.
      if (copy !== null) await this.deps.launcher.label('medium', toolsRoot)
      this.msys.set(profile, copy)
    }
    const copy = this.msys.get(profile) ?? null
    return copy === null ? null : { ...copy, gitRoot }
  }

  private async findShells(): Promise<{ gitRoot: string | null; powershell: string }> {
    if (this.shells !== null) return this.shells
    const env = this.deps.baseEnv()
    const path = (Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '').split(';').filter((d) => d !== '')
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
    // Git for Windows' bash, found from where git itself is: never the WSL launcher in System32.
    let gitRoot: string | null = null
    for (const dir of path) {
      const clean = dir.replace(/^"(.*)"$/, '$1')
      if (!existsSync(join(clean, 'git.exe'))) continue
      for (const candidate of [join(clean, '..', 'bin', 'bash.exe'), join(clean, '..', 'usr', 'bin', 'bash.exe'), join(clean, '..', '..', 'bin', 'bash.exe')]) {
        if (existsSync(candidate) && existsSync(join(dirname(candidate), '..', 'usr', 'bin', 'msys-2.0.dll')) ) {
          gitRoot = resolve(dirname(candidate), '..')
          break
        }
        if (existsSync(candidate) && existsSync(join(dirname(candidate), 'msys-2.0.dll'))) {
          gitRoot = resolve(dirname(candidate), '..', '..')
          break
        }
      }
      if (gitRoot !== null) break
    }
    let powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const dir of path) {
      const candidate = join(dir.replace(/^"(.*)"$/, '$1'), 'pwsh.exe')
      // Only a PowerShell every account can read: one installed in the user's profile is of no use to the sandbox account.
      if (existsSync(candidate) && !/\\users\\/i.test(candidate)) {
        powershell = candidate
        break
      }
    }
    this.shells = { gitRoot, powershell }
    return this.shells
  }

  private fail(projectId: string | null, profile: ContainmentProfile, detail: string): ContainResult {
    try {
      this.deps.onFailure?.({ projectId, profile, detail })
    } catch {
      // A listener's failure is not the broker's.
    }
    this.counts.refused += 1
    return { ok: false, reason: detail }
  }

  /** How many launches were prepared inside a containment since this start, by kind, and how many were refused. */
  counters(): { shell: number; commands: number; programs: number; refused: number } {
    return { ...this.counts }
  }

  private spec(session: ContainSession, roots: SessionRoots, commandLine: string, env: Record<string, string>, extra: Partial<LaunchSpec> = {}): LaunchSpec {
    const sandbox = session.profile === 'ISOLATED' ? this.sandbox() : null
    return {
      profile: session.profile,
      cwd: roots.worktree,
      commandLine,
      env,
      maxProcesses: this.deps.limits?.maxProcesses ?? DEFAULT_MAX_PROCESSES,
      ...(this.deps.limits?.maxJobMemoryBytes !== undefined ? { maxJobMemoryBytes: this.deps.limits.maxJobMemoryBytes } : {}),
      ...(sandbox ? { sandbox: sandbox.ref } : {}),
      ...extra,
    }
  }

  /**
   * How an agent's shell command will run. The command text is written to a script in the session's temporary
   * directory and the launcher runs the shell on that script, so nothing of the command is ever spliced into a
   * command line. Returns what to run instead of the command, or the reason nothing will run.
   */
  async containShell(
    input: ContainSession & {
      cwd: string
      shell: ShellKind
      command: string
      timeoutMs?: number
      /** The profile of the session the command belongs to, when the command itself runs under another (git under RESTRICTED in an ISOLATED session). Its directories are the session's. */
      sessionProfile?: ExecutionProfileName
      /** The command is git and nothing else: it gets git's own hardening and may write the worktree's own git data. */
      gitOnly?: boolean
      /** For a git-only command: the directories of the repository a contained git must write to commit on its own branch. From NEXUS's record. */
      gitWritable?: readonly string[]
      /** The repository's Git directory (the common one). With it, under ISOLATED, the sandbox account is given what git needs there. */
      gitCommonDir?: string
      /** The worktree's own Git directory, from NEXUS's record. A git-only command is pointed at it, whatever the worktree's `.git` file says. */
      gitDir?: string
      /** The branch NEXUS made for the worktree. A git-only command runs only while the worktree is on it. */
      gitBranch?: string
    },
  ): Promise<ContainResult> {
    const state = this.usable(input.profile)
    if (!state.usable) return this.fail(input.projectId, input.profile, `The ${input.profile} execution profile is not available, so the command was not run: ${state.detail}`)
    try {
      // The directories of the profile the command runs under. A git that runs as the user in an ISOLATED
      // session gets its home, its temporary directory, its empty hooks directory and its script where the
      // sandbox account cannot write: nothing contained code left there is read by a process of the user.
      if (input.gitOnly === true && (input.gitDir === undefined || input.gitBranch === undefined || input.shell !== 'bash')) return this.fail(input.projectId, input.profile, 'A command that is git alone runs only as the bash script NEXUS wrote, with the Git directory and the branch NEXUS recorded for the worktree. One of them is missing, so it was not run.')
      const roots = await this.roots(input)
      // Whether git can read this repository from inside the command. Under ISOLATED that is so once the sandbox
      // account was given its access; a command that runs as the user (RESTRICTED) reads it anyway.
      let gitReadable = input.profile === 'RESTRICTED'
      if (input.profile === 'ISOLATED' && input.gitCommonDir !== undefined) {
        // Without the access the command still runs; git inside it is then told that it cannot work here.
        gitReadable = await this.grantGit({ commonDir: input.gitCommonDir, writable: input.gitWritable ?? [] }).then(
          () => true,
          () => false,
        )
      } else if (input.gitOnly === true) {
        for (const dir of input.gitWritable ?? []) {
          if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
          await this.ensureLow(dir)
        }
      }
      // Whatever the command is: the files of the worktree's entry that say where the repository is and what
      // configuration applies, and the places git takes whole sets of objects from, are not the task's to write.
      if (input.gitDir !== undefined) await this.pinGit(input.gitDir)
      const shells = await this.findShells()
      const bash = input.shell === 'bash' ? await this.bashFor(input.profile) : null
      // git is hardened wherever it can reach the repository: in a command that is git alone, and in every command of a session whose account was given access.
      const { env, withheld } = this.environment(input, roots, input.gitOnly === true || (input.profile === 'ISOLATED' && gitReadable) ? { ...this.gitHardening(roots, input.profile === 'ISOLATED'), ...(input.gitOnly === true ? this.gitPins(roots, input.gitDir, input.sessionProfile === 'ISOLATED' && input.profile !== 'ISOLATED') : {}) } : {})
      if (bash !== null) {
        // The copy's own tools first, then Git itself, so that `git`, `ls` and `grep` are what a Git Bash user expects.
        const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
        env[key] = [bash.binDir, join(bash.gitRoot, 'mingw64', 'bin'), join(bash.gitRoot, 'cmd'), env[key] ?? ''].filter((e) => e !== '').join(';')
        env['MSYSTEM'] = 'MINGW64'
        env['MSYS'] = 'winsymlinks:nativestrict'
      }
      const id = randomBytes(8).toString('hex')
      // The sandbox account cannot read the user's repository, so git inside a command that is more than git finds
      // none. The command is told why, in the place where git would have answered.
      const gitHint: 'all' | 'refs' | null = input.profile === 'ISOLATED' && input.gitOnly !== true && /\bgit\b/.test(input.command) ? (gitReadable ? 'refs' : 'all') : null
      let commandLine: string
      if (input.shell === 'bash') {
        if (bash === null) return this.fail(input.projectId, input.profile, 'Git Bash was not found, so a bash command cannot be run inside the containment.')
        const script = join(roots.temp, `nx-${id}.sh`)
        const body = input.gitOnly === true ? gitOnlyScript(input.command, input.gitBranch ?? '') :`${gitHint !== null ? bashGitGuard(gitHint) : ''}${input.command}\n`
        writeFileSync(script, body, { flag: 'wx' })
        commandLine = `${quoteArg(bash.bash)} --noprofile --norc ${quoteArg(script)}`
      } else {
        const script = join(roots.temp, `nx-${id}.ps1`)
        // A UTF-8 byte order mark: Windows PowerShell reads a script without one in the ANSI code page.
        writeFileSync(script, `${String.fromCharCode(0xfeff)}${gitHint === null ? '' : powershellGitGuard(gitHint)}${input.command}\nexit $LASTEXITCODE\n`, { flag: 'wx' })
        commandLine = `${quoteArg(shells.powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoteArg(script)}`
      }
      // The command starts where the agent's shell is, when that is inside the worktree; else at the worktree.
      const cwd = within(roots.worktree, input.cwd) && existsSync(input.cwd) ? input.cwd : roots.worktree
      const specPath = this.deps.launcher.writeSpec({ ...this.spec(input, roots, commandLine, env, input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), cwd })
      const { file, args } = this.deps.launcher.invocation(specPath)
      this.counts.shell += 1
      return { ok: true, profile: input.profile, file, args, specPath, roots, withheldEnv: withheld }
    } catch (e) {
      return this.fail(input.projectId, input.profile, `The containment could not be set up, so the command was not run: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Runs a command line NEXUS itself runs in a project (the dependency setup, a check command) inside the
   * containment. The command line is one the project configured; it is refused if it uses shell operators, as
   * before 0.8. Throws when the containment cannot be made: the caller records a failed command, not a run.
   */
  async runProjectCommand(input: ContainSession & { commandLine: string }, options: Omit<RunProcessOptions, 'cwd' | 'env'>): Promise<ProcessResult> {
    const state = this.usable(input.profile)
    if (!state.usable) {
      this.fail(input.projectId, input.profile, state.detail)
      throw new Error(`The ${input.profile} execution profile is not available, so the command was not run: ${state.detail}`)
    }
    // The same validation as an uncontained run: a configured command is a program and its arguments.
    tokenizeCommandLine(input.commandLine)
    const roots = await this.roots(input)
    const { env } = this.environment(input, roots)
    const comspec = this.deps.baseEnv()['ComSpec'] ?? this.deps.baseEnv()['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe'
    const specPath = this.deps.launcher.writeSpec(this.spec(input, roots, `${quoteArg(comspec)} /d /s /c "${input.commandLine}"`, env, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs + 5000 } : {}))
    try {
      const { file, args } = this.deps.launcher.invocation(specPath)
      this.counts.commands += 1
      return await runProcess(file, args, { ...options, cwd: roots.worktree, env: this.launcherEnv() })
    } finally {
      this.deps.launcher.removeSpec(specPath)
    }
  }

  /**
   * How a program that stays running (a development server, an application under test) is started inside the
   * containment. Nothing is started here: the caller spawns what is returned and owns the process; ending the
   * launcher ends everything below it, because the job dies with it. The spec is the caller's to release.
   *
   * `commandLine` is a configured command (a program and its arguments, no shell operators) run through the
   * command interpreter so that `npm` and `pnpm` resolve; `file` and `args` name a program directly.
   */
  async containProgram(
    input: ContainSession & ({ commandLine: string } | { file: string; args: readonly string[] }) & {
      cwd?: string
      set?: Record<string, string>
      /** The program has a window: it gets a desktop of its own, and a job without UI limits (Windows nests no job under one that has them, and a browser engine makes its own). */
      window?: { desktop: string }
    },
  ): Promise<ContainProgramResult> {
    const state = this.usable(input.profile)
    if (!state.usable) return this.fail(input.projectId, input.profile, `The ${input.profile} execution profile is not available, so nothing was started: ${state.detail}`) as ContainProgramResult
    try {
      const roots = await this.roots(input)
      const { env } = this.environment(input, roots, input.set ?? {})
      let commandLine: string
      if ('commandLine' in input) {
        tokenizeCommandLine(input.commandLine)
        const comspec = this.deps.baseEnv()['ComSpec'] ?? this.deps.baseEnv()['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe'
        commandLine = `${quoteArg(comspec)} /d /s /c "${input.commandLine}"`
      } else commandLine = this.commandLineFor(input.file, input.args, env)
      const cwd = input.cwd !== undefined && within(roots.worktree, input.cwd) && existsSync(input.cwd) ? input.cwd : roots.worktree
      const specPath = this.deps.launcher.writeSpec({ ...this.spec(input, roots, commandLine, env, input.window ? { window: true, desktop: input.window.desktop, uiLimits: WINDOW_UI_LIMITS } : {}), cwd })
      const { file, args } = this.deps.launcher.invocation(specPath)
      this.counts.programs += 1
      return { ok: true, profile: input.profile, file, args, specPath, roots, launcherEnv: this.launcherEnv() }
    } catch (e) {
      return this.fail(input.projectId, input.profile, `The containment could not be set up, so nothing was started: ${e instanceof Error ? e.message : String(e)}`) as ContainProgramResult
    }
  }

  releaseSpec(specPath: string): void {
    this.deps.launcher.removeSpec(specPath)
  }

  /**
   * The command line for a program and its arguments, with the program found on the PATH the command will
   * have, not on the launcher's: the contained process is started by path, never by a name looked up elsewhere.
   */
  private commandLineFor(file: string, args: readonly string[], env: Record<string, string>): string {
    let program = file
    if (!/[\\/]/.test(file)) {
      const path = (Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '').split(';').filter((e) => e !== '')
      const hasExt = /\.[a-z0-9]{1,4}$/i.test(file)
      outer: for (const dir of path) {
        for (const ext of hasExt ? [''] : ['.exe', '.cmd', '.bat', '.com']) {
          const candidate = join(dir, `${file}${ext}`)
          if (existsSync(candidate)) {
            program = candidate
            break outer
          }
        }
      }
    }
    if (/\.(cmd|bat)$/i.test(program)) {
      const comspec = this.deps.baseEnv()['ComSpec'] ?? this.deps.baseEnv()['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe'
      return `${quoteArg(comspec)} /d /s /c "${[program, ...args].map(quoteArg).join(' ')}"`
    }
    return [program, ...args].map(quoteArg).join(' ')
  }

  /** Runs a program with arguments inside the containment and waits for it. For NEXUS's own use and for tests of the containment. */
  async run(input: ContainSession & { file: string; args: readonly string[]; cwd?: string; set?: Record<string, string> }, options: Omit<RunProcessOptions, 'cwd' | 'env'> = {}): Promise<ProcessResult> {
    const state = this.usable(input.profile)
    if (!state.usable) throw new Error(`The ${input.profile} execution profile is not available: ${state.detail}`)
    const roots = await this.roots(input)
    const { env } = this.environment(input, roots, input.set ?? {})
    const spec = this.spec(input, roots, this.commandLineFor(input.file, input.args, env), env, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs + 5000 } : {})
    const specPath = this.deps.launcher.writeSpec({ ...spec, ...(input.cwd !== undefined && within(roots.worktree, input.cwd) ? { cwd: input.cwd } : {}) })
    try {
      const { file, args } = this.deps.launcher.invocation(specPath)
      return await runProcess(file, args, { ...options, cwd: roots.worktree, env: this.launcherEnv() })
    } finally {
      this.deps.launcher.removeSpec(specPath)
    }
  }

  /**
   * What a contained git gets so that the repository cannot make it run a program: no hooks, no file-system
   * monitor, no pager, no editor, no external transport. Given in the environment, which outranks the
   * repository's and the worktree's own configuration.
   */
  private gitHardening(roots: SessionRoots, otherAccount = false): Record<string, string> {
    const emptyHooks = join(roots.temp, 'no-hooks')
    mkdirSync(emptyHooks, { recursive: true })
    const config: [string, string][] = [
      ['core.hooksPath', emptyHooks],
      ['core.fsmonitor', 'false'],
      ['core.pager', 'cat'],
      ['protocol.ext.allow', 'never'],
      ['core.sshCommand', 'false'],
      ['credential.helper', ''],
      // The task's work is not what triggers housekeeping of the user's repository.
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      // A repository the task put inside the worktree is not entered: with its entry in the index a plain status
      // would start a git in it, under its own configuration (measured; tests/integration/git/hostile-index).
      ['diff.ignoreSubmodules', 'all'],
      ['submodule.recurse', 'false'],
      ['status.submoduleSummary', 'false'],
      // The repository belongs to the user and the command runs as the sandbox account: git is told that this is meant.
      ...(otherAccount ? ([['safe.directory', '*']] as [string, string][]) : []),
    ]
    // Git LFS, where it is installed, is a filter the machine's own git configuration defines and a `.gitattributes`
    // in the worktree selects; where it downloads from is read from a `.lfsconfig` in the worktree (measured by the
    // second audit: a request to an address the worktree named). It is told not to download: files stay pointers.
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(config.length), GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1' }
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    })
    return env
  }

  /**
   * Where a git that runs for a git-only command looks: the Git directory NEXUS recorded for the worktree and
   * the repository above it, said in its environment, so that the `.git` file of the worktree (which the task
   * can rewrite) decides nothing; and an empty file as the user-level configuration.
   */
  private gitPins(roots: SessionRoots, gitDir: string | undefined, ownIndex = false): Record<string, string> {
    const empty = join(roots.home, 'gitconfig-empty')
    if (!existsSync(empty)) writeFileSync(empty, '')
    const pins: Record<string, string> = { GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: '1' }
    if (gitDir !== undefined) {
      pins['GIT_DIR'] = gitDir
      pins['GIT_COMMON_DIR'] = resolve(gitDir, '..', '..')
      pins['GIT_WORK_TREE'] = roots.worktree
      // The index in the worktree's entry is written by the sandbox account: an entry there can name a file
      // outside the worktree, and a git that runs as the user would then read it out (`git diff`) or write it
      // (`git restore .`), both measured by the second audit. So the user's git in an ISOLATED session never
      // reads that index. It keeps one of its own beside its home, where the sandbox account has no access;
      // what gets into it comes from commits (git refuses a tree entry that steps out, measured) and from
      // the files of the worktree.
      if (ownIndex) pins['GIT_INDEX_FILE'] = join(dirname(roots.home), 'git-index')
    }
    return pins
  }

  /** The launcher itself needs almost nothing; what the command gets is in its spec. */
  private launcherEnv(): Record<string, string> {
    const base = this.deps.baseEnv()
    const env: Record<string, string> = {}
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
      const value = base[name]
      if (value !== undefined) env[name] = value
    }
    return env
  }

  /**
   * Removes what ended sessions left: their temporary and home directories, and spec files older than a day.
   * Called at start and when a mission ends. The project caches are kept.
   */
  sweep(keepSessions: (dirName: string) => boolean = () => false): { removed: number } {
    let removed = 0
    // Nothing is removed in a sandbox root that did not pass its verification: what is there is then not known to be NEXUS's.
    const verified = (this.deps.accountProblem?.() ?? null) === null ? this.deps.account() : null
    const stateRoots = [this.deps.sandboxDir, ...(verified ? [verified.root] : [])]
    for (const stateRoot of stateRoots) {
      const sessions = join(stateRoot, 'sessions', shortHash(this.deps.sandboxDir))
      if (existsSync(sessions)) {
        for (const name of readdirSync(sessions)) {
          if (keepSessions(name)) continue
          try {
            rmSync(join(sessions, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
            removed += 1
          } catch {
            // In use by a process that is still ending; the next sweep takes it.
          }
        }
      }
      const specs = join(stateRoot, 'specs')
      if (existsSync(specs)) {
        const cutoff = Date.now() - 86_400_000
        for (const name of readdirSync(specs)) {
          try {
            if (statSync(join(specs, name)).mtimeMs < cutoff) rmSync(join(specs, name), { force: true })
          } catch {
            // gone already
          }
        }
      }
    }
    this.labeled.clear()
    return { removed }
  }
}
