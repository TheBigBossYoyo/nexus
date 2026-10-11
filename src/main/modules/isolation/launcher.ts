import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@main/modules/process/run-process'

/**
 * 0.8: the Node side of `nexus-launch.exe` (native/nexus-launch). NEXUS describes one command in a spec file
 * and starts the launcher on it; the launcher makes the job object and the token and is the only thing that
 * starts the command. This module writes specs, sets the integrity labels of directories, and establishes
 * once per start whether the containment really works on this machine, by running it.
 */

/** What the launcher is asked to do. ISOLATED: job, no privileges, low integrity. RESTRICTED: job and no privileges. */
export type ContainmentProfile = 'ISOLATED' | 'RESTRICTED'

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
  /** Where the launcher writes what the job did (process count, peak memory, exit). */
  reportPath?: string
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
  if (spec.reportPath !== undefined) lines.push(`report=${b64(spec.reportPath)}`)
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

export class Launcher {
  private check: ContainmentCheck | null = null

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
   * Sets the integrity label of a tree. `low`: contained code may write there. `protect`: contained code may
   * neither read nor write there. `clear`: back to no label of its own. Only the label changes; the owner and
   * the access list are not touched.
   */
  async label(mode: 'low' | 'protect' | 'clear', path: string): Promise<void> {
    const result = await runProcess(this.options.executable, ['label', mode, path], { cwd: this.options.specDir, timeoutMs: 10 * 60_000, env: minimalEnv() })
    if (result.exitCode !== 0) throw new Error(`The integrity label of ${path} could not be set: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }

  /**
   * Establishes that the containment works here, by using it: a contained process must be able to write in a
   * low-labeled directory, must not be able to write beside it, and must not be able to read a protected one.
   * The answer is kept for this start. Any doubt is "not available": a profile that was not shown to hold is
   * not reported as holding.
   */
  async verify(scratchRoot: string, force = false): Promise<ContainmentCheck> {
    if (this.check !== null && !force) return this.check
    const done = (available: boolean, detail: string): ContainmentCheck => (this.check = { available, detail, checkedAt: new Date().toISOString() })
    if (process.platform !== 'win32') return done(false, 'The containment exists on Windows only.')
    if (!existsSync(this.options.executable)) return done(false, `The launcher is missing: ${this.options.executable}`)
    const root = join(scratchRoot, `verify-${randomBytes(6).toString('hex')}`)
    const inside = join(root, 'inside')
    const beside = join(root, 'beside')
    const secret = join(root, 'secret')
    try {
      for (const dir of [inside, beside, secret]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(secret, 'sentinel.txt'), 'nexus-verify-sentinel')
      await this.label('low', inside)
      await this.label('protect', secret)
      // cmd.exe only: present on every Windows, no runtime to load, cannot raise a dialog of its own.
      const script = [
        `echo ok> "${join(inside, 'w.txt')}"`,
        `(echo x> "${join(beside, 'w.txt')}") 2>nul`,
        `(type "${join(secret, 'sentinel.txt')}" > "${join(inside, 'r.txt')}") 2>nul`,
        'exit /b 0',
      ].join(' & ')
      const comspec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe'
      const specPath = this.writeSpec({ profile: 'ISOLATED', cwd: inside, commandLine: `${quoteArg(comspec)} /d /s /c "${script}"`, env: minimalEnv(inside), timeoutMs: 20_000, maxProcesses: 8 })
      const { file, args } = this.invocation(specPath)
      const result = await runProcess(file, args, { cwd: inside, timeoutMs: 30_000, env: minimalEnv() })
      this.removeSpec(specPath)
      if (result.exitCode !== 0) return done(false, `The launcher could not run a contained command (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`)
      if (!existsSync(join(inside, 'w.txt'))) return done(false, 'A contained process could not write in its own directory.')
      if (existsSync(join(beside, 'w.txt'))) return done(false, 'A contained process wrote outside its directory: the containment does not hold on this machine.')
      const leaked = existsSync(join(inside, 'r.txt')) ? readFileSync(join(inside, 'r.txt'), 'utf8') : ''
      if (leaked.includes('nexus-verify-sentinel')) return done(false, 'A contained process read a protected file: the containment does not hold on this machine.')
      return done(true, 'Verified at this start: a contained process wrote in its own directory, was refused beside it, and was refused a protected file.')
    } catch (e) {
      return done(false, `The containment could not be verified: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      try {
        await this.label('clear', secret).catch(() => undefined)
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // scratch
      }
    }
  }

  /** The last verification, or null when none was made at this start. */
  status(): ContainmentCheck | null {
    return this.check
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
