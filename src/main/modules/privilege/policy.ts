import { basename, isAbsolute, join, win32 } from 'node:path'
import type { ForbiddenPrivilegedAction, PrivilegedCapability, PrivilegedOperationRequest, PrivilegedOperationReview, PrivilegedPolicyDecision } from '@shared/privilege'

/**
 * 0.9.1: the deterministic security policy of privilege sessions. It decides twice: before any reviewer sees a
 * request (a forbidden one never reaches a model) and after the reviews (the same checks again, then the reviews'
 * verdicts). A reviewer can refuse what this allows; it can never allow what this refuses.
 *
 * Two layers. The absolute deny list (B8) is matched against everything the request says: the program, its
 * arguments, its environment and its stated goal; any hit is DENIED whatever the capability, the session or a
 * review. Then each capability is a template: which programs, which argument shapes, whether the full Council must
 * approve as well as the Technical Director. A program that interprets command strings (cmd, a PowerShell -Command,
 * mshta, a script host) is never a template: PowerShell is run only with -File of a script whose content was hashed.
 * The broker checks the program and argument lists again on its side (native/nexus-elevate).
 */

export interface PrivilegedPolicyContext {
  /** %SystemRoot%, e.g. C:\Windows. */
  systemRoot: string
  programFiles: string
  programFilesX86: string
  /** Where NEXUS's own elevated scripts are (resources/sandbox-setup or native/sandbox-setup). */
  nexusScriptsDir: string | null
  /** Where the acceptance fixture's scripts are. */
  fixtureDir: string | null
  /** SHA-256 of a file NEXUS ships, computed from the file on disk now; null when it cannot be read. */
  trustedHash: (path: string) => string | null
  /** The worktrees of the run the request belongs to: the only places a project's installer may come from. */
  projectRoots: readonly string[]
  /** The capabilities the active session was given, or null when no session is active. */
  sessionCapabilities: readonly PrivilegedCapability[] | null
}

