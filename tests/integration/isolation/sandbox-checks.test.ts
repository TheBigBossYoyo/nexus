import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { verifySandboxSetup } from '@main/modules/isolation/sandbox-setup'
// @ts-expect-error a build script without types
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// The elevated setup of the sandbox account trusts no name: an account, a folder or a firewall rule that is
// already there is judged by what it is. The judgements are plain functions (native/sandbox-setup/
// sandbox-checks.ps1), and are tested here without elevation: against states written down as data (an account
// somebody else made, an account in the administrators group, a firewall rule narrowed to one port) and
// against real folders in the scratch directory (a junction, a folder with access for everyone, a folder with
// a link inside). Nothing on the machine is changed outside the scratch directory.

const d = process.platform === 'win32' ? describe : describe.skip
const SCRATCH = resolve('test-results', 'sandbox-checks-tests')
const CHECKS = resolve('native', 'sandbox-setup', 'sandbox-checks.ps1')
const ME = 'S-1-5-21-1-2-3-1000'
const SANDBOX = 'S-1-5-21-1-2-3-1007'
const MARK = 'NEXUS sandbox account v1'

/** Runs PowerShell with the checks loaded and returns what the expression gives, as JSON. */
function ps<T>(expression: string): T {
  const script = `$ErrorActionPreference='Stop'; . '${CHECKS.replace(/'/g, "''")}'; ${expression} | ConvertTo-Json -Depth 6 -Compress`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()
  return JSON.parse(out === '' ? 'null' : out) as T
}
const list = (value: unknown): string[] => (value === null || value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [String(value)])
const account = (over: Record<string, unknown>): string => {
  const state = { Name: 'NexusSandbox', Sid: SANDBOX, Enabled: true, Description: MARK, PrincipalSource: 'Local', Groups: ['S-1-5-32-545'], UnreadGroups: [] as string[], ...over }
  return `(Test-NexusAccountState ([pscustomobject]@{ Name='${state.Name}'; Sid='${state.Sid}'; Enabled=$${state.Enabled}; Description='${state.Description}'; PrincipalSource='${state.PrincipalSource}'; Groups=@(${(state.Groups as string[]).map((g) => `'${g}'`).join(',')}); UnreadGroups=@(${(state.UnreadGroups as string[]).map((g) => `'${g}'`).join(',')}) }))`
}
const judgeAccount = (over: Record<string, unknown>): { Ours: boolean; Problems: string[]; Repairable: string[] } => {
  const r = ps<{ Ours: boolean; Problems: unknown; Repairable: unknown }>(account(over))
  return { Ours: r.Ours, Problems: list(r.Problems), Repairable: list(r.Repairable) }
}
const rule = (over: Record<string, string>): string[] => {
  const s = { Enabled: 'True', Action: 'Block', Direction: 'Outbound', Profile: 'Any', LocalUser: `D:(A;;CC;;;${SANDBOX})`, RemoteAddress: 'Any', LocalAddress: 'Any', Protocol: 'Any', RemotePort: 'Any', LocalPort: 'Any', Program: 'Any', ...over }
  return list(ps<{ r: unknown }>(`@{ r = @(Test-NexusFirewallRuleState ([pscustomobject]@{ ${Object.entries(s).map(([k, v]) => `${k}='${v}'`).join('; ')} }) 'Outbound' '${SANDBOX}') }`).r)
}
const myRealSid = (): string => execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim()
const judgeRoot = (path: string, strict = false): { Problems: string[]; Repairable: string[] } => {
  const r = ps<{ Problems: unknown; Repairable: unknown }>(`(Test-NexusRootState (Get-NexusRootState '${path}') '${myRealSid()}' '${SANDBOX}'${strict ? ' -Strict' : ''})`)
  return { Problems: list(r.Problems), Repairable: list(r.Repairable) }
}

