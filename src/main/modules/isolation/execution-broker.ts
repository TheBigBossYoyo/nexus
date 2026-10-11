import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { containedEnv } from '@main/modules/process/contained-env'
import { tokenizeCommandLine } from '@main/modules/process/command-line'
import { runProcess, type ProcessResult, type RunProcessOptions } from '@main/modules/process/run-process'
import { quoteArg, type ContainmentCheck, type ContainmentProfile, type Launcher, type LaunchSpec } from './launcher'

/**
 * 0.8: the execution broker. Whoever wants project code run (an agent's shell tool, NEXUS's own check and setup
 * commands, an application under test) asks here and gets back how it will run: under which profile, in
 * which directories, with which environment, through the launcher. A caller never gets a bare spawn by asking.
 *
 * Profiles, honestly:
 *  ISOLATED    a job object the tree cannot leave, a token with no privileges and low integrity (it can write
 *              only where NEXUS labeled a directory for it), an allowlist environment with its own home, temp
 *              and caches, and no read access to what NEXUS marked protected. It does not limit the network,
 *              and it does not stop reads of files nobody protected.
 *  RESTRICTED  the job object, the token without privileges, the allowlist environment. Files are as for the user.
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
  /** NEXUS's directory for sandbox state: `sessions/`, `cache/`, `specs/`, `verify/`. */
  sandboxDir: string
  /** The environment the allowlist is applied to (the runtime's own). */
  baseEnv: () => NodeJS.ProcessEnv
  /** Directories dropped from PATH: NEXUS's own install directory. */
  nexusPathEntries?: () => string[]
  /** Variables a project's settings add to the allowlist. */
  extraEnvNames?: (projectId: string) => string[]
  /** The commit identity for git commands an agent runs: with a home of its own git finds no user configuration. */
  gitIdentity?: () => { name: string; email: string }
  /** Told when a containment that was asked for could not be made. */
  onFailure?: (info: { projectId: string | null; detail: string }) => void
  /** Limits of one command's process tree. */
  limits?: { maxProcesses?: number; maxJobMemoryBytes?: number }
}

export type ShellKind = 'bash' | 'powershell'

export type ContainResult =
  | { ok: true; profile: ContainmentProfile; file: string; args: string[]; specPath: string; roots: SessionRoots; withheldEnv: string[] }
  | { ok: false; reason: string }

const DEFAULT_MAX_PROCESSES = 512

function shortHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16)
}

export class ExecutionBroker {
  private readonly labeled = new Set<string>()
  private shells: { bash: string | null; powershell: string } | null = null

  constructor(private readonly deps: ExecutionBrokerDeps) {}

  /** Runs the containment once to see that it holds here. See Launcher.verify. */
  verify(force = false): Promise<ContainmentCheck> {
    return this.deps.launcher.verify(join(this.deps.sandboxDir, 'verify'), force)
  }

  status(): ContainmentCheck | null {
    return this.deps.launcher.status()
  }

  /**
   * Whether a profile can be used now. ISOLATED and RESTRICTED need the launcher to have been verified at this
   * start; when it was not, the answer is no, with the reason. There is no downgrade here.
   */
  usable(profile: ExecutionProfileName): { usable: boolean; detail: string } {
    if (profile === 'STANDARD') return { usable: true, detail: 'No containment: commands run as the user.' }
    const check = this.status()
    if (check === null) return { usable: false, detail: 'The containment has not been verified at this start.' }
    return { usable: check.available, detail: check.detail }
  }

  private async ensureLow(dir: string): Promise<void> {
    const key = dir.toLowerCase()
    if (this.labeled.has(key)) return
    mkdirSync(dir, { recursive: true })
    await this.deps.launcher.label('low', dir)
    this.labeled.add(key)
  }