/** An entry of the deny list: what it stands for and how it is recognized. Patterns are case-insensitive. */
const FORBIDDEN: ReadonlyArray<{ action: ForbiddenPrivilegedAction; pattern: RegExp }> = [
  { action: 'DISABLE_UAC', pattern: /enablelua|consentpromptbehavio|promptonsecuredesktop|filteradministratortoken|localaccounttokenfilterpolicy|\b(disable|turn\s*off|switch\s*off|bypass)\b[^.]{0,30}\buac\b|\buac\b[^.]{0,30}\b(off|disable)/i },
  { action: 'DISABLE_BITDEFENDER', pattern: /bitdefender|bdservicehost|vsserv|bdredline|bdagent|bdntwrk/i },
  { action: 'DISABLE_DEFENDER', pattern: /(?<!bit)defender|windefend|mpcmdrun|mppreference|disablerealtime|disableantispyware|disableioav|disablebehavio|tamperprotection|wdfilter|wdnissvc|securityhealth|antivirus|anti-virus|\bav\b[^.]{0,20}\b(off|disable|exclu)/i },
  { action: 'CREATE_ADMIN_USER', pattern: /new-localuser|add-localgroupmember|localgroup\s+administrators|\bnet1?(\.exe)?\s+user\b[^\n]*\/add|\b(create|add|make)\b[^.]{0,30}\badmin(istrator)?\b[^.]{0,20}\b(user|account)/i },
  { action: 'CHANGE_USER_PASSWORD', pattern: /set-localuser|\bnet1?(\.exe)?\s+user\s+\S+\s+\S+|\b(change|reset|set)\b[^.]{0,30}\bpassword/i },
  { action: 'MODIFY_UNRELATED_USER_ACCOUNTS', pattern: /remove-localuser|disable-localuser|rename-localuser|enable-localuser|useraccount|\bnet1?(\.exe)?\s+(user|localgroup|accounts)\b|\b(delete|disable|rename)\b[^.]{0,30}\b(user|account)s?\b/i },
  { action: 'REMOVE_WINDOWS_SECURITY_POLICY', pattern: /secedit|auditpol|gpupdate|\\policies\\|grouppolicy|applocker|codeintegrity|\bwdac\b|smartscreen|set-executionpolicy|\bhvci\b|credentialguard|deviceguard|\bfirewall\b[^.]{0,30}\b(off|disable)|opmode\s+disable|state\s+off|set-netfirewallprofile/i },
  { action: 'OPEN_NEXUS_CONTROL_PLANE_TO_INTERNET', pattern: /portproxy|0\.0\.0\.0|remoteaddress=any|\bdir=in\b[\s\S]{0,300}\baction=allow|action=allow[\s\S]{0,300}\bdir=in\b|\b(expose|open|publish)\b[^.]{0,40}\b(control\s*plane|nexus)\b[^.]{0,30}\b(internet|public|lan|network)/i },
  { action: 'INSTALL_ARBITRARY_KERNEL_DRIVER', pattern: /\.sys\b|type=\s*kernel|type=\s*filesys|pnputil|devcon|infdefaultinstall|\.inf\b|\bkernel\s*(mode\s*)?driver/i },
  { action: 'CHANGE_BOOT_CONFIGURATION', pattern: /bcdedit|bcdboot|bootrec|reagentc|safeboot|\{bootmgr\}|testsigning|nointegritychecks|bootstatuspolicy|recoveryenabled|\bboot\s*(config|configuration|loader|order|entry)/i },
  { action: 'READ_CREDENTIAL_STORE_ARBITRARILY', pattern: /cmdkey|vaultcmd|credentialmanager|credential\s*manager|\\credentials\\|\\protect\\|lsass|sekurlsa|mimikatz|\\sam\b|\breg(\.exe)?\s+save\b|\bdpapi\b|storedcredential|\bvault\b|\bntds\b|\bhashdump\b|\bsecrets?\s*dump/i },
  { action: 'EXPORT_USER_SECRETS', pattern: /[\\/]\.ssh[\\/]|id_rsa|id_ed25519|[\\/]\.aws[\\/]|[\\/]\.azure[\\/]|[\\/]\.config[\\/]gh|\.npmrc|\.netrc|\.git-credentials|[\\/]\.claude[\\/]|[\\/]\.codex[\\/]|[\\/]\.gnupg[\\/]|[\\/]\.docker[\\/]|overnight\.key|secrets\.bin|\.protected\b|chatgpt-credentials|\bexfiltrat|\bupload\b[^.]{0,40}\b(credential|secret|token|key|password)s?|\b(credential|secret|token|password)s?\b[^.]{0,40}\bupload/i },
  { action: 'DELETE_UNRELATED_USER_FILES', pattern: /remove-item[^\n]*-recurse|\brd\s+\/s|\brmdir\s+\/s|\bdel\s+\/[sq]|\bformat(\.com)?\s+[a-z]:|cipher(\.exe)?\s+\/w|\b(delete|wipe|erase|remove|clean)\b[^.\n]{0,60}\\users\\[^\\]+\\(documents|desktop|downloads|pictures|videos|music|onedrive)\b|\b(delete|wipe|erase)\b[^.]{0,30}\b(user|personal|home)\b[^.]{0,20}\b(files|folders|data)/i },
  { action: 'ALTER_NEXUS_PRIVILEGED_POLICY', pattern: /nexusprivilege|nexus-elevate|privilege[\s_-]*(polic|session|broker)|privileged[\s_-]*(polic|capabilit)|\\appdata\\roaming\\nexus\\|\\programs\\nexus\\|\bnexus\b[^.]{0,30}\b(security\s*polic|deny\s*list|policy\s*engine)/i },
  { action: 'GRANT_THEMSELVES_NEW_PRIVILEGED_CAPABILITIES', pattern: /\bgrant\b[^.]{0,40}\b(capabilit|privilege|admin|elevat)|sedebugprivilege|setcbprivilege|seimpersonate|setokeninformation|ntrights|\bsecpol\b|\buser\s*rights?\s*assignment|\b(add|extend|widen)\b[^.]{0,30}\b(capabilit|scope)/i },
]

