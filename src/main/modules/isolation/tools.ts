import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, type Dirent, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 0.8: tools for the sandbox account. The account cannot read the user's profile, and that is where many
 * development tools are installed (scoop, nvm, a per-user Python). Instead of opening the profile to it, the
 * tools a project needs are copied once into the sandbox root, and the account's PATH names the copies. A
 * tool installed for all users (Program Files) is used where it is.
 */

/** Programs looked for on the user's PATH. A name that is not here is found only if it is installed for all users. */
export const MIRRORED_TOOLS = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'python', 'python3', 'pip', 'bun', 'deno', 'cargo', 'rustc', 'go', 'dotnet', 'java'] as const

const EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1']
const MAX_MIRROR_BYTES = 1500 * 1024 * 1024
const MAX_MIRROR_FILES = 120_000

export interface MirroredTool {
  name: string
  /** Where the user has it. */
  source: string
  /** The copy the account uses, or null when it was not copied. */
  mirror: string | null
  /** Why it was not copied, when it was not. */
  note: string | null
}

export interface ToolMirrorState {
  tools: MirroredTool[]
  /** PATH for the account: the copies first, then the entries of the user's PATH that every account can read. */
  path: string
}

const lower = (p: string): string => resolve(p).toLowerCase()
const inside = (root: string, p: string): boolean => lower(p) === lower(root) || lower(p).startsWith(`${lower(root)}\\`)

