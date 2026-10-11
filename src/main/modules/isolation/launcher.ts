import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@main/modules/process/run-process'

/**
 * 0.8: the Node side of `nexus-launch.exe` (native/nexus-launch). NEXUS describes one command in a spec file
 * and starts the launcher on it; the launcher makes the job object and the token and is the only thing that
 * starts the command. This module writes specs, sets the integrity labels of directories, and establishes
 * once per start whether the containment really works on this machine, by running it.
 */

/**
 * What the launcher is asked to do. Both make a job object and a token with no privileges at low integrity.
 * RESTRICTED runs the command as the user. ISOLATED runs it as the machine's sandbox account, which has no
 * access to the user's profile, credential vault or keys, and no network but the loopback.
 */
export type ContainmentProfile = 'ISOLATED' | 'RESTRICTED'

/** What ISOLATED needs besides the command: who to run as, and where that account finds the launcher. */
export interface SandboxAccountRef {
  /** The DPAPI blob with the account's name and password, readable by the user alone. */
  credentialPath: string
  /** A copy of nexus-launch.exe the account can run. */
  stage2Path: string
  /** A directory the account can read, for the inner spec. */
  stage2Dir: string
}

export interface LaunchSpec {
  profile: ContainmentProfile
  cwd: string
  /** The Windows command line, as CreateProcess takes it. */
  commandLine: string
  /** The whole environment of the command. Nothing is inherited beyond it. */
  env: Record<string, string>
  maxProcesses?: number
  maxJobMemoryBytes?: number
  timeoutMs?: number
  /** A process that shows a window (an application under test). Console commands leave it false. */
  window?: boolean
  /** JOB_OBJECT_UILIMIT_* bits. Default: all of them. An application with a window needs fewer. */
  uiLimits?: number
  /**
   * A desktop made for the command, by name (letters, digits, '-'). What it shows is on no screen and takes none
   * of the user's input. For an application with a window that NEXUS looks at through its debugging port.
   */
  desktop?: string
  /** Where the launcher writes what the job did (process count, peak memory, exit). */
  reportPath?: string
  /** Required for ISOLATED. */
  sandbox?: SandboxAccountRef
}

/** Launcher exit codes that are its own, not the command's. */
export const LAUNCH_EXIT = { usage: 120, spec: 121, timeout: 124, containment: 125, start: 126 } as const

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