/** Programs that interpret a command string. Never run by a privilege session (PowerShell only as -File, below). */
const SHELLS = new Set(['cmd.exe', 'command.com', 'mshta.exe', 'wscript.exe', 'cscript.exe', 'rundll32.exe', 'regsvr32.exe', 'regsvcs.exe', 'regasm.exe', 'installutil.exe', 'msbuild.exe', 'bash.exe', 'wsl.exe', 'sh.exe', 'busybox.exe', 'node.exe', 'python.exe', 'pythonw.exe', 'py.exe', 'perl.exe', 'ruby.exe', 'java.exe', 'javaw.exe', 'forfiles.exe', 'pcalua.exe', 'conhost.exe', 'cmstp.exe', 'msxsl.exe', 'wmic.exe', 'schtasks.exe', 'at.exe', 'psexec.exe', 'psexec64.exe', 'runas.exe', 'explorer.exe'])
const POWERSHELLS = new Set(['powershell.exe', 'pwsh.exe'])
const PS_HEAD = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** Windows services no privilege session controls, by name. */
const PROTECTED_SERVICES = new Set(
  ['windefend', 'wdnissvc', 'wdfilter', 'sense', 'securityhealthservice', 'wscsvc', 'mpssvc', 'bfe', 'eventlog', 'trustedinstaller', 'lsm', 'samss', 'vaultsvc', 'keyiso', 'cryptsvc', 'appidsvc', 'gpsvc', 'lanmanserver', 'lanmanworkstation', 'termservice', 'winrm', 'remoteregistry', 'vsserv', 'bdredline', 'bdservicehost', 'updatesrv', 'wuauserv', 'bits', 'dhcp', 'dnscache', 'nsi', 'rpcss', 'rpceptmapper', 'schedule', 'seclogon', 'sppsvc', 'usosvc', 'winmgmt', 'wlansvc', 'netlogon', 'efs'].map((s) => s.toLowerCase()),
)

/** Flags that make an installer silent: a template requires one, and allows nothing else. */
const SILENT_FLAGS = new Set(['/s', '/q', '/qn', '/quiet', '/passive', '/silent', '/verysilent', '/norestart', '/suppressmsgboxes', '/sp-', '--silent', '--quiet', '--norestart', '-s', '-q', '/install', '/uninstall', '/repair', '/currentuser', '/allusers'])
const SILENT_REQUIRED = new Set(['/s', '/q', '/qn', '/quiet', '/passive', '/silent', '/verysilent', '--silent', '--quiet', '-s', '-q'])

const lower = (s: string): string => s.toLowerCase()
const samePath = (a: string, b: string): boolean => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const under = (path: string, root: string): boolean => {
  const p = win32.normalize(path).toLowerCase()
  const r = win32.normalize(root).toLowerCase().replace(/\\+$/, '')
  return p.startsWith(`${r}\\`)
}

interface TemplateResult {
  ok: boolean
  reason: string
  council: string[]
}

const fail = (reason: string): TemplateResult => ({ ok: false, reason, council: [] })
const pass = (reason: string, council: string[] = []): TemplateResult => ({ ok: true, reason, council })

export class PrivilegedPolicyEngine {
  /** The context is read for each decision, for the request at hand (its run's worktrees), or for none. */
  constructor(private readonly ctx: (req: PrivilegedOperationRequest | null) => PrivilegedPolicyContext) {}

  /** The deny list, matched against everything the request says. */
  forbiddenIn(req: Pick<PrivilegedOperationRequest, 'executable' | 'args' | 'env' | 'goal' | 'whyRequired' | 'whyElevation' | 'cwd'>): ForbiddenPrivilegedAction | null {
    const name = lower(win32.basename(req.executable))
    if (SHELLS.has(name)) return 'ARBITRARY_SHELL'
    if (POWERSHELLS.has(name)) {
      const head = req.args.slice(0, PS_HEAD.length).map(lower)
      // Everything after -File <script> goes to the script, not to PowerShell: the fixed head is the whole check.
      if (head.join(' ') !== PS_HEAD.map(lower).join(' ') || req.args.length < PS_HEAD.length + 1) return 'ARBITRARY_SHELL'
    }
    // The command as one line (a pattern may span arguments: `net user x /add` arrives as four), then each other field.
    const text = [[req.executable, ...req.args].join(' '), ...Object.entries(req.env).map(([k, v]) => `${k}=${v}`), req.cwd ?? '', req.goal, req.whyRequired, req.whyElevation].join('\n')
    for (const f of FORBIDDEN) if (f.pattern.test(text)) return f.action
    return null
  }

