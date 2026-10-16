// Builds native/nexus-sip/nexus-sip.cs with the C# compiler that ships with Windows (.NET Framework 4).
//
//   node scripts/build-sip.mjs [outDir]     default outDir: out/native
//
// Built the same way as the Wi-Fi helper (scripts/build-wlan.mjs); /unsafe is on because the helper hands sound to
// the media engine as raw memory. The Linphone runtime it needs is fetched by scripts/fetch-linphone-sdk.mjs.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(import.meta.dirname, '..')

export function sipHelperSource() {
  return join(here, 'native', 'nexus-sip', 'nexus-sip.cs')
}

/** Compiles the SIP helper into `outDir` unless an up-to-date one is there. Returns its path. */
export function buildSipHelper(outDir = join(here, 'out', 'native')) {
  if (process.platform !== 'win32') throw new Error('The SIP helper is a Windows program.')
  const source = sipHelperSource()
  const output = join(outDir, 'nexus-sip.exe')
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  mkdirSync(outDir, { recursive: true })
  const run = spawnSync(csc, ['/nologo', '/optimize+', '/unsafe', '/platform:x64', '/target:exe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0 || !existsSync(output)) throw new Error(`The SIP helper did not compile:\n${run.stdout}\n${run.stderr}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildSipHelper(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
