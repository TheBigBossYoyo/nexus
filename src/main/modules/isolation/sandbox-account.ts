import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxAccountRef } from './launcher'

/**
 * 0.8: the machine's sandbox account, as the one-time elevated setup left it (native/sandbox-setup,
 * scripts/sandbox-setup.mjs). NEXUS never creates the account, never changes the firewall and never elevates
 * by itself: it reads what the setup recorded and uses it. No record means no ISOLATED profile.
 */

export interface SandboxAccount {
  account: string
  sid: string
  /** The directory the account and the user share, outside the user's profile. */
  root: string
  credentialPath: string
  firewallOutbound: boolean
  firewallInbound: boolean
  setupAt: string
}

export function sandboxStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env['LOCALAPPDATA']
  return local ? join(local, 'NexusSandbox') : null
}

/** The recorded account, or null when the setup was never run for this user or its record is unusable. */
export function readSandboxAccount(env: NodeJS.ProcessEnv = process.env): SandboxAccount | null {
  const dir = sandboxStateDir(env)
  if (dir === null) return null
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8')) as Record<string, unknown>
    const account = String(raw['account'] ?? '')
    const sid = String(raw['sid'] ?? '')
    const root = String(raw['root'] ?? '')
    const credentialPath = String(raw['credential'] ?? '')
    if (!/^[A-Za-z][A-Za-z0-9]{2,19}$/.test(account) || !/^S-1-5-21-[0-9-]+$/.test(sid)) return null
    // The root is under ProgramData and nowhere else: a record that names another place is not followed.
    if (!/^[A-Za-z]:\\ProgramData\\[A-Za-z0-9_-]+$/i.test(root) || !existsSync(root) || !existsSync(credentialPath)) return null
    return { account, sid, root, credentialPath, firewallOutbound: raw['firewallOutbound'] === true, firewallInbound: raw['firewallInbound'] === true, setupAt: String(raw['setupAt'] ?? '') }
  } catch {
    return null
  }
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * Makes sure the account can run the launcher: a copy in the sandbox root, replaced when it differs from the
 * one NEXUS itself uses. Returns what an ISOLATED spec needs.
 */
export function prepareSandboxLauncher(account: SandboxAccount, launcherExecutable: string): SandboxAccountRef {
  const bin = join(account.root, 'bin')
  // Named by its content: two NEXUS builds on one machine (an installed one and a development one, or two test
  // processes) each find their own launcher there, and none replaces a file another is running.
  const digest = sha(launcherExecutable).slice(0, 16)
  const stage2Path = join(bin, `nexus-launch-${digest}.exe`)
  mkdirSync(bin, { recursive: true })
  if (!existsSync(stage2Path)) {
    const temp = join(bin, `.${digest}-${process.pid}-${Date.now()}.tmp`)
    copyFileSync(launcherExecutable, temp)
    try {
      renameSync(temp, stage2Path)
    } catch {
      // Another process put the same content there first.
      rmSync(temp, { force: true })
      if (!existsSync(stage2Path)) throw new Error(`The launcher could not be copied to ${bin}.`)
    }
  }
  // Copies of builds long gone are removed; one in use refuses and is left.
  try {
    const cutoff = Date.now() - 14 * 86_400_000
    for (const name of readdirSync(bin)) {
      const path = join(bin, name)
      if (path !== stage2Path && /^(nexus-launch(-[0-9a-f]{16})?\.exe|\..*\.tmp)$/.test(name) && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    }
  } catch {
    // Housekeeping only.
  }
  const stage2Dir = join(account.root, 'specs')
  mkdirSync(stage2Dir, { recursive: true })
  return { credentialPath: account.credentialPath, stage2Path, stage2Dir }
}
