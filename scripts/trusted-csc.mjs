// The path of the C# compiler of Windows, taken from a source the environment cannot change. (Review L13.)
//
// The Windows folder is the SystemRoot value under HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion, read with the reg.exe
// at its fixed path (never through PATH, SystemRoot or windir). The compiler must be <root>\Microsoft.NET\Framework64\v4.0.30319\csc.exe
// and its real path must lie inside the real <root>\Microsoft.NET\Framework64. There is no fallback to the environment.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'

export const REG_EXE = 'C:\\Windows\\System32\\reg.exe'
const KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'

const underFolder = (path, root) => win32.normalize(path).toLowerCase().startsWith(`${win32.normalize(root).toLowerCase().replace(/\\+$/, '')}\\`)

/** The SystemRoot value out of `reg query ... /v SystemRoot` output, or null. */
function parseSystemRoot(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s*SystemRoot\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line)
    if (!m) continue
    const value = m[1]
    if (!/^[A-Za-z]:\\/.test(value)) return null
    if (value.split(/[\\/]+/).includes('..')) return null
    return win32.normalize(value).replace(/\\+$/, '')
  }
  return null
}

/** Returns the absolute path of the trusted csc.exe or throws. `deps`: spawnSync, existsSync, realpath (for tests). */
export function trustedCsc(deps = {}) {
  const run = deps.spawnSync ?? spawnSync
  const exists = deps.existsSync ?? existsSync
  const realpath = deps.realpath ?? realpathSync.native
  if (!exists(REG_EXE)) throw new Error(`The registry tool was not found: ${REG_EXE}`)
  const result = run(REG_EXE, ['query', KEY, '/v', 'SystemRoot'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: 'C:\\Windows\\System32' }
  })
  if (result.error) throw new Error(`The Windows folder could not be read from the registry: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`The Windows folder could not be read from the registry (reg.exe exited with ${result.status}).`)
  const root = parseSystemRoot(result.stdout)
  if (!root) throw new Error('The SystemRoot value in the registry is not an absolute drive path.')
  const frameworkDir = win32.join(root, 'Microsoft.NET', 'Framework64')
  const csc = win32.join(frameworkDir, 'v4.0.30319', 'csc.exe')
  if (!exists(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  let realCsc
  let realFramework
  try {
    realCsc = realpath(csc)
    realFramework = realpath(frameworkDir)
  } catch (error) {
    throw new Error(`The C# compiler of Windows could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!underFolder(realCsc, realFramework)) throw new Error(`The C# compiler resolves outside ${frameworkDir}: ${realCsc}`)
  return csc
}
