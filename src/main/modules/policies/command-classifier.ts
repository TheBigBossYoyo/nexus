import { canonicalizePath, isPathInside, isSecretPath } from './paths'
import { tokenize } from './shell-tokenizer'
import type { Segment, Shell } from './shell-tokenizer'

export type CommandLevel = 'safe' | 'write' | 'needs_approval' | 'forbidden'
export type CommandRisk = 'low' | 'medium' | 'high'
/** How a single sub-command may be used by restricted roles. */
export type SegmentKind = 'readonly' | 'verify' | 'install' | 'other'

export interface SegmentInfo {
  command: string
  kind: SegmentKind
}

export interface CommandClassification {
  /** safe: every sub-command is read-only inspection. write: anything else not gated. */
  level: CommandLevel
  reasons: string[]
  /** Highest risk among needs_approval findings; null otherwise. */
  risk: CommandRisk | null
  /** One entry per inspected sub-command (including nested shells and substitutions). */
  segments: SegmentInfo[]
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

  add(level: Finding['level'], risk: CommandRisk, reason: string): void {
    this.findings.push({ level, risk, reason })
  }
  ask(risk: CommandRisk, reason: string): void {
    this.add('needs_approval', risk, reason)
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
  if (a.findings.some((f) => f.level === 'forbidden')) {
    const forbidden = a.findings.filter((f) => f.level === 'forbidden')
    return { level: 'forbidden', reasons: [...new Set(forbidden.map((f) => f.reason))], risk: 'high', segments }
  }
  if (a.findings.length > 0) {
    const risk = a.findings.reduce<CommandRisk>((m, f) => (RISK_ORDER[f.risk] > RISK_ORDER[m] ? f.risk : m), 'low')
    return { level: 'needs_approval', reasons, risk, segments }
  }
  const readOnly = segments.every((s) => s.kind === 'readonly')
  return { level: readOnly ? 'safe' : 'write', reasons: [], risk: null, segments }
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
const DOTNET_NETWORK = /net\.webclient|downloadstring|downloadfile|start-bitstransfer|system\.net\.http/i

function analyzeText(text: string, shell: Shell, a: Analysis, depth: number): void {
  if (depth > MAX_NESTING) {
    a.ask('high', 'shell commands are nested too deeply to inspect')
    return
  }
  if (CREDENTIAL_STORE.test(text)) {
    a.add('forbidden', 'high', 'Claude credential stores must never be read or printed')
  }
  if (SECURITY_TOOLING.test(text)) {
    a.add('forbidden', 'high', 'disabling or modifying security tooling is not permitted')
  }
  if (MACHINE_ENV.test(text)) {
    a.ask('high', 'changes machine/user environment variables')
  }
  if (SECRET_ENV_REF.test(text)) {
    a.ask('high', 'accessing secrets: references a key/token/secret-like environment variable')
  }
  if (DOTNET_NETWORK.test(text)) {
    a.ask('medium', 'network operation (.NET web client / BITS transfer)')
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
  const base = word.split(/[\\/]/).pop() ?? word
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

function analyzeSegment(seg: Segment, shell: Shell, a: Analysis, depth: number): void {
  const words = [...seg.words]
  const hasPathSep = words[0] !== undefined && /[\\/]/.test(words[0]) && !/^\.[\\/]node_modules[\\/]\.bin[\\/]/.test(words[0])

  let i = 0
  if (shell === 'bash') while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++
  let wrapped = i > 0
  let isCallOp = false
  if (shell === 'powershell' && (words[i] === '&' || words[i] === '.')) {
    isCallOp = true
    i++
  }
  const first = words[i]
  if (isCallOp && (first === undefined || first.startsWith('$'))) {
    a.ask('medium', 'call operator with a dynamic command name cannot be inspected')
  }

  // Strip wrappers that run another command.
  for (let guard = 0; guard < 4 && words[i] !== undefined; guard++) {
    const w = normalizeName(words[i] ?? '')
    if (w === 'sudo' || w === 'doas' || w === 'gsudo') {
      a.ask('high', `${w} runs with elevated privileges`)
      i = skipFlags(words, i + 1)
      wrapped = true
    } else if (w === 'env') {
      const j = skipEnvArgs(words, i + 1)
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

  checkWords(seg, words, a, DELETE_CMDS.has(normalizeName(words[i] ?? '')) || MOVE_CMDS.has(normalizeName(words[i] ?? '')))

  const nameWord = words[i]
  if (nameWord === undefined) {
    a.segments.push({ command: '', kind: seg.words.length === 0 && seg.redirects.every((r) => isHarmlessRedirect(r.op, r.target)) ? 'readonly' : 'other' })
    return
  }
  const cmd = normalizeName(nameWord)
  const args = words.slice(i + 1)
  const lc = args.map((x) => x.toLowerCase())

  if (seg.sep === '|' && INTERPRETERS.has(cmd) && args.every((x) => x.startsWith('-'))) {
    a.ask('high', `piping data into ${cmd} executes it (download-and-execute pattern)`)
  }
  if (seg.sep === '|' && (cmd === 'iex' || cmd === 'invoke-expression')) {
    a.ask('high', 'piping into Invoke-Expression executes arbitrary text')
  }

  const handledNested = analyzeNestedShell(cmd, args, a, depth)
  if (!handledNested) analyzeCommand(cmd, args, lc, a)

  let kind: SegmentKind = 'other'
  const redirectsOk = seg.redirects.every((r) => isHarmlessRedirect(r.op, r.target))
  if (!wrapped && !handledNested && redirectsOk && !hasPathSep) {
    if (isReadOnly(cmd, args, lc)) kind = 'readonly'
    else if (isVerification(cmd, args, lc, a)) kind = 'verify'
    else if (isPlainInstall(cmd, args, lc)) kind = 'install'
  }
  a.segments.push({ command: cmd, kind })
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

function checkWords(seg: Segment, words: string[], a: Analysis, destructive: boolean): void {
  const candidates = [...words, ...seg.redirects.map((r) => r.target)]
  for (const w of candidates) {
    if (w === '') continue
    for (const v of valuesOf(w)) {
      if (!/\s/.test(v) || /[\\/]/.test(v)) {
        if (isSecretPath(v)) a.ask('high', `accessing secrets: ${v}`)
      }
      if (destructive && v.split(/[\\/]/).some((s) => s.toLowerCase() === '.git')) {
        a.ask('high', 'deleting or moving a .git directory')
      }
      const outside = outsideRoots(v, a)
      if (outside !== null) a.ask(destructive ? 'high' : 'medium', `${destructive ? 'deleting/moving ' : ''}${outside}`)
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
  shutdown: 'shutdown affects the whole machine',
  'restart-computer': 'restarts the machine',
  'stop-computer': 'shuts down the machine',
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

const KEYLIKE = /key|token|secret|passw|credential|auth/i
const REGISTRY_PATH = /^(hklm|hkcu|hkcr|hku|hkcc)(:|\\)|^registry::|^hkey_/i
const REGISTRY_WRITERS = /^(set|new|remove|clear|rename|move|copy)-(item|itemproperty)$|^(sp|si|ni|ri|rp|rni|mi|ci|cpi|cp|mp)$/

function analyzeCommand(cmd: string, args: string[], lc: string[], a: Analysis): void {
  const positional = args.filter((x) => !x.startsWith('-'))
  const pos = positional.map((x) => x.toLowerCase())

  const high = HIGH_ALWAYS[cmd]
  if (high !== undefined) a.ask('high', high)
  const medium = MEDIUM_ALWAYS[cmd]
  if (medium !== undefined) a.ask('medium', medium)

  if (DELETE_CMDS.has(cmd)) analyzeDelete(cmd, args, lc, a)
  if (cmd === 'rmdir' || cmd === 'rd') {
    if (lc.includes('/s') || lc.includes('/q')) a.ask('high', `recursive delete (${cmd} /s)`)
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
      if (m >= 0 && mod === 'twine' && lc.slice(m + 2).includes('upload')) a.ask('high', 'publishes a package (twine upload)')
      break
    }
    case 'twine':
      if (pos[0] === 'upload') a.ask('high', 'publishes a package (twine upload)')
      break
    case 'cargo':
      if (['publish', 'yank', 'login', 'owner'].includes(pos[0] ?? '')) a.ask('high', `publishes or manages a crate (cargo ${pos[0]})`)
      else if (pos[0] === 'install') a.ask('medium', 'cargo install writes binaries outside the worktree')
      else if (pos[0] === 'update') a.ask('medium', 'dependency upgrade (cargo update)')
      break
    case 'go':
      if (pos[0] === 'install') a.ask('medium', 'go install writes binaries outside the worktree')
      break
    case 'dotnet':
      if (pos[0] === 'tool' && (lc.includes('-g') || lc.includes('--global'))) a.ask('high', 'global dotnet tool install')
      if (pos[0] === 'nuget' && pos[1] === 'push') a.ask('high', 'publishes a package (dotnet nuget push)')
      break
    case 'docker':
      if (['push', 'login'].includes(pos[0] ?? '')) a.ask('high', `docker ${pos[0]} contacts or publishes to a registry`)
      break
    case 'gem':
      if (pos[0] === 'push') a.ask('high', 'publishes a package (gem push)')
      break
    case 'vsce':
    case 'ovsx':
    case 'poetry':
    case 'flit':
    case 'hatch':
    case 'lerna':
    case 'changeset':
      if (pos[0] === 'publish') a.ask('high', `publishes a package (${cmd} publish)`)
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
        a.ask('high', `system software change (${cmd} ${pos[0]})`)
      }
      break
    case 'reg':
      if (['add', 'delete', 'import', 'load', 'unload', 'copy', 'save', 'restore', 'flags'].includes(pos[0] ?? '')) {
        a.ask('high', `registry change (reg ${pos[0]})`)
      }
      break
    case 'net':
    case 'net1':
      if (['user', 'localgroup', 'share', 'stop', 'start', 'pause', 'continue', 'accounts', 'config', 'use'].includes(pos[0] ?? '')) {
        a.ask('high', `net ${pos[0]} changes accounts, services or shares`)
      }
      break
    case 'start-process':
    case 'saps':
    case 'start':
      if (lc.includes('runas')) a.ask('high', 'starts a process with elevated privileges (-Verb RunAs)')
      break
    case 'printenv':
      if (positional.length === 0 || positional.some((x) => KEYLIKE.test(x))) a.ask('high', 'accessing secrets: printenv reads environment variables')
      break
    case 'find':
      analyzeFind(args, lc, a)
      break
    case 'robocopy':
      if (lc.some((x) => ['/mir', '/purge', '/mov', '/move'].includes(x))) a.ask('high', 'robocopy mirror/purge/move can delete files')
      break
    case 'certutil':
      if (lc.includes('-urlcache') || lc.includes('-verifyctl')) a.ask('medium', 'network download (certutil)')
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
    a.ask('high', 'modifies the Windows registry')
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
  if (recursive) a.ask('high', `recursive delete (${cmd})`)
  else if (force) a.ask('medium', `forced delete (${cmd})`)
}

function analyzeFind(args: string[], lc: string[], a: Analysis): void {
  if (lc.includes('-delete')) a.ask('high', 'find -delete removes files')
  const e = lc.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok' || x === '-okdir')
  if (e >= 0) {
    const payload = normalizeName(args[e + 1] ?? '')
    if (DELETE_CMDS.has(payload) || MOVE_CMDS.has(payload)) a.ask('high', `find -exec ${payload} deletes or moves files`)
    else a.ask('medium', 'find -exec runs commands for each match')
  }
}

const GIT_UNSAFE_CONFIG = /^(core\.(sshcommand|hookspath|pager|editor|fsmonitor)|credential\.|alias\.|http\.proxy|protocol\.ext)/i

function analyzeGit(args: string[], lc: string[], a: Analysis): void {
  let i = 0
  while (i < args.length) {
    const w = args[i] ?? ''
    if (w === '-c') {
      if (GIT_UNSAFE_CONFIG.test(args[i + 1] ?? '')) a.ask('high', 'git -c can configure arbitrary command execution')
      i += 2
    } else if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(w)) i += 2
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
      a.ask(force ? 'high' : 'medium', force ? 'git push --force/--delete rewrites or removes remote history' : 'git push publishes commits to a remote')
      break
    }
    case 'reset':
      if (hasFlag('--hard', '--merge', '--keep')) a.ask('high', 'git reset --hard discards uncommitted work')
      break
    case 'clean':
      if ((hasFlag('--force') || rshort.includes('f')) && !hasFlag('-n', '--dry-run') && !rshort.includes('n')) {
        a.ask('high', 'git clean -f permanently deletes untracked files')
      }
      break
    case 'branch':
      if (rshort.includes('D') || (hasFlag('--delete') && hasFlag('--force')) || (rshort.includes('d') && rshort.includes('f'))) {
        a.ask('high', 'git branch -D force-deletes a branch')
      }
      break
    case 'checkout': {
      const creates = rest.includes('-b') || rest.includes('-B') || hasFlag('--orphan')
      if (hasFlag('--', '-f', '--force', '--ours', '--theirs') || rpos.includes('.') || rest.includes('-B') || (!creates && rpos.length >= 2)) {
        a.ask('high', 'git checkout can discard uncommitted changes')
      }
      break
    }
    case 'switch':
      if (hasFlag('-f', '--force', '--discard-changes')) a.ask('high', 'git switch --discard-changes discards uncommitted work')
      break
    case 'restore': {
      const staged = hasFlag('--staged') || rest.includes('-S')
      const worktree = hasFlag('--worktree') || rest.includes('-W')
      if (!staged || worktree) a.ask('high', 'git restore discards uncommitted changes in the working tree')
      break
    }
    case 'rebase':
      a.ask('high', 'git rebase rewrites history')
      break
    case 'filter-branch':
    case 'filter-repo':
      a.ask('high', `git ${sub} rewrites history`)
      break
    case 'worktree':
      if (['remove', 'prune', 'move'].includes(rlc[0] ?? '')) a.ask('high', `git worktree ${rlc[0]} removes or relocates worktrees`)
      break
    case 'config':
      if (hasFlag('--global', '--system', '--file', '-f')) a.ask('high', 'git config --global/--system changes configuration outside the repository')
      break
    case 'stash':
      if (['drop', 'clear'].includes(rlc[0] ?? '')) a.ask('medium', `git stash ${rlc[0]} discards stashed work`)
      break
    case 'reflog':
      if (['expire', 'delete'].includes(rlc[0] ?? '')) a.ask('high', 'git reflog expire/delete destroys recovery points')
      break
    case 'gc':
    case 'prune':
      if (sub === 'prune' || rlc.some((x) => x.startsWith('--prune=now'))) a.ask('high', 'git prune permanently deletes unreachable objects')
      break
    case 'update-ref':
      if (hasFlag('-d')) a.ask('high', 'git update-ref -d deletes a ref')
      break
    case 'credential':
      a.ask('high', 'accessing secrets: git credential reads stored credentials')
      break
    case 'clone':
    case 'fetch':
    case 'pull':
    case 'ls-remote':
      a.ask('medium', `network operation (git ${sub})`)
      break
    case 'submodule':
      if (['update', 'add'].includes(rlc[0] ?? '')) a.ask('medium', `network operation (git submodule ${rlc[0]})`)
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
    a.ask(writes ? 'high' : 'medium', writes ? 'gh api performs a write against GitHub' : 'network operation (gh api)')
    return
  }
  if (['release', 'secret', 'variable', 'auth', 'ssh-key', 'gpg-key', 'extension', 'codespace', 'alias', 'config'].includes(sub)) {
    a.ask('high', `gh ${sub} ${verb ?? ''} publishes or changes GitHub/account state`.replace('  ', ' '))
    return
  }
  const read = verb !== undefined && GH_READ_VERBS.has(verb)
  a.ask(read ? 'medium' : 'high', `network operation (gh ${sub} ${verb ?? ''})`.replace('  ', ' '))
}

const PM_PUBLISH = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'login', 'adduser', 'token', 'owner', 'access', 'team', 'logout'])

function analyzePackageManager(cmd: string, lc: string[], a: Analysis): void {
  const positional = lc.filter((x) => !x.startsWith('-'))
  const sub = positional[0]
  const sub2 = positional[1]
  if (PM_PUBLISH.has(sub ?? '') || (sub === 'npm' && PM_PUBLISH.has(sub2 ?? ''))) {
    a.ask('high', `publishes or changes registry state (${cmd} ${sub === 'npm' ? 'npm ' : ''}${sub === 'npm' ? sub2 : sub})`)
    return
  }
  const globalFlag = lc.some((x) => x === '-g' || x === '--global' || x === '--location=global')
  const mutating = ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade', 'link', 'unlink', 'ln']
  if ((globalFlag && mutating.includes(sub ?? '')) || (cmd === 'yarn' && sub === 'global')) {
    a.ask('high', `global package change (${cmd} ${sub ?? ''} -g) modifies the system outside the worktree`)
    return
  }
  const upgrade = ['update', 'upgrade', 'up'].includes(sub ?? '')
  if (upgrade || (sub === 'audit' && lc.includes('fix') && lc.includes('--force'))) {
    const named = positional.slice(1)
    const sweeping = named.length === 0 || lc.some((x) => x === '-l' || x === '--latest' || x === '-i' || x === '--interactive')
    if (upgrade && sweeping) a.ask('medium', `dependency upgrade at large (${cmd} ${sub})`)
    else if (sub === 'audit') a.ask('medium', 'npm audit fix --force can introduce breaking upgrades')
  }
}

function analyzePip(cmd: string, pos: string[], a: Analysis): void {
  if (!['install', 'uninstall'].includes(pos[0] ?? '') && !(cmd === 'pipx' && pos[0] !== undefined)) return
  if (cmd === 'uv' && pos[0] !== 'pip') return
  if (a.venv) return
  a.ask('medium', `${cmd} ${pos[0] ?? ''} outside a virtual environment changes the global Python installation`)
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

function isReadOnly(cmd: string, args: string[], lc: string[]): boolean {
  if (VERSION_PROBES.has(cmd) && args.length === 1 && ['-v', '--version', '-V', 'version', '-version'].includes(args[0] ?? '')) return true
  switch (cmd) {
    case 'git':
      return isReadOnlyGit(args, lc)
    case 'sort':
      return !lc.some((x) => x === '-o' || x.startsWith('--output') || (/^-[a-z]*o/.test(x) && !x.startsWith('--')))
    case 'tail':
      return !lc.some((x) => x === '-f' || x.startsWith('--follow'))
    case 'rg':
      return !lc.some((x) => x.startsWith('--pre') || x.startsWith('--hostname-bin') || x === '-z' || x === '--search-zip')
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
  if (rlc.some((x) => x.startsWith('--output') || x === '-o' || x.startsWith('--ext-diff') || x.startsWith('--exec'))) return false
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
