import { lookup } from 'node:dns/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
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
  /** The SID of the account NEXUS verified. The launcher starts nothing as any other account. */
  sid?: string
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
   * The name of the command's desktop (letters, digits, '-'). Every contained command runs on a desktop of its
   * own, which the launcher makes: what it shows is on no screen, it takes none of the user's input and it cannot
   * read the user's screen. Without a name the launcher picks one. An application with a window that NEXUS looks
   * at through its debugging port is given one.
   */
  desktop?: string
  /** Where the launcher writes what the job did (process count, peak memory, exit). */
  reportPath?: string
  /** Required for ISOLATED. */
  sandbox?: SandboxAccountRef
  /**
   * ISOLATED only: the name of the AppContainer the command is started in, with no capability. Windows then
   * looks up no name for it, shows it nothing of the machine's name cache and lets none of its packets out.
   */
  appContainer?: string
}

/**
 * The AppContainer every command of the ISOLATED profile is started in. A name: Windows derives the same SID
 * from it on every machine. It holds one capability, NEXUS's own and of the same name, which Windows gives no
 * meaning; the elevated setup (native/sandbox-setup) and NEXUS open the sandbox's folders to that capability.
 * (Not to the AppContainer's own SID: an access list that names an AppContainer keeps every low-integrity
 * program out of the folder. Measured.) It holds none of Windows' capabilities, so Windows looks up no name for
 * it, shows it nothing of the machine's name cache and lets none of its packets out; the loopback, where
 * NEXUS's proxy listens, is all the network it has.
 */
export const SANDBOX_APP_CONTAINER = 'NexusSandbox.Contained.1'

/**
 * Windows rewrites three variables of a process it starts in an AppContainer, from the LOCALAPPDATA it is
 * given: LOCALAPPDATA itself becomes `<it>\Packages\<name>\AC`, TEMP and TMP `<that>\Temp` (measured). The
 * directories are not made by Windows. This makes them and returns the temporary directory the command will see.
 */
export function appContainerDirs(localAppData: string, name: string = SANDBOX_APP_CONTAINER): { localAppData: string; temp: string } {
  const local = join(localAppData, 'Packages', name.toLowerCase(), 'AC')
  const temp = join(local, 'Temp')
  mkdirSync(temp, { recursive: true })
  return { localAppData: local, temp }
}

/** A name every Windows machine asks for by itself (the connectivity check), used to see whether a contained process gets names looked up. */
const DNS_PROBE_NAME = 'dns.msftncsi.com'

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
    if (spec.sandbox.sid !== undefined) {
      if (!/^S-1-5-21-[0-9-]{5,100}$/.test(spec.sandbox.sid)) throw new Error('The sandbox account has no usable SID.')
      lines.push(`account-sid=${spec.sandbox.sid}`)
    }
    if (spec.appContainer !== undefined) {
      if (!/^[A-Za-z0-9.-]{1,64}$/.test(spec.appContainer)) throw new Error('An AppContainer name is letters, digits, dots and hyphens.')
      lines.push(`appcontainer=${spec.appContainer}`)
    }
  } else if (spec.appContainer !== undefined) {
    throw new Error('An AppContainer is part of the ISOLATED profile only.')
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
  /** Why the sandbox account's launcher could not be put in place, when that failed. */
  sandboxError?: string
  /** Directories of the sandbox root every session reads and none may write (the tools, the launcher's copies). ISOLATED only. */
  sharedReadOnly?: readonly string[]
}

export class Launcher {
  private readonly checks = new Map<ContainmentProfile, ContainmentCheck>()
  private containerSid: string | null = null
  private capability: string | null = null

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

