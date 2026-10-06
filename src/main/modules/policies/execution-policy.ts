import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { AgentRole } from '@shared/domain'
import type { Capability, ExecutionDecision, ExecutionProfile, ProvenanceKind, TrustClass } from '@shared/security'
import { classifyCommand } from './command-classifier'
import { decodeScript, inspectContent, looksBinary, MAX_INSPECT_CHARS, type ContentFinding } from './content-inspector'
import {
  executableName,
  familyForScriptPath,
  interpreterFor,
  parseInterpreter,
  SCRIPT_EXTENSIONS,
  type Interpreter,
  type InterpreterFamily,
} from './interpreters'
import { parsePackageManager, readManifest, scriptNamesFor, scriptsOf, workspaceManifests, type Manifest, type PackageManager } from './package-scripts'
import { canonicalizePath, isPathInside } from './paths'
import { originOf, type BaseFileReader, type FileOrigin, type ProvenanceTracker } from './provenance'
import { neutralizeCommitHeredocs, neutralizeInertHeredocs, tokenize } from './shell-tokenizer'
import type { Redirect, Segment, Shell } from './shell-tokenizer'

/**
 * The 0.7 interpreter and package-script policy. It looks THROUGH an interpreter invocation at what will
 * run (a script file, inline code, a package.json script) and judges that. It is static inspection: it
 * narrows what can be done by accident or by an obvious instruction, it does not confine a process once it
 * runs. docs/SECURITY.md lists exactly what it cannot see.
 */

export interface ExecutionEnv {
  role: AgentRole
  caps: ReadonlySet<Capability>
  profile: ExecutionProfile
  worktree: string
  projectRoot: string
  safeCommandPrefixes: string[][]
  tracker?: ProvenanceTracker
  base?: BaseFileReader
}

export interface VerdictItem {
  decision: ExecutionDecision
  reason: string
  trust: TrustClass
  provenance: ProvenanceKind
}

export interface ExecutionVerdict {
  decision: ExecutionDecision
  /** Reasons of the items at the final decision level, de-duplicated. */
  reasons: string[]
  trust: TrustClass
  provenance: ProvenanceKind
  items: VerdictItem[]
}

const RANK: Record<ExecutionDecision, number> = { ALLOW: 0, ALLOW_WITH_AUDIT: 1, REQUIRE_APPROVAL: 2, DENY: 3 }

export function worseDecision(a: ExecutionDecision, b: ExecutionDecision): ExecutionDecision {
  return RANK[a] >= RANK[b] ? a : b
}

export function summarizeVerdict(items: VerdictItem[]): ExecutionVerdict {
  let decision: ExecutionDecision = 'ALLOW'
  for (const i of items) decision = worseDecision(decision, i.decision)
  const top = items.filter((i) => i.decision === decision)
  const first = top[0]
  return {
    decision,
    reasons: [...new Set(top.map((i) => i.reason))],
    trust: first?.trust ?? 'TRUSTED_PROJECT_COMMAND',
    provenance: first?.provenance ?? 'not_applicable',
    items,
  }
}

const MAX_DEPTH = 5
const MAX_FILES = 40
const MAX_REFERENCES = 10
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const CLASSIFIER_CAP = 200_000

interface State {
  items: VerdictItem[]
  visited: Set<string>
  files: number
  /** Files the same command line writes; running one of them means running content that does not exist yet. */
  written: Set<string>
  commandText: string
  multiSegment: boolean
}

const shellFor = (f: InterpreterFamily): Shell => (f === 'powershell' ? 'powershell' : 'bash')

function lcKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function add(st: State, decision: ExecutionDecision, reason: string, trust: TrustClass, provenance: ProvenanceKind): void {
  st.items.push({ decision, reason, trust, provenance })
}