  /** The directories of a session, created and labeled so that a contained command may write in them. */
  async roots(session: { projectId: string; sessionKey: string; worktree: string }): Promise<SessionRoots> {
    const base = join(this.deps.sandboxDir, 'sessions', shortHash(`${session.projectId}|${session.sessionKey}|${session.worktree}`))
    const roots: SessionRoots = { worktree: session.worktree, temp: join(base, 'tmp'), home: join(base, 'home'), cache: join(this.deps.sandboxDir, 'cache', shortHash(session.projectId)) }
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

  environment(projectId: string, roots: SessionRoots, set: Record<string, string> = {}): { env: Record<string, string>; withheld: string[] } {
    const identity = this.deps.gitIdentity?.()
    return containedEnv(this.deps.baseEnv(), {
      tempDir: roots.temp,
      extraNames: this.deps.extraEnvNames?.(projectId) ?? [],
      dropPathEntries: this.deps.nexusPathEntries?.() ?? [],
      set: {
        USERPROFILE: roots.home,
        HOME: roots.home,
        APPDATA: join(roots.home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(roots.home, 'AppData', 'Local'),
        // Package managers keep their caches where the contained command may write, and read no token from the user's own configuration.
        npm_config_cache: join(roots.cache, 'npm'),
        npm_config_store_dir: join(roots.cache, 'pnpm-store'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        YARN_CACHE_FOLDER: join(roots.cache, 'yarn'),
        PIP_CACHE_DIR: join(roots.cache, 'pip'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        ELECTRON_CACHE: join(roots.cache, 'electron'),
        GIT_CONFIG_NOSYSTEM: '0',
        GIT_TERMINAL_PROMPT: '0',
        ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}),
        ...set,
      },
    })
  }

  private async findShells(): Promise<{ bash: string | null; powershell: string }> {
    if (this.shells !== null) return this.shells
    const env = this.deps.baseEnv()
    const path = (Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '').split(';').filter((d) => d !== '')
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
    // Git for Windows' bash, found from where git itself is: never the WSL launcher in System32.
    let bash: string | null = null
    for (const dir of path) {
      const clean = dir.replace(/^"(.*)"$/, '$1')
      for (const candidate of [join(clean, '..', 'bin', 'bash.exe'), join(clean, '..', 'usr', 'bin', 'bash.exe'), join(clean, '..', '..', 'bin', 'bash.exe')]) {
        if (existsSync(join(clean, 'git.exe')) && existsSync(candidate)) {
          bash = join(dirname(candidate), 'bash.exe')
          break
        }
      }
      if (bash !== null) break
    }
    let powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const dir of path) {
      const candidate = join(dir.replace(/^"(.*)"$/, '$1'), 'pwsh.exe')
      if (existsSync(candidate)) {
        powershell = candidate
        break
      }
    }
    this.shells = { bash, powershell }
    return this.shells
  }

  private fail(projectId: string | null, detail: string): ContainResult {
    try {
      this.deps.onFailure?.({ projectId, detail })
    } catch {
      // A listener's failure is not the broker's.
    }
    return { ok: false, reason: detail }
  }

  private spec(profile: ContainmentProfile, roots: SessionRoots, commandLine: string, env: Record<string, string>, extra: Partial<LaunchSpec> = {}): LaunchSpec {
    return {
      profile,
      cwd: roots.worktree,
      commandLine,
      env,
      maxProcesses: this.deps.limits?.maxProcesses ?? DEFAULT_MAX_PROCESSES,
      ...(this.deps.limits?.maxJobMemoryBytes !== undefined ? { maxJobMemoryBytes: this.deps.limits.maxJobMemoryBytes } : {}),
      ...extra,
    }
  }

  /**
   * How an agent's shell command will run. The command text is written to a script in the session's temporary
   * directory and the launcher runs the shell on that script, so nothing of the command is ever spliced into a
   * command line. Returns what to run instead of the command, or the reason nothing will run.
   */
  async containShell(input: { profile: ContainmentProfile; projectId: string; sessionKey: string; worktree: string; cwd: string; shell: ShellKind; command: string; timeoutMs?: number }): Promise<ContainResult> {
    const state = this.usable(input.profile)
    if (!state.usable) return this.fail(input.projectId, `The ${input.profile} execution profile is not available, so the command was not run: ${state.detail}`)
    try {
      const roots = await this.roots(input)
      const shells = await this.findShells()
      const { env, withheld } = this.environment(input.projectId, roots)
      const id = randomBytes(8).toString('hex')
      let commandLine: string
      if (input.shell === 'bash') {
        if (shells.bash === null) return this.fail(input.projectId, 'Git Bash was not found, so a bash command cannot be run inside the containment.')
        const script = join(roots.temp, `nx-${id}.sh`)
        writeFileSync(script, `${input.command}\n`, { flag: 'wx' })
        commandLine = `${quoteArg(shells.bash)} --noprofile --norc ${quoteArg(script)}`
      } else {
        const script = join(roots.temp, `nx-${id}.ps1`)
        // A UTF-8 byte order mark: Windows PowerShell reads a script without one in the ANSI code page.
        writeFileSync(script, `\ufeff${input.command}\nexit $LASTEXITCODE\n`, { flag: 'wx' })
        commandLine = `${quoteArg(shells.powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoteArg(script)}`
      }
      // The command starts where the agent's shell is, when that is inside the worktree; else at the worktree.
      const cwd = input.cwd.toLowerCase().startsWith(roots.worktree.toLowerCase()) && existsSync(input.cwd) ? input.cwd : roots.worktree
      const specPath = this.deps.launcher.writeSpec({ ...this.spec(input.profile, roots, commandLine, env, input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), cwd })
      const { file, args } = this.deps.launcher.invocation(specPath)
      return { ok: true, profile: input.profile, file, args, specPath, roots, withheldEnv: withheld }
    } catch (e) {
      return this.fail(input.projectId, `The containment could not be set up, so the command was not run: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Runs a command line NEXUS itself runs in a project (the dependency setup, a check command) inside the
   * containment. The command line is one the project configured; it is refused if it uses shell operators, as
   * before 0.8. Throws when the containment cannot be made: the caller records a failed command, not a run.
   */
  async runProjectCommand(input: { profile: ContainmentProfile; projectId: string; sessionKey: string; worktree: string; commandLine: string }, options: Omit<RunProcessOptions, 'cwd' | 'env'>): Promise<ProcessResult> {
    const state = this.usable(input.profile)
    if (!state.usable) {
      this.fail(input.projectId, state.detail)
      throw new Error(`The ${input.profile} execution profile is not available, so the command was not run: ${state.detail}`)
    }
    // The same validation as an uncontained run: a configured command is a program and its arguments.
    tokenizeCommandLine(input.commandLine)
    const roots = await this.roots(input)
    const { env } = this.environment(input.projectId, roots)
    const comspec = this.deps.baseEnv()['ComSpec'] ?? this.deps.baseEnv()['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe'
    const specPath = this.deps.launcher.writeSpec(this.spec(input.profile, roots, `${quoteArg(comspec)} /d /s /c "${input.commandLine}"`, env, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs + 5000 } : {}))
    try {
      const { file, args } = this.deps.launcher.invocation(specPath)
      return await runProcess(file, args, { ...options, cwd: roots.worktree, env: this.launcherEnv() })
    } finally {
      this.deps.launcher.removeSpec(specPath)
    }
  }

  /** The launcher itself needs almost nothing; what the command gets is in its spec. */
  private launcherEnv(): Record<string, string> {
    const base = this.deps.baseEnv()
    const env: Record<string, string> = {}
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
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
    const sessions = join(this.deps.sandboxDir, 'sessions')
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
    const specs = join(this.deps.sandboxDir, 'specs')
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
    this.labeled.clear()
    return { removed }
  }
}
