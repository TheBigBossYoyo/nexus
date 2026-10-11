import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
  const stage2Path = join(bin, 'nexus-launch.exe')
  mkdirSync(bin, { recursive: true })
  if (!existsSync(stage2Path) || sha(stage2Path) !== sha(launcherExecutable)) copyFileSync(launcherExecutable, stage2Path)
  const stage2Dir = join(account.root, 'specs')
  mkdirSync(stage2Dir, { recursive: true })
  return { credentialPath: account.credentialPath, stage2Path, stage2Dir }
}
