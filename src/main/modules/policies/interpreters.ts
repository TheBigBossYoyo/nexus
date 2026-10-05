/**
 * Recognises interpreters by the resolved executable name (not the file extension of what they run) and
 * works out what each invocation runs: a script file, inline code, a module, or nothing inspectable.
 */

export type InterpreterFamily = 'powershell' | 'cmd' | 'python' | 'node' | 'posix_shell' | 'wsh' | 'mshta' | 'deno' | 'bun' | 'ts_runner' | 'ruby' | 'perl' | 'php'

/** What one interpreter invocation executes. */
export type InterpreterTarget =
  | { kind: 'script'; path: string; extraPaths: string[] }
  | { kind: 'inline'; code: string; flag: string }
  /** `python -m pytest`, `node --test`, `deno test`: a named tool or module, not a file. */
  | { kind: 'module'; name: string }
  | { kind: 'encoded'; payload: string }
  | { kind: 'version' }
  | { kind: 'interactive' }
  | { kind: 'none' }

export interface Interpreter {
  family: InterpreterFamily
  /** Lowercase base name without extension, e.g. "powershell". */
  name: string
}

const EXT = /\.(exe|cmd|bat|com)$/i

/** Lowercase base name of a command word with a Windows executable extension removed. */
export function executableName(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(EXT, '')
  return base
}

const TABLE: Record<string, InterpreterFamily> = {
  powershell: 'powershell', pwsh: 'powershell', powershell_ise: 'powershell',
  cmd: 'cmd',
  python: 'python', python3: 'python', py: 'python', pythonw: 'python', pypy: 'python', pypy3: 'python',
  node: 'node', nodejs: 'node',
  bash: 'posix_shell', sh: 'posix_shell', zsh: 'posix_shell', dash: 'posix_shell', ksh: 'posix_shell', fish: 'posix_shell',
  wscript: 'wsh', cscript: 'wsh',
  mshta: 'mshta',
  deno: 'deno',
  bun: 'bun',
  tsx: 'ts_runner', 'ts-node': 'ts_runner', 'ts-node-esm': 'ts_runner', 'ts-node-script': 'ts_runner',
  ruby: 'ruby',
  perl: 'perl',
  php: 'php',
}

