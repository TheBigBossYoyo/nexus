import type { TrustClass } from '@shared/security'
import { EXEC_API, hasPowerApiText, NEXUS_DATA_TEXT, POWER_COMMAND_FORMS, POWER_WORDS } from './power-patterns'

/**
 * Static inspection of script and command text. This is a defence layer that makes the obvious things
 * visible and gateable; it is NOT a sandbox. Text that builds its commands at run time, compiled code and
 * code that is fetched after the check all pass straight through it (docs/SECURITY.md, "Not a full OS sandbox").
 */

export type FindingSeverity = 'deny' | 'approval' | 'audit'

export type FindingCategory =
  | 'power'
  | 'registry'
  | 'service'
  | 'scheduled_task'
  | 'credentials'
  | 'destructive'
  | 'process_spawn'
  | 'shell_recursion'
  | 'encoded'
  | 'obfuscation'
  | 'download'
  | 'global_env'
  | 'security_config'
  | 'system_install'
  | 'nexus_data'
  | 'uninspectable'

export interface ContentFinding {
  category: FindingCategory
  severity: FindingSeverity
  reason: string
  trust: TrustClass
}

/** Inspect at most this many characters; a script larger than this is reported as uninspectable. */
export const MAX_INSPECT_CHARS = 1_000_000
const MAX_DEPTH = 3

