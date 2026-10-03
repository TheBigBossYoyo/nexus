import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { NexusError } from '@shared/result'
import { runProcess } from './run-process'
import type { ProcessResult, RunProcessOptions } from './run-process'

const OPERATOR_HELP =
  'Shell control operators (&&, ||, |, &, ;, >, <, backticks, $()) are not supported; configure a single command'

/**
 * Splits a command line into argv without invoking a shell. Single and double quotes group;
 * backslashes are literal (Windows paths) except `\"` inside double quotes. Unquoted shell
 * control operators are rejected rather than interpreted.
 */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null

  const reject = (what: string): never => {
    throw new NexusError('invalid_input', `Command line contains "${what}". ${OPERATOR_HELP}`, { commandLine })
  }

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' &&commandLine[i + 1] === '"') {
        current += '"'
        i++
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (ch === '\r' || ch === '\n') {
      reject('newline')
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
    } else if (ch === '&' || ch === '|') {
      reject(commandLine[i + 1] === ch ? ch + ch : ch)
    } else if (ch === ';' || ch === '>' || ch === '<' || ch === '`') {
      reject(ch)
    } else if (ch === '$' && commandLine[i + 1] === '(') {
      reject('$(')
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) throw new NexusError('invalid_input', `Unterminated ${quote} quote in command line`, { commandLine })
  if (inToken) tokens.push(current)
  if (tokens.length === 0) throw new NexusError('invalid_input', 'Command line is empty')
  return tokens
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

const WINDOWS_RUNNABLE = new Set(['.exe', '.com', '.cmd', '.bat'])

/** Resolves an executable name against PATH (honouring PATHEXT on Windows). Null when not found. */
export async function resolveExecutable(
  name: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const env = opts.env ?? process.env
  const win = process.platform === 'win32'
  const pathExt = win
    ? (envGet(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.toLowerCase())
        .filter((e) => WINDOWS_RUNNABLE.has(e))
    : ['']

  const candidatesFor = (base: string): string[] => {
    if (!win) return [base]
    const own = extname(base).toLowerCase()
    const list = WINDOWS_RUNNABLE.has(own) ? [base] : []
    for (const ext of pathExt) list.push(base + ext)
    return list
  }

  const check = async (p: string): Promise<boolean> => {
    if (!(await isFile(p))) return false
    if (win) return true
    try {
      await access(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  const hasDir = name.includes('/') || name.includes(sep)
  const dirs = hasDir
    ? [isAbsolute(name) ? '' : opts.cwd]
    : (envGet(env, 'PATH') ?? '').split(delimiter).filter((d) => d.length > 0)

  for (const dir of dirs) {
    const base = hasDir ? (dir === '' ? name : resolve(dir, name)) : join(dir.replace(/^"(.*)"$/, '$1'), name)
    for (const candidate of candidatesFor(base)) {
      if (await check(candidate)) return candidate
    }
  }
  return null
}

const CMD_META = /[()%!^"<>&|]/g

/** Quotes one argument for the MSVC runtime, then caret-escapes it so cmd.exe passes it through literally. */
export function escapeForCmd(arg: string): string {
  if (/[\0\r\n]/.test(arg)) {
    throw new NexusError('invalid_input', 'Arguments for .cmd/.bat files cannot contain newlines')
  }
  let a = arg.replace(/(\\*)"/g, '$1$1\\"')
  a = a.replace(/(\\+)$/, '$1$1')
  const quoted = `"${a}"`.replace(CMD_META, '^$&')
  // Batch files re-parse %* once more, so every meta character must survive two rounds.
  return quoted.replace(CMD_META, '^$&')
}

/** Runs a user/project-configured command line such as "pnpm test" without a shell. */
export async function runCommandLine(commandLine: string, opts: RunProcessOptions): Promise<ProcessResult> {
  const [name, ...args] = tokenizeCommandLine(commandLine)
  const resolved = await resolveExecutable(name!, { cwd: opts.cwd, env: opts.env })
  if (!resolved) {
    throw new NexusError('not_found', `Executable "${name}" was not found on PATH`, { commandLine, cwd: opts.cwd })
  }
  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const env = opts.env ?? process.env
    const comspec = envGet(env, 'ComSpec') ?? 'cmd.exe'
    // The program path is plainly quoted (caret-escaped quotes would not protect spaces in it);
    // cmd.exe would still expand %VAR% inside the quotes, so refuse such paths.
    if (resolved.includes('%')) {
      throw new NexusError('invalid_input', `Cannot run a batch file whose path contains "%": ${resolved}`)
    }
    const line = [`"${resolved}"`, ...args.map(escapeForCmd)].join(' ')
    return runProcess(comspec, ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true })
  }
  return runProcess(resolved, args, opts)
}
