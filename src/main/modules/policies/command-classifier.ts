import { canonicalizePath, isPathInside, isSecretPath } from './paths'
import { neutralizeCommitHeredocs, neutralizeInertHeredocs, tokenize } from './shell-tokenizer'
import type { Segment, Shell } from './shell-tokenizer'

export type CommandLevel = 'safe' | 'write' | 'needs_approval' | 'forbidden'
export type CommandRisk = 'low' | 'medium' | 'high'
/** How a single sub-command may be used by restricted roles. */
export type SegmentKind = 'readonly' | 'verify' | 'install' | 'other'

/**
 * What a command does, independent of who runs it (0.2.1). SAFE_READ, SAFE_PROJECT_WRITE and GIT_LOCAL
 * never need approval for writing roles inside their worktree; the rest are gated or forbidden.
 */
export type CommandClass = 'SAFE_READ' | 'SAFE_PROJECT_WRITE' | 'GIT_LOCAL' | 'NETWORK' | 'SYSTEM_CHANGE' | 'DESTRUCTIVE' | 'UNKNOWN'

const CLASS_SEVERITY: Record<CommandClass, number> = {
  SAFE_READ: 0,
  SAFE_PROJECT_WRITE: 1,
  GIT_LOCAL: 2,
  UNKNOWN: 3,
  NETWORK: 4,
  SYSTEM_CHANGE: 5,
  DESTRUCTIVE: 6,
}

function maxClass(classes: CommandClass[]): CommandClass {
  return classes.reduce<CommandClass>((m, c) => (CLASS_SEVERITY[c] > CLASS_SEVERITY[m] ? c : m), 'SAFE_READ')
}

export interface SegmentInfo {
  command: string
  kind: SegmentKind
  class?: CommandClass
}

export interface CommandClassification {
  /** safe: every sub-command is read-only inspection. write: anything else not gated. */
  level: CommandLevel
  reasons: string[]
  /** Highest risk among needs_approval findings; null otherwise. */
  risk: CommandRisk | null
  /** One entry per inspected sub-command (including nested shells and substitutions). */
  segments: SegmentInfo[]
  /** Most severe class among every inspected sub-command and finding (SAFE_READ for an empty command). */
  commandClass: CommandClass
  /** Every distinct class seen, most severe last. */
  classes: CommandClass[]
}

export interface ClassifyOptions {
  /** Directories the command may touch. The first entry is the working directory. Omit to skip path checks. */
  roots?: string[]
  /** Extra commands (word prefixes, e.g. "pnpm test:unit") that count as verification commands. */
  safeCommandPrefixes?: string[]
}

const MAX_NESTING = 6
const RISK_ORDER: Record<CommandRisk, number> = { low: 0, medium: 1, high: 2 }

interface Finding {
  level: 'needs_approval' | 'forbidden'
  risk: CommandRisk
  reason: string
  cls: CommandClass
}

class Analysis {
  readonly findings: Finding[] = []
  readonly segments: SegmentInfo[] = []
  readonly roots: string[]
  readonly prefixes: string[][]
  venv = false

  constructor(readonly opts: ClassifyOptions) {
    this.roots = []
    for (const r of opts.roots ?? []) {
      try {
        this.roots.push(canonicalizePath(r, r))
      } catch {
        this.roots.push(r)
      }
    }
    this.prefixes = (opts.safeCommandPrefixes ?? [])
      .map((p) => p.trim().toLowerCase().split(/\s+/).filter(Boolean))
      .filter((p) => p.length > 0)
  }

  add(level: Finding['level'], risk: CommandRisk, reason: string, cls: CommandClass = 'UNKNOWN'): void {
    this.findings.push({ level, risk, reason, cls })
  }
  ask(risk: CommandRisk, reason: string, cls: CommandClass = 'UNKNOWN'): void {
    this.add('needs_approval', risk, reason, cls)
  }
}

export function classifyCommand(command: string, shell: Shell, opts: ClassifyOptions = {}): CommandClassification {
  const a = new Analysis(opts)
  a.venv = /(^|[\\/\s])\.?(venv|virtualenv|env)[\\/](scripts|bin)[\\/]|\bactivate\b|VIRTUAL_ENV/i.test(command)
  try {
    analyzeText(command, shell, a, 0)
  } catch (e) {
    a.add('forbidden', 'high', `command could not be analysed safely: ${e instanceof Error ? e.message : String(e)}`)
  }
  const reasons = [...new Set(a.findings.map((f) => f.reason))]
  const segments = a.segments
  const all = [...a.segments.map((s) => s.class ?? 'UNKNOWN'), ...a.findings.map((f) => f.cls)]
  const classes = [...new Set(all)].sort((x, y) => CLASS_SEVERITY[x] - CLASS_SEVERITY[y])
  const commandClass = maxClass(all)
  if (a.findings.some((f) => f.level === 'forbidden')) {
    const forbidden = a.findings.filter((f) => f.level === 'forbidden')
    return { level: 'forbidden', reasons: [...new Set(forbidden.map((f) => f.reason))], risk: 'high', segments, commandClass, classes }
  }
  if (a.findings.length > 0) {
    const risk = a.findings.reduce<CommandRisk>((m, f) => (RISK_ORDER[f.risk] > RISK_ORDER[m] ? f.risk : m), 'low')
    return { level: 'needs_approval', reasons, risk, segments, commandClass, classes }
  }
  const readOnly = segments.every((s) => s.kind === 'readonly')
  return { level: readOnly ? 'safe' : 'write', reasons: [], risk: null, segments, commandClass, classes }
}

// ---------------------------------------------------------------------------------------------
// Whole-text checks
// ---------------------------------------------------------------------------------------------

const CREDENTIAL_STORE = /\.claude[\\/]+\.credentials|\.credentials\.json/i
const SECURITY_TOOLING =
  /\b(set|add)-mppreference\b|disablerealtimemonitoring|disableantispyware|\bwindefend\b|\bmpssvc\b|\bwdnissvc\b|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off|disable-netfirewallrule|set-netfirewallprofile|bcdedit[^;|&]*\b(testsigning|nointegritychecks)\b|uninstall-windowsdefender|mpcmdrun[^;|&]*-remove/i