/** Undo trivial quoting tricks so that "shut"+"down", sh^utdown and `shutdown cannot hide a name. */
export function squashText(text: string): string {
  let t = text
  for (let k = 0; k < 4; k++) t = t.replace(/(["'])\s*\+\s*(["'])/g, '')
  return t.replace(/[\^`"']/g, '')
}

interface Rule {
  category: FindingCategory
  severity: FindingSeverity
  reason: string
  trust: TrustClass
  pattern: RegExp
}

const SYS: TrustClass = 'SYSTEM_SENSITIVE'

const RULES: Rule[] = [
  { category: 'registry', severity: 'approval', trust: SYS, reason: 'modifies the Windows registry', pattern: /\breg(?:\.exe)?\s+(?:add|delete|import|load|unload|copy|save|restore|flags)\b|\bregedit(?:32)?\b|\b(?:set|new|remove|clear|rename)-itemproperty\b[^\n;|&]*\b(?:hklm|hkcu|hkcr|hku|hkcc|registry::)|\bwinreg\.(?:setvalue|createkey|deletekey|deletevalue|setvalueex)|\bregsetvalue|\bregcreatekey|\bregdeletekey|\[microsoft\.win32\.registry\]::(?:setvalue|openbasekey)/i },
  { category: 'service', severity: 'approval', trust: SYS, reason: 'creates, changes or controls Windows services', pattern: /\bsc(?:\.exe)?\s+(?:\\\\\S+\s+)?(?:create|config|delete|start|stop|failure|sdset)\b|\b(?:new|set|remove|stop|restart|start|suspend)-service\b|\bnet1?\s+(?:start|stop|pause|continue)\b|\bnssm\b|\bsystemctl\s+(?:enable|disable|start|stop|restart|mask)\b/i },
  { category: 'scheduled_task', severity: 'approval', trust: SYS, reason: 'creates or changes scheduled tasks', pattern: /\bschtasks(?:\.exe)?\b|\b(?:register|unregister|set|new|start)-scheduledtask\b|\bnew-scheduledtask\w*\b|\bcrontab\b|\bat(?:\.exe)?\s+\d{1,2}:\d{2}\b/i },
  { category: 'credentials', severity: 'approval', trust: SYS, reason: 'reads credential stores or secret-bearing locations', pattern: /[\\/]\.ssh\b|[\\/]\.aws\b|\.git-credentials|[\\/]\.netrc\b|[\\/]\.npmrc\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\bcmdkey\b|\bvaultcmd\b|credential\s*manager|\bcredread\b|\bcredwrite\b|windows\.security\.credentials|\bpasswordvault\b|google[\\/]+chrome[\\/]+user\s*data|microsoft[\\/]+edge[\\/]+user\s*data|mozilla[\\/]+firefox[\\/]+profiles|\blogin\s*data\b|\bmimikatz\b|\blsass\b|\bconvertfrom-securestring\b/i },
  { category: 'credentials', severity: 'deny', trust: SYS, reason: 'Claude credential stores must never be read or printed', pattern: /\.claude[\\/]+\.?credentials|\.credentials\.json/i },
  { category: 'nexus_data', severity: 'deny', trust: SYS, reason: "NEXUS's own database, key files and runtime endpoint (named pipe, endpoint.json, runtime.log) must never be accessed from agent-run code", pattern: NEXUS_DATA_TEXT },
  { category: 'security_config', severity: 'deny', trust: SYS, reason: 'disabling or modifying security tooling is not permitted', pattern: /\b(?:set|add)-mppreference\b|disablerealtimemonitoring|disableantispyware|\bwindefend\b|\bmpssvc\b|\bwdnissvc\b|netsh\s+advfirewall|disable-netfirewallrule|set-netfirewallprofile|\bbcdedit\b|uninstall-windowsdefender|mpcmdrun[^;|&\n]*-remove|\bset-executionpolicy\b/i },
  { category: 'global_env', severity: 'approval', trust: SYS, reason: 'changes persistent or machine-wide environment variables', pattern: /\bsetx(?:\.exe)?\s+\S|setenvironmentvariable\s*\([^)]*\b(?:machine|user)\b|\[environment\]::setenvironmentvariable\([^)]*,[^)]*,\s*\[?(?:system\.)?(?:environmentvariabletarget\]::)?(?:machine|user)/i },
  { category: 'system_install', severity: 'approval', trust: SYS, reason: 'installs or removes system-wide software', pattern: /\b(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum|pacman)\s+(?:install|upgrade|uninstall|remove|update)\b|\bmsiexec(?:\.exe)?\b|\b(?:install|uninstall)-(?:module|package|script|windowsfeature)\b|\b(?:add|remove)-appxpackage\b|\b(?:npm|pnpm|yarn)\s+(?:(?:i|install|add|remove|uninstall|update|upgrade|link)\s+)?(?:[^\n;|&]*\s)?(?:-g|--global)\b|\byarn\s+global\b|\bpip3?\s+install\b[^\n;|&]*--(?:user|break-system-packages)/i },
  { category: 'destructive', severity: 'approval', trust: SYS, reason: 'deletes or reformats whole directories, drives or disks', pattern: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*(?:\/(?:\s|$|\*)|~|\$home|\$\{home\}|%userprofile%|\.\.[\\/]?(?:\s|$)|[a-z]:[\\/]?(?:\s|$|\*))|\bremove-item\b[^\n;|&]*-recurse[^\n;|&]*(?:\s|['"])(?:[a-z]:[\\/]?\*?|~|\$env:(?:userprofile|systemroot|windir|programfiles|homedrive)|\\\*|\/)(?:\s|['"]|$)|\bformat(?:\.com)?\s+[a-z]:|\b(?:diskpart|format-volume|clear-disk|initialize-disk|remove-partition|vssadmin\s+delete|wbadmin\s+delete|bcdboot)\b|\bcipher\s+\/w|\b(?:rd|rmdir)\s+(?:\/[sq]\s+)+[a-z]:[\\/]?(?:\s|$)|\bdel\s+(?:\/[sqf]\s+)+[a-z]:[\\/]|shutil\.rmtree\(\s*(?:['"]?[a-z]:[\\/]?['"]?|['"]\/['"]|os\.path\.expanduser)|rmsync\(\s*(?:['"]?[a-z]:[\\/]?['"]?|['"]\/['"]|os\.homedir)/i },
  { category: 'download', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'downloads and executes remote content', pattern: /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)\b[^\n]*\|\s*(?:iex|invoke-expression|sh|bash|powershell|pwsh|python3?|node|cmd)\b|\bdownload(?:string|file)\b[^\n]*\b(?:iex|invoke-expression|start-process)\b|\b(?:iex|invoke-expression)\b[^\n]*\bdownloadstring\b|\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer/i },
  { category: 'download', severity: 'audit', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'network access', pattern: /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget|start-bitstransfer|downloadfile|downloadstring)\b|net\.webclient|system\.net\.http|urllib\.request|\brequests\.(?:get|post|put)\b|\bhttps?\.(?:get|request)\(|\bfetch\s*\(\s*['"]https?:|\baxios\b/i },
  { category: 'process_spawn', severity: 'audit', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'starts other processes', pattern: EXEC_API },
  { category: 'shell_recursion', severity: 'audit', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'starts a nested shell', pattern: /\b(?:cmd(?:\.exe)?\s+\/[ck]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-(?:c|command|file|e|ec|enc|encodedcommand)\b|(?:ba|z|da|k)?sh\s+-c\b)/i },
  { category: 'obfuscation', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'builds a command from environment variables or string pieces at run time', pattern: /\$env:\w+\s*\+\s*['"$]|%\w+%%\w+%|(?:^|[\s&|(])(?:![a-z_]\w*!)+[\s/-]|&\s*\(\s*\$\w+\s*\+|&\s*\(\s*['"][^'"]*['"]\s*\+|\bset\s+\w+=[^\n]*\n[^\n]*%\w+:~\d+,\d+%|%\w+:~-?\d+,-?\d+%%\w+:~|\[char\]\s*\d+\s*\+\s*\[char\]|\[string\]::join\([^)]*\[char\]|\bfrombase64string\b[^\n]*\b(?:iex|invoke-expression|start-process|assembly)\b/i },
]

const DECODE_PRIMITIVE = /\batob\s*\(|buffer\.from\([^)]*['"]base64['"]|fromcharcode|b64decode|base64\.(?:b64)?decode|frombase64string|\bchr\s*\(\s*\d+\s*\)\s*\+|\bunhexlify\b|\bbytes\.fromhex\b/i
const DYNAMIC_EVAL = /\beval\s*\(|\bexec\s*\(|new\s+function\s*\(|\b__import__\s*\(|\bcompile\s*\(|\binvoke-expression\b|\biex\b|\bchild_process\b|\bsubprocess\b|\bos\.system\b/i

const ENC_FLAG = /(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+['"]?([A-Za-z0-9+/]{12,}={0,2})['"]?/gi

/** Decodes a PowerShell -EncodedCommand argument (base64 of UTF-16LE text). null when it is not one. */
export function decodeEncodedCommand(b64: string): string | null {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0 || buf.length % 2 !== 0) return null
    const text = buf.toString('utf16le')
    // UTF-16LE text of a script has almost no control characters; anything else was not a command.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text
  } catch {
    return null
  }
}

/** Decoded payloads of every -EncodedCommand argument found in `text`. */
export function findEncodedCommands(text: string): { raw: string; decoded: string | null }[] {
  const out: { raw: string; decoded: string | null }[] = []
  for (const m of text.matchAll(ENC_FLAG)) {
    const raw = m[1]
    if (raw !== undefined) out.push({ raw, decoded: decodeEncodedCommand(raw) })
  }
  return out
}

function mark(out: ContentFinding[], f: ContentFinding): void {
  if (!out.some((x) => x.category === f.category && x.severity === f.severity && x.reason === f.reason)) out.push(f)
}

/**
 * Findings for a piece of script or command text. Power-related text is DENY; other dangerous categories
 * need approval; "audit" findings are informational and are only logged.
 */
export function inspectContent(text: string, depth = 0): ContentFinding[] {
  const out: ContentFinding[] = []
  if (text.length > MAX_INSPECT_CHARS) {
    mark(out, { category: 'uninspectable', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'is too large to inspect' })
    text = text.slice(0, MAX_INSPECT_CHARS)
  }
  const squashed = squashText(text)
  const variants = squashed === text ? [text] : [text, squashed]

  for (const t of variants) {
    if (hasPowerApiText(t) || POWER_COMMAND_FORMS.some((p) => p.test(t))) {
      mark(out, { category: 'power', severity: 'deny', trust: SYS, reason: 'controls the machine power state (shutdown, restart, suspend, logoff); only NEXUS power control may do that' })
    }
  }
  if (POWER_WORDS.test(squashed) && EXEC_API.test(squashed)) {
    mark(out, { category: 'power', severity: 'deny', trust: SYS, reason: 'starts a process next to a power command (shutdown, reboot, logoff)' })
  }
  for (const rule of RULES) {
    if (variants.some((t) => rule.pattern.test(t))) mark(out, { category: rule.category, severity: rule.severity, reason: rule.reason, trust: rule.trust })
  }
  if (variants.some((t) => DECODE_PRIMITIVE.test(t)) && variants.some((t) => DYNAMIC_EVAL.test(t))) {
    mark(out, { category: 'obfuscation', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'decodes text and runs or evaluates it' })
  }

  for (const enc of findEncodedCommands(text)) {
    mark(out, { category: 'encoded', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'contains an encoded PowerShell command' })
    if (enc.decoded === null) {
      mark(out, { category: 'encoded', severity: 'approval', trust: 'UNTRUSTED_AGENT_AUTHORED', reason: 'contains an encoded argument that does not decode to PowerShell text' })
    } else if (depth < MAX_DEPTH) {
      for (const f of inspectContent(enc.decoded, depth + 1)) mark(out, { ...f, reason: `(inside the encoded command) ${f.reason}` })
    }
  }
  return out
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = { audit: 0, approval: 1, deny: 2 }

export function worstSeverity(findings: readonly ContentFinding[]): FindingSeverity | null {
  let worst: FindingSeverity | null = null
  for (const f of findings) if (worst === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst]) worst = f.severity
  return worst
}

/** True when the first bytes look like a compiled executable or other binary, which cannot be inspected as text. */
export function looksBinary(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true // MZ (PE)
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true // ELF
  const n = Math.min(head.length, 8000)
  for (let i = 0; i < n; i++) if (head[i] === 0) return !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff) // NUL bytes: binary unless UTF-16 text
  return false
}

/** Decodes script bytes as text, handling a UTF-16 byte-order mark (PowerShell scripts are often UTF-16). */
export function decodeScript(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const text = buf.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
