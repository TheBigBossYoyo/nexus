import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@main/modules/process/run-process'
import { sandboxStateDir } from './sandbox-account'

/**
 * 0.8: the one-time setup of the machine's sandbox account, started from NEXUS. It raises one Windows
 * elevation prompt: the elevated script creates a local standard account that is in no group of the user's,
 * a directory outside the user's profile that both may use, and firewall rules that let none of that
 * account's traffic in or out. The account's password is made here, handed to the elevated script in a file
 * only this user and administrators can read, kept as a DPAPI blob of this user, and the file is deleted. It
 * is never shown, logged or returned.
 *
 * Nothing here runs unless the user asked for it and confirmed it: the caller shows the confirmation.
 */

export interface SandboxSetupInput {
  /** nexus-launch.exe: it stores the credential. */
  launcher: string
  /** The directory of setup-sandbox.ps1. */
  scriptsDir: string
  /** A directory of NEXUS's own for the two short-lived files of the setup. */
  workDir: string
  env: NodeJS.ProcessEnv
}

export interface SandboxSetupResult {
  ok: boolean
  /** What was done, or why nothing was: shown to the user as it is. */
  detail: string
}

interface SetupScriptResult {
  ok?: boolean
  account?: string
  sid?: string
  root?: string
  firewallOutbound?: boolean
  firewallInbound?: boolean
  error?: string
}

export async function setupSandboxAccount(input: SandboxSetupInput): Promise<SandboxSetupResult> {
  if (process.platform !== 'win32') return { ok: false, detail: 'The sandbox account exists on Windows only.' }
  const script = join(input.scriptsDir, 'setup-sandbox.ps1')
  if (!existsSync(script)) return { ok: false, detail: `The setup script is missing: ${script}` }
  if (!existsSync(input.launcher)) return { ok: false, detail: `The launcher is missing: ${input.launcher}` }
  const system32 = join(input.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
  const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const minimal: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'PSModulePath']) {
    if (input.env[name] !== undefined) minimal[name] = input.env[name]
  }
  minimal['PATH'] = `${system32};${join(system32, 'WindowsPowerShell', 'v1.0')}`

  const who = await runProcess(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { cwd: system32, env: minimal, timeoutMs: 15_000 })
  const sid = /S-1-5-21-[0-9-]+/.exec(who.stdout)?.[0]
  if (!sid) return { ok: false, detail: 'The identity of the current user could not be read.' }

  mkdirSync(input.workDir, { recursive: true })
  const resultFile = join(input.workDir, `result-${randomBytes(4).toString('hex')}.json`)
  const passwordFile = join(input.workDir, `p-${randomBytes(8).toString('hex')}.txt`)
  const password = `${randomBytes(30).toString('base64url')}aA1!`
  const stateDir = sandboxStateDir(input.env)
  if (stateDir === null) return { ok: false, detail: 'This user has no local application data directory to keep the account in.' }
  const readResult = (): SetupScriptResult | null => {
    if (!existsSync(resultFile)) return null
    try {
      return JSON.parse(readFileSync(resultFile, 'utf8').replace(String.fromCharCode(0xfeff), '')) as SetupScriptResult
    } catch {
      return null
    }
  }
  let result: SetupScriptResult | null
  try {
    writeFileSync(passwordFile, password, { flag: 'wx' })
    await runProcess(join(system32, 'icacls.exe'), [passwordFile, '/inheritance:r', '/grant:r', `*${sid}:F`, '/grant:r', '*S-1-5-32-544:F'], { cwd: system32, env: minimal, timeoutMs: 15_000 })
    // -Verb RunAs raises the consent prompt. The script's own window is hidden; -Wait returns when it has ended.
    const list = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`, '-MainUserSid', sid, '-PasswordFile', `"${passwordFile}"`, '-ResultFile', `"${resultFile}"`].map((a) => `'${a.replace(/'/g, "''")}'`).join(', ')
    await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${list}; exit $p.ExitCode`], { cwd: system32, env: minimal, timeoutMs: 5 * 60_000 })
    result = readResult()
  } finally {
    rmSync(passwordFile, { force: true })
    rmSync(resultFile, { force: true })
  }
  if (result === null) return { ok: false, detail: 'Nothing was changed: the Windows elevation prompt was declined, or the setup did not start.' }
  if (result.ok !== true || !result.account || !result.root) return { ok: false, detail: `The setup did not complete: ${String(result.error ?? 'no reason was given').slice(0, 300)}` }

  mkdirSync(stateDir, { recursive: true })
  const credentialPath = join(stateDir, 'credential.bin')
  const stored = await runProcess(input.launcher, ['credential', 'write', credentialPath], { cwd: stateDir, env: minimal, timeoutMs: 30_000, input: `${result.account}\n${password}\n` })
  if (stored.exitCode !== 0) return { ok: false, detail: 'The account was created, but its credential could not be stored. Run the setup again.' }
  writeFileSync(join(stateDir, 'sandbox.json'), JSON.stringify({ account: result.account, sid: result.sid, root: result.root, firewallOutbound: result.firewallOutbound === true, firewallInbound: result.firewallInbound === true, setupAt: new Date().toISOString(), credential: credentialPath }, null, 2))
  return {
    ok: true,
    detail: `The sandbox account ${result.account} is set up, with ${result.root} as its directory${result.firewallOutbound === true ? ' and no route to the network of its own' : '; its firewall rule could NOT be made, so the isolated profile will not be used'}. Restart NEXUS: the isolated profile is verified at start.`,
  }
}