function insideWorktree(env: ExecutionEnv, p: string): boolean {
  return isPathInside(env.worktree, p)
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/** Commands whose arguments are text or file names to read, search or copy, not something to run. */
const TEXT_ONLY_CMDS = new Set([
  'git', 'echo', 'write-host', 'write-output', 'printf', 'rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'ls', 'dir', 'wc',
])

/**
 * The command text with the parts that are only text removed: git commit messages and inert heredocs (the same
 * exemptions the classifier makes) and segments of commands that merely print or search their arguments.
 * What is left is inspected as a whole, so a literal power command with no recognised wrapper around it
 * ([scriptblock]::Create('shutdown /s').Invoke()) is still seen.
 */
function inspectableText(command: string, shell: Shell, segs: Segment[]): string {
  let text = shell === 'bash' ? neutralizeInertHeredocs(neutralizeCommitHeredocs(command)) : command
  const all = shell === 'bash' && text !== command ? tokenize(text, shell) : segs
  all.forEach((seg, i) => {
    const n = executableName(seg.words[0] ?? '')
    const writes = seg.redirects.some((r) => !r.op.startsWith('<') && r.target !== '' && !['/dev/null', 'nul', '$null'].includes(r.target.toLowerCase()))
    const feedsNext = all[i + 1]?.sep === '|'
    if (TEXT_ONLY_CMDS.has(n) && !writes && !feedsNext && seg.raw !== '') text = text.replace(seg.raw, ' ')
  })
  return text
}

/** `npm_config_*`, `pnpm_config_*`, yarn and script-shell settings smuggled in through the environment or `config set`. */
const PM_ENV = /\b(?:npm_config_\w+|pnpm_config_\w+|yarn_\w+|bun_config_\w+|pnpm_script_src_dir)\s*=/i
const SCRIPT_SHELL = /script[-_]shell(?:\s*=\s*|\s+)['"]?([^\s'";&|]+)/gi

/** Evaluates every interpreter, script and package-manager invocation in a shell command line. */
export async function evaluateExecution(command: string, shell: Shell, env: ExecutionEnv): Promise<ExecutionVerdict> {
  const segs = tokenize(command, shell)
  const st: State = {
    items: [],
    visited: new Set(),
    files: 0,
    written: new Set(collectWriteTargets(segs).map((t) => resolveLexical(env.worktree, t))),
    commandText: command,
    multiSegment: segs.length > 1,
  }
  // The whole command text, minus what is only text: power and the other system-sensitive categories at their usual outcome.
  const text = inspectableText(command, shell, segs)
  applyFindings(
    st,
    inspectContent(text).filter((f) => f.severity !== 'audit' && f.category !== 'encoded' && f.category !== 'uninspectable'),
    'not_applicable',
    env,
    'this command',
  )
  if (/\bcmd(?:\.exe)?\b/i.test(text) && /(?:^|[\s&|(])(?:!\w+!)+[\s/-]/.test(text)) {
    add(st, 'REQUIRE_APPROVAL', 'runs a command whose name is assembled from variables at run time (!var! with delayed expansion)', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
  }
  if (PM_ENV.test(command)) add(st, 'REQUIRE_APPROVAL', 'changes package manager behaviour through npm_config_* style settings', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
  for (const m of command.matchAll(SCRIPT_SHELL)) {
    const target = m[1] ?? ''
    if (target === '' || /^(?:true|false)$/i.test(target)) continue
    await evalScriptFile(target, 'cmd', env, st, env.worktree, 0)
    add(st, 'REQUIRE_APPROVAL', 'sets the program package managers run scripts with (script-shell)', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
  }
  await evalSegments(segs, shell, env, st, env.worktree, 0)
  return summarizeVerdict(st.items)
}

function resolveLexical(cwd: string, p: string): string {
  return lcKey(path.resolve(cwd, p))
}

/** What feeds a command's standard input, when anything visible does. */
interface Fed {
  kind: 'literal' | 'file' | 'unknown'
  target?: string
}

const LITERAL_PRODUCERS = new Set(['echo', 'printf', 'write-output', 'write-host'])

function stdinFeed(seg: Segment, prev: Segment | undefined): Fed | null {
  const redirect = seg.redirects.find((r) => r.op.startsWith('<'))
  if (redirect !== undefined) return redirect.op.startsWith('<<') ? { kind: 'literal' } : { kind: 'file', target: redirect.target }
  if (seg.sep === '|') return LITERAL_PRODUCERS.has(executableName(prev?.words[0] ?? '')) ? { kind: 'literal' } : { kind: 'unknown' }
  return null
}

async function evalSegments(segs: Segment[], shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  let here = cwd
  let prev: Segment | undefined
  for (const seg of segs) {
    const next = cdTarget(seg.words, shell)
    if (next !== null) here = path.resolve(here, next)
    else await evalSegment(seg, shell, env, st, here, depth, stdinFeed(seg, prev))
    prev = seg
  }
}

/** The directory a `cd`/`Set-Location`/`pushd` segment changes to, or null for any other segment. */
function cdTarget(words: string[], shell: Shell): string | null {
  const n = executableName(words[0] ?? '')
  if (!['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(n)) return null
  const rest = words.slice(1).filter((w) => !(w.startsWith('/') && w.length === 2) && !(shell === 'powershell' && /^-(path|literalpath|passthru)$/i.test(w)))
  return rest[0] ?? null
}

// ---------------------------------------------------------------------------------------------
// File words: what a word names once Windows' own reading of it is applied
// ---------------------------------------------------------------------------------------------

/**
 * A word as Windows reads it: quotes removed, trailing dots and spaces dropped from the last name (`evil.cmd.`
 * is evil.cmd) and an alternate data stream suffix removed (`evil.cmd::$DATA`, `evil.cmd:stream`).
 */
export function normalizeWord(w: string): string {
  const x = w.trim().replace(/^["']+|["']+$/g, '')
  const cut = Math.max(x.lastIndexOf('\\'), x.lastIndexOf('/')) + 1
  const head = x.slice(0, cut)
  let base = x.slice(cut)
  const skip = cut === 0 && /^[a-zA-Z]:/.test(base) ? 2 : 0
  const colon = base.indexOf(':', skip)
  if (colon > 0) base = base.slice(0, colon)
  const trimmed = base.replace(/[. ]+$/, '')
  return head + (trimmed === '' ? base : trimmed)
}

const PATHEXT = ['.com', '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.wsf']
/** Extensions that mean "run this", whatever launches it. */
const EXEC_TYPES = /\.(cmd|bat|com|exe|ps1|psm1|vbs|vbe|wsf|wsh|hta|scr|msi|sh|bash|lnk)$/i
/** Extensions a launcher we do not know may be asked to run. */
const ARG_SCAN_EXT = /\.(cmd|bat|com|exe|ps1|psm1|vbs|vbe|wsf|wsh|hta|scr|msi|sh|bash|lnk|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|jar)$/i

/** The existing file a word names inside `cwd`, resolving a missing extension through PATHEXT; null when there is none. */
function resolveFileWord(word: string, cwd: string): string | null {
  const n = normalizeWord(word)
  if (n === '' || n.startsWith('-') || hasDynamicPart(n) || n.length > 240) return null
  const candidates = [n, ...PATHEXT.map((e) => n + e)]
  for (const c of candidates) {
    try {
      const abs = canonicalizePath(c, cwd)
      if (existsSync(abs) && statSync(abs).isFile()) return abs
    } catch {
      // not a usable path: not a file word
    }
  }
  return null
}

/** Dev tools and file utilities whose file arguments are read, searched, formatted or copied rather than launched. */
const SAFE_ARG_CMDS = new Set([
  ...TEXT_ONLY_CMDS, 'gh', 'less', 'more', 'ag', 'cp', 'copy', 'mv', 'move', 'rm', 'del', 'erase', 'rmdir', 'rd', 'mkdir', 'md', 'touch', 'xcopy', 'robocopy', 'ren', 'rename', 'attrib', 'sort', 'uniq',
  'find', 'fc', 'comp', 'diff', 'cmp', 'sed', 'awk', 'tar', 'zip', 'unzip', '7z', 'gzip', 'file', 'stat', 'tree', 'test-path', 'get-item', 'gi', 'get-childitem', 'gci', 'get-filehash', 'resolve-path',
  'set-content', 'add-content', 'out-file', 'tee', 'tee-object', 'copy-item', 'cpi', 'move-item', 'mi', 'remove-item', 'ri', 'rename-item', 'rni', 'new-item', 'ni', 'select-object', 'format-hex',
  'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'pytest', 'mypy', 'ruff', 'black', 'flake8', 'isort', 'pylint', 'pyright', 'biome', 'stylelint', 'mocha', 'ava', 'vite', 'webpack',
  'rollup', 'esbuild', 'tsup', 'electron-vite', 'electron-builder', 'cargo', 'rustc', 'gofmt', 'make', 'code', 'cursor', 'notepad', 'sha256sum', 'md5sum', 'certutil', 'wsl-ls',
])

/** Launchers whose argument is a command line to run, with the argument that holds it. */
const INLINE_LIKE_FLAGS = new Set(['-c', '-e', '-command', '-encodedcommand', '-ec', '-enc', '--eval', '-eval', '/c', '/k'])

async function evalFileByPath(abs: string, raw: string, env: ExecutionEnv, st: State, depth: number, unknownLauncher: boolean): Promise<void> {
  if (/\.(exe|com|scr|msi)$/i.test(abs)) {
    await evalProgramFile(abs, env, st, path.dirname(abs))
    return
  }
  const fam = familyForScriptPath(abs) ?? 'cmd'
  const before = st.items.length
  await evalResolvedFile(abs, raw, fam, env, st, depth, true)
  if (unknownLauncher && EXEC_TYPES.test(abs) && insideWorktree(env, abs)) {
    const origin = inNodeModules(abs) ? null : await originOf(abs, env.worktree, env.tracker, env.base)
    if (origin !== null && (origin.kind === 'agent_authored' || origin.kind === 'agent_modified')) {
      add(st, 'REQUIRE_APPROVAL', `${path.relative(env.worktree, abs).replace(/\\/g, '/')} was written or changed by an agent and is passed to a program NEXUS does not recognise, which may run it`, 'UNTRUSTED_AGENT_AUTHORED', origin.kind)
    }
  }
  void before
}

/** Arguments of an unrecognised command that name an executable-type file, or inline program text. */
async function scanArgs(exe: string, args: string[], env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = a.toLowerCase()
    if (INLINE_LIKE_FLAGS.has(l) && args[i + 1] !== undefined) {
      const code = args.slice(i + 1).join(' ')
      if (env.profile === 'RESTRICTED') add(st, 'REQUIRE_APPROVAL', `${exe} is given inline program text (${a}) and is not a program NEXUS recognises`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
      applyFindings(st, inspectContent(code), 'inline_code', env, `inline text passed to ${exe}`)
    }
    let value = a
    if (a.startsWith('-') || (a.startsWith('/') && a.length > 1 && /^\/[a-z]+[:=]/i.test(a))) {
      const m = /^[-/][\w-]+[:=](.+)$/.exec(a)
      if (m?.[1] === undefined) continue
      value = m[1]
    }
    for (const word of /\s/.test(value) ? value.split(/\s+/) : [value]) {
      const abs = resolveFileWord(word, cwd)
      if (abs === null || !ARG_SCAN_EXT.test(abs) || !insideWorktree(env, abs)) continue
      await evalFileByPath(abs, word, env, st, depth, true)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One simple command
// ---------------------------------------------------------------------------------------------

const WRAPPERS = new Set(['sudo', 'doas', 'gsudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'call', 'builtin', 'stdbuf', 'timeout', 'xargs', 'cross-env', 'cross-env-shell', 'dotenv', 'env-cmd', 'start', 'start-process', 'saps', 'wait-on'])

async function evalSegment(seg: Segment, shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number, fed: Fed | null = null): Promise<void> {
  let words = [...seg.words]
  if (depth > MAX_DEPTH) {
    add(st, 'REQUIRE_APPROVAL', 'commands are nested too deeply to inspect', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  // Leading assignments (FOO=1 cmd) and the call operators of PowerShell.
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '') || words[0] === '&' || words[0] === '.')) {
    if (words[0] === '.' && words.length > 1 && shell === 'bash') break
    words = words.slice(1)
  }
  for (let guard = 0; guard < 6 && words.length > 0; guard++) {
    const n = executableName(words[0] ?? '')
    if (!WRAPPERS.has(n)) break
    if (n === 'start-process' || n === 'saps') {
      words = startProcessInner(words.slice(1))
      continue
    }
    let j = 1
    if (n === 'start' || n === 'call') {
      while (j < words.length && /^\/[a-z]+$/i.test(words[j] ?? '')) j++
      if (n === 'start' && words[j] !== undefined && /^[^\\/.]*\s/.test(words[j] ?? '')) j++ // start "title" cmd
    } else if (n === 'timeout' && /^\d/.test(words[j] ?? '')) j++
    else if (n === 'env' || n === 'cross-env' || n === 'dotenv' || n === 'env-cmd') {
      while (j < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[j] ?? '') || (words[j] ?? '').startsWith('-') || words[j] === '--')) j++
    } else while (j < words.length && (words[j] ?? '').startsWith('-')) j++
    words = words.slice(j)
  }
  const name = words[0] === undefined ? undefined : normalizeWord(words[0])
  if (name === undefined) return

  const exe = executableName(name)
  const args = words.slice(1)

  if (exe === 'logoff' || exe === 'tsdiscon') {
    add(st, 'DENY', 'logging the user off or disconnecting the session is controlling the machine power state, which only NEXUS power control may do', 'SYSTEM_SENSITIVE', 'not_applicable')
    return
  }

  if (exe === 'concurrently' || exe === 'npm-run-all' || exe === 'run-s' || exe === 'run-p') {
    await evalRunners(exe, args, shell, env, st, cwd, depth)
    return
  }
  if (exe === 'cd' || exe === 'echo') return

  if (exe === 'npm' || exe === 'pnpm' || exe === 'yarn' || exe === 'npx' || exe === 'bunx' || exe === 'pnpx') {
    await evalPackageManager(exe === 'pnpx' ? 'npx' : exe, args, shell, env, st, cwd, depth)
    return
  }
  if (exe === 'bun') {
    const it = interpreterFor(name)
    const target = it === null ? null : parseInterpreter(it, args)
    if (it !== null && target !== null && (target.kind === 'script' || target.kind === 'inline')) {
      await evalInterpreter(it, args, shell, env, st, cwd, depth, fed)
    } else await evalPackageManager('bun', args, shell, env, st, cwd, depth)
    return
  }

  const it = interpreterFor(name)
  if (it !== null) {
    await evalInterpreter(it, args, shell, env, st, cwd, depth, fed)
    return
  }

  // bash `source x.sh` / `. x.sh`, PowerShell Import-Module .\x.psm1.
  if ((exe === 'source' || (name === '.' && shell === 'bash')) && args[0] !== undefined) {
    await evalScriptFile(args[0], 'posix_shell', env, st, cwd, depth)
    return
  }
  if (exe === 'import-module' || exe === 'ipmo') {
    const target = args.find((a) => !a.startsWith('-') && (SCRIPT_EXTENSIONS.test(normalizeWord(a)) || /\.dll$/i.test(a)))
    if (target !== undefined) await evalScriptFile(target, 'powershell', env, st, cwd, depth)
    return
  }
  // git runs a command for `bisect run`, `rebase --exec`, `submodule foreach`.
  if (exe === 'git') {
    const lc = args.map((x) => x.toLowerCase())
    const k = lc.indexOf('bisect') >= 0 && lc.indexOf('run') > lc.indexOf('bisect') ? lc.indexOf('run') : -1
    if (k >= 0 && args.length > k + 1) await evalSegment({ words: args.slice(k + 1), redirects: [], sep: '', raw: args.slice(k + 1).join(' ') }, shell, env, st, cwd, depth + 1)
    const x = lc.findIndex((v) => v === '--exec' || v === '-x' || v.startsWith('--exec='))
    if (x >= 0) await evalCommandText(lc[x]?.includes('=') ? (args[x] ?? '').slice((args[x] ?? '').indexOf('=') + 1) : (args[x + 1] ?? ''), 'bash', env, st, cwd, depth + 1)
    const fe = lc.indexOf('foreach')
    if (fe >= 0 && lc.includes('submodule')) await evalCommandText(args.slice(fe + 1).filter((v) => !v.startsWith('-')).join(' '), 'bash', env, st, cwd, depth + 1)
    return
  }

  // A file run directly: .\build.cmd, ./run.sh, `evil.cmd.`, `evil.cmd::$DATA`, or `evil2` that Windows resolves to evil2.bat.
  const direct = resolveFileWord(name, cwd)
  if (direct !== null) {
    await evalFileByPath(direct, name, env, st, depth, false)
    return
  }
  if (SCRIPT_EXTENSIONS.test(name)) {
    // Named like a script but not found here (or outside the worktree): judge the path as given.
    const fam = familyForScriptPath(name)
    if (fam !== null) await evalScriptFile(name, fam, env, st, cwd, depth)
    return
  }
  if (/[\\/]/.test(name) && /\.(exe|com|scr|msi)$/i.test(name)) {
    await evalProgramFile(name, env, st, cwd)
    return
  }

  // An unrecognised launcher (explorer, Invoke-Item, Start-Job, forfiles ...): any executable-type file among its arguments is run, as far as we know.
  if (!SAFE_ARG_CMDS.has(exe)) await scanArgs(exe, args, env, st, cwd, depth)
}

/** Words of `Start-Process FilePath -ArgumentList a,b` as a plain command line. */
function startProcessInner(args: string[]): string[] {
  const out: string[] = []
  let file: string | undefined
  let list: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = a.toLowerCase()
    if (l === '-filepath' || l === '-path') file = args[++i]
    else if (l === '-argumentlist' || l === '-args') {
      const v = args[++i] ?? ''
      list = v.split(/,(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/).flatMap((x) => x.trim().split(/\s+/)).filter((x) => x !== '')
    } else if (['-verb', '-workingdirectory', '-windowstyle', '-credential', '-redirectstandardoutput', '-redirectstandarderror', '-redirectstandardinput', '-environment'].includes(l)) i++
    else if (a.startsWith('-')) continue
    else if (file === undefined) file = a
    else list.push(a)
  }
  if (file !== undefined) out.push(file, ...list)
  return out
}

async function evalRunners(exe: string, args: string[], shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  const m = readManifest(cwd)
  for (const a of args) {
    if (a.startsWith('-')) continue
    if (exe === 'concurrently') {
      // Each quoted argument is a complete command line.
      await evalCommandText(a, shell, env, st, cwd, depth + 1)
    } else if (m !== null) {
      for (const name of Object.keys(m.scripts).filter((s) => (a.includes('*') ? new RegExp(`^${a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s) : s === a))) {
        await evalScriptBody(m, name, env, st, depth, [])
      }
    }
  }
}

async function evalCommandText(text: string, shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  await evalSegments(tokenize(text, shell), shell, env, st, cwd, depth)
}

// ---------------------------------------------------------------------------------------------
// Interpreters
// ---------------------------------------------------------------------------------------------

const SHELL_FAMILIES = new Set<InterpreterFamily>(['powershell', 'cmd', 'posix_shell'])
const KNOWN_PY_MODULES = new Set(['pytest', 'unittest', 'mypy', 'pip', 'venv', 'ensurepip', 'black', 'ruff', 'flake8', 'pylint', 'coverage', 'tox', 'build', 'twine', 'json.tool', 'http.server', 'compileall', 'doctest', 'pydoc', 'timeit', 'nose', 'isort', 'pyright', 'poetry', 'pipenv', 'uv', 'virtualenv', 'django', 'flask', 'uvicorn', 'gunicorn', 'sphinx', 'alembic'])

async function evalInterpreter(it: Interpreter, args: string[], shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number, fed: Fed | null = null): Promise<void> {
  let t = parseInterpreter(it, args)
  const restricted = env.profile === 'RESTRICTED'
  // A bare interpreter with something piped or redirected into it reads its program from standard input.
  if ((t.kind === 'interactive' || t.kind === 'none') && fed !== null) t = { kind: 'stdin' }
  if (t.kind === 'version' || t.kind === 'interactive' || t.kind === 'none') return
  if (!env.caps.has('INTERPRETER_EXEC')) {
    add(st, 'DENY', `the ${env.role} role has no INTERPRETER_EXEC capability, so it cannot run ${it.name}`, 'UNTRUSTED_AGENT_AUTHORED', 'not_applicable')
    return
  }
  switch (t.kind) {
    case 'module': {
      if (it.family === 'python') {
        const modPath = t.name.replace(/\./g, '/')
        for (const rel of [`${modPath}.py`, `${modPath}/__main__.py`]) {
          if (existsSync(path.resolve(cwd, rel))) {
            await evalScriptFile(rel, 'python', env, st, cwd, depth)
            return
          }
        }
        if (!KNOWN_PY_MODULES.has(t.name.toLowerCase()) && t.name !== '') add(st, 'ALLOW_WITH_AUDIT', `runs Python module ${t.name}`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
      }
      return
    }
    case 'encoded': {
      const reasons = inspectContent(`-EncodedCommand ${t.payload}`)
      const decisive = reasons.filter((f) => f.severity === 'deny')
      if (decisive.length > 0) {
        for (const f of decisive) add(st, 'DENY', f.reason, f.trust, 'inline_code')
      } else {
        add(st, restricted ? 'DENY' : 'REQUIRE_APPROVAL', 'encoded PowerShell command: its content is hidden from the person approving it', 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
        for (const f of reasons.filter((x) => x.severity === 'approval' && !x.reason.startsWith('contains an encoded'))) add(st, restricted ? 'DENY' : 'REQUIRE_APPROVAL', f.reason, f.trust, 'inline_code')
      }
      return
    }
    case 'stdin': {
      if (restricted) {
        add(st, 'DENY', `${it.name} reading its program from standard input is inline code, which the RESTRICTED execution profile does not allow`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
      } else if (fed?.kind === 'file' && fed.target !== undefined) {
        await evalScriptFile(fed.target, it.family, env, st, cwd, depth)
      } else if (fed?.kind === 'literal') {
        add(st, 'ALLOW_WITH_AUDIT', `${it.name} reads its program from standard input; the literal text is part of this command and was inspected with it`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
      } else {
        add(st, 'REQUIRE_APPROVAL', `${it.name} reads its program from standard input, which NEXUS cannot see`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
      }
      return
    }
    case 'inline': {
      const isShell = SHELL_FAMILIES.has(it.family) || it.family === 'wsl'
      // Inline code that starts processes cannot be reviewed as a file can: it is put to the user.
      const findings = inspectContent(t.code).map((f): ContentFinding => (!isShell && (f.category === 'process_spawn' || f.category === 'shell_recursion') ? { ...f, severity: 'approval' } : f))
      if (restricted) {
        add(st, 'DENY', `inline ${it.name} code (${t.flag}) is not allowed in the RESTRICTED execution profile`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
        return
      }
      applyFindings(st, findings, 'inline_code', env, `inline ${it.name} code`)
      if (isShell) {
        // A nested shell is a command line: judge the commands it contains, the same as if they were typed directly.
        await evalCommandText(t.code, shellFor(it.family), env, st, cwd, depth + 1)
      } else if (findings.length === 0 || findings.every((f) => f.severity === 'audit')) {
        add(st, 'ALLOW_WITH_AUDIT', `inline ${it.name} code (${t.flag}) is arbitrary code; it was inspected statically`, 'UNTRUSTED_AGENT_AUTHORED', 'inline_code')
      }
      return
    }
    case 'script': {
      if (it.family === 'wsh' || it.family === 'mshta') {
        add(st, 'REQUIRE_APPROVAL', `${it.name} is the legacy Windows script host`, 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
      }
      if (t.path === '') return
      if (t.path === '-') {
        await evalInterpreter(it, [], shell, env, st, cwd, depth, fed ?? { kind: 'unknown' })
        return
      }
      await evalScriptFile(t.path, it.family, env, st, cwd, depth)
      for (const extra of t.extraPaths) await evalScriptFile(extra, it.family, env, st, cwd, depth)
      return
    }
  }
}

/** "; it also starts other processes" for the informational findings, so the log says what was seen. */
function auditNotes(findings: readonly ContentFinding[]): string {
  const notes = [...new Set(findings.filter((f) => f.severity === 'audit').map((f) => f.reason))]
  return notes.length === 0 ? '' : `; it also ${notes.join(', ')}`
}

/** Converts content findings into verdict items for a body whose provenance is `prov`. */
function applyFindings(st: State, findings: readonly ContentFinding[], prov: ProvenanceKind, env: ExecutionEnv, what: string): void {
  for (const f of findings) {
    if (f.severity === 'deny') add(st, 'DENY', `${what} ${f.reason}`, f.trust, prov)
    else if (f.severity === 'approval') {
      // RESTRICTED turns a dangerous finding into a refusal; STANDARD asks.
      const sys = f.trust === 'SYSTEM_SENSITIVE'
      add(st, env.profile === 'RESTRICTED' && sys ? 'DENY' : 'REQUIRE_APPROVAL', `${what} ${f.reason}`, f.trust, prov)
    } else if (f.category === 'download' && !env.caps.has('NETWORK')) {
      add(st, 'DENY', `${what} uses the network, which this execution profile does not allow`, f.trust, prov)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Script files
// ---------------------------------------------------------------------------------------------

function hasDynamicPart(p: string): boolean {
  return /\$|%[^%\s]+%|`|\*|\?/.test(p)
}

function resolveScript(raw: string, cwd: string, family: InterpreterFamily): { abs: string } | { error: string; deny?: boolean } {
  if (hasDynamicPart(raw)) return { error: 'the script path is computed at run time and cannot be inspected' }
  try {
    const candidates = family === 'node' || family === 'ts_runner' || family === 'bun' ? [raw, `${raw}.js`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.ts`, `${raw}/index.js`] : [raw]
    let first: string | null = null
    for (const c of candidates) {
      const abs = canonicalizePath(c, cwd)
      first ??= abs
      if (existsSync(abs) && statSync(abs).isFile()) return { abs }
    }
    return { abs: first ?? canonicalizePath(raw, cwd) }
  } catch (e) {
    return { error: `the script path cannot be resolved safely (${e instanceof Error ? e.message : String(e)})` }
  }
}

async function evalScriptFile(raw: string, family: InterpreterFamily, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  const r = resolveScript(normalizeWord(raw), cwd, family)
  if ('error' in r) {
    add(st, 'REQUIRE_APPROVAL', r.error, 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  await evalResolvedFile(r.abs, raw, family, env, st, depth, true)
}

const inNodeModules = (p: string): boolean => p.split(/[\\/]/).some((s) => s.toLowerCase() === 'node_modules')

async function evalResolvedFile(abs: string, raw: string, family: InterpreterFamily, env: ExecutionEnv, st: State, depth: number, entry: boolean): Promise<void> {
  const key = lcKey(abs)
  if (st.visited.has(key)) return
  st.visited.add(key)
  if (++st.files > MAX_FILES) {
    add(st, 'REQUIRE_APPROVAL', 'the script pulls in too many files to inspect', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  const label = path.relative(env.worktree, abs).replace(/\\/g, '/') || raw

  if (!insideWorktree(env, abs)) {
    if (entry) add(st, 'REQUIRE_APPROVAL', `${raw} is outside the task worktree and cannot be vetted`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
    return
  }
  const writtenHere = st.written.has(key)
  const isFile = ((): boolean => {
    try {
      return statSync(abs).isFile()
    } catch {
      return false
    }
  })()
  if (!isFile && !writtenHere) {
    if (entry && st.multiSegment) add(st, 'REQUIRE_APPROVAL', `${label} does not exist yet; another part of this command may create it`, 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  if (writtenHere) {
    // Written and run by the same command line: the content is the command text itself.
    const findings = inspectContent(st.commandText)
    applyFindings(st, findings, 'agent_authored', env, `${label} (written by this command)`)
    add(st, env.profile === 'RESTRICTED' ? 'REQUIRE_APPROVAL' : 'ALLOW_WITH_AUDIT', `${label} is written and run in the same command`, 'UNTRUSTED_AGENT_AUTHORED', 'agent_authored')
    return
  }

  // A script too large to read is never waved through: an executed script-type file that cannot be inspected is put to the user.
  const installed = inNodeModules(abs) && env.tracker?.recorded(abs, env.worktree) == null
  try {
    if (installed && statSync(abs).size > MAX_INSPECT_CHARS) return // a large bundled dependency (tsc.js, a vendored release): not read
    if (!installed && statSync(abs).size > MAX_SCRIPT_BYTES) {
      add(st, 'REQUIRE_APPROVAL', `${label} is too large to inspect`, 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
      return
    }
  } catch {
    // handled when the file is read below
  }

  let origin: FileOrigin
  if (inNodeModules(abs) && env.tracker?.recorded(abs, env.worktree) == null) origin = { kind: 'repository_unmodified', evidence: 'installed dependency' }
  else origin = await originOf(abs, env.worktree, env.tracker, env.base)
  const agentMade = origin.kind === 'agent_authored' || origin.kind === 'agent_modified'
  const prov: ProvenanceKind = origin.kind === 'unknown' ? 'unknown' : origin.kind
  const trust: TrustClass = agentMade ? 'UNTRUSTED_AGENT_AUTHORED' : 'UNTRUSTED_REPOSITORY_CODE'

  let buf: Buffer
  try {
    buf = readFileSync(abs)
  } catch {
    add(st, 'REQUIRE_APPROVAL', `${label} cannot be read for inspection`, trust, prov)
    return
  }

  if (looksBinary(buf.subarray(0, 8192))) {
    if (agentMade || origin.kind === 'unknown') add(st, 'REQUIRE_APPROVAL', `${label} is a compiled or binary file and cannot be inspected (${origin.evidence})`, trust, prov)
    return
  }

  const text = decodeScript(buf)
  const findings = inspectContent(text)
  const before = st.items.length
  applyFindings(st, findings, prov, env, label)
  const scriptFamily = familyForScriptPath(abs) ?? family
  // The command classifier reads shell text. In other languages an identifier such as `shutdown()` would look like a command.
  const strict = agentMade || origin.kind === 'unknown'
  for (const reason of SHELL_FAMILIES.has(scriptFamily) ? classifierReasons(text, shellFor(scriptFamily), strict) : []) {
    add(st, reason.forbidden ? 'DENY' : 'REQUIRE_APPROVAL', `${label}: ${reason.text}`, 'SYSTEM_SENSITIVE', prov)
  }
  if (st.items.length === before) {
    if (agentMade) {
      const needsApproval = env.profile === 'RESTRICTED' || !env.caps.has('WRITE_WORKTREE')
      add(st, needsApproval ? 'REQUIRE_APPROVAL' : 'ALLOW_WITH_AUDIT', `${label} is agent-authored code (${origin.evidence})${auditNotes(findings)}`, 'UNTRUSTED_AGENT_AUTHORED', prov)
    } else if (origin.kind === 'unknown' && env.profile === 'RESTRICTED') {
      add(st, 'REQUIRE_APPROVAL', `${label} has unknown provenance (${origin.evidence})`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
    }
  } else if (agentMade && env.profile === 'RESTRICTED') {
    add(st, 'REQUIRE_APPROVAL', `${label} is agent-authored code (${origin.evidence})`, 'UNTRUSTED_AGENT_AUTHORED', prov)
  }

  // Shell scripts run further commands: look through those too.
  const fam = familyForScriptPath(abs) ?? family
  if (SHELL_FAMILIES.has(fam) && text.length <= CLASSIFIER_CAP) {
    await evalCommandText(text, fam === 'powershell' ? 'powershell' : 'bash', env, st, path.dirname(abs), depth + 1)
  }
  // Libraries a script loads are code that runs too: an unmodified entry point must not load an agent-written module.
  if (depth < MAX_DEPTH) {
    const { refs, truncated } = relativeReferences(text, fam, path.dirname(abs))
    if (truncated) add(st, 'REQUIRE_APPROVAL', `${label} references too many files to inspect them all`, trust, prov)
    for (const ref of refs) {
      await evalResolvedFile(ref, ref, fam, env, st, depth + 1, false)
    }
  }
}

async function evalProgramFile(raw: string, env: ExecutionEnv, st: State, cwd: string): Promise<void> {
  let abs: string
  try {
    abs = canonicalizePath(raw, cwd)
  } catch {
    add(st, 'REQUIRE_APPROVAL', 'the program path cannot be resolved safely', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  if (!existsSync(abs)) return
  if (!insideWorktree(env, abs)) {
    add(st, 'REQUIRE_APPROVAL', `${raw} is a program outside the task worktree`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
    return
  }
  const origin = inNodeModules(abs) ? ({ kind: 'repository_unmodified', evidence: 'installed dependency' } as FileOrigin) : await originOf(abs, env.worktree, env.tracker, env.base)
  if (origin.kind === 'agent_authored' || origin.kind === 'agent_modified') {
    add(st, 'REQUIRE_APPROVAL', `${path.relative(env.worktree, abs)} is a program built or changed by an agent and cannot be inspected (${origin.evidence})`, 'UNTRUSTED_AGENT_AUTHORED', origin.kind)
  }
}

/** Relative `require('./x')`, `import './x'`, Python sibling imports and PowerShell dot-sourcing, resolved to existing files. */
function relativeReferences(text: string, family: InterpreterFamily, dir: string): { refs: string[]; truncated: boolean } {
  const out = new Set<string>()
  const addIf = (c: string): void => {
    try {
      const abs = canonicalizePath(c, dir)
      if (existsSync(abs) && statSync(abs).isFile()) out.add(abs)
    } catch {
      // not resolvable: not followed
    }
  }
  if (family === 'node' || family === 'ts_runner' || family === 'bun') {
    for (const m of text.matchAll(/(?:require\s*\(|import\s*\(|\bfrom\s+|\bimport\s+)\s*['"](\.{1,2}[\\/][^'"]+)['"]/g)) {
      const ref = m[1] ?? ''
      for (const c of [ref, `${ref}.js`, `${ref}.mjs`, `${ref}.cjs`, `${ref}.ts`, `${ref}/index.js`]) addIf(c)
    }
  } else if (family === 'python') {
    for (const m of text.matchAll(/^\s*(?:from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
      const mod = (m[1] ?? m[2] ?? '').replace(/^\.+/, '')
      if (mod === '') continue
      const rel = mod.replace(/\./g, '/')
      addIf(`${rel}.py`)
      addIf(`${rel}/__init__.py`)
    }
  } else if (family === 'powershell') {
    for (const m of text.matchAll(/(?:^|[;\n]\s*)(?:\.|&)\s+['"]?(\.{0,2}[\\/][^'"\s;]+\.(?:ps1|psm1))['"]?/gi)) addIf(m[1] ?? '')
  }
  const all = [...out]
  return { refs: all.slice(0, MAX_REFERENCES), truncated: all.length > MAX_REFERENCES }
}

/** What the command classifier makes of a script body; only forbidden findings count unless `strict`. */
function classifierReasons(text: string, shell: Shell, strict: boolean): { text: string; forbidden: boolean }[] {
  const out: { text: string; forbidden: boolean }[] = []
  const cls = classifyCommand(text.length > CLASSIFIER_CAP ? text.slice(0, CLASSIFIER_CAP) : text, shell)
  const real = cls.reasons.filter((r) => !/could not be analysed/.test(r))
  if (cls.level === 'forbidden') for (const r of real) out.push({ text: r, forbidden: true })
  else if (strict && cls.level === 'needs_approval' && cls.risk === 'high') for (const r of real) out.push({ text: r, forbidden: false })
  return out
}

// ---------------------------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------------------------

const KNOWN_DEV_TOOLS = new Set([
  'vitest', 'jest', 'tsc', 'eslint', 'prettier', 'playwright', 'vue-tsc', 'mocha', 'ava', 'vite', 'webpack', 'rollup', 'esbuild', 'next', 'nuxt', 'turbo', 'nx', 'biome', 'stylelint',
  'cypress', 'electron-vite', 'electron-builder', 'tsup', 'rimraf', 'jiti', 'lint-staged', 'husky', 'changeset', 'knip', 'depcheck', 'madge', 'size-limit', 'typedoc', 'storybook', 'svelte-check',
])

function matchesPrefix(env: ExecutionEnv, words: string[]): boolean {
  const lc = words.map((w) => w.toLowerCase())
  return env.safeCommandPrefixes.some((p) => p.length <= lc.length && p.every((x, i) => lc[i] === x))
}

function nearestManifest(start: string, stop: string): Manifest | null {
  let dir = start
  for (let i = 0; i < 12; i++) {
    const m = readManifest(dir)
    if (m !== null) return m
    if (lcKey(dir) === lcKey(stop)) return null
    const up = path.dirname(dir)
    if (up === dir || !isPathInside(stop, up)) return null
    dir = up
  }
  return null
}

function hasLocalBin(tool: string, cwd: string, stop: string): boolean {
  let dir = cwd
  for (let i = 0; i < 12; i++) {
    for (const ext of ['', '.cmd', '.exe', '.ps1']) if (existsSync(path.join(dir, 'node_modules', '.bin', tool + ext))) return true
    const up = path.dirname(dir)
    if (up === dir || lcKey(dir) === lcKey(stop) || !isPathInside(stop, up)) return false
    dir = up
  }
  return false
}

/** Package-manager configuration files: a change to one of them changes what the next `pnpm test` runs. */
const PM_CONFIG_FILES = ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', '.yarnrc.yml', '.yarnrc', 'bunfig.toml']

async function evalPmConfig(env: ExecutionEnv, st: State, start: string, depth: number): Promise<void> {
  let dir = start
  for (let i = 0; i < 12; i++) {
    for (const f of PM_CONFIG_FILES) {
      const abs = path.join(dir, f)
      try {
        if (!statSync(abs).isFile() || statSync(abs).size > 256 * 1024) continue
      } catch {
        continue
      }
      const origin = await originOf(abs, env.worktree, env.tracker, env.base)
      const changed = origin.kind === 'agent_authored' || origin.kind === 'agent_modified'
      const text = decodeScript(readFileSync(abs))
      const label = path.relative(env.worktree, abs).replace(/\\/g, '/')
      // The program scripts run with, and the files Yarn loads, are executed whenever the manager runs a script.
      for (const m of text.matchAll(/^\s*script-shell\s*=\s*['"]?(.+?)['"]?\s*$/gim)) await evalScriptFile(m[1] ?? '', 'cmd', env, st, dir, depth)
      if (changed) {
        for (const m of text.matchAll(/^\s*yarnPath:\s*['"]?(.+?)['"]?\s*$/gm)) await evalScriptFile(m[1] ?? '', 'node', env, st, dir, depth)
        for (const m of text.matchAll(/^\s*-?\s*path:\s*['"]?(\S+?)['"]?\s*$/gm)) await evalScriptFile(m[1] ?? '', 'node', env, st, dir, depth)
        if (/^\.pnpmfile\./.test(f)) await evalResolvedFile(abs, f, 'node', env, st, depth, true)
        add(st, 'REQUIRE_APPROVAL', `${label} (package manager configuration) was written or changed by an agent; it can change which programs the next package script runs`, 'UNTRUSTED_AGENT_AUTHORED', origin.kind)
      }
    }
    const up = path.dirname(dir)
    if (up === dir || lcKey(dir) === lcKey(env.worktree) || !isPathInside(env.worktree, up)) return
    dir = up
  }
}

async function evalPackageManager(pm: PackageManager | 'npx' | 'bunx', args: string[], shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  const parsed = parsePackageManager(pm, args)
  let workDir = cwd
  if (parsed.dir !== null) {
    try {
      workDir = canonicalizePath(parsed.dir, cwd)
    } catch {
      add(st, 'REQUIRE_APPROVAL', 'the package manager is pointed at a directory that cannot be resolved safely', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
      return
    }
    if (!insideWorktree(env, workDir)) {
      add(st, 'REQUIRE_APPROVAL', 'the package manager is pointed at a directory outside the task worktree', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
      return
    }
  }
  if (parsed.ambiguous) {
    add(st, 'REQUIRE_APPROVAL', `${pm} is given a flag NEXUS does not know, so it cannot tell which script or tool this runs`, 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
    return
  }
  if (parsed.scriptShell !== null) {
    // The program every script is run through: it is executed, so it is inspected like a script.
    await evalScriptFile(parsed.scriptShell, 'cmd', env, st, cwd, depth)
    add(st, 'REQUIRE_APPROVAL', 'sets the program package scripts are run with (--script-shell)', 'UNTRUSTED_AGENT_AUTHORED', 'unknown')
  }
  const inv = parsed.invocation
  if (inv.kind === 'other') return
  await evalPmConfig(env, st, workDir, depth)

  if (inv.kind === 'exec') {
    await evalExecTool(inv.tool, inv.args, inv.download, inv.forced, shell, env, st, workDir, depth)
    return
  }

  if (inv.kind === 'install' && !env.caps.has('PACKAGE_INSTALL')) {
    add(st, 'DENY', `the ${env.role} role has no PACKAGE_INSTALL capability`, 'UNTRUSTED_AGENT_AUTHORED', 'not_applicable')
    return
  }
  if (inv.kind === 'script' && !env.caps.has('RUN_TESTS') && !env.caps.has('RUN_BUILD')) {
    add(st, 'DENY', `the ${env.role} role cannot run package scripts`, 'UNTRUSTED_AGENT_AUTHORED', 'not_applicable')
    return
  }
  const manifests = parsed.workspaces ? workspaceManifests(env.worktree) : [nearestManifest(workDir, env.worktree)].filter((m): m is Manifest => m !== null)
  const names = scriptNamesFor(inv)
  const configured = matchesPrefix(env, [pm, ...args])
  let ran = 0
  for (const m of manifests) {
    for (const name of names) {
      if (m.scripts[name] === undefined) continue
      ran++
      await evalScriptBody(m, name, env, st, depth, [pm, ...args], configured)
    }
  }
  if (inv.kind === 'script' && ran === 0 && pm !== 'npm' && interpreterFor(inv.name) !== null) {
    // `pnpm tsx x.ts`, `yarn node x.js`: no such script, so the manager runs the binary of that name.
    await evalExecTool(inv.name, args.slice(args.findIndex((x) => x === inv.name) + 1), false, false, shell, env, st, workDir, depth)
  }
  if (inv.kind === 'install' && env.profile === 'RESTRICTED' && !env.caps.has('NETWORK')) {
    add(st, 'REQUIRE_APPROVAL', 'installing dependencies uses the network and runs dependency lifecycle scripts', 'UNTRUSTED_REPOSITORY_CODE', 'not_applicable')
  }
}

async function evalExecTool(tool: string, args: string[], download: boolean, forced: boolean, shell: Shell, env: ExecutionEnv, st: State, cwd: string, depth: number): Promise<void> {
  const it = interpreterFor(tool)
  if (it !== null) {
    await evalInterpreter(it, args, shell, env, st, cwd, depth)
    return
  }
  if (SCRIPT_EXTENSIONS.test(tool) || /[\\/]/.test(tool)) {
    const fam = familyForScriptPath(tool)
    if (fam !== null) await evalScriptFile(tool, fam, env, st, cwd, depth)
    return
  }
  const name = executableName(tool)
  if (hasLocalBin(name, cwd, env.worktree)) return
  if (KNOWN_DEV_TOOLS.has(name) && !forced) return
  if (!download && !forced) return // pnpm/yarn exec never fetch: a missing binary just fails
  if (!env.caps.has('NETWORK')) {
    add(st, 'DENY', `${tool} is not installed in this project and fetching it needs the network, which this execution profile does not allow`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
    return
  }
  add(st, 'REQUIRE_APPROVAL', `${tool} is not installed in this project; running it downloads and executes a package`, 'UNTRUSTED_REPOSITORY_CODE', 'unknown')
}

async function scriptWasModified(m: Manifest, name: string, env: ExecutionEnv): Promise<{ modified: boolean; known: boolean }> {
  const manifestPath = path.join(m.dir, 'package.json')
  const rel = path.relative(env.worktree, manifestPath).replace(/\\/g, '/')
  const baseText = await env.tracker?.baseContent(rel, env.base)
  if (baseText === undefined) {
    const rec = env.tracker?.recorded(manifestPath, env.worktree) ?? null
    return { modified: rec !== null, known: rec !== null }
  }
  if (baseText === null) return { modified: true, known: true }
  try {
    const baseScripts = scriptsOf(JSON.parse(baseText))
    return { modified: baseScripts[name] !== m.scripts[name], known: true }
  } catch {
    return { modified: true, known: true }
  }
}

async function evalScriptBody(m: Manifest, name: string, env: ExecutionEnv, st: State, depth: number, invocation: string[], configured = false): Promise<void> {
  const body = m.scripts[name] ?? ''
  const vkey = `pkg:${lcKey(m.dir)}:${name}`
  if (st.visited.has(vkey)) return
  st.visited.add(vkey)
  const { modified, known } = await scriptWasModified(m, name, env)
  const label = `package script "${name}" (${path.relative(env.worktree, m.dir).replace(/\\/g, '/') || '.'}/package.json)`
  const prov: ProvenanceKind = modified ? 'agent_modified' : known ? (configured ? 'configured_command' : 'repository_unmodified') : 'unknown'
  const trust: TrustClass = modified ? 'UNTRUSTED_AGENT_AUTHORED' : configured ? 'TRUSTED_PROJECT_COMMAND' : 'UNTRUSTED_REPOSITORY_CODE'

  const before = st.items.length
  applyFindings(st, inspectContent(body), prov, env, label)
  for (const r of classifierReasons(body, 'bash', modified)) add(st, r.forbidden ? 'DENY' : 'REQUIRE_APPROVAL', `${label}: ${r.text}`, 'SYSTEM_SENSITIVE', prov)
  // Look through the body: it may start an interpreter, a script file or another package script.
  await evalCommandText(body, 'bash', env, st, m.dir, depth + 1)
  const clean = st.items.length === before
  if (!known && env.profile === 'RESTRICTED') {
    add(st, 'REQUIRE_APPROVAL', `${label} cannot be compared with the base commit`, trust, prov)
  } else if (modified && clean) {
    add(st, env.profile === 'RESTRICTED' || !env.caps.has('WRITE_WORKTREE') ? 'REQUIRE_APPROVAL' : 'ALLOW_WITH_AUDIT', `${label} was changed by an agent since the base commit`, trust, prov)
  } else if (modified && env.profile === 'RESTRICTED') {
    add(st, 'REQUIRE_APPROVAL', `${label} was changed by an agent since the base commit`, trust, prov)
  }
}

// ---------------------------------------------------------------------------------------------
// Files a command line writes (for execution provenance)
// ---------------------------------------------------------------------------------------------

const WRITE_FIRST = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object', 'tee', 'new-item', 'ni', 'export-csv', 'export-clixml'])
const WRITE_LAST = new Set(['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'xcopy', 'rename-item', 'rni', 'ren', 'rename'])
const HARMLESS = new Set(['/dev/null', 'nul', '$null', 'con'])

/** Targets of redirections and of the common file-writing commands in a tokenized command line. */
export function collectWriteTargets(segs: Segment[]): string[] {
  const out: string[] = []
  const redirects = (rs: Redirect[]): void => {
    for (const r of rs) {
      if (r.op.startsWith('<') || r.target === '' || HARMLESS.has(r.target.toLowerCase()) || (r.op.includes('&') && /^\d+$/.test(r.target))) continue
      out.push(r.target)
    }
  }
  for (const seg of segs) {
    redirects(seg.redirects)
    const n = executableName(seg.words[0] ?? '')
    const args = seg.words.slice(1)
    const named: string[] = []
    for (let i = 0; i < args.length; i++) {
      const l = (args[i] ?? '').toLowerCase()
      if (['-path', '-filepath', '-literalpath', '-destination', '-file'].includes(l) && args[i + 1] !== undefined) named.push(args[++i] ?? '')
    }
    const positional = args.filter((a) => !a.startsWith('-') && !(a.startsWith('/') && a.length <= 3))
    if (WRITE_FIRST.has(n)) {
      if (named.length > 0) out.push(...named)
      else if (positional[0] !== undefined) out.push(positional[0])
    } else if (WRITE_LAST.has(n)) {
      const dest = named[0] ?? positional[positional.length - 1]
      if (dest !== undefined) out.push(dest)
    }
  }
  return out
}