  /**
   * Narrows a named pipe that already listens to the current user and the system, and keeps out everything
   * below medium integrity (reading included). Throws when it could not be done: a pipe that is to be
   * protected and is not must not be used.
   */
  async protectPipe(pipe: string): Promise<void> {
    const result = await runProcess(this.options.executable, ['pipe-protect', pipe], { cwd: dirname(this.options.executable), timeoutMs: 20_000, env: minimalEnv() })
    if (result.exitCode !== 0) throw new Error(`The runtime's pipe could not be protected: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }

  /** The SID of the AppContainer of the ISOLATED profile, as the launcher itself derives it. */
  async appContainerSid(): Promise<string> {
    if (this.containerSid !== null) return this.containerSid
    const result = await runProcess(this.options.executable, ['appcontainer-sid', SANDBOX_APP_CONTAINER], { cwd: dirname(this.options.executable), timeoutMs: 20_000, env: minimalEnv() })
    const sid = result.stdout.trim()
    if (result.exitCode !== 0 || !/^S-1-15-2-[0-9-]{10,120}$/.test(sid)) throw new Error(`The AppContainer's identifier could not be derived: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    this.containerSid = sid
    return sid
  }

  /** The SID of NEXUS's own capability, the one thing the AppContainer holds: what access lists name. */
  async capabilitySid(): Promise<string> {
    if (this.capability !== null) return this.capability
    const result = await runProcess(this.options.executable, ['capability-sid', SANDBOX_APP_CONTAINER], { cwd: dirname(this.options.executable), timeoutMs: 20_000, env: minimalEnv() })
    const sid = result.stdout.trim()
    if (result.exitCode !== 0 || !/^S-1-15-3-1024-[0-9-]{10,140}$/.test(sid)) throw new Error(`The sandbox's capability could not be derived: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    this.capability = sid
    return sid
  }

  /**
   * Lets the AppContainer write in a directory tree of the sandbox, by its capability. Without an entry of its
   * own an AppContainer writes nowhere, whatever the account may do.
   */
  async grantContainer(path: string): Promise<void> {
    const sid = await this.capabilitySid()
    const system32 = join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')
    const result = await runProcess(join(system32, 'icacls.exe'), [path, '/grant', `*${sid}:(OI)(CI)(M)`, '/Q'], { cwd: system32, timeoutMs: 10 * 60_000, env: minimalEnv(), maxOutputBytes: 64 * 1024 })
    if (result.exitCode !== 0) throw new Error(`The AppContainer could not be let into ${path}: ${(result.stderr.trim() || result.stdout.trim()).slice(-300)}`)
  }

  /**
   * Takes a directory tree of the sandbox away from the AppContainer: its capability has no entry there any
   * more, inherited or its own. An integrity label does not do this: a process in an AppContainer reads a file
   * labeled "no read from below" and replaces one labeled "no write from below" (measured). What keeps it out
   * of a place is that its capability has no entry there, and nothing else.
   */
  async closeToContainer(path: string): Promise<void> {
    const sid = await this.capabilitySid()
    const system32 = join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')
    for (const args of [[path, '/inheritance:d', '/Q'], [path, '/remove', `*${sid}`, '/T', '/Q']]) {
      const result = await runProcess(join(system32, 'icacls.exe'), args, { cwd: system32, timeoutMs: 10 * 60_000, env: minimalEnv(), maxOutputBytes: 64 * 1024 })
      if (result.exitCode !== 0) throw new Error(`${path} could not be closed to the AppContainer: ${(result.stderr.trim() || result.stdout.trim()).slice(-300)}`)
    }
  }

  /**
   * Takes away every entry of its own the capability has in a tree, and leaves what the tree inherits (reading,
   * from the sandbox root). For the places contained code of every session reads and none may write: the tools
   * and the launcher's copies. An entry to write there, from whatever made it, would let one session change what
   * the next one runs.
   */
  async withdrawContainerEntries(path: string): Promise<void> {
    const sid = await this.capabilitySid()
    const system32 = join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')
    const icacls = (args: string[]): ReturnType<typeof runProcess> => runProcess(join(system32, 'icacls.exe'), args, { cwd: system32, timeoutMs: 10 * 60_000, env: minimalEnv(), maxOutputBytes: 256 * 1024 })
    // Looked at first, the directory and what lies directly in it: walking a tree of tools at every start would
    // cost minutes, and an entry of its own is the exception. icacls marks what is inherited with "(I)".
    const listed = await icacls([path])
    const below = await icacls([join(path, '*')])
    if (listed.exitCode !== 0) throw new Error(`The access list of ${path} could not be read: ${(listed.stderr.trim() || listed.stdout.trim()).slice(-300)}`)
    const hasOwn = (text: string): boolean => text.split(/\r?\n/).some((line) => line.includes(`${sid}:`) && !line.includes(`${sid}:(I)`))
    const targets: string[] = []
    if (hasOwn(listed.stdout)) targets.push(path)
    if (below.exitCode === 0 && hasOwn(below.stdout)) {
      for (const name of readdirSync(path)) {
        const child = join(path, name)
        const one = await icacls([child])
        if (one.exitCode === 0 && hasOwn(one.stdout)) targets.push(child)
      }
    }
    // Only where an entry of its own is: Windows then recomputes what lies below that one place.
    for (const target of targets) {
      const result = await icacls([target, '/remove:g', `*${sid}`, '/Q'])
      if (result.exitCode !== 0) throw new Error(`The entries of the AppContainer in ${target} could not be taken away: ${(result.stderr.trim() || result.stdout.trim()).slice(-300)}`)
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
   * be a different account in an AppContainer, unable to read a directory of the user's, without a route to
   * the Internet, without names looked up for it and without sight of the machine's name cache.
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
    if (profile === 'ISOLATED' && place.sandboxError !== undefined) return done(false, `The sandbox account on record cannot be used: ${place.sandboxError}`)
    if (profile === 'ISOLATED' && (place.sandbox === undefined || !existsSync(place.sandbox.credentialPath))) return done(false, 'The sandbox account is not set up on this machine.')
    const id = randomBytes(6).toString('hex')
    const root = join(place.scratchRoot, `verify-${id}`)
    const inside = join(root, 'inside')
    const beside = join(root, 'beside')
    const secret = join(root, 'secret')
    const userOnly = profile === 'ISOLATED' && place.userOnlyRoot !== undefined ? join(place.userOnlyRoot, `verify-${id}`) : null
    const shared = profile === 'ISOLATED' ? (place.sharedReadOnly ?? []).filter((dir) => existsSync(dir)) : []
    // What the account's request is checked against: a listener here that answers anything.
    const control = profile === 'ISOLATED' ? createServer((_req, res) => res.end('ok')) : null
    let controlPort = 0
    try {
      if (control !== null) {
        await new Promise<void>((resolve, reject) => control.once('error', reject).listen(0, '127.0.0.1', resolve))
        controlPort = (control.address() as AddressInfo).port
      }
      for (const dir of [inside, beside, secret]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(secret, 'sentinel.txt'), 'nexus-verify-sentinel')
      if (userOnly !== null) {
        mkdirSync(userOnly, { recursive: true })
        writeFileSync(join(userOnly, 'sentinel.txt'), 'nexus-verify-user-sentinel')
      }
      await this.label('low', inside)
      if (profile === 'ISOLATED') await this.grantContainer(inside)
      await this.label('protect', secret)
      // Under ISOLATED the protected place is one the AppContainer's capability has no entry on: that, and not
      // a label, is what keeps an AppContainer out, and it is how everything outside the sandbox root is kept.
      if (profile === 'ISOLATED') await this.closeToContainer(secret)
      const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
      // cmd.exe and tools of System32 only: present on every Windows, no runtime to load, no dialog of their own.
      const lines = [
        `echo ok> "${join(inside, 'w.txt')}"`,
        `(echo x> "${join(beside, 'w.txt')}") 2>nul`,
        `(type "${join(secret, 'sentinel.txt')}" > "${join(inside, 'r.txt')}") 2>nul`,
        `"${join(systemRoot, 'System32', 'whoami.exe')}" > "${join(inside, 'who.txt')}" 2>nul`,
      ]
      if (userOnly !== null) lines.push(`(type "${join(userOnly, 'sentinel.txt')}" > "${join(inside, 'u.txt')}") 2>nul`)
      // A public address over HTTP: reached means the account has a route out. That the same request fails could
      // also mean that the request cannot be made at all here (no curl, no network), so its counterpart is made
      // first, to an address the account must reach: a listener of this process on the loopback.
      let namesHere = false
      const env = minimalEnv(inside)
      if (profile === 'ISOLATED') {
        lines.push(`"${join(systemRoot, 'System32', 'curl.exe')}" -s -m 4 -o NUL http://127.0.0.1:${controlPort}/ && echo reached> "${join(inside, 'loop.txt')}"`)
        lines.push(`"${join(systemRoot, 'System32', 'curl.exe')}" -s -m 4 -o NUL http://1.1.1.1/ && echo reached> "${join(inside, 'net.txt')}"`)
        // Names. Windows looks a name up for whoever asks, in a service of its own that no firewall rule for an
        // account sees: an address in the answer means the contained process got a name looked up (or read from
        // the cache), and a long listing means it was shown the cache. Both in the ways a program would ask:
        // the resolver every program uses (ping), a query of its own (nslookup), a request by name (curl).
        lines.push(`("${join(systemRoot, 'System32', 'PING.EXE')}" -4 -n 1 -w 200 ${DNS_PROBE_NAME} > "${join(inside, 'name.txt')}") 2>nul`)
        lines.push(`("${join(systemRoot, 'System32', 'nslookup.exe')}" -timeout=2 -retry=1 ${DNS_PROBE_NAME} > "${join(inside, 'query.txt')}") 2>nul`)
        lines.push(`"${join(systemRoot, 'System32', 'curl.exe')}" -s -m 4 -o NUL http://${DNS_PROBE_NAME}/ && echo reached> "${join(inside, 'byname.txt')}"`)
        lines.push(`("${join(systemRoot, 'System32', 'ipconfig.exe')}" /displaydns > "${join(inside, 'cache.txt')}") 2>nul`)
        // The canonical form of a path, asked from inside by the account's own copy of this launcher. Node's native
        // realpath, Rust's canonicalize and the installer of Electron ask Windows the same; inside an AppContainer
        // the answer needs the entry the setup (and, after a restart of Windows, its startup task) puts on the
        // Mount Manager device.
        if (place.sandbox) lines.push(`("${place.sandbox.stage2Path}" canonical "${inside}" > "${join(inside, 'canonical.txt')}") 2>nul`)
        // What every session reads and none may write: a file made there by this command means the next session
        // would run what this one left.
        for (const [i, dir] of shared.entries()) lines.push(`(echo x> "${join(dir, `nexus-verify-${id}-${i}.txt`)}") 2>nul`)
        // What the same question gives outside the containment, so that "no answer" inside is not read as more than it is.
        namesHere = await lookup(DNS_PROBE_NAME).then(() => true, () => false)
        // An AppContainer is started only with a home to derive its own directories from.
        const home = join(inside, 'home')
        env['USERPROFILE'] = home
        env['APPDATA'] = join(home, 'AppData', 'Roaming')
        env['LOCALAPPDATA'] = join(home, 'AppData', 'Local')
        mkdirSync(env['APPDATA'], { recursive: true })
        appContainerDirs(env['LOCALAPPDATA'])
      }
      lines.push('exit /b 0')
      const comspec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe'
      const specPath = this.writeSpec({ profile, cwd: inside, commandLine: `${quoteArg(comspec)} /d /s /c "${lines.join(' & ')}"`, env, timeoutMs: 60_000, maxProcesses: 16, ...(place.sandbox ? { sandbox: place.sandbox } : {}), ...(profile === 'ISOLATED' ? { appContainer: SANDBOX_APP_CONTAINER } : {}) })
      const { file, args } = this.invocation(specPath)
      const result = await runProcess(file, args, { cwd: inside, timeoutMs: 75_000, env: minimalEnv() })
      this.removeSpec(specPath)
      const read = (name: string): string => (existsSync(join(inside, name)) ? readFileSync(join(inside, name), 'utf8') : '')
      if (result.exitCode !== 0) return done(false, `The launcher could not run a contained command (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`)
      if (!existsSync(join(inside, 'w.txt'))) return done(false, 'A contained process could not write in its own directory.')
      if (existsSync(join(beside, 'w.txt'))) return done(false, 'A contained process wrote outside its directory: the containment does not hold on this machine.')
      if (read('r.txt').includes('nexus-verify-sentinel')) return done(false, 'A contained process read a protected file: the containment does not hold on this machine.')
      if (profile === 'RESTRICTED') return done(true, 'Verified at this start: a contained process wrote in its own directory, was refused beside it, and was refused a protected file. It runs as you: your network, credential vault, unprotected files and screen are within its reach.')
      const who = read('who.txt').trim().toLowerCase()
      const self = `${(process.env['USERDOMAIN'] ?? '').toLowerCase()}\\${(process.env['USERNAME'] ?? '').toLowerCase()}`
      if (who === '' || who === self) return done(false, 'The contained process did not run as the sandbox account.')
      if (read('u.txt').includes('nexus-verify-user-sentinel')) return done(false, "The sandbox account read a file in the user's profile: the containment does not hold on this machine.")
      for (const [i, dir] of shared.entries()) {
        const planted = join(dir, `nexus-verify-${id}-${i}.txt`)
        if (existsSync(planted)) {
          rmSync(planted, { force: true })
          return done(false, `A contained process wrote in ${dir}, which every session reads: one session could change what the next one runs. The containment does not hold on this machine.`)
        }
      }
      if (read('net.txt').includes('reached')) return done(false, 'The sandbox account reached the Internet directly: its firewall rule is missing or not effective.')
      // Without the counterpart the failed request proves nothing: said as it is.
      if (!read('loop.txt').includes('reached')) return done(false, 'Whether the sandbox account has a route to the Internet could not be established: its test request did not even reach NEXUS on this machine.')
      const address = /\b\d{1,3}(\.\d{1,3}){3}\b/
      if (address.test(read('name.txt'))) return done(false, 'Windows looked up a name for the contained process: it is not in an AppContainer that holds, and a name it asks for can be seen outside.')
      // nslookup names its server first; an address after the name asked for is an answer.
      const query = read('query.txt')
      const asked = query.toLowerCase().lastIndexOf(DNS_PROBE_NAME)
      if (asked >= 0 && address.test(query.slice(asked))) return done(false, 'The contained process got an answer to a name query of its own: its packets are not kept in.')
      if (read('byname.txt').includes('reached')) return done(false, 'The contained process reached a server by its name: it has a route out.')
      if (read('cache.txt').split(/\r?\n/).filter((line) => line.trim() !== '').length > 8) return done(false, "The contained process was shown the machine's cache of looked-up names.")
      // Not a hole, a broken tool chain: said as what it is, and as unusable, so that nothing fails later in a way nobody understands.
      if (!read('canonical.txt').toLowerCase().includes(inside.toLowerCase().slice(2))) return done(false, 'Windows gives a contained process no canonical form of a path: the entry of the sandbox on the Mount Manager device is missing (it is restored at every start of Windows by the startup task of the setup). Run the sandbox setup again.')
      return done(true, `Verified at this start: a contained process ran as ${who} in an AppContainer that holds none of Windows' capabilities, wrote in its own directory, was refused beside it, was refused a protected file and a file in your profile${shared.length > 0 ? ', could not write where the shared tools lie' : ''}, reached NEXUS on this machine, had no direct route to the Internet, got no name looked up (by the resolver, by a query of its own, by a request) and was not shown the machine's name cache.${namesHere ? '' : ' Names could not be looked up from this machine at all at that moment, so the refusal of names was seen only as far as that goes.'}`)
    } catch (e) {
      return done(false, `The containment could not be verified: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      control?.close()
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
