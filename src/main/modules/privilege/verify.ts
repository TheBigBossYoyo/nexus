import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { PrivilegedOperationRequest } from '@shared/privilege'
import { runProcess, type ProcessResult } from '../process/run-process'

/**
 * 0.9.1: what can be seen after a privileged operation, from NEXUS's own unelevated side (B4, post-execution
 * verification): whether the files, registry keys and services the request said it would change are there, and
 * in what state. It reads; it never changes anything. What it reports goes into the receipt as "observed".
 */

export interface VerifierDeps {
  run?: (file: string, args: readonly string[]) => Promise<Pick<ProcessResult, 'exitCode' | 'stdout'>>
  systemRoot?: string
}

export function createPrivilegeVerifier(deps: VerifierDeps = {}): (req: PrivilegedOperationRequest) => Promise<string[]> {
  const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
  const run =
    deps.run ??
    ((file: string, args: readonly string[]) =>
      runProcess(file, args, { cwd: systemRoot, env: { SystemRoot: systemRoot, windir: systemRoot, PATH: `${systemRoot}\\System32` }, timeoutMs: 15_000, maxOutputBytes: 16_384 }))
  return async (req) => {
    const seen: string[] = []
    for (const file of req.expected.files.slice(0, 20)) {
      if (!/^[a-z]:\\/i.test(file)) continue
      seen.push(`${file}: ${existsSync(file) ? 'present' : 'absent'}.`)
    }
    for (const key of req.expected.registry.slice(0, 20)) {
      if (!/^(HKLM|HKEY_LOCAL_MACHINE|HKCU|HKEY_CURRENT_USER)\\[^"*?<>|]{1,250}$/i.test(key)) continue
      const r = await run(win32.join(systemRoot, 'System32', 'reg.exe'), ['query', key]).catch(() => null)
      seen.push(`${key}: ${r === null ? 'could not be read' : r.exitCode === 0 ? 'present' : 'absent'}.`)
    }
    for (const service of req.expected.services.slice(0, 20)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(service)) continue
      const r = await run(win32.join(systemRoot, 'System32', 'sc.exe'), ['query', service]).catch(() => null)
      const state = r?.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/)?.[1]
      seen.push(`service ${service}: ${r === null ? 'could not be read' : r.exitCode === 0 ? (state ?? 'present').toLowerCase() : 'absent'}.`)
    }
    return seen
  }
}