const MACHINE_ENV = /setenvironmentvariable\s*\([^)]*\b(machine|user)\b/i
const SECRET_ENV_REF =
  /(?:\$env:|\$\{env:|\$\{?|%|printenv\s+|getenvironmentvariable\w*\(\s*['"]?)[a-z0-9_]*(?:key|token|secret|passw|credential)[a-z0-9_]*/i
const DANGEROUS_ENV_NAME = '(?:git_[a-z0-9_]*|ld_[a-z0-9_]*|dyld_[a-z0-9_]*|node_options|pager|editor|visual|browser|ssh_askpass|pythonstartup|pythonpath|path)'
const DANGEROUS_ENV_ASSIGN = new RegExp(`(?:\\$\\{?env:|\\benv:)${DANGEROUS_ENV_NAME}\\}?\\s*\\+?=|\\bset\\s+"?${DANGEROUS_ENV_NAME}=`, 'i')
const DANGEROUS_ENV_WORD = new RegExp(`^${DANGEROUS_ENV_NAME}=`, 'i')
const ENV_ASSIGN_REASON = 'sets an environment variable that makes tools run programs (GIT_*, PAGER, EDITOR, LD_*, PATH, ...)'
const POWER_REASON = 'shutting down, restarting, suspending or powering off the machine is forbidden for every role'
/** Power-state APIs and WMI/CIM methods; plain command names are matched per segment instead. */
const POWER_TEXT =
  /\b(shutdownwindows|win32shutdown|win32shutdowntracker|setsuspendstate|exitwindowsex|initiatesystemshutdown(?:ex)?|ntshutdownsystem|ntinitiatepoweraction|ntsetsystempowerstate)\b|powrprof(?:\.dll)?\s*,|\binvoke-(?:wmi|cim)method\b[^|;&\n]*-(?:method)?name\s+['"]?(?:win32)?(?:shutdown|reboot)\b|\bsystemctl\s+(?:--?\S+\s+)*(?:poweroff|reboot|halt|suspend|hibernate|hybrid-sleep|kexec)\b|\bloginctl\s+(?:--?\S+\s+)*(?:poweroff|reboot|halt|suspend|hibernate)\b/i
/** Executables that power off, restart or suspend the machine. Matched on the normalised base name. */
const POWER_CMDS = new Set([
  'shutdown', 'psshutdown', 'psshutdown64', 'stop-computer', 'restart-computer', 'poweroff', 'halt', 'reboot', 'slidetoshutdown', 'telinit', 'tsshutdn',
])
/** Commands that launch or schedule another program: their arguments may name a power command. */
const LAUNCHER_CMDS = new Set([
  'start-process', 'saps', 'start', 'invoke-item', 'ii', 'invoke-expression', 'iex', 'eval', 'invoke-command', 'icm', 'start-job', 'start-threadjob',
  'schtasks', 'at', 'new-scheduledtaskaction', 'register-scheduledtask', 'set-scheduledtask', 'runas', 'explorer', 'conhost', 'wt', 'set-alias', 'new-alias', 'sal', 'nal', 'alias',
  'rundll32', 'mshta', 'wscript', 'cscript', 'forfiles', 'wmic', 'invoke-wmimethod', 'invoke-cimmethod',
])
const DANGEROUS_ENV_SET = new RegExp(
  `(?:\\b(?:set-item|new-item|si|ni|sp|set-content|add-content|set-itemproperty)\\s+(?:-(?:path|name|literalpath)\\s+)?["']?\\$?env:${DANGEROUS_ENV_NAME}\\b|setenvironmentvariable\\s*\\(\\s*["']${DANGEROUS_ENV_NAME}["'])`,
  'i',
)
const DOTNET_NETWORK = /net\.webclient|downloadstring|downloadfile|start-bitstransfer|system\.net\.http/i

function analyzeText(rawText: string, shell: Shell, a: Analysis, depth: number): void {
  // A quoted heredoc used only as a git commit message is inert prose, not shell (bash only).
  const text = shell === 'bash' ? neutralizeInertHeredocs(neutralizeCommitHeredocs(rawText)) : rawText
  if (depth > MAX_NESTING) {
    a.ask('high', 'shell commands are nested too deeply to inspect')
    return
  }
  if (CREDENTIAL_STORE.test(text)) {
    a.add('forbidden', 'high', 'Claude credential stores must never be read or printed', 'SYSTEM_CHANGE')
  }
  if (SECURITY_TOOLING.test(text)) {
    a.add('forbidden', 'high', 'disabling or modifying security tooling is not permitted', 'SYSTEM_CHANGE')
  }
  if (POWER_TEXT.test(text) || POWER_TEXT.test(squash(text)) || powerViaExecApi(text) || scriptWriteRunsPower(rawText)) {
    a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')
  }
  if (DANGEROUS_ENV_SET.test(text)) a.ask('high', ENV_ASSIGN_REASON)
  if (MACHINE_ENV.test(text)) {
    a.ask('high', 'changes machine/user environment variables', 'SYSTEM_CHANGE')
  }
  if (SECRET_ENV_REF.test(text)) {
    a.ask('high', 'accessing secrets: references a key/token/secret-like environment variable')
  }
  if (DANGEROUS_ENV_ASSIGN.test(text)) a.ask('high', ENV_ASSIGN_REASON)
  if (DOTNET_NETWORK.test(text)) {
    a.ask('medium', 'network operation (.NET web client / BITS transfer)', 'NETWORK')
  }
  for (const seg of tokenize(text, shell)) analyzeSegment(seg, shell, a, depth)
}

// ---------------------------------------------------------------------------------------------
// Segment analysis
// ---------------------------------------------------------------------------------------------

const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred'])
const MOVE_CMDS = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'rename'])
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'py', 'node', 'ruby', 'perl'])
const SH_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const HARMLESS_REDIRECT_TARGET = new Set(['/dev/null', 'nul', '$null'])

function normalizeName(word: string): string {
  if (/^(%comspec%|\$env:comspec|\$\{env:comspec\}|\$comspec)$/i.test(word)) return 'cmd'
  const base = word.split(/[\\/]/).pop() ?? word
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

/**
 * Every plausible reading of a command word once trivial obfuscation is undone: the plain base name, the
 * name with cmd carets, quotes, backticks and "+" removed (shut^down, 'shut''down', "shut"+"down") and the
 * name with backslash escapes removed (sh\\utdown).
 */
function commandNameCandidates(word: string): string[] {
  const stripped = word.replace(/[\^`"'+]/g, '')
  return [...new Set([normalizeName(word), normalizeName(stripped), normalizeName(stripped.replace(/\\/g, ''))])]
}

/** Merges adjacent string literals ("shut"+"down") and drops quoting/escape characters, so names can be matched. */
function squash(text: string): string {
  let t = text
  for (let k = 0; k < 4; k++) t = t.replace(/(["'])\s*\+\s*(["'])/g, '')
  return t.replace(/[\^`"']/g, '')
}

const NEXUS_DATA = /nexus\.db(?:-wal|-shm|-journal)?|overnight\.key/i
const NEXUS_DATA_REASON = 'NEXUS application data (its database and overnight key) must never be accessed from an agent shell'
const DYNAMIC_REASON = 'the command name is computed at run time (variable or command substitution) and cannot be inspected'
const POWER_WORDS =
  /\b(?:shutdown(?:\.exe)?|poweroff|reboot|stop-computer|restart-computer|psshutdown\w*|tsshutdn|slidetoshutdown|setsuspendstate|exitwindowsex|initiatesystemshutdown\w*|shutdownwindows|win32shutdown\w*|ntshutdownsystem)\b|powrprof/i
/** APIs and cmdlets that start another program; combined with a power word anywhere in the same text they are forbidden. */
const EXEC_API =
  /start-process|\bsaps\b|\binvoke-expression\b|\biex\b|invoke-command|diagnostics\.process|processstartinfo|wscript\.shell|shell\.application|shellexecute|new-object\s+-com|\.run\s*\(|child_process|\bos\.(?:system|popen|exec\w*|spawn\w*)|subprocess|\bpopen\b|\bexec(?:sync|file|filesync)?\s*\(|\bspawn(?:sync)?\s*\(|\bsystem\s*\(|\bgettype\s*\(|\bproc_open|\bshell_exec|\bpassthru/i
/** Interpreter flags whose argument is program text. */
const INLINE_FLAGS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
  perl: ['-e'],
  ruby: ['-e'],
  php: ['-r'],
  lua: ['-e'],
  deno: ['eval'],
}

function powerViaExecApi(text: string): boolean {
  let t = text
  if (/\bgit\s+commit\b/i.test(t)) t = t.replace(/(\s-[a-zA-Z]*m|\s--message)[ =]+("[^"]*"|'[^']*')/g, ' ')
  const s = squash(t)
  return EXEC_API.test(s) && POWER_WORDS.test(s)
}

/** Program text passed on the command line to an interpreter (-e, -c, eval ...), or null when it runs a file. */
function inlineProgram(cmd: string, args: string[]): string | null {
  const lc = args.map((x) => x.toLowerCase())
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') return args.filter((x) => !x.startsWith('-')).join(' ')
  const flags = INLINE_FLAGS[cmd]
  if (flags === undefined) return null
  const k = lc.findIndex((x) => flags.includes(x) || (cmd !== 'deno' && /^-[a-z]{2,}$/.test(x) && flags.some((f) => f.length === 2 && x.endsWith(f.slice(1)))))
  return k < 0 ? null : args.slice(k + 1).join(' ')
}

/** `shutdown` & co. named by the first real argument of a package runner or multi-call binary. */
function runnerLaunchesPower(cmd: string, args: string[]): boolean {
  const lc = args.map((x) => x.toLowerCase())
  const firstReal = (xs: string[]): string | undefined => xs.find((x) => !x.startsWith('-'))
  let target: string | undefined
  if (cmd === 'busybox' || cmd === 'toybox' || cmd === 'npx' || cmd === 'bunx') target = firstReal(args)
  else if (['pnpm', 'npm', 'yarn', 'bun'].includes(cmd)) {
    const k = lc.findIndex((x) => x === 'exec' || x === 'dlx' || x === 'x')
    if (k >= 0) target = firstReal(args.slice(k + 1))
  }
  return target !== undefined && commandNameCandidates(target).some((n) => POWER_CMDS.has(n))
}

const SCRIPT_NAME = /[^\s"'<>|&;()=,]{1,200}\.(?:bat|cmd|ps1|sh)\b/gi

/** A script written in this command line that contains a power command and is also run in it. */
function scriptWriteRunsPower(rawText: string): boolean {
  const counts = new Map<string, number>()
  for (const m of rawText.matchAll(SCRIPT_NAME)) {
    const name = (m[0].split(/[\\/]/).pop() ?? m[0]).toLowerCase()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (![...counts.values()].some((n) => n >= 2)) return false
  if (textRunsPowerCommand(rawText)) return true
  for (const shell of ['bash', 'powershell'] as const) {
    for (const seg of tokenize(rawText, shell)) {
      const mentions = [...seg.words, ...seg.redirects.map((r) => r.target)].some((w) => /\.(bat|cmd|ps1|sh)\b/i.test(w))
      if (mentions && launchesPowerCommand(seg.words.slice(1))) return true
    }
  }
  return false
}

/** True when any real argument word of a segment (not a git commit message) mentions NEXUS's own data. */
function touchesNexusData(seg: Segment): boolean {
  const words = seg.words
  const commit = words.some((w) => normalizeName(w) === 'git') && words.includes('commit')
  const texts: string[] = seg.redirects.map((r) => r.target)
  words.forEach((w, k) => {
    const prev = words[k - 1] ?? ''
    if (commit && (/^-[a-zA-Z]*m$|^--message$|^-[Fm]$/.test(prev) || /^--message=/.test(w))) return
    texts.push(w)
  })
  return texts.some((t) => NEXUS_DATA.test(t) || NEXUS_DATA.test(squash(t)))
}

function analyzeSegment(seg: Segment, shell: Shell, a: Analysis, depth: number): void {
  const findingsBefore = a.findings.length
  const words = [...seg.words]
  const hasPathSep = words[0] !== undefined && /[\\/]/.test(words[0]) && !/^\.[\\/]node_modules[\\/]\.bin[\\/]/.test(words[0])

  let i = 0
  if (shell === 'bash') {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) {
      if (DANGEROUS_ENV_WORD.test(words[i] ?? '')) a.ask('high', ENV_ASSIGN_REASON)
      i++
    }
  }
  let wrapped = i > 0
  let isCallOp = false
  if (shell === 'powershell' && (words[i] === '&' || words[i] === '.')) {
    isCallOp = true
    i++
  }
  const first = words[i]
  if (isCallOp && (first === undefined || first.startsWith('$'))) {
    a.ask('high', 'call operator with a dynamic command name cannot be inspected')
  }
  if (touchesNexusData(seg)) a.add('forbidden', 'high', NEXUS_DATA_REASON, 'SYSTEM_CHANGE')

  // Strip wrappers that run another command.
  for (let guard = 0; guard < 4 && words[i] !== undefined; guard++) {
    const w = normalizeName(words[i] ?? '')
    if (w === 'sudo' || w === 'doas' || w === 'gsudo') {
      a.ask('high', `${w} runs with elevated privileges`, 'SYSTEM_CHANGE')
      i = skipFlags(words, i + 1)
      wrapped = true
    } else if (w === 'env') {
      const j = skipEnvArgs(words, i + 1)
      if (words.slice(i + 1, j).some((x) => DANGEROUS_ENV_WORD.test(x))) a.ask('high', ENV_ASSIGN_REASON)
      if (j >= words.length) {
        a.ask('high', 'accessing secrets: env prints every environment variable')
        break
      }
      i = j
      wrapped = true
    } else if (['command', 'exec', 'nohup', 'time', 'nice', 'call', 'builtin', 'stdbuf', 'timeout'].includes(w)) {
      i = skipFlags(words, i + 1)
      if (w === 'timeout' && /^\d/.test(words[i] ?? '')) i++
      wrapped = true
    } else if (w === 'xargs') {
      i = skipXargsFlags(words, i + 1)
      wrapped = true
    } else break
  }

  checkWords(seg, words, a, DELETE_CMDS.has(normalizeName(words[i] ?? '')) || MOVE_CMDS.has(normalizeName(words[i] ?? '')), normalizeName(words[i] ?? '') === 'git')

  const nameWord = words[i]
  if (nameWord === undefined) {
    const bare = seg.words.length === 0 && seg.redirects.every((r) => isHarmlessRedirect(r.op, r.target))
    const own = a.findings.slice(findingsBefore).map((x) => x.cls)
    a.segments.push({ command: '', kind: bare ? 'readonly' : 'other', class: own.length > 0 ? maxClass(own) : bare ? 'SAFE_READ' : 'SAFE_PROJECT_WRITE' })
    return
  }
  const cands = commandNameCandidates(nameWord)
  const cmd = cands.find((c) => INTERPRETERS.has(c) || SH_SHELLS.has(c)) ?? cands[0] ?? normalizeName(nameWord)
  const args = words.slice(i + 1)
  const lc = args.map((x) => x.toLowerCase())

  if (!isCallOp && ((shell === 'bash' && /^\$/.test(nameWord)) || /^%[^%\s]+%/.test(nameWord))) {
    if (normalizeName(nameWord) !== 'cmd') a.ask('high', DYNAMIC_REASON)
  }
  const program = inlineProgram(cmd, args)
  if (program !== null && (POWER_WORDS.test(squash(program)) || POWER_TEXT.test(squash(program)))) {
    a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')
  }
  if (runnerLaunchesPower(cmd, args)) a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')

  if (seg.sep === '|' && INTERPRETERS.has(cmd) && args.every((x) => x.startsWith('-'))) {
    a.ask('high', `piping data into ${cmd} executes it (download-and-execute pattern)`)
  }
  if (seg.sep === '|' && (cmd === 'iex' || cmd === 'invoke-expression')) {
    a.ask('high', 'piping into Invoke-Expression executes arbitrary text')
  }

  if (cands.some((c) => POWER_CMDS.has(c))) a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')
  else if (LAUNCHER_CMDS.has(cmd) && launchesPowerCommand(args)) a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')

  const handledNested = analyzeNestedShell(cmd, args, a, depth)
  if (!handledNested) analyzeCommand(cmd, args, lc, a)

  let kind: SegmentKind = 'other'
  const redirectsOk = seg.redirects.every((r) => isHarmlessRedirect(r.op, r.target))
  if (!wrapped && !handledNested && redirectsOk && !hasPathSep) {
    if (isReadOnly(cmd, args, lc)) kind = 'readonly'
    else if (isVerification(cmd, args, lc, a)) kind = 'verify'
    else if (isPlainInstall(cmd, args, lc)) kind = 'install'
  }
  a.segments.push({ command: cmd, kind, class: segmentClass(cmd, args, kind, handledNested, seg, a.findings.slice(findingsBefore)) })
}

/** Commands whose only effect (once path checks pass) is writing files inside the project. */
const PROJECT_WRITE_CMDS = new Set([
  'mkdir', 'md', 'touch', 'cp', 'copy', 'copy-item', 'cpi', 'new-item', 'ni', 'set-content', 'add-content', 'ac', 'out-file',
  'mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'rename', 'rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir', 'rd', 'unlink', 'tee', 'tee-object',
])
/** git subcommands that only change the local repository (index, refs, worktrees, configuration of this repo). */
const GIT_LOCAL_SUBS = new Set([
  'add', 'commit', 'branch', 'worktree', 'stash', 'switch', 'checkout', 'merge', 'tag', 'restore', 'reset', 'cherry-pick', 'revert', 'mv', 'rm',
  'init', 'apply', 'am', 'bisect', 'notes', 'config', 'remote', 'submodule', 'rebase', 'range-diff', 'sparse-checkout', 'maintenance', 'gc', 'fsck',
  'format-patch', 'archive', 'bundle', 'clean', 'reflog', 'update-index', 'write-tree', 'commit-tree', 'hash-object', 'mktree', 'symbolic-ref', 'pack-refs', 'repack',
])

function segmentClass(cmd: string, args: string[], kind: SegmentKind, nested: boolean, seg: Segment, own: Finding[]): CommandClass {
  if (own.length > 0) return maxClass(own.map((x) => x.cls))
  if (nested) return 'SAFE_READ' // the wrapped commands are classified on their own
  if (kind === 'readonly' || kind === 'verify') return 'SAFE_READ'
  if (kind === 'install') return 'SAFE_PROJECT_WRITE'
  if (cmd === 'git' && GIT_LOCAL_SUBS.has(gitSubcommand(args) ?? '')) return 'GIT_LOCAL'
  if (cmd === 'git' && isReadOnlyGit(args, args.map((x) => x.toLowerCase()))) return 'SAFE_READ'
  if (PROJECT_WRITE_CMDS.has(cmd)) return 'SAFE_PROJECT_WRITE'
  if (READONLY_SIMPLE.has(cmd) && seg.redirects.length > 0) return 'SAFE_PROJECT_WRITE'
  return 'UNKNOWN'
}

/** First git subcommand after global options, lowercased. */
function gitSubcommand(args: string[]): string | undefined {
  let i = 0
  while (i < args.length) {
    const w = args[i] ?? ''
    if (w === '-c' || ['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(w)) i += 2
    else if (/^--config-env/i.test(w)) i += w.includes('=') ? 1 : 2
    else if (w.startsWith('-')) i++
    else break
  }
  return args[i]?.toLowerCase()
}

const POWER_WRAPPERS = new Set(['cmd', 'start', 'call', 'powershell', 'pwsh', 'sh', 'bash', 'command', 'start-process', 'saps', 'runas', 'sudo', 'env', 'nohup', 'timeout'])

/** True when a shell command line (as one string) runs a power command, directly or through a launcher word. */
function textRunsPowerCommand(text: string, depth = 0): boolean {
  if (depth > 3) return false
  for (const shell of ['bash', 'powershell'] as const) {
    for (const seg of tokenize(text, shell)) {
      const words = seg.words.filter((w) => w !== '&' && w !== '.')
      const names = commandNameCandidates(words[0] ?? '')
      const first = names.find((n) => POWER_WRAPPERS.has(n)) ?? names[0] ?? ''
      if (names.some((n) => POWER_CMDS.has(n))) return true
      if (POWER_WRAPPERS.has(first) && words.slice(1).some((w) => !w.startsWith('-') && !w.startsWith('/') && commandNameCandidates(w).some((n) => POWER_CMDS.has(n)))) return true
      if (POWER_WRAPPERS.has(first) && words.slice(1).some((w) => /\s/.test(w) && textRunsPowerCommand(w, depth + 1))) return true
    }
  }
  return false
}

/** True when any argument of a launcher/scheduler command names a power command (path, .exe, flag value or command line). */
function launchesPowerCommand(args: string[]): boolean {
  for (const raw of args) {
    const values = [raw]
    if (raw.startsWith('-') || raw.startsWith('/')) {
      const m = /^[-/]\w+[:=](.+)$/.exec(raw)
      if (m?.[1] !== undefined) values.push(m[1])
    }
    for (const v of values) {
      if (/\s/.test(v) ? textRunsPowerCommand(v) : commandNameCandidates(v).some((n) => POWER_CMDS.has(n))) return true
    }
  }
  return false
}

function isHarmlessRedirect(op: string, target: string): boolean {
  if (op.startsWith('<') && !op.startsWith('<<')) return true
  if (op.includes('&') && /^\d+$/.test(target)) return true
  return HARMLESS_REDIRECT_TARGET.has(target.toLowerCase())
}

function skipFlags(words: string[], from: number): number {
  let j = from
  while (j < words.length && (words[j] ?? '').startsWith('-')) j++
  return j
}
function skipEnvArgs(words: string[], from: number): number {
  let j = from
  while (j < words.length) {
    const w = words[j] ?? ''
    if (w.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) j++
    else break
  }
  return j
}
function skipXargsFlags(words: string[], from: number): number {
  let j = from
  while (j < words.length && (words[j] ?? '').startsWith('-')) {
    j += ['-i', '-n', '-p', '-d', '-l', '-s', '-e', '-a'].includes((words[j] ?? '').toLowerCase()) ? 2 : 1
  }
  return j
}

// ---------------------------------------------------------------------------------------------
// Path and secret checks on every word
// ---------------------------------------------------------------------------------------------

function checkWords(seg: Segment, words: string[], a: Analysis, destructive: boolean, isGit = false): void {
  const candidates = [...words, ...seg.redirects.map((r) => r.target)]
  for (const w of candidates) {
    if (w === '') continue
    for (const v of valuesOf(w)) {
      if (!/\s/.test(v) || /[\\/]/.test(v)) {
        if (isSecretPath(v)) a.ask('high', `accessing secrets: ${v}`)
      }
      const namesGit = v.split(/[\\/]/).some((s) => s.toLowerCase() === '.git')
      if (destructive && namesGit) {
        a.ask('high', 'deleting or moving a .git directory', 'DESTRUCTIVE')
      } else if (namesGit && !isGit) {
        // Git's own files (a worktree's `.git` pointer, the repository's config and hooks) decide which
        // repository NEXUS's later git commands act on and what they run. No command but git itself has a
        // reason to name them.
        a.ask('high', `touching Git's own files: ${v}`, 'SYSTEM_CHANGE')
      }
      const outside = outsideRoots(v, a)
      if (outside !== null) a.ask(destructive ? 'high' : 'medium', `${destructive ? 'deleting/moving ' : ''}${outside}`, destructive ? 'DESTRUCTIVE' : 'UNKNOWN')
    }
  }
  for (const r of seg.redirects) {
    if (r.op.startsWith('<') || isHarmlessRedirect(r.op, r.target)) continue
    if (r.target === '') a.ask('medium', 'process substitution or redirection without a visible target')
  }
}

function valuesOf(word: string): string[] {
  const out = [word]
  if (word.startsWith('-')) {
    const eq = word.indexOf('=')
    if (eq > 0) out.push(word.slice(eq + 1))
    const m = /^-\w+:(.+)$/.exec(word)
    if (m?.[1] !== undefined) out.push(m[1])
  }
  return out
}

/** Returns a description when `v` refers to a location outside every root, otherwise null. */
function outsideRoots(v: string, a: Analysis): string | null {
  const base = a.roots[0]
  if (base === undefined) return null
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(v)) return null
  if (v === '/dev/null' || v === '/dev/stdin' || v === '/dev/stdout' || v === '/dev/stderr') return null
  if (/^\/[A-Za-z?](:.*)?$/.test(v)) return null // cmd switches such as /s /q /c
  if (v === '~' || /^~[\\/]/.test(v)) return `path outside the worktree (home directory): ${v}`
  const pathVars = 'userprofile|home|appdata|localappdata|temp|tmp|programfiles|programdata|systemroot|windir|systemdrive|homedrive|homepath|allusersprofile|public'
  if (new RegExp(`^(\\$\\{?(env:)?|%)(${pathVars})(\\}|%|\\b)`, 'i').test(v)) {
    return `path from an environment variable may be outside the worktree: ${v}`
  }
  if (/^[\\/]{2}[^\\/]/.test(v)) return `UNC path outside the worktree: ${v}`

  let p = v
  const msys = /^\/(?:mnt\/)?([a-zA-Z])(?:\/(.*))?$/.exec(v)
  if (msys?.[1] !== undefined) p = `${msys[1].toUpperCase()}:\\${msys[2] ?? ''}`
  else if (!/^([a-zA-Z]:|[\\/])/.test(v) && !v.split(/[\\/]/).includes('..')) return null
  else if (/^\\/.test(v) && !/^\\[A-Za-z0-9_.-]+\\/.test(v)) return null // regex escapes like \d+

  const glob = p.search(/[*?[]/)
  if (glob >= 0) {
    p = p.slice(0, Math.max(p.slice(0, glob).search(/[\\/][^\\/]*$/), 0)) || '.'
    if (/^[a-zA-Z]:$/.test(p)) p += '\\'
  }
  try {
    const canonical = canonicalizePath(p, base)
    if (a.roots.some((r) => isPathInside(r, canonical))) return null
  } catch {
    // fall through: anything we cannot resolve is treated as outside
  }
  return `path outside the worktree: ${v}`
}

// ---------------------------------------------------------------------------------------------
// Nested shells
// ---------------------------------------------------------------------------------------------

function analyzeNestedShell(cmd: string, args: string[], a: Analysis, depth: number): boolean {
  if (cmd === 'wsl') {
    a.ask('high', 'WSL is not supported; commands must run natively on Windows')
    return true
  }
  const ps = cmd === 'powershell' || cmd === 'pwsh'
  const cmdExe = cmd === 'cmd'
  const sh = SH_SHELLS.has(cmd)
  if (!ps && !cmdExe && !sh) return false

  const lc = args.map((x) => x.toLowerCase())
  if (ps && lc.some((x) => /^-e(c|nc|ncodedcommand)?$/.test(x) || x === '-encodedcommand')) {
    a.ask('high', 'encoded PowerShell commands cannot be inspected')
    return true
  }
  const flagIdx = ps
    ? lc.findIndex((x) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(x))
    : cmdExe
      ? lc.findIndex((x) => x === '/c' || x === '/k')
      : lc.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x))
  if (flagIdx < 0) {
    a.ask('medium', `${cmd} runs a script file or starts an interactive shell that cannot be inspected`)
    return true
  }
  const payload = args.slice(flagIdx + 1).join(' ')
  if (payload.trim() === '') {
    a.ask('medium', `${cmd} invoked without an inspectable command`)
    return true
  }
  analyzeText(payload, ps ? 'powershell' : 'bash', a, depth + 1)
  return true
}

// ---------------------------------------------------------------------------------------------
// Per-command danger rules
// ---------------------------------------------------------------------------------------------

const HIGH_ALWAYS: Record<string, string> = {
  setx: 'setx changes persistent environment variables',
  schtasks: 'schtasks manages scheduled tasks',
  rundll32: 'rundll32 runs arbitrary DLL entry points',
  powercfg: 'powercfg changes power and sleep configuration',
  format: 'format erases a volume',
  'format-volume': 'format-volume erases a volume',
  diskpart: 'diskpart modifies disks',
  'clear-disk': 'clear-disk erases a disk',
  'initialize-disk': 'initialize-disk modifies disks',
  'remove-partition': 'remove-partition deletes a partition',
  bcdedit: 'bcdedit changes boot configuration',
  mountvol: 'mountvol changes volume mounts',
  fsutil: 'fsutil changes file system settings',
  vssadmin: 'vssadmin manages shadow copies',
  takeown: 'takeown changes file ownership',
  icacls: 'icacls changes file permissions',
  cacls: 'cacls changes file permissions',
  runas: 'runas starts a process as another user',
  netsh: 'netsh changes network configuration',
  wmic: 'wmic can change system state',
  dism: 'dism changes Windows components',
  sfc: 'sfc modifies system files',
  regedit: 'regedit edits the registry',
  regedt32: 'regedt32 edits the registry',
  sc: 'sc manages Windows services',
  'new-service': 'creates a Windows service',
  'set-service': 'changes a Windows service',
  'stop-service': 'stops a Windows service',
  'remove-service': 'removes a Windows service',
  'restart-service': 'restarts a Windows service',
  'new-localuser': 'creates a local user',
  'remove-localuser': 'removes a local user',
  'add-localgroupmember': 'changes local group membership',
  'set-executionpolicy': 'changes the PowerShell execution policy',
  'enable-psremoting': 'enables PowerShell remoting',
  'set-netfirewallrule': 'changes firewall rules',
  'new-netfirewallrule': 'creates firewall rules',
  'enable-windowsoptionalfeature': 'installs Windows features',
  'disable-windowsoptionalfeature': 'removes Windows features',
  'register-scheduledtask': 'registers a scheduled task',
  'set-scheduledtask': 'changes a scheduled task',
  'unregister-scheduledtask': 'removes a scheduled task',
  msiexec: 'msiexec installs or removes system software',
  'install-module': 'installs a PowerShell module system-wide',
  'install-package': 'installs system software',
  'install-script': 'installs a PowerShell script system-wide',
  'add-appxpackage': 'installs an application package',
  'remove-appxpackage': 'removes an application package',
  cmdkey: 'accessing secrets: cmdkey manages stored Windows credentials',
  vaultcmd: 'accessing secrets: vaultcmd reads the Windows credential vault',
  'convertfrom-securestring': 'accessing secrets: converts a secure string to text',
  ssh: 'ssh opens a remote connection',
  scp: 'scp transfers files to or from a remote host',
  sftp: 'sftp transfers files to or from a remote host',
  nc: 'nc opens arbitrary network connections',
  ncat: 'ncat opens arbitrary network connections',
  netcat: 'netcat opens arbitrary network connections',
  telnet: 'telnet opens arbitrary network connections',
  iex: 'Invoke-Expression runs arbitrary text as code',
  'invoke-expression': 'Invoke-Expression runs arbitrary text as code',
  eval: 'eval runs arbitrary text as code',
}

const MEDIUM_ALWAYS: Record<string, string> = {
  curl: 'network operation (curl)',
  wget: 'network operation (wget)',
  'invoke-webrequest': 'network operation (Invoke-WebRequest)',
  iwr: 'network operation (Invoke-WebRequest)',
  'invoke-restmethod': 'network operation (Invoke-RestMethod)',
  irm: 'network operation (Invoke-RestMethod)',
  ftp: 'network operation (ftp)',
  bitsadmin: 'network operation (bitsadmin)',
  'start-bitstransfer': 'network operation (BITS transfer)',
  taskkill: 'terminates processes',
  'stop-process': 'terminates processes',
  kill: 'terminates processes',
  pkill: 'terminates processes',
  killall: 'terminates processes',
  spps: 'terminates processes',
  'invoke-command': 'runs commands that cannot be inspected',
}

const NETWORK_HIGH = new Set(['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'telnet'])
const EXEC_HIGH = new Set(['iex', 'invoke-expression', 'eval'])
const PROCESS_KILL = new Set(['taskkill', 'stop-process', 'kill', 'pkill', 'killall', 'spps'])

const KEYLIKE = /key|token|secret|passw|credential|auth/i
const REGISTRY_PATH = /^(hklm|hkcu|hkcr|hku|hkcc)(:|\\)|^registry::|^hkey_/i
const REGISTRY_WRITERS = /^(set|new|remove|clear|rename|move|copy)-(item|itemproperty)$|^(sp|si|ni|ri|rp|rni|mi|ci|cpi|cp|mp)$/

function analyzeCommand(cmd: string, args: string[], lc: string[], a: Analysis): void {
  const positional = args.filter((x) => !x.startsWith('-'))
  const pos = positional.map((x) => x.toLowerCase())

  const high = HIGH_ALWAYS[cmd]
  if (high !== undefined) a.ask('high', high, NETWORK_HIGH.has(cmd) ? 'NETWORK' : EXEC_HIGH.has(cmd) ? 'UNKNOWN' : 'SYSTEM_CHANGE')
  const medium = MEDIUM_ALWAYS[cmd]
  if (medium !== undefined) a.ask('medium', medium, PROCESS_KILL.has(cmd) ? 'SYSTEM_CHANGE' : cmd === 'invoke-command' ? 'UNKNOWN' : 'NETWORK')
  if (cmd === 'wmic' && lc.some((x) => /^(win32)?(shutdown|reboot)$/.test(x))) a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')

  if (DELETE_CMDS.has(cmd)) analyzeDelete(cmd, args, lc, a)
  if (cmd === 'rmdir' || cmd === 'rd') {
    if (lc.includes('/s') || lc.includes('/q')) a.ask('high', `recursive delete (${cmd} /s)`, 'DESTRUCTIVE')
  }

  switch (cmd) {
    case 'git':
      analyzeGit(args, lc, a)
      break
    case 'gh':
      analyzeGh(positional, lc, a)
      break
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'npx':
      analyzePackageManager(cmd, lc, a)
      break
    case 'pip':
    case 'pip3':
    case 'pipx':
    case 'conda':
    case 'uv':
      analyzePip(cmd, pos, a)
      break
    case 'python':
    case 'python3':
    case 'py': {
      const m = lc.indexOf('-m')
      const mod = lc[m + 1]
      if (m >= 0 && mod === 'pip') analyzePip('pip', lc.slice(m + 2).filter((x) => !x.startsWith('-')), a)
      if (m >= 0 && mod === 'twine' && lc.slice(m + 2).includes('upload')) a.ask('high', 'publishes a package (twine upload)', 'NETWORK')
      break
    }
    case 'twine':
      if (pos[0] === 'upload') a.ask('high', 'publishes a package (twine upload)', 'NETWORK')
      break
    case 'cargo':
      if (['publish', 'yank', 'login', 'owner'].includes(pos[0] ?? '')) a.ask('high', `publishes or manages a crate (cargo ${pos[0]})`, 'NETWORK')
      else if (pos[0] === 'install') a.ask('medium', 'cargo install writes binaries outside the worktree', 'SYSTEM_CHANGE')
      else if (pos[0] === 'update') a.ask('medium', 'dependency upgrade (cargo update)', 'NETWORK')
      break
    case 'go':
      if (pos[0] === 'install') a.ask('medium', 'go install writes binaries outside the worktree', 'SYSTEM_CHANGE')
      break
    case 'dotnet':
      if (pos[0] === 'tool' && (lc.includes('-g') || lc.includes('--global'))) a.ask('high', 'global dotnet tool install', 'SYSTEM_CHANGE')
      if (pos[0] === 'nuget' && pos[1] === 'push') a.ask('high', 'publishes a package (dotnet nuget push)', 'NETWORK')
      break
    case 'docker':
      if (['push', 'login'].includes(pos[0] ?? '')) a.ask('high', `docker ${pos[0]} contacts or publishes to a registry`, 'NETWORK')
      break
    case 'gem':
      if (pos[0] === 'push') a.ask('high', 'publishes a package (gem push)', 'NETWORK')
      break
    case 'vsce':
    case 'ovsx':
    case 'poetry':
    case 'flit':
    case 'hatch':
    case 'lerna':
    case 'changeset':
      if (pos[0] === 'publish') a.ask('high', `publishes a package (${cmd} publish)`, 'NETWORK')
      break
    case 'winget':
    case 'choco':
    case 'scoop':
    case 'brew':
    case 'apt':
    case 'apt-get':
    case 'dnf':
    case 'yum':
    case 'pacman':
      if (['install', 'upgrade', 'uninstall', 'remove', 'update', 'import', 'source', 'add', 'sync'].includes(pos[0] ?? '')) {
        a.ask('high', `system software change (${cmd} ${pos[0]})`, 'SYSTEM_CHANGE')
      }
      break
    case 'reg':
      if (['add', 'delete', 'import', 'load', 'unload', 'copy', 'save', 'restore', 'flags'].includes(pos[0] ?? '')) {
        a.ask('high', `registry change (reg ${pos[0]})`, 'SYSTEM_CHANGE')
      }
      break
    case 'net':
    case 'net1':
      if (['user', 'localgroup', 'share', 'stop', 'start', 'pause', 'continue', 'accounts', 'config', 'use'].includes(pos[0] ?? '')) {
        a.ask('high', `net ${pos[0]} changes accounts, services or shares`, 'SYSTEM_CHANGE')
      }
      break
    case 'start-process':
    case 'saps':
    case 'start':
      if (lc.includes('runas')) a.ask('high', 'starts a process with elevated privileges (-Verb RunAs)', 'SYSTEM_CHANGE')
      break
    case 'export':
    case 'declare':
    case 'typeset':
    case 'readonly':
    case 'local':
    case 'setenv':
      if (args.some((x) => DANGEROUS_ENV_WORD.test(x))) a.ask('high', ENV_ASSIGN_REASON)
      break
    case 'printenv':
      if (positional.length === 0 || positional.some((x) => KEYLIKE.test(x))) a.ask('high', 'accessing secrets: printenv reads environment variables')
      break
    case 'find':
      analyzeFind(args, lc, a)
      break
    case 'robocopy':
      if (lc.some((x) => ['/mir', '/purge', '/mov', '/move'].includes(x))) a.ask('high', 'robocopy mirror/purge/move can delete files', 'DESTRUCTIVE')
      break
    case 'certutil':
      if (lc.includes('-urlcache') || lc.includes('-verifyctl')) a.ask('medium', 'network download (certutil)', 'NETWORK')
      break
    default:
      break
  }

  for (const w of args) {
    const m = /^env:(.*)$/i.exec(w)
    if (m && (m[1] === '' || /[*?]/.test(m[1] ?? '') || KEYLIKE.test(m[1] ?? ''))) {
      a.ask('high', 'accessing secrets: reads environment variables')
    }
  }
  if (REGISTRY_WRITERS.test(cmd) && args.some((w) => REGISTRY_PATH.test(w) || REGISTRY_PATH.test(w.replace(/^-\w+:/, '')))) {
    a.ask('high', 'modifies the Windows registry', 'SYSTEM_CHANGE')
  }
}

function shortFlags(args: string[]): string {
  return args
    .filter((x) => /^-[A-Za-z]{1,4}$/.test(x))
    .map((x) => x.slice(1))
    .join('')
}

function analyzeDelete(cmd: string, args: string[], lc: string[], a: Analysis): void {
  const cluster = shortFlags(args)
  const recursive =
    lc.some((x) => /^--?(r|re|rec|recu|recur|recurs|recurse|recursive)$/.test(x) || x === '/s') ||
    /[rR]/.test(cluster) ||
    lc.includes('/q')
  const force =
    lc.some((x) => /^--?(fo|for|forc|force)$/.test(x) || x === '/f') || cluster.includes('f')
  if (recursive) a.ask('high', `recursive delete (${cmd})`, 'DESTRUCTIVE')
  else if (force) a.ask('medium', `forced delete (${cmd})`, 'DESTRUCTIVE')
}

function analyzeFind(args: string[], lc: string[], a: Analysis): void {
  if (lc.includes('-delete')) a.ask('high', 'find -delete removes files', 'DESTRUCTIVE')
  const e = lc.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok' || x === '-okdir')
  if (e >= 0) {
    const payload = normalizeName(args[e + 1] ?? '')
    if (POWER_CMDS.has(payload)) a.add('forbidden', 'high', POWER_REASON, 'SYSTEM_CHANGE')
    else if (DELETE_CMDS.has(payload) || MOVE_CMDS.has(payload)) a.ask('high', `find -exec ${payload} deletes or moves files`, 'DESTRUCTIVE')
    else a.ask('medium', 'find -exec runs commands for each match')
  }
}

const GIT_UNSAFE_CONFIG =
  /^(core\.|credential\.|alias\.|http\.|protocol\.|diff\.|difftool\.|merge\.|mergetool\.|filter\.|pager\.|gpg\.|sequence\.|url\.|uploadpack\.|receive\.|include|submodule\.|ssh\.|man\.|web\.|browser\.|remote\.[^.]*\.(proxy|uploadpack|receivepack|vcs))/i

/** git keys that cannot hurt on their own (the broader GIT_UNSAFE_CONFIG list also matches them). */
const GIT_HARMLESS_CONFIG =
  /^(core\.(autocrlf|filemode|safecrlf|ignorecase|eol|longpaths|quotepath|whitespace|symlinks|precomposeunicode|trustctime|untrackedcache|abbrev|commentchar)|merge\.(ff|conflictstyle|renames|stat|verbosity)|diff\.(renames|algorithm|colormoved|context|mnemonicprefix|wsErrorHighlight)|http\.(sslverify|postbuffer))$/i
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only', '--get-color', '--get-colorbool'])
const GIT_CONFIG_REMOVE_FLAGS = new Set(['--unset', '--unset-all', '--remove-section', '--rename-section'])

/** `git config` writing a key that makes git run programs is as dangerous as `git -c`, in every scope. */
function analyzeGitConfig(rest: string[], rlc: string[], a: Analysis): void {
  if (rlc.some((x) => GIT_CONFIG_READ_FLAGS.has(x) || GIT_CONFIG_REMOVE_FLAGS.has(x))) return
  if (rlc.includes('-e') || rlc.includes('--edit')) {
    a.ask('high', 'git config --edit opens an editor', 'SYSTEM_CHANGE')
    return
  }
  let positional = rest.filter((x) => !x.startsWith('-'))
  // newer syntax: git config set|get|unset|list|edit
  const verb = positional[0]?.toLowerCase()
  if (verb === 'get' || verb === 'list' || verb === 'unset') return
  if (verb === 'edit') {
    a.ask('high', 'git config edit opens an editor', 'SYSTEM_CHANGE')
    return
  }
  if (verb === 'set') positional = positional.slice(1)
  // The key is not always the first word: an option that takes a value (`--type bool`, `--default x`,
  // `--comment x`, `--file f`) puts its value before it. Every word is therefore looked at as a possible key;
  // a value that merely looks like a dangerous key costs one question, a key that is missed costs the machine.
  const key = positional.find((word) => GIT_UNSAFE_CONFIG.test(word) && !GIT_HARMLESS_CONFIG.test(word))
  if (key !== undefined) {
    a.ask('high', `git config ${key} can make git run arbitrary programs`, 'SYSTEM_CHANGE')
  }
}

/** -C / --git-dir / --work-tree must stay inside the worktree and may not be computed at run time. */
function checkGitLocation(value: string | undefined, a: Analysis): void {
  if (value === undefined || /[$`%~]/.test(value)) {
    a.ask('high', 'git is pointed at a location computed at run time (-C/--git-dir/--work-tree)', 'SYSTEM_CHANGE')
    return
  }
  const base = a.roots[0]
  if (base === undefined) return
  try {
    const target = canonicalizePath(value, base)
    if (a.roots.some((r) => isPathInside(r, target))) return
  } catch {
    // unresolvable: treat as outside
  }
  a.ask('high', `git is pointed outside the worktree (${value})`, 'SYSTEM_CHANGE')
}

function analyzeGit(args: string[], lc: string[], a: Analysis): void {
  let i = 0
  while (i < args.length) {
    const w = args[i] ?? ''
    if (w === '-c') {
      if (GIT_UNSAFE_CONFIG.test(args[i + 1] ?? '')) a.ask('high', 'git -c can configure arbitrary command execution')
      i += 2
    } else if (/^--config-env/i.test(w)) {
      a.ask('high', 'git --config-env can configure arbitrary command execution')
      i += w.includes('=') ? 1 : 2
    } else if (['-C', '--git-dir', '--work-tree'].includes(w)) {
      checkGitLocation(args[i + 1], a)
      i += 2
    } else if (/^--(git-dir|work-tree)=/i.test(w)) {
      checkGitLocation(w.slice(w.indexOf('=') + 1), a)
      i++
    } else if (['--namespace', '--exec-path'].includes(w)) i += 2
    else if (w.startsWith('-')) i++
    else break
  }
  const sub = lc[i]
  const rest = args.slice(i + 1)
  const rlc = lc.slice(i + 1)
  const rpos = rest.filter((x) => !x.startsWith('-'))
  const rshort = shortFlags(rest)
  if (sub === undefined) return
  const hasFlag = (...names: string[]): boolean => rlc.some((x) => names.includes(x))

  switch (sub) {
    case 'push': {
      const force =
        hasFlag('--force', '-f', '--delete', '-d', '--mirror', '--prune') ||
        rlc.some((x) => x.startsWith('--force-with-lease') || x.startsWith('+') || x.startsWith(':')) ||
        /[f]/.test(rshort)
      a.ask(force ? 'high' : 'medium', force ? 'git push --force/--delete rewrites or removes remote history' : 'git push publishes commits to a remote', force ? 'DESTRUCTIVE' : 'NETWORK')
      break
    }
    case 'reset':
      if (hasFlag('--hard', '--merge', '--keep')) a.ask('high', 'git reset --hard discards uncommitted work', 'DESTRUCTIVE')
      break
    case 'clean':
      if ((hasFlag('--force') || rshort.includes('f')) && !hasFlag('-n', '--dry-run') && !rshort.includes('n')) {
        a.ask('high', 'git clean -f permanently deletes untracked files', 'DESTRUCTIVE')
      }
      break
    case 'branch':
      if (rshort.includes('D') || (hasFlag('--delete') && hasFlag('--force')) || (rshort.includes('d') && rshort.includes('f'))) {
        a.ask('high', 'git branch -D force-deletes a branch', 'DESTRUCTIVE')
      }
      break
    case 'checkout': {
      const creates = rest.includes('-b') || rest.includes('-B') || hasFlag('--orphan')
      if (hasFlag('--', '-f', '--force', '--ours', '--theirs') || rpos.includes('.') || rest.includes('-B') || (!creates && rpos.length >= 2)) {
        a.ask('high', 'git checkout can discard uncommitted changes', 'DESTRUCTIVE')
      }
      break
    }
    case 'switch':
      if (hasFlag('-f', '--force', '--discard-changes')) a.ask('high', 'git switch --discard-changes discards uncommitted work', 'DESTRUCTIVE')
      break
    case 'restore': {
      const staged = hasFlag('--staged') || rest.includes('-S')
      const worktree = hasFlag('--worktree') || rest.includes('-W')
      if (!staged || worktree) a.ask('high', 'git restore discards uncommitted changes in the working tree', 'DESTRUCTIVE')
      break
    }
    case 'rebase':
      a.ask('high', 'git rebase rewrites history', 'DESTRUCTIVE')
      break
    case 'filter-branch':
    case 'filter-repo':
      a.ask('high', `git ${sub} rewrites history`, 'DESTRUCTIVE')
      break
    case 'worktree':
      if (['remove', 'prune', 'move'].includes(rlc[0] ?? '')) a.ask('high', `git worktree ${rlc[0]} removes or relocates worktrees`, 'DESTRUCTIVE')
      break
    case 'config':
      analyzeGitConfig(rest, rlc, a)
      if (hasFlag('--global', '--system', '--file', '-f')) a.ask('high', 'git config --global/--system changes configuration outside the repository', 'SYSTEM_CHANGE')
      break
    case 'stash':
      if (['drop', 'clear'].includes(rlc[0] ?? '')) a.ask('medium', `git stash ${rlc[0]} discards stashed work`, 'DESTRUCTIVE')
      break
    case 'reflog':
      if (['expire', 'delete'].includes(rlc[0] ?? '')) a.ask('high', 'git reflog expire/delete destroys recovery points', 'DESTRUCTIVE')
      break
    case 'gc':
    case 'prune':
      if (sub === 'prune' || rlc.some((x) => x.startsWith('--prune=now'))) a.ask('high', 'git prune permanently deletes unreachable objects', 'DESTRUCTIVE')
      break
    case 'update-ref':
      if (hasFlag('-d')) a.ask('high', 'git update-ref -d deletes a ref', 'DESTRUCTIVE')
      break
    case 'credential':
      a.ask('high', 'accessing secrets: git credential reads stored credentials')
      break
    case 'clone':
    case 'fetch':
    case 'pull':
    case 'ls-remote':
      a.ask('medium', `network operation (git ${sub})`, 'NETWORK')
      break
    case 'submodule':
      if (['update', 'add'].includes(rlc[0] ?? '')) a.ask('medium', `network operation (git submodule ${rlc[0]})`, 'NETWORK')
      break
    default:
      break
  }
}

const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks'])

function analyzeGh(positional: string[], lc: string[], a: Analysis): void {
  const sub = positional[0]?.toLowerCase()
  const verb = positional[1]?.toLowerCase()
  if (sub === undefined) return
  if (sub === 'api') {
    const writes =
      lc.some((x) => ['-f', '--field', '--raw-field', '--input'].includes(x)) ||
      lc.some((x, idx) => (x === '-x' || x === '--method') && lc[idx + 1] !== 'get')
    a.ask(writes ? 'high' : 'medium', writes ? 'gh api performs a write against GitHub' : 'network operation (gh api)', 'NETWORK')
    return
  }
  if (['release', 'secret', 'variable', 'auth', 'ssh-key', 'gpg-key', 'extension', 'codespace', 'alias', 'config'].includes(sub)) {
    a.ask('high', `gh ${sub} ${verb ?? ''} publishes or changes GitHub/account state`.replace('  ', ' '), 'NETWORK')
    return
  }
  const read = verb !== undefined && GH_READ_VERBS.has(verb)
  a.ask(read ? 'medium' : 'high', `network operation (gh ${sub} ${verb ?? ''})`.replace('  ', ' '), 'NETWORK')
}

const PM_PUBLISH = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'login', 'adduser', 'token', 'owner', 'access', 'team', 'logout'])

function analyzePackageManager(cmd: string, lc: string[], a: Analysis): void {
  const positional = lc.filter((x) => !x.startsWith('-'))
  const sub = positional[0]
  const sub2 = positional[1]
  if (PM_PUBLISH.has(sub ?? '') || (sub === 'npm' && PM_PUBLISH.has(sub2 ?? ''))) {
    a.ask('high', `publishes or changes registry state (${cmd} ${sub === 'npm' ? 'npm ' : ''}${sub === 'npm' ? sub2 : sub})`, 'NETWORK')
    return
  }
  const globalFlag = lc.some((x) => x === '-g' || x === '--global' || x === '--location=global')
  const mutating = ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade', 'link', 'unlink', 'ln']
  if ((globalFlag && mutating.includes(sub ?? '')) || (cmd === 'yarn' && sub === 'global')) {
    a.ask('high', `global package change (${cmd} ${sub ?? ''} -g) modifies the system outside the worktree`, 'SYSTEM_CHANGE')
    return
  }
  const upgrade = ['update', 'upgrade', 'up'].includes(sub ?? '')
  if (upgrade || (sub === 'audit' && lc.includes('fix') && lc.includes('--force'))) {
    const named = positional.slice(1)
    const sweeping = named.length === 0 || lc.some((x) => x === '-l' || x === '--latest' || x === '-i' || x === '--interactive')
    if (upgrade && sweeping) a.ask('medium', `dependency upgrade at large (${cmd} ${sub})`, 'NETWORK')
    else if (sub === 'audit') a.ask('medium', 'npm audit fix --force can introduce breaking upgrades', 'NETWORK')
  }
}

function analyzePip(cmd: string, pos: string[], a: Analysis): void {
  if (!['install', 'uninstall'].includes(pos[0] ?? '') && !(cmd === 'pipx' && pos[0] !== undefined)) return
  if (cmd === 'uv' && pos[0] !== 'pip') return
  if (a.venv) return
  a.ask('medium', `${cmd} ${pos[0] ?? ''} outside a virtual environment changes the global Python installation`, 'SYSTEM_CHANGE')
}

// ---------------------------------------------------------------------------------------------
// Allowlists for restricted roles
// ---------------------------------------------------------------------------------------------

const READONLY_SIMPLE = new Set([
  'ls', 'dir', 'get-childitem', 'gci', 'cat', 'type', 'get-content', 'gc', 'findstr', 'select-string', 'sls',
  'rg', 'grep', 'egrep', 'fgrep', 'pwd', 'get-location', 'gl', 'wc', 'measure-object', 'measure', 'head', 'tail',
  'where', 'which', 'get-command', 'gcm', 'echo', 'write-output', 'write-host', 'select-object', 'select',
  'sort-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'test-path', 'get-item', 'gi',
  'resolve-path', 'rvpa', 'get-filehash', 'tree', 'stat', 'basename', 'dirname', 'realpath', 'split-path',
  'join-path', 'uniq', 'get-date', 'date',
])
const VERSION_PROBES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'py', 'git', 'tsc', 'cargo', 'go', 'dotnet', 'java', 'rustc', 'deno', 'pip', 'pip3'])
const GIT_READ_SUBS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'ls-tree', 'cat-file', 'rev-list', 'merge-base', 'show-ref', 'grep', 'diff-tree', 'name-rev', 'annotate'])
const GIT_BRANCH_FLAGS = new Set(['--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--no-color', '--color'])

/** True when `x` (lowercased) is a long option equal to, an abbreviation of, or an extension of one of `names`. */
function matchesLong(x: string, names: string[]): boolean {
  const n = x.split('=')[0] ?? x
  return n.length >= 3 && n.startsWith('--') && names.some((d) => d.startsWith(n) || n.startsWith(d))
}

/** True when `x` is a single-dash short-option cluster containing one of `chars` (case-sensitive). */
function shortClusterHas(x: string, chars: string): boolean {
  return /^-[^-]/.test(x) && [...x.slice(1)].some((c) => chars.includes(c))
}

/** Pipeline cmdlets whose arguments may be script blocks that PowerShell executes. */
const SCRIPTBLOCK_ARG_CMDS = new Set(['where', 'select', 'select-object', 'sort-object', 'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'out-string'])
/** git options that name a program to run or a file to write. */
const GIT_DANGEROUS_LONG = ['--output', '--open-files-in-pager', '--ext-diff', '--exec', '--upload-pack', '--receive-pack']
const UNIQ_VALUE_LONG = new Set(['--skip-fields', '--skip-chars', '--check-chars'])

/** `uniq [OPTION]... [INPUT [OUTPUT]]`: the second operand is an output file, so at most one operand is read-only. */
function isReadOnlyUniq(args: string[]): boolean {
  let operands = 0
  for (let k = 0; k < args.length; k++) {
    const x = args[k] ?? ''
    if (x === '--') {
      operands += args.length - k - 1
      break
    }
    if (x.startsWith('--')) {
      if (UNIQ_VALUE_LONG.has(x)) k++
    } else if (x.startsWith('-') && x.length > 1) {
      if (/[fsw]$/.test(x)) k++
    } else operands++
  }
  return operands <= 1
}

/** `date` can set the clock (-s, or a bare MMDDhhmm operand); only formatting and display are read-only. */
function isReadOnlyDate(args: string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const x = args[k] ?? ''
    if (x.startsWith('+') || ['-u', '--utc', '--universal', '-R', '--rfc-email'].includes(x)) continue
    if (/^--(date|iso-8601|rfc-[a-z0-9-]+|reference)=/.test(x) || /^-I\w*$/.test(x)) continue
    if (x === '-d' || x === '--date' || x === '-r' || x === '--reference') {
      k++
      continue
    }
    return false
  }
  return true
}

function isReadOnly(cmd: string, args: string[], lc: string[]): boolean {
  if (VERSION_PROBES.has(cmd) && args.length === 1 && ['-v', '--version', '-V', 'version', '-version'].includes(args[0] ?? '')) return true
  if (SCRIPTBLOCK_ARG_CMDS.has(cmd) && args.some((x) => x.includes('{'))) return false
  switch (cmd) {
    case 'git':
      return isReadOnlyGit(args, lc)
    case 'sort':
      return !lc.some((x) => x === '-o' || matchesLong(x, ['--output', '--compress-program']) || (/^-[a-z]*o/.test(x) && !x.startsWith('--')) || x.startsWith('/o'))
    case 'tail':
      return !lc.some((x) => x === '-f' || x.startsWith('--follow'))
    case 'rg':
      return !lc.some((x) => x.startsWith('--pre') || x.startsWith('--hostname-bin') || x === '--search-zip' || shortClusterHas(x, 'z'))
    case 'tree':
      return !lc.some((x) => matchesLong(x, ['--output']) || shortClusterHas(x, 'o'))
    case 'uniq':
      return isReadOnlyUniq(args)
    case 'date':
      return isReadOnlyDate(args)
    case 'get-content':
    case 'gc':
      return !lc.some((x) => x === '-wait')
    default:
      return READONLY_SIMPLE.has(cmd)
  }
}

function isReadOnlyGit(args: string[], lc: string[]): boolean {
  if (args.length === 0) return false
  const first = args[0] ?? ''
  if (first.startsWith('-')) return false
  const sub = first.toLowerCase()
  const rest = args.slice(1)
  const rlc = lc.slice(1)
  // git accepts unique abbreviations of long options, so match prefixes; -O/-o differ by case.
  if (rlc.some((x) => x === '-o' || matchesLong(x, GIT_DANGEROUS_LONG))) return false
  if (rest.some((x) => x.startsWith('-O'))) return false
  if (sub === 'grep' && rest.some((x) => shortClusterHas(x, 'O'))) return false
  if (GIT_READ_SUBS.has(sub)) return true
  const pos = rest.filter((x) => !x.startsWith('-'))
  switch (sub) {
    case 'branch': {
      if (!rlc.every((x) => x.startsWith('-') ? GIT_BRANCH_FLAGS.has(x.split('=')[0] ?? x) : true)) return false
      const listing = rlc.some((x) => ['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current'].includes(x))
      return pos.length === 0 || listing
    }
    case 'tag': {
      const listing = rlc.includes('--list') || rlc.includes('-l')
      return rlc.every((x) => !x.startsWith('-') || ['--list', '-l', '-n', '--sort', '--contains'].includes(x.split('=')[0] ?? x)) && (pos.length === 0 || listing)
    }
    case 'remote':
      return rest.length === 0 || (rest.length === 1 && (rlc[0] === '-v' || rlc[0] === '--verbose'))
    case 'stash':
      return rlc[0] === 'list' || rlc[0] === 'show'
    default:
      return false
  }
}

const VERIFY_TOOLS = new Set(['vitest', 'jest', 'tsc', 'eslint', 'playwright', 'vue-tsc', 'pytest', 'mypy'])
const VERIFY_SCRIPT = /^(test|lint|typecheck|type-check|build|check|compile|verify)(:[\w:.-]+)?$/
const PM_VALUE_FLAGS = new Set(['--filter', '-f', '--prefix', '-c', '--dir', '--workspace', '-w', '--cwd'])

function pmWords(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = (words[i] ?? '').toLowerCase()
    if (w.startsWith('-')) {
      if (PM_VALUE_FLAGS.has(w)) i++
      continue
    }
    out.push(w)
  }
  return out
}

function verifyTool(tool: string, args: string[], lc: string[]): boolean {
  if (!VERIFY_TOOLS.has(tool)) return false
  if (lc.some((x) => x.startsWith('--out') || x === '-o')) return false
  if (lc.some((x) => x === '--fix' || x === '--fix-dry-run' || x === '-u' || x === '--update' || x === '--updatesnapshot' || x === '--write')) return false
  if (tool === 'playwright') return args.find((x) => !x.startsWith('-'))?.toLowerCase() === 'test'
  return true
}

function isVerification(cmd: string, args: string[], lc: string[], a: Analysis): boolean {
  const normalized = [cmd, ...lc]
  for (const prefix of a.prefixes) {
    if (prefix.length <= normalized.length && prefix.every((p, idx) => normalized[idx] === p) && !lc.some((x) => x === '--fix')) return true
  }
  if (verifyTool(cmd, args, lc)) return true
  const pw = pmWords(args)
  const sub = pw[0]
  switch (cmd) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (sub === 'run' || sub === 'run-script') return VERIFY_SCRIPT.test(pw[1] ?? '')
      if (sub === 'exec') {
        const ti = lc.indexOf(pw[1] ?? '')
        return ti >= 0 && verifyTool(pw[1] ?? '', args.slice(ti + 1), lc.slice(ti + 1))
      }
      if (sub === 't' || sub === 'test') return true
      return VERIFY_SCRIPT.test(sub ?? '') && cmd !== 'npm'
    }
    case 'npx':
    case 'bunx': {
      if (lc.includes('-y') || lc.includes('--yes')) return false
      const idx = args.findIndex((x) => !x.startsWith('-'))
      const tool = (args[idx] ?? '').toLowerCase()
      return idx >= 0 && verifyTool(tool, args.slice(idx + 1), lc.slice(idx + 1))
    }
    case 'python':
    case 'python3':
    case 'py': {
      const m = lc.indexOf('-m')
      return m >= 0 && ['pytest', 'unittest', 'mypy'].includes(lc[m + 1] ?? '')
    }
    case 'cargo':
      return ['test', 'check', 'build', 'clippy'].includes(sub ?? '')
    case 'go':
      return ['test', 'vet', 'build'].includes(sub ?? '')
    case 'dotnet':
      return ['test', 'build'].includes(sub ?? '')
    case 'make':
      return ['test', 'check'].includes(sub ?? '')
    default:
      return false
  }
}

function isPlainInstall(cmd: string, _args: string[], lc: string[]): boolean {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) return false
  const pw = pmWords(lc)
  const sub = pw[0]
  if (cmd === 'yarn' && pw.length === 0) return true
  if (sub === 'ci') return cmd === 'npm' && pw.length === 1
  return (sub === 'install' || sub === 'i') && pw.length === 1
}