/** The interpreter a command word names, or null. Handles full paths, `.exe` suffixes, case and `python3.11`. */
export function interpreterFor(word: string): Interpreter | null {
  const candidates = new Set([executableName(word), executableName(word.replace(/[\^`"'+]/g, ''))])
  for (const name of candidates) {
    const direct = TABLE[name]
    if (direct !== undefined) return { family: direct, name }
    if (/^python3?(\.\d+)*$/.test(name) || /^pypy3?(\.\d+)*$/.test(name)) return { family: 'python', name }
    if (/^node(\d+)?$/.test(name)) return { family: 'node', name }
  }
  return null
}

export const SCRIPT_EXTENSIONS = /\.(ps1|psm1|cmd|bat|sh|bash|py|pyw|js|mjs|cjs|ts|mts|cts|vbs|vbe|wsf|wsh|hta|rb|pl|php|jar)$/i

/** Script type implied by the file extension, for scripts run directly (`.\build.cmd`, `./run.sh`). */
export function familyForScriptPath(p: string): InterpreterFamily | null {
  const ext = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase()
  switch (ext) {
    case 'ps1': case 'psm1': return 'powershell'
    case 'cmd': case 'bat': return 'cmd'
    case 'sh': case 'bash': return 'posix_shell'
    case 'py': case 'pyw': return 'python'
    case 'js': case 'mjs': case 'cjs': return 'node'
    case 'ts': case 'mts': case 'cts': return 'ts_runner'
    case 'vbs': case 'vbe': case 'wsf': case 'wsh': return 'wsh'
    case 'hta': return 'mshta'
    case 'rb': return 'ruby'
    case 'pl': return 'perl'
    case 'php': return 'php'
    default: return null
  }
}

const lower = (xs: string[]): string[] => xs.map((x) => x.toLowerCase())

function firstPositional(args: string[], valueFlags: ReadonlySet<string>, from = 0): number {
  for (let i = from; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') return i + 1 < args.length ? i + 1 : -1
    if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.has(a.toLowerCase())) i++
      continue
    }
    return i
  }
  return -1
}

const none: InterpreterTarget = { kind: 'none' }

function parsePython(args: string[]): InterpreterTarget {
  const lc = lower(args)
  const VALUE = new Set(['-w', '-x', '-q'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = lc[i] ?? ''
    if (l === '-c' || /^-[a-zA-Z]*c$/.test(a)) return { kind: 'inline', code: args.slice(i + 1).join(' '), flag: '-c' }
    if (l === '-m') return { kind: 'module', name: lc[i + 1] ?? '' }
    if (l.startsWith('-m') && l.length > 2 && !l.startsWith('--')) return { kind: 'module', name: l.slice(2) }
    if (l === '-v' || l === '--version' || l === '-vv') return { kind: 'version' }
    if (l === '-') return { kind: 'interactive' }
    if (a.startsWith('-')) {
      if (VALUE.has(l)) i++
      continue
    }
    if (/^\d(\.\d+)?$/.test(a)) continue
    return { kind: 'script', path: a, extraPaths: [] }
  }
  return args.length === 0 ? { kind: 'interactive' } : none
}

function parseNode(args: string[]): InterpreterTarget {
  const lc = lower(args)
  const extra: string[] = []
  const VALUE = new Set(['--input-type', '--experimental-default-type', '--conditions', '-c', '--title', '--env-file', '--inspect-port', '--max-old-space-size', '--stack-size'])
  const PRELOAD = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = lc[i] ?? ''
    if (['-e', '--eval', '-p', '--print', '-pe'].includes(l)) return { kind: 'inline', code: args.slice(i + 1).join(' '), flag: a }
    if (/^--(?:eval|print)=/.test(l)) return { kind: 'inline', code: a.slice(a.indexOf('=') + 1), flag: a.split('=')[0] ?? a }
    if (l === '-v' || l === '--version') return { kind: 'version' }
    if (l === '--test' || l === '--watch') return { kind: 'module', name: 'node:test' }
    if (PRELOAD.has(l)) {
      if (args[i + 1] !== undefined) extra.push(args[i + 1] ?? '')
      i++
      continue
    }
    const attached = /^--(?:require|import|loader|experimental-loader)=(.+)$/.exec(a)
    if (attached?.[1] !== undefined) {
      extra.push(attached[1])
      continue
    }
    if (a.startsWith('-')) {
      if (VALUE.has(l)) i++
      continue
    }
    return { kind: 'script', path: a, extraPaths: extra }
  }
  return args.length === 0 ? { kind: 'interactive' } : none
}

function parsePowerShell(args: string[]): InterpreterTarget {
  const lc = lower(args)
  const VALUE = new Set(['-executionpolicy', '-ep', '-windowstyle', '-w', '-version', '-v', '-inputformat', '-outputformat', '-workingdirectory', '-wd', '-configurationname', '-psconsolefile', '-settingsfile', '-custompipename'])
  for (let i = 0; i < args.length; i++) {
    const l = lc[i] ?? ''
    const flag = l.slice(1)
    const isFlag = (full: string): boolean => /^-[a-z]+$/.test(l) && flag.length > 0 && full.startsWith(flag)
    if (l === '-ec' || (isFlag('encodedcommand') && flag.startsWith('e'))) return { kind: 'encoded', payload: args[i + 1] ?? '' }
    if (isFlag('command')) return { kind: 'inline', code: args.slice(i + 1).join(' '), flag: '-Command' }
    if (isFlag('file')) return { kind: 'script', path: args[i + 1] ?? '', extraPaths: [] }
    if (l.startsWith('-')) {
      if (VALUE.has(l)) i++
      continue
    }
    // A bare first argument is a script path or the start of a command line (powershell runs it as -Command).
    return SCRIPT_EXTENSIONS.test(args[i] ?? '') ? { kind: 'script', path: args[i] ?? '', extraPaths: [] } : { kind: 'inline', code: args.slice(i).join(' '), flag: '-Command' }
  }
  return args.length === 0 ? { kind: 'interactive' } : none
}

function parseCmd(args: string[]): InterpreterTarget {
  const lc = lower(args)
  for (let i = 0; i < args.length; i++) {
    const l = lc[i] ?? ''
    if (/^\/[ckr]/.test(l)) {
      const rest = [l.length > 2 ? (args[i] ?? '').slice(2) : '', ...args.slice(i + 1)].filter((x) => x !== '')
      return { kind: 'inline', code: rest.join(' '), flag: (args[i] ?? '').slice(0, 2) }
    }
    if (l.startsWith('/')) continue
    return none
  }
  return { kind: 'interactive' }
}

function parsePosixShell(args: string[]): InterpreterTarget {
  const lc = lower(args)
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = lc[i] ?? ''
    if (l === '--version') return { kind: 'version' }
    if (/^-[a-z]*c[a-z]*$/.test(a)) return { kind: 'inline', code: args.slice(i + 1).join(' '), flag: a }
    if (a === '-o' || a === '+o' || a === '--rcfile' || a === '--init-file') {
      i++
      continue
    }
    if (a.startsWith('-') || a.startsWith('+')) continue
    return { kind: 'script', path: a, extraPaths: [] }
  }
  return { kind: 'interactive' }
}

function parseWsh(args: string[]): InterpreterTarget {
  const idx = args.findIndex((a) => !a.startsWith('//'))
  return idx < 0 ? none : { kind: 'script', path: args[idx] ?? '', extraPaths: [] }
}

function parseFlagInline(args: string[], inlineFlags: string[], valueFlags: Set<string>): InterpreterTarget {
  const lc = lower(args)
  for (let i = 0; i < args.length; i++) {
    const l = lc[i] ?? ''
    if (inlineFlags.includes(l)) return { kind: 'inline', code: args.slice(i + 1).join(' '), flag: args[i] ?? '' }
    if (l === '-v' || l === '--version') return { kind: 'version' }
    if (l.startsWith('-')) {
      if (valueFlags.has(l)) i++
      continue
    }
    return { kind: 'script', path: args[i] ?? '', extraPaths: [] }
  }
  return args.length === 0 ? { kind: 'interactive' } : none
}

/** Parses the arguments of an interpreter into what it will run. */
export function parseInterpreter(it: Interpreter, args: string[]): InterpreterTarget {
  switch (it.family) {
    case 'python':
      return parsePython(args)
    case 'node':
      return parseNode(args)
    case 'powershell':
      return parsePowerShell(args)
    case 'cmd':
      return parseCmd(args)
    case 'posix_shell':
      return parsePosixShell(args)
    case 'wsh':
      return parseWsh(args)
    case 'mshta': {
      const i = firstPositional(args, new Set())
      return i < 0 ? none : { kind: 'script', path: args[i] ?? '', extraPaths: [] }
    }
    case 'ruby':
    case 'perl':
      return parseFlagInline(args, ['-e'], new Set(['-i', '-i.bak', '-i0', '-i1', '-x']))
    case 'php':
      return parseFlagInline(args, ['-r'], new Set(['-d', '-c']))
    case 'ts_runner':
      return parseFlagInline(args, ['-e', '--eval', '-p', '--print'], new Set(['-r', '--require', '--import', '--tsconfig', '-p', '--project']))
    case 'deno': {
      const lc = lower(args)
      const sub = lc.find((x) => !x.startsWith('-'))
      if (sub === 'eval') return { kind: 'inline', code: args.slice(lc.indexOf('eval') + 1).join(' '), flag: 'eval' }
      if (sub === 'run') {
        const i = firstPositional(args, new Set(['--config', '-c', '--import-map', '--lock', '--cert', '--location', '--v8-flags']), lc.indexOf('run') + 1)
        return i < 0 ? none : { kind: 'script', path: args[i] ?? '', extraPaths: [] }
      }
      if (sub === undefined) return lc.includes('--version') || lc.includes('-v') ? { kind: 'version' } : none
      return { kind: 'module', name: sub }
    }
    case 'bun': {
      const lc = lower(args)
      if (lc.includes('-e') || lc.includes('--eval')) {
        const k = lc.findIndex((x) => x === '-e' || x === '--eval')
        return { kind: 'inline', code: args.slice(k + 1).join(' '), flag: args[k] ?? '-e' }
      }
      if (lc.includes('--version') || lc.includes('-v')) return { kind: 'version' }
      const i = firstPositional(args, new Set(['--cwd', '--config', '-c', '--env-file', '--preload', '-r']))
      if (i < 0) return none
      const first = args[i] ?? ''
      if (first.toLowerCase() === 'run') {
        const j = firstPositional(args, new Set(['--cwd', '--config', '-c', '--env-file', '--preload', '-r']), i + 1)
        return j >= 0 && SCRIPT_EXTENSIONS.test(args[j] ?? '') ? { kind: 'script', path: args[j] ?? '', extraPaths: [] } : { kind: 'module', name: args[j] ?? '' }
      }
      return SCRIPT_EXTENSIONS.test(first) ? { kind: 'script', path: first, extraPaths: [] } : { kind: 'module', name: first.toLowerCase() }
    }
  }
}
