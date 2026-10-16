import { resolve, win32 } from 'node:path'

/**
 * 0.9.1: whether this checkout lies inside the sandbox's own folder (C:\ProgramData\NexusSandbox): a mission's
 * worktree does, when NEXUS works on itself. From there the containment cannot be tested: the scratch directories
 * of the containment tests would be the sandbox's own (the launcher refuses them), git sees a repository owned by
 * another account, and "outside the sandbox" is not outside. Those tests skip there, saying why; they run in an
 * ordinary checkout.
 */
export function insideSandboxRoot(cwd: string = process.cwd()): boolean {
  if (process.platform !== 'win32') return false
  const programData = process.env['ProgramData'] ?? 'C:\\ProgramData'
  const root = win32.join(programData, 'NexusSandbox').toLowerCase()
  const here = resolve(cwd).toLowerCase()
  return here === root || here.startsWith(`${root}\\`)
}

export const INSIDE_SANDBOX_REASON = 'this checkout lies inside the sandbox folder (a NEXUS mission worktree): containment is tested from an ordinary checkout'
