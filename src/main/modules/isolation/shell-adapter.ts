import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quoteArg } from './launcher'

/**
 * 0.8: the shell behind the agent's Bash capability, inside a containment. The capability is "run this POSIX
 * shell command in the task"; which program parses and runs it is a backend, chosen by the profile, and always
 * a program that itself runs inside the containment. The command's text, its substitutions, its redirections
 * and every process it starts are the contained shell's own: nothing of a command is parsed or started outside.
 *
 *  msys-bash    Git for Windows' bash, from a private copy of its MSYS runtime. It is what the RESTRICTED profile
 *               uses. It cannot run in an AppContainer: the MSYS runtime keeps its shared state in a kernel
 *               object directory an AppContainer may not create, and dies at its first step (measured).
 *  busybox-ash  busybox-w32: one native Windows program that is a POSIX shell (ash, with the usual bash
 *               extensions of `[[ ]]`, `$'…'`, `${var/…}`, `local`) and the Unix tools. It needs no runtime and
 *               runs in an AppContainer. It is what the ISOLATED profile uses. It is not bash: arrays and a few
 *               other bash-only constructs do not exist in it (process substitution does, and `bash` by name
 *               is this same shell). What it has and has not is listed, as tests, in shell-semantics.test.ts.
 *
 * A command the contained shell cannot parse is not run at all, and says so: the shell itself checks the whole
 * script first, inside the containment, and the failure names the construct. There is no second shell to fall
 * back to, inside or outside.
 */

export type ShellBackend = 'msys-bash' | 'busybox-ash'

/** The exit code of a command that was not run because the contained shell cannot parse it. */
export const UNSUPPORTED_SYNTAX_EXIT = 2

export interface PreparedShell {
  /** The Windows command line the launcher starts. */
  commandLine: string
}

export interface SandboxShellAdapter {
  readonly backend: ShellBackend
  /** One line for people and for the agent: what the shell is. */
  readonly describe: string
  /** Directories put first on the command's PATH. */
  pathEntries(): string[]
  /** Variables the shell needs. */
  env(): Record<string, string>
  /**
   * Writes the script of one command into `dir` (the session's own temporary directory, which the contained
   * command can read) and returns how it is started. `prelude` is text NEXUS puts before the command (a `git`
   * function that explains what cannot work); it must be valid for every backend, so it is POSIX sh.
   */
  prepare(input: { dir: string; id: string; command: string; prelude?: string }): PreparedShell
}

/** Git for Windows' bash from a private MSYS copy (see mirrorMsys). */
export function msysBashAdapter(copy: { bash: string; binDir: string; gitRoot: string }): SandboxShellAdapter {
  return {
    backend: 'msys-bash',
    describe: 'bash (Git for Windows)',
    // The copy's own tools first, then Git itself, so that `git`, `ls` and `grep` are what a Git Bash user expects.
    pathEntries: () => [copy.binDir, join(copy.gitRoot, 'mingw64', 'bin'), join(copy.gitRoot, 'cmd')],
    env: () => ({ MSYSTEM: 'MINGW64', MSYS: 'winsymlinks:nativestrict' }),
    prepare({ dir, id, command, prelude }) {
      const script = join(dir, `nx-${id}.sh`)
      writeFileSync(script, `${prelude ?? ''}${command}\n`, { flag: 'wx' })
      return { commandLine: `${quoteArg(copy.bash)} --noprofile --norc ${quoteArg(script)}` }
    },
  }
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * What the contained shell is told to do with a command: check all of it, and run it only if it parses. The
 * check and the run are the same program, inside the containment.
 */
export function busyboxRunner(script: string): string {
  const s = shQuote(script.replace(/\\/g, '/'))
  return [
    `nx_s=${s}`,
    `if ! sh -n "$nx_s" 2>"$nx_s.err"; then`,
    `  echo 'NEXUS: this command was not run. The shell inside the isolated containment is a POSIX shell (busybox ash), not bash, and it cannot parse the command:' >&2`,
    `  sed -e 's/^/  /' "$nx_s.err" >&2`,
    `  echo 'Bash-only syntax (arrays and associative arrays, coproc, select) does not exist here. Write the command without it. Nothing of it was executed.' >&2`,
    `  rm -f "$nx_s.err"`,
    `  exit ${UNSUPPORTED_SYNTAX_EXIT}`,
    `fi`,
    `rm -f "$nx_s.err"`,
    // Not `exec`: this shell's exec starts the program and ends without waiting for it, and the launcher ends the
    // whole tree when its first process has ended (measured: the command was cut off before it printed a line).
    `sh "$nx_s"`,
    `exit $?`,
    '',
  ].join('\n')
}

/** busybox-w32 from a copy the contained account can read (see mirrorBusybox). */
export function busyboxAshAdapter(copy: { busybox: string; binDir: string }, gitCmdDir: string | null): SandboxShellAdapter {
  return {
    backend: 'busybox-ash',
    describe: 'POSIX sh (busybox ash): not bash; arrays do not exist in it',
    // The shell's directory (it holds `sh.exe` for programs that start a shell by name), then Git's own programs.
    pathEntries: () => [copy.binDir, ...(gitCmdDir !== null ? [gitCmdDir] : [])],
    // SHELL names this shell: the user's own (Git's bash) is not one a contained program could start.
    env: () => ({ SHELL: join(copy.binDir, 'sh.exe') }),
    prepare({ dir, id, command, prelude }) {
      const script = join(dir, `nx-${id}.sh`)
      const runner = join(dir, `nx-${id}.run.sh`)
      writeFileSync(script, `${prelude ?? ''}${command}\n`, { flag: 'wx' })
      writeFileSync(runner, busyboxRunner(script), { flag: 'wx' })
      return { commandLine: `${quoteArg(copy.busybox)} sh ${quoteArg(runner)}` }
    },
  }
}

/**
 * The SHA-256 of the busybox-w32 build NEXUS ships (FRP-6075-g169694ebd, 64-bit, Unicode). A file that is
 * anything else is not copied and not run: the shell of the containment is a pinned program.
 */
export const BUSYBOX_SHA256: string | null = '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c'

/**
 * A copy of busybox-w32 where the contained account can read it and contained code cannot change it, with a
 * second name `sh.exe` beside it. Returns null when NEXUS has no busybox or it is not the pinned build.
 */
export function mirrorBusybox(input: { toolsRoot: string; source: string | null; expectedSha256?: string | null }): { busybox: string; binDir: string } | null {
  if (input.source === null || !existsSync(input.source)) return null
  const digest = createHash('sha256').update(readFileSync(input.source)).digest('hex')
  const expected = input.expectedSha256 === undefined ? BUSYBOX_SHA256 : input.expectedSha256
  if (expected !== null && digest !== expected.toLowerCase()) return null
  const binDir = join(input.toolsRoot, `busybox-${digest.slice(0, 16)}`)
  const busybox = join(binDir, 'busybox.exe')
  const marker = join(binDir, '.nexus-mirror.json')
  const intact = (): boolean => existsSync(marker) && existsSync(busybox) && createHash('sha256').update(readFileSync(busybox)).digest('hex') === digest
  if (!intact()) {
    rmSync(binDir, { recursive: true, force: true })
    mkdirSync(binDir, { recursive: true })
    copyFileSync(input.source, busybox)
    copyFileSync(input.source, join(binDir, 'sh.exe'))
    writeFileSync(marker, JSON.stringify({ source: input.source, sha256: digest, copiedAt: new Date().toISOString() }))
  }
  return { busybox, binDir }
}
