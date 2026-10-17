// Builds native/nexus-wlan/nexus-wlan.cs with the C# compiler that ships with Windows (.NET Framework 4).
//
//   node scripts/build-wlan.mjs [outDir]     default outDir: out/native
//
// Built the same way as the launcher (scripts/build-launcher.mjs): csc.exe is part of Windows, nothing is installed.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trustedCsc } from './trusted-csc.mjs'

const here = resolve(import.meta.dirname, '..')

export function wlanHelperSource() {
  return join(here, 'native', 'nexus-wlan', 'nexus-wlan.cs')
}

/** Compiles the Wi-Fi helper into `outDir` unless an up-to-date one is there. Returns its path. */
export function buildWlanHelper(outDir = join(here, 'out', 'native'), { fresh = false, findCsc = trustedCsc, run = spawnSync } = {}) {
  if (process.platform !== 'win32') throw new Error('The Wi-Fi helper is a Windows program.')
  const source = wlanHelperSource()
  const output = join(outDir, 'nexus-wlan.exe')
  if (!fresh && existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = findCsc()
  mkdirSync(outDir, { recursive: true })
  const result = run(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !existsSync(output)) throw new Error(`The Wi-Fi helper did not compile:\n${result.stdout}\n${result.stderr}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const positional = args.filter((a) => a !== '--fresh')
  console.log(buildWlanHelper(positional[0] ? resolve(positional[0]) : undefined, { fresh: args.includes('--fresh') }))
}