  /** Before any reviewer: may this request be put to review at all, and does it need the full Council? */
  precheck(req: PrivilegedOperationRequest): PrivilegedPolicyDecision {
    const forbidden = this.forbiddenIn(req)
    if (forbidden !== null) return { verdict: 'DENIED', reason: `Forbidden under any privilege session (${forbidden}).`, forbidden, councilRequired: false, councilWhy: [] }
    const ctx = this.ctx(req)
    if (ctx.sessionCapabilities === null) return deny('No privilege session is active: the owner has not authorized administrator work for this.')
    if (!ctx.sessionCapabilities.includes(req.capability)) return deny(`The active privilege session was not given ${req.capability}.`)
    if (!win32.isAbsolute(req.executable) || !/^[a-z]:\\/i.test(req.executable)) return deny('The executable must be an absolute path on a local drive.')
    if (req.cwd !== undefined && (!win32.isAbsolute(req.cwd) || !/^[a-z]:\\/i.test(req.cwd))) return deny('The working directory must be an absolute path on a local drive.')
    if (req.secretArgs.some((i) => i >= req.args.length)) return deny('A secret argument index names no argument.')
    if (!this.protectedProgram(req.executable) && req.sha256 === undefined) return deny('A program outside the protected program folders must be given with its SHA-256.')
    const t = this.template(req, ctx)
    if (!t.ok) return deny(t.reason)
    // Every allowed operation fits a template that was reviewed once: the Council is asked for what the template
    // itself flags (machine-wide installs, NEXUS's own security configuration, the firewall, a script), not for each
    // first use of a known program.
    return { verdict: 'ALLOWED', reason: t.reason, forbidden: null, councilRequired: t.council.length > 0, councilWhy: [...t.council] }
  }

  /**
   * After the reviews: the same checks again (nothing a reviewer said changes them), then the reviews. The Technical
   * Director must approve every operation; the Council too when the precheck said so. CRITICAL risk is refused.
   */
  final(req: PrivilegedOperationRequest, reviews: readonly PrivilegedOperationReview[]): PrivilegedPolicyDecision {
    const again = this.precheck(req)
    if (again.verdict === 'DENIED') return again
    const technical = reviews.find((r) => r.reviewer === 'CLAUDE_TECHNICAL_DIRECTOR')
    if (technical === undefined || technical.failed) return { ...again, verdict: 'DENIED', reason: 'The Technical Director gave no valid review; nothing runs without one.' }
    if (technical.verdict !== 'APPROVE') return { ...again, verdict: 'DENIED', reason: `The Technical Director did not approve (${technical.verdict}).` }
    if (technical.risk === 'CRITICAL') return { ...again, verdict: 'DENIED', reason: 'Rated CRITICAL risk: not run under a privilege session.' }
    if (again.councilRequired) {
      const council = reviews.find((r) => r.reviewer === 'DIRECTOR_COUNCIL')
      if (council === undefined || council.failed) return { ...again, verdict: 'DENIED', reason: 'This operation needs the Director Council, which gave no valid review.' }
      if (council.verdict !== 'APPROVE') return { ...again, verdict: 'DENIED', reason: `The Director Council did not approve (${council.verdict}).` }
      if (council.risk === 'CRITICAL') return { ...again, verdict: 'DENIED', reason: 'Rated CRITICAL risk by the Council: not run under a privilege session.' }
    }
    return { ...again, reason: `${again.reason} Approved by review${again.councilRequired ? ' and the Council' : ''}.` }
  }

  protectedProgram(path: string): boolean {
    const c = this.ctx(null)
    return [join(c.systemRoot, 'System32'), join(c.systemRoot, 'SysWOW64'), c.programFiles, c.programFilesX86].some((root) => under(path, root))
  }

  private system(c: PrivilegedPolicyContext, name: string): string {
    return win32.join(c.systemRoot, 'System32', name)
  }