export function renderSpec(spec: LaunchSpec): string {
  const lines = ['version=1', `profile=${spec.profile}`, `cwd=${b64(spec.cwd)}`, `command=${b64(spec.commandLine)}`]
  for (const [name, value] of Object.entries(spec.env)) {
    if (name === '' || name.includes('=') || name.includes('\0') || value.includes('\0')) throw new Error(`An environment variable cannot be passed to a contained process: ${name.slice(0, 40)}`)
    lines.push(`env=${b64(`${name}=${value}`)}`)
  }
  if (spec.maxProcesses !== undefined) lines.push(`max-processes=${Math.floor(spec.maxProcesses)}`)
  if (spec.maxJobMemoryBytes !== undefined) lines.push(`max-job-memory=${Math.floor(spec.maxJobMemoryBytes)}`)
  if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) lines.push(`timeout-ms=${Math.floor(spec.timeoutMs)}`)
  if (spec.uiLimits !== undefined) lines.push(`ui-limits=${spec.uiLimits >>> 0}`)
  if (spec.window === true) lines.push('window=1')
  if (spec.desktop !== undefined) {
    if (!/^[a-z0-9-]{1,40}$/.test(spec.desktop)) throw new Error('A desktop name is letters, digits and hyphens.')
    lines.push(`desktop=${spec.desktop}`)
  }
  if (spec.reportPath !== undefined) lines.push(`report=${b64(spec.reportPath)}`)
  if (spec.profile === 'ISOLATED') {
    if (spec.sandbox === undefined) throw new Error('The ISOLATED profile needs the sandbox account.')
    lines.push(`credential=${b64(spec.sandbox.credentialPath)}`, `stage2=${b64(spec.sandbox.stage2Path)}`, `stage2-dir=${b64(spec.sandbox.stage2Dir)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Quotes one argument the way the Microsoft C runtime parses a command line. */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') slashes += 1
    else if (ch === '"') {
      out += `${'\\'.repeat(slashes * 2 + 1)}"`
      slashes = 0
    } else {
      out += `${'\\'.repeat(slashes)}${ch}`
      slashes = 0
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

export function commandLineOf(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteArg).join(' ')
}

export interface LauncherOptions {
  /** Absolute path of nexus-launch.exe. */
  executable: string
  /** NEXUS's own directory for spec files. Contained code has no access to it and needs none. */
  specDir: string
}

export interface ContainmentCheck {
  available: boolean
  /** What was established, or why the containment is not available. Shown to the user as it is. */
  detail: string
  checkedAt: string
}

/** The directories a verification of a profile works in: one the command may write, one beside it, one protected. */
export interface VerifyPlace {
  /** A directory under which the scratch is made. For ISOLATED it must be inside the sandbox account's root. */
  scratchRoot: string
  /** A directory the sandbox account has no access to at all (inside the user's profile). ISOLATED only. */
  userOnlyRoot?: string
  sandbox?: SandboxAccountRef
}

export class Launcher {
  private readonly checks = new Map<ContainmentProfile, ContainmentCheck>()

  constructor(private readonly options: LauncherOptions) {}

  get executable(): string {
    return this.options.executable
  }

  /** Writes a spec under a name nobody can guess and returns its path. */
  writeSpec(spec: LaunchSpec): string {
    mkdirSync(this.options.specDir, { recursive: true })
    const path = join(this.options.specDir, `${randomBytes(12).toString('hex')}.spec`)
    writeFileSync(path, renderSpec(spec), { flag: 'wx' })
    return path
  }

  removeSpec(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      // A leftover spec names a command; it starts nothing by lying there.
    }
  }

  /** The program and arguments that run a spec. */
  invocation(specPath: string): { file: string; args: string[] } {
    return { file: this.options.executable, args: ['--spec', specPath] }
  }

  /**
   * Sets the integrity label of a tree. `low`: contained code may write there. `medium`: it may read and not
   * write there, said explicitly so that a protected parent directory does not apply. `protect`: contained code may
   * neither read nor write there. `clear`: back to no label of its own. Only the label changes; the owner and
   * the access list are not touched.
   */
  async label(mode: 'low' | 'medium' | 'protect' | 'clear', path: string): Promise<void> {
    const result = await runProcess(this.options.executable, ['label', mode, path], { cwd: dirname(this.options.executable), timeoutMs: 10 * 60_000, env: minimalEnv() })
    if (result.exitCode !== 0) throw new Error(`The integrity label of ${path} could not be set: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }

  /**
   * Establishes that a profile works here, by using it. A contained process must be able to write in its own
   * directory and must not be able to write beside it or to read a protected file; under ISOLATED it must also
   * be a different account, unable to read a directory of the user's, and without a route to the Internet.
   * The answer is kept for this start. Any doubt is "not available": a profile that was not shown to hold is
   * not reported as holding.
   */
  async verify(profile: ContainmentProfile, place: VerifyPlace, force = false): Promise<ContainmentCheck> {
    const known = this.checks.get(profile)
    if (known !== undefined && !force) return known
    const done = (available: boolean, detail: string): ContainmentCheck => {
      const check = { available, detail, checkedAt: new Date().toISOString() }
      this.checks.set(profile, check)
      return check
    }
    if (process.platform !== 'win32') return done(false, 'The containment exists on Windows only.')
    if (!existsSync(this.options.executable)) return done(false, `The launcher is missing: ${this.options.executable}`)
    if (profile === 'ISOLATED' && (place.sandbox === undefined || !existsSync(place.sandbox.credentialPath))) return done(false, 'The sandbox account is not set up on this machine.')
    const id = randomBytes(6).toString('hex')
    const root = join(place.scratchRoot, `verify-${id}`)
    const inside = join(root, 'inside')
    const beside = join(root, 'beside')
    const secret = join(root, 'secret')
    const userOnly = profile === 'ISOLATED' && place.userOnlyRoot !== undefined ? join(place.userOnlyRoot, `verify-${id}`) : null
    try {
      for (const dir of [inside, beside, secret]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(secret, 'sentinel.txt'), 'nexus-verify-sentinel')
      if (userOnly !== null) {
        mkdirSync(userOnly, { recursive: true })
        writeFileSync(join(userOnly, 'sentinel.txt'), 'nexus-verify-user-sentinel')
      }
      await this.label('low', inside)
      await this.label('protect', secret)
      const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
      // cmd.exe and tools of System32 only: present on every Windows, no runtime to load, no dialog of their own.
      const lines = [
        `echo ok> "${join(inside, 'w.txt')}"`,
        `(echo x> "${join(beside, 'w.txt')}") 2>nul`,
        `(type "${join(secret, 'sentinel.txt')}" > "${join(inside, 'r.txt')}") 2>nul`,
        `"${join(systemRoot, 'System32', 'whoami.exe')}" > "${join(inside, 'who.txt')}" 2>nul`,
      ]
      if (userOnly !== null) lines.push(`(type "${join(userOnly, 'sentinel.txt')}" > "${join(inside, 'u.txt')}") 2>nul`)
      // A public resolver's address on the DNS port: reached means the account has a route out.
      if (profile === 'ISOLATED') lines.push(`"${join(systemRoot, 'System32', 'curl.exe')}" -s -m 4 -o NUL http://1.1.1.1/ && echo reached> "${join(inside, 'net.txt')}"`)
      lines.push('exit /b 0')
      const comspec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe'
      const specPath = this.writeSpec({ profile, cwd: inside, commandLine: `${quoteArg(comspec)} /d /s /c "${lines.join(' & ')}"`, env: minimalEnv(inside), timeoutMs: 30_000, maxProcesses: 16, ...(place.sandbox ? { sandbox: place.sandbox } : {}) })
      const { file, args } = this.invocation(specPath)
      const result = await runProcess(file, args, { cwd: inside, timeoutMs: 45_000, env: minimalEnv() })
      this.removeSpec(specPath)
      const read = (name: string): string => (existsSync(join(inside, name)) ? readFileSync(join(inside, name), 'utf8') : '')
      if (result.exitCode !== 0) return done(false, `The launcher could not run a contained command (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`)
      if (!existsSync(join(inside, 'w.txt'))) return done(false, 'A contained process could not write in its own directory.')
      if (existsSync(join(beside, 'w.txt'))) return done(false, 'A contained process wrote outside its directory: the containment does not hold on this machine.')
      if (read('r.txt').includes('nexus-verify-sentinel')) return done(false, 'A contained process read a protected file: the containment does not hold on this machine.')
      if (profile === 'RESTRICTED') return done(true, 'Verified at this start: a contained process wrote in its own directory, was refused beside it, and was refused a protected file. It runs as you: your network, credential vault and unprotected files are within its reach.')
      const who = read('who.txt').trim().toLowerCase()
      const self = `${(process.env['USERDOMAIN'] ?? '').toLowerCase()}\\${(process.env['USERNAME'] ?? '').toLowerCase()}`
      if (who === '' || who === self) return done(false, 'The contained process did not run as the sandbox account.')
      if (read('u.txt').includes('nexus-verify-user-sentinel')) return done(false, "The sandbox account read a file in the user's profile: the containment does not hold on this machine.")
      if (read('net.txt').includes('reached')) return done(false, 'The sandbox account reached the Internet directly: its firewall rule is missing or not effective.')
      return done(true, `Verified at this start: a contained process ran as ${who}, wrote in its own directory, was refused beside it, was refused a protected file and a file in your profile, and had no direct route to the Internet.`)
    } catch (e) {
      return done(false, `The containment could not be verified: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      try {
        await this.label('clear', secret).catch(() => undefined)
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        if (userOnly !== null) rmSync(userOnly, { recursive: true, force: true })
      } catch {
        // scratch
      }
    }
  }

  /** The last verification of a profile, or null when none was made at this start. */
  status(profile: ContainmentProfile): ContainmentCheck | null {
    return this.checks.get(profile) ?? null
  }
}

/** The little the launcher itself and cmd.exe need. */
export function minimalEnv(temp?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name] ?? process.env[name.toUpperCase()]
    if (value !== undefined) env[name] = value
  }
  const root = env['SystemRoot'] ?? 'C:\\Windows'
  env['PATH'] = `${root}\\System32;${root}`
  if (temp !== undefined) {
    env['TEMP'] = temp
    env['TMP'] = temp
  }
  return env
}
