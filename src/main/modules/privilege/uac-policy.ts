import { win32 } from 'node:path'
import { runProcess, type ProcessResult } from '../process/run-process'
import { parseRegListing } from './persistence-snapshot'

/**
 * Warns when Windows will elevate without a UAC prompt (EnableLUA = 0, or ConsentPromptBehaviorAdmin = 0). The read is
 * informational and gates nothing: it never refuses a session, never changes a setting, and only ever uses the `query`
 * verb of reg.exe. Like the existing readers it takes reg.exe from the runtime's systemRoot, so a modified environment
 * could hide or invent the warning; that is why nothing depends on it.
 */

export const UAC_POLICY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'

export interface UacPolicy {
  enableLua: number | null
  consentPromptBehaviorAdmin: number | null
}

export const UAC_WARNING_TEXT =
  'Windows will not show a UAC prompt for this session (its policy elevates without asking), so your confirmation in NEXUS is the only consent.'

function dword(listing: ReturnType<typeof parseRegListing>, name: string): number | null {
  for (const key of listing.keys.values()) {
    const v = key.values.get(name.toLowerCase())
    if (!v || v.type !== 'REG_DWORD') continue
    const m = /^0x([0-9a-f]{1,8})$/i.exec(v.data.trim())
    if (m) return parseInt(m[1]!, 16)
  }
  return null
}

/** `reg query` output of the System policy key; a missing or malformed value is null. */
export function parseUacPolicy(stdout: string): UacPolicy {
  const listing = parseRegListing(stdout)
  return { enableLua: dword(listing, 'EnableLUA'), consentPromptBehaviorAdmin: dword(listing, 'ConsentPromptBehaviorAdmin') }
}

export function uacWarning(policy: UacPolicy): string | null {
  return policy.enableLua === 0 || policy.consentPromptBehaviorAdmin === 0 ? UAC_WARNING_TEXT : null
}

type RunResult = Pick<ProcessResult, 'exitCode' | 'stdout'> & Partial<Pick<ProcessResult, 'timedOut' | 'aborted'>>

export interface UacPolicyReaderDeps {
  systemRoot: string
  run?: (file: string, args: readonly string[]) => Promise<RunResult>
  /** How long an answer is reused: the Admin access panel asks for it on every poll of the status. */
  maxAgeMs?: number
  now?: () => number
}

/** Reads the policy unelevated, at most once a minute; any failure gives null values (no warning). */
export function createUacPolicyReader(deps: UacPolicyReaderDeps): () => Promise<UacPolicy> {
  const { systemRoot } = deps
  const run =
    deps.run ??
    ((file: string, args: readonly string[]) =>
      runProcess(file, args, {
        cwd: systemRoot,
        env: { SystemRoot: systemRoot, windir: systemRoot, PATH: `${systemRoot}\\System32` },
        timeoutMs: 3000,
        maxOutputBytes: 64 * 1024,
        keep: 'head',
      }))
  const reg = win32.join(systemRoot, 'System32', 'reg.exe')
  const maxAgeMs = deps.maxAgeMs ?? 60_000
  const now = deps.now ?? Date.now
  let last: { at: number; answer: Promise<UacPolicy> } | null = null
  const read = async (): Promise<UacPolicy> => {
    try {
      const r = await run(reg, ['query', UAC_POLICY_KEY])
      if (r.exitCode !== 0 || r.timedOut || r.aborted) return { enableLua: null, consentPromptBehaviorAdmin: null }
      return parseUacPolicy(r.stdout)
    } catch {
      return { enableLua: null, consentPromptBehaviorAdmin: null }
    }
  }
  return () => {
    if (last === null || now() - last.at >= maxAgeMs) last = { at: now(), answer: read() }
    return last.answer
  }
}