function findOnPath(name: string, entries: readonly string[]): string | null {
  for (const dir of entries) {
    for (const ext of EXTENSIONS) {
      const candidate = join(dir, `${name}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Node's own library (libuv) names the pipes between a process and its children `\\?\pipe\uv\<n>-<pid>`.
 * Windows lets a process in an AppContainer make pipes only under `\\?\pipe\LOCAL\`, libuv before 1.53 takes
 * the refusal for a name that is taken and tries the next one for ever: `spawn`, `exec` and `fork` with a pipe
 * hang (measured with Node 24; fixed upstream in libuv 1.53.0, 2026-09-24, which no Node release carries yet).
 * So the copy of node.exe the sandbox uses has that one name pattern replaced by one of the same length under
 * `LOCAL\`. It no longer carries the process number; two processes that try the same name are told apart by the
 * loop that was the problem: the second is refused and takes the next number.
 *
 * Only NEXUS's own copy in the sandbox root is changed, never the user's Node. The pattern must be there exactly
 * once; a file where it is not (a Node that has the fix, or another program) is left as it is. Returns what was
 * done. Programs that bring a libuv of their own (the Node inside Electron, a Node a project installs) are not
 * reached by this: a child process with a pipe started from them inside the isolated profile still hangs.
 */
const LIBUV_PIPE_OLD = Buffer.from('\\\\?\\pipe\\uv\\%llu-%lu\0', 'latin1')
const LIBUV_PIPE_NEW = Buffer.from('\\\\?\\pipe\\LOCAL\\%llu\0\0', 'latin1')

export function adaptLibuvPipes(file: string): 'adapted' | 'not-needed' | 'ambiguous' {
  const bytes = readFileSync(file)
  const first = bytes.indexOf(LIBUV_PIPE_OLD)
  if (first < 0) return 'not-needed'
  if (bytes.indexOf(LIBUV_PIPE_OLD, first + 1) >= 0) return 'ambiguous'
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, LIBUV_PIPE_NEW, 0, LIBUV_PIPE_NEW.length, first)
  } finally {
    closeSync(fd)
  }
  return 'adapted'
}

/** Whether a program is a Node whose child processes would hang in an AppContainer (see adaptLibuvPipes). */
function needsLibuvAdaptation(file: string): boolean {
  try {
    return /^node\.exe$/i.test(file.split('\\').pop() ?? '') && readFileSync(file).indexOf(LIBUV_PIPE_OLD) >= 0
  } catch {
    return false
  }
}

/** Follows a scoop shim (`name.shim` beside `name.exe`, with `path = "..."`) to the program it starts. */
function throughShim(file: string): string {
  const shim = file.replace(/\.[^.\\]+$/, '.shim')
  if (!existsSync(shim)) return file
  const m = /^\s*path\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(shim, 'utf8'))
  return m?.[1] && existsSync(m[1].trim()) ? m[1].trim() : file
}

/** The directory to copy for a tool: the top of its installation, not only the folder its executable is in. */
function installRoot(real: string): string {
  let dir = dirname(real)
  // `...\app\<version>\bin\tool.exe` and `...\node_modules\pkg\bin\tool.exe`: the installation is above `bin`.
  for (let i = 0; i < 4; i += 1) {
    const base = dir.split('\\').pop()?.toLowerCase() ?? ''
    if (base === 'bin' || base === 'scripts' || base === 'node_modules' || /^[.@]/.test(base)) dir = dirname(dir)
    else break
  }
  return dir
}

function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        files += 1
        try {
          bytes += statSync(full).size
        } catch {
          // unreadable: not counted, not copied
        }
      }
      if (files > MAX_MIRROR_FILES || bytes > MAX_MIRROR_BYTES) return { bytes, files }
    }
  }
  return { bytes, files }
}

/**
 * Finds the listed tools on the user's PATH and, for each that lives inside the user's profile, makes sure a
 * copy of its installation exists under `<sandboxRoot>\tools`. A copy is made once per installation directory
 * and version (its real path), and reused. Nothing in the user's profile is changed.
 */
export function mirrorTools(input: { sandboxRoot: string; userProfile: string; path: string; names?: readonly string[] }): ToolMirrorState {
  const entries = input.path.split(';').map((e) => e.trim().replace(/^"(.*)"$/, '$1')).filter((e) => e !== '')
  const toolsDir = join(input.sandboxRoot, 'tools')
  mkdirSync(toolsDir, { recursive: true })
  const tools: MirroredTool[] = []
  const mirroredRoots = new Map<string, string>()
  const mirrorDirs: string[] = []
  for (const name of input.names ?? MIRRORED_TOOLS) {
    const found = findOnPath(name, entries)
    if (found === null) continue
    let real: string
    try {
      real = realpathSync.native(throughShim(found))
    } catch {
      continue
    }
    // A Node installed for all users is copied all the same when its copy has to be adapted (see adaptLibuvPipes).
    const adapt = needsLibuvAdaptation(real)
    if (!inside(input.userProfile, real) && !adapt) {
      tools.push({ name, source: real, mirror: null, note: 'installed for all users; used where it is' })
      continue
    }
    const root = installRoot(real)
    // Never the profile itself or a directory just under it: an installation is deeper than that.
    if (inside(input.userProfile, real) && (lower(root) === lower(input.userProfile) || lower(dirname(root)) === lower(input.userProfile))) {
      tools.push({ name, source: real, mirror: null, note: 'its installation directory could not be told apart from the profile; not copied' })
      continue
    }
    let target = mirroredRoots.get(lower(root))
    if (target === undefined) {
      target = join(toolsDir, createHash('sha256').update(lower(root)).digest('hex').slice(0, 16))
      const marker = join(target, '.nexus-mirror.json')
      if (!existsSync(marker)) {
        const size = measure(root)
        if (size.files > MAX_MIRROR_FILES || size.bytes > MAX_MIRROR_BYTES) {
          tools.push({ name, source: real, mirror: null, note: 'its installation is too large to copy' })
          continue
        }
        rmSync(target, { recursive: true, force: true })
        cpSync(root, target, { recursive: true, dereference: false, errorOnExist: false, force: true, verbatimSymlinks: true })
        writeFileSync(marker, JSON.stringify({ source: root, copiedAt: new Date().toISOString(), files: size.files, bytes: size.bytes }))
      }
      mirroredRoots.set(lower(root), target)
    }
    const relative = dirname(real).slice(root.length)
    const dir = join(target, relative)
    // Done once per copy and recorded beside it; a copy made before this was known is adapted the first time it is seen.
    const adapted = join(target, '.nexus-libuv-pipes')
    if (adapt && !existsSync(adapted)) {
      const copy = join(dir, real.split('\\').pop() as string)
      writeFileSync(adapted, existsSync(copy) ? adaptLibuvPipes(copy) : 'missing')
    }
    if (!mirrorDirs.some((d) => lower(d) === lower(dir))) mirrorDirs.push(dir)
    tools.push({ name, source: real, mirror: join(dir, real.split('\\').pop() as string), note: null })
  }
  const shared = entries.filter((e) => !inside(input.userProfile, e))
  return { tools, path: [...mirrorDirs, ...shared].join(';') }
}

/**
 * A private copy of Git for Windows' MSYS runtime (bash and the Unix tools), for contained shells. The MSYS
 * runtime keeps shared state in a kernel object named after the path it is installed at; the one of the
 * user's own Git belongs to the user's ordinary processes, and a low-integrity process is refused it. A copy
 * at another path has a name of its own, which the contained processes create themselves. Git itself
 * (git.exe) is a native program and is used where it is installed.
 *
 * Returns the copy's bash.exe, or null when Git for Windows was not found. The copy is made once per Git
 * installation and reused.
 */
export function mirrorMsys(input: { toolsRoot: string; gitRoot: string }): { bash: string; binDir: string } | null {
  const source = join(input.gitRoot, 'usr')
  if (!existsSync(join(source, 'bin', 'bash.exe')) || !existsSync(join(source, 'bin', 'msys-2.0.dll'))) return null
  const version = `${statSync(join(source, 'bin', 'msys-2.0.dll')).size}-${statSync(join(source, 'bin', 'msys-2.0.dll')).mtimeMs}`
  const target = join(input.toolsRoot, `msys-${createHash('sha256').update(`${lower(input.gitRoot)}|${version}`).digest('hex').slice(0, 16)}`)
  const marker = join(target, '.nexus-mirror.json')
  if (!existsSync(marker)) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(join(target, 'usr'), { recursive: true })
    cpSync(join(source, 'bin'), join(target, 'usr', 'bin'), { recursive: true, force: true })
    for (const part of ['lib', 'libexec', 'ssl']) if (existsSync(join(source, part))) cpSync(join(source, part), join(target, 'usr', part), { recursive: true, force: true })
    if (existsSync(join(source, 'share', 'terminfo'))) cpSync(join(source, 'share', 'terminfo'), join(target, 'usr', 'share', 'terminfo'), { recursive: true, force: true })
    if (existsSync(join(input.gitRoot, 'etc'))) cpSync(join(input.gitRoot, 'etc'), join(target, 'etc'), { recursive: true, force: true })
    mkdirSync(join(target, 'tmp'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ source: input.gitRoot, copiedAt: new Date().toISOString() }))
  }
  return { bash: join(target, 'usr', 'bin', 'bash.exe'), binDir: join(target, 'usr', 'bin') }
}