d('the sandbox setup trusts no name', () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
  })
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  describe('an account that is already there', () => {
    it('made by this setup, as it should be: nothing to say', () => {
      expect(judgeAccount({})).toEqual({ Ours: true, Problems: [], Repairable: [] })
    })
    it("made by the first version of the setup: the same account, to be brought up to date", () => {
      expect(judgeAccount({ Description: 'NEXUS: contained project code runs here' })).toEqual({ Ours: true, Problems: [], Repairable: ['carries the mark of an earlier setup'] })
    })
    it('of that name and somebody else\'s: not taken over', () => {
      const r = judgeAccount({ Description: 'Backup operator account' })
      expect(r.Ours).toBe(false)
      expect(r.Problems.join(' ')).toContain('does not carry the mark')
      expect(judgeAccount({ Description: '' }).Problems.join(' ')).toContain('does not carry the mark')
    })
    it("somebody else's and an administrator: every problem is a refusal, none a repair", () => {
      const r = judgeAccount({ Description: 'x', Groups: ['S-1-5-32-545', 'S-1-5-32-544'] })
      expect(r.Problems.join(' ')).toContain('member of the group S-1-5-32-544')
      expect(r.Repairable).toEqual([])
    })
    it('this setup\'s own, put in other groups or disabled since: repaired, by taking it out of them', () => {
      const r = judgeAccount({ Groups: ['S-1-5-32-545', 'S-1-5-32-544', 'S-1-5-32-555'], Enabled: false })
      expect(r.Problems).toEqual([])
      expect(r.Repairable.sort()).toEqual(['disabled', 'member of the group S-1-5-32-544', 'member of the group S-1-5-32-555'])
    })
    it('a group whose members could not be listed: not taken for a group the account is out of', () => {
      const r = judgeAccount({ UnreadGroups: ['S-1-5-32-544'] })
      expect(r.Problems.join(' ')).toContain('the members of the group S-1-5-32-544 could not be listed')
      expect(r.Repairable).toEqual([])
    })
    it('not a local account, or not an ordinary user: refused', () => {
      expect(judgeAccount({ PrincipalSource: 'MicrosoftAccount' }).Problems.join(' ')).toContain('not a local account')
      expect(judgeAccount({ Sid: 'S-1-5-21-1-2-3-500' }).Problems.join(' ')).toContain('not an ordinary local user')
      expect(judgeAccount({ Sid: 'S-1-5-18' }).Problems.join(' ')).toContain('not an ordinary local user')
    })
  })

  describe('a firewall rule that is already there', () => {
    it('as the setup makes it: nothing to say; none: said', () => {
      expect(rule({})).toEqual([])
      expect(list(ps<{ r: unknown }>(`@{ r = @(Test-NexusFirewallRuleState $null 'Outbound' '${SANDBOX}') }`).r)).toEqual(['there is no such rule'])
    })
    it('of that name and of another shape: every difference is named', () => {
      expect(rule({ Enabled: 'False' }).join(' ')).toContain('not enabled')
      expect(rule({ Action: 'Allow' }).join(' ')).toContain('its action is Allow')
      expect(rule({ Direction: 'Inbound' }).join(' ')).toContain('its direction is Inbound')
      expect(rule({ Profile: 'Domain' }).join(' ')).toContain('profiles Domain only')
      expect(rule({ LocalUser: 'D:(A;;CC;;;S-1-5-21-9-9-9-1001)' }).join(' ')).toContain('not for the sandbox account alone')
      expect(rule({ LocalUser: 'Any' }).join(' ')).toContain('not for the sandbox account alone')
      expect(rule({ RemotePort: '443' }).join(' ')).toContain('narrowed by RemotePort')
      expect(rule({ RemoteAddress: '10.0.0.0/8' }).join(' ')).toContain('narrowed by RemoteAddress')
      expect(rule({ Protocol: 'TCP' }).join(' ')).toContain('narrowed by Protocol')
      expect(rule({ Program: 'C:\\\\x.exe' }).join(' ')).toContain('narrowed by Program')
    })
  })

  describe('a folder that is already there', () => {
    it('one the user made, with the access list it inherited: usable, and its access is to be set', () => {
      const dir = join(SCRATCH, 'plain')
      mkdirSync(dir)
      const r = judgeRoot(dir)
      expect(r.Problems).toEqual([])
      expect(r.Repairable.join(' ')).toContain('its access list is inherited')
      // The verification asks more: what is only repairable for the setup is wrong until repaired.
      expect(judgeRoot(dir, true).Problems.join(' ')).toContain('its access list is inherited')
    })
    it('a junction to another place: refused', () => {
      const target = join(SCRATCH, 'target')
      mkdirSync(target)
      symlinkSync(target, join(SCRATCH, 'junction'), 'junction')
      expect(judgeRoot(join(SCRATCH, 'junction')).Problems.join(' ')).toContain('a link to another place')
    })
    it('a file of that name: refused', () => {
      writeFileSync(join(SCRATCH, 'a-file'), 'x')
      expect(judgeRoot(join(SCRATCH, 'a-file')).Problems.join(' ')).toContain('not a folder')
    })
    it('a folder with a link to another place inside: refused', () => {
      const dir = join(SCRATCH, 'with-link')
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      symlinkSync(SCRATCH, join(dir, 'worktrees'), 'junction')
      expect(judgeRoot(dir).Problems.join(' ')).toContain('contains a link to another place: worktrees')
    })
    it('a folder that gives access to everyone: usable only once that is taken away, and the verification says no', () => {
      const dir = join(SCRATCH, 'open')
      mkdirSync(dir)
      execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant', '*S-1-1-0:(OI)(CI)F', '/grant', `*${myRealSid()}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
      const r = judgeRoot(dir)
      expect(r.Problems).toEqual([])
      expect(r.Repairable.join(' ')).toContain('access for S-1-1-0')
      expect(judgeRoot(dir, true).Problems.join(' ')).toContain('access for S-1-1-0')
    })
    it('a folder whose owner is written down as somebody else: refused', () => {
      const r = ps<{ Problems: unknown }>(`(Test-NexusRootState ([pscustomobject]@{ Path='x'; IsDirectory=$true; Reparse=$false; Owner='S-1-5-21-9-9-9-1001'; Protected=$true; Rules=@(); Children=@() }) '${ME}' '${SANDBOX}')`)
      expect(list(r.Problems).join(' ')).toContain('belongs to somebody else')
    })
    it('a folder with an entry that belongs to somebody else: refused', () => {
      const r = ps<{ Problems: unknown }>(`(Test-NexusRootState ([pscustomobject]@{ Path='x'; IsDirectory=$true; Reparse=$false; Owner='${ME}'; Protected=$true; Rules=@(); Children=@([pscustomobject]@{ Name='tools'; Reparse=$false; Owner='S-1-5-21-9-9-9-1001' }) }) '${ME}' '${SANDBOX}')`)
      expect(list(r.Problems).join(' ')).toContain('an entry that belongs to somebody else: tools')
    })
    it('exactly as the setup makes it: nothing to say, for the setup and for the verification', () => {
      const rules = `@(${[['S-1-5-18', 'FullControl'], ['S-1-5-32-544', 'FullControl'], [ME, 'FullControl'], [SANDBOX, 'Modify, Synchronize']].map(([sid, rights]) => `[pscustomobject]@{ Sid='${sid}'; Rights='${rights}'; Type='Allow'; Inherited=$false }`).join(',')})`
      for (const strict of ['', ' -Strict']) {
        const r = ps<{ Problems: unknown; Repairable: unknown }>(`(Test-NexusRootState ([pscustomobject]@{ Path='x'; IsDirectory=$true; Reparse=$false; Owner='${ME}'; Protected=$true; Rules=${rules}; Children=@([pscustomobject]@{ Name='bin'; Reparse=$false; Owner='${ME}' }, [pscustomobject]@{ Name='sessions'; Reparse=$false; Owner='${SANDBOX}' }) }) '${ME}' '${SANDBOX}'${strict})`)
        expect(list(r.Problems)).toEqual([])
        expect(list(r.Repairable)).toEqual([])
      }
    })
  })

  /** What NEXUS passes at start: the AppContainer and its capability, as the launcher derives them. */
  const containerIds = (): { sid: string; capabilitySid: string } => {
    // Built when this checkout has no build yet (a fresh clone), as the other tests of the launcher do (0.9.1).
    const exe = buildLauncher() as string
    const derive = (what: string): string => execFileSync(exe, [what, 'NexusSandbox.Contained.1'], { encoding: 'utf8', windowsHide: true }).trim()
    return { sid: derive('appcontainer-sid'), capabilitySid: derive('capability-sid') }
  }

  it("this machine's own sandbox account, if it has one, passes the verification NEXUS runs at start", async () => {
    const mine = readSandboxAccount()
    if (mine === null) return
    const container = containerIds()
    const verdict = await verifySandboxSetup(mine, resolve('native', 'sandbox-setup'), process.env, container)
    console.info(`sandbox verification on this machine: ok=${verdict.ok}; problems=${JSON.stringify(verdict.problems)}; notes=${JSON.stringify(verdict.notes)}`)
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
  }, 60_000)

  it('a record that names another account or another folder than Windows has is not believed', async () => {
    const mine = readSandboxAccount()
    if (mine === null) return
    const container = containerIds()
    const wrongSid = await verifySandboxSetup({ ...mine, sid: 'S-1-5-21-9-9-9-1234' }, resolve('native', 'sandbox-setup'), process.env, container)
    expect(wrongSid.ok).toBe(false)
    expect(wrongSid.problems.join(' ')).toContain('is not the one NEXUS was told of')
    const wrongRoot = await verifySandboxSetup({ ...mine, root: 'C:\\ProgramData\\NexusSandboxElsewhere' }, resolve('native', 'sandbox-setup'), process.env, container)
    expect(wrongRoot.ok).toBe(false)
    const noAccount = await verifySandboxSetup({ ...mine, account: 'NexusNoSuchAccount' }, resolve('native', 'sandbox-setup'), process.env, container)
    expect(noAccount.problems.join(' ')).toContain('there is no account named')
  }, 120_000)
})