  private powershell(c: PrivilegedPolicyContext): string {
    return win32.join(c.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }

  /** A run of a script NEXUS ships: system PowerShell, the fixed head, the script from its own folder with its real hash. */
  private shippedScript(req: PrivilegedOperationRequest, c: PrivilegedPolicyContext, dir: string | null, scripts: readonly string[], params: Record<string, 'value' | 'switch'>): TemplateResult {
    if (dir === null) return fail('The scripts of this capability are not part of this build.')
    if (!samePath(req.executable, this.powershell(c))) return fail('This capability runs the system PowerShell only.')
    if (req.args.length < 6 || req.args.slice(0, 5).join(' ').toLowerCase() !== PS_HEAD.join(' ').toLowerCase()) return fail('PowerShell runs only as -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>.')
    const script = req.args[5] as string
    const known = scripts.find((s) => samePath(script, win32.join(dir, s)))
    if (known === undefined) return fail(`Only ${scripts.join(', ')} from NEXUS's own folder may be run for this capability.`)
    const hash = c.trustedHash(script)
    const input = req.inputs.find((i) => i.arg === 5)
    if (hash === null || input === undefined || input.sha256 !== hash) return fail('The script must be staged with the hash of the file NEXUS ships.')
    for (let i = 6; i < req.args.length; i++) {
      const name = (req.args[i] as string).replace(/^-/, '')
      const kind = Object.entries(params).find(([p]) => p.toLowerCase() === name.toLowerCase())?.[1]
      if (!(req.args[i] as string).startsWith('-') || kind === undefined) return fail(`The parameter ${req.args[i]} is not one this script takes here.`)
      if (kind === 'value') {
        i++
        if (i >= req.args.length) return fail('A parameter has no value.')
      }
    }
    return pass('A script NEXUS ships, with its own hash.')
  }

  private installerArgs(args: readonly string[], from: number): string | null {
    const rest = args.slice(from).map(lower)
    if (!rest.some((a) => SILENT_REQUIRED.has(a))) return 'An installer runs only silently (/S, /quiet, /qn, /silent or the like).'
    const odd = rest.find((a) => !SILENT_FLAGS.has(a) && !/^\/l\*?v?$/.test(a) && !/^[a-z]:\\[^"*?<>|]+\.log$/i.test(a))
    return odd !== undefined ? `The installer argument ${odd} is not one of the silent-installation flags.` : null
  }

  private inProject(path: string, c: PrivilegedPolicyContext): boolean {
    return c.projectRoots.some((root) => under(path, root))
  }

  /** An installer: msiexec with a hashed package, or a hashed installer program; silent, nothing else. */
  private installer(req: PrivilegedOperationRequest, c: PrivilegedPolicyContext, opts: { fromProject: boolean; verbs: readonly string[] }): TemplateResult {
    if (samePath(req.executable, this.system(c, 'msiexec.exe'))) {
      const verb = lower(req.args[0] ?? '')
      if (!opts.verbs.includes(verb)) return fail(`msiexec is allowed here only with ${opts.verbs.join(' or ')}.`)
      const pkg = req.args[1] ?? ''
      const isProductCode = /^\{[0-9a-f-]{36}\}$/i.test(pkg)
      if (!isProductCode) {
        if (!/\.msi$/i.test(pkg) || req.inputs.find((i) => i.arg === 1) === undefined) return fail('The package must be a .msi file given with its SHA-256.')
        if (opts.fromProject && !this.inProject(pkg, c)) return fail("The package must come from the run's own worktree.")
      } else if (verb === '/i') return fail('An installation names its package file, not a product code.')
      const bad = this.installerArgs(req.args, 2)
      return bad === null ? pass('A silent Windows Installer operation on a hashed package.') : fail(bad)
    }
    if (this.protectedProgram(req.executable)) return fail('An installer here is msiexec or a hashed installer program.')
    if (req.sha256 === undefined) return fail('The installer must be given with its SHA-256.')
    if (opts.fromProject && !this.inProject(req.executable, c)) return fail("The installer must come from the run's own worktree.")
    if (!/\.exe$/i.test(req.executable)) return fail('The installer must be an .exe or a .msi.')
    const bad = this.installerArgs(req.args, 0)
    return bad === null ? pass('A hashed installer, run silently.') : fail(bad)
  }

  private template(req: PrivilegedOperationRequest, c: PrivilegedPolicyContext): TemplateResult {
    const name = lower(win32.basename(req.executable))
    switch (req.capability) {
      case 'NEXUS_SANDBOX_REPAIR':
      case 'NEXUS_SCHEDULED_TASK_REPAIR': {
        // The sandbox's own setup creates an account and firewall rules: NEXUS starts it, never an agent.
        if (req.role !== 'NEXUS') return fail("Repairing NEXUS's sandbox is done by NEXUS itself, not by an agent.")
        const r = this.shippedScript(req, c, c.nexusScriptsDir, ['setup-sandbox.ps1'], { MainUserSid: 'value', PasswordFile: 'value', ResultFile: 'value' })
        return r.ok ? pass(r.reason, ["modifies NEXUS's own privileged security configuration (account, firewall)"]) : r
      }
      case 'NEXUS_CANONICALIZATION_REPAIR': {
        const r = this.shippedScript(req, c, c.nexusScriptsDir, ['restore-canonicalization.ps1'], { ResultFile: 'value', Check: 'switch' })
        return r.ok ? pass(r.reason, req.args.some((a) => lower(a) === '-check') ? [] : ["modifies NEXUS's own privileged security configuration (an access entry of the Mount Manager)"]) : r
      }
      case 'PROJECT_TOOLCHAIN_INSTALL':
      case 'KNOWN_DEPENDENCY_MACHINE_INSTALL': {
        const r = this.installer(req, c, { fromProject: false, verbs: ['/i'] })
        return r.ok ? pass(r.reason, ['installs software for the whole machine']) : r
      }
      case 'PROJECT_TOOLCHAIN_REPAIR': {
        if (POWERSHELLS.has(name)) {
          // A project's repair script: a shell, so the Council looks at it too.
          if (!samePath(req.executable, this.powershell(c))) return fail('The system PowerShell only.')
          const script = req.args[5] ?? ''
          if (!/\.ps1$/i.test(script) || !this.inProject(script, c) || req.inputs.find((i) => i.arg === 5) === undefined) return fail("A repair script must be a .ps1 of the run's own worktree, given with its SHA-256.")
          return pass("A hashed repair script of the project's own.", ['runs a script with administrator rights'])
        }
        return this.installer(req, c, { fromProject: false, verbs: ['/fa', '/fomus', '/fvomus', '/f'] })
      }
      case 'APP_INSTALL_TEST':
        return this.installer(req, c, { fromProject: true, verbs: ['/i'] })
      case 'APP_UNINSTALL_TEST': {
        if (samePath(req.executable, this.system(c, 'msiexec.exe'))) return this.installer(req, c, { fromProject: false, verbs: ['/x'] })
        if (!(under(req.executable, c.programFiles) || under(req.executable, c.programFilesX86)) || !/^(uninst|uninstall)[^\\]*\.exe$/i.test(basename(req.executable))) return fail("An uninstall runs the application's own uninstaller under Program Files, or msiexec /x.")
        const bad = this.installerArgs(req.args, 0)
        return bad === null ? pass("The application's own uninstaller, run silently.") : fail(bad)
      }
      case 'PROJECT_SERVICE_CONTROL': {
        if (!samePath(req.executable, this.system(c, 'sc.exe'))) return fail('Services are controlled with the system sc.exe only.')
        const [verb, service, ...rest] = req.args.map((a) => a.trim())
        if (!['query', 'queryex', 'start', 'stop', 'qc'].includes(lower(verb ?? '')) || rest.length > 0) return fail('sc.exe is allowed with query, queryex, qc, start or stop and a service name, nothing else.')
        if (service === undefined || !/^[A-Za-z0-9_.-]{1,80}$/.test(service)) return fail('The service name is not valid.')
        if (PROTECTED_SERVICES.has(lower(service))) return fail(`${service} is a Windows or security service: never controlled by a privilege session.`)
        return pass("Control of the project's own service.")
      }
      case 'NEXUS_FIREWALL_RECONCILIATION': {
        if (!samePath(req.executable, this.system(c, 'netsh.exe'))) return fail('Firewall rules are reconciled with the system netsh.exe only.')
        const a = req.args.map(lower)
        if (a[0] !== 'advfirewall' || a[1] !== 'firewall' || !['add', 'delete', 'show'].includes(a[2] ?? '') || a[3] !== 'rule') return fail('netsh is allowed with advfirewall firewall add|delete|show rule only.')
        const nameArg = req.args.find((x) => /^name=/i.test(x))
        if (nameArg === undefined || !/^name=NexusSandbox[A-Za-z0-9 _.-]{0,80}$/i.test(nameArg)) return fail("Only NEXUS's own rules (named NexusSandbox…) are reconciled.")
        if (a[2] === 'add' && !a.includes('action=block')) return fail("NEXUS's rules block; a rule that allows is never added by a privilege session.")
        return pass("A rule of NEXUS's own sandbox.", a[2] === 'show' ? [] : ['changes the firewall'])
      }
      case 'SIGNED_DRIVER_QUERY': {
        if (!samePath(req.executable, this.system(c, 'driverquery.exe'))) return fail('Drivers are queried with the system driverquery.exe only.')
        const allowed = new Set(['/si', '/v', '/fo', 'csv', 'list', 'table', '/nh'])
        if (!req.args.every((x) => allowed.has(lower(x)))) return fail('driverquery is allowed with /si /v /fo csv|list|table /nh only.')
        return pass('A read-only query of the installed drivers.')
      }
      case 'NEXUS_ACCEPTANCE_FIXTURE': {
        if (samePath(req.executable, this.system(c, 'reg.exe'))) {
          const [verb, key, ...rest] = req.args
          if (!['add', 'delete', 'query'].includes(lower(verb ?? ''))) return fail('reg.exe is allowed with add, delete or query here.')
          if (!/^HKLM\\SOFTWARE\\NexusPrivilegeFixture(\\[A-Za-z0-9_.-]{1,60}){0,3}$/i.test(key ?? '')) return fail('The fixture touches HKLM\\SOFTWARE\\NexusPrivilegeFixture only.')
          const flags = new Set(['/v', '/t', '/d', '/f', '/ve', '/s'])
          for (let i = 0; i < rest.length; i++) {
            const f = lower(rest[i] as string)
            if (!flags.has(f)) return fail(`The reg.exe argument ${rest[i]} is not allowed here.`)
            if (f === '/v' || f === '/t' || f === '/d') {
              const value = rest[++i] ?? ''
              if (!/^[A-Za-z0-9_. :-]{0,200}$/.test(value)) return fail('A fixture value has characters the fixture never uses.')
              if (f === '/t' && !['reg_sz', 'reg_dword'].includes(lower(value))) return fail('The fixture writes REG_SZ or REG_DWORD only.')
            }
          }
          return pass("The fixture's own registry key.")
        }
        return this.shippedScript(req, c, c.fixtureDir, ['fixture-install.ps1', 'fixture-repair.ps1', 'fixture-remove.ps1'], { Version: 'value', ResultFile: 'value' })
      }
    }
  }
}

function deny(reason: string): PrivilegedPolicyDecision {
  return { verdict: 'DENIED', reason, forbidden: null, councilRequired: false, councilWhy: [] }
}

/** The arguments as they may be shown and logged: secret ones replaced, and anything that looks like a secret. */
export function redactArgs(args: readonly string[], secretArgs: readonly number[]): string[] {
  return args.map((a, i) => (secretArgs.includes(i) ? '[secret]' : redactText(a)))
}

/** Values that look like credentials (password=…, token=…, long base64/hex runs) are replaced. */
export function redactText(text: string): string {
  return text
    .replace(/\b(password|passwd|pwd|secret|token|apikey|api_key|key|credential)s?\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[secret]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [secret]')
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{12,}\b/g, '[secret]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, '[secret]')
}

/** Whether a path is a drive path NEXUS may hand to the broker (for callers that build requests). */
export function isDrivePath(path: string): boolean {
  return isAbsolute(path) && /^[a-z]:\\/i.test(path)
}
