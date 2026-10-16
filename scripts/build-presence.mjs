// Builds native/nexus-presence/nexus-presence.cs, the meter of what NEXUS's work shows on the owner's screen, with the C# compiler of Windows.
//
//   node scripts/build-presence.mjs [outDir]     default outDir: out/native
//
// Built the same way as the other helpers (scripts/build-sip.mjs). It is a window-less program (/target:winexe): it
// never opens a console window of its own.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(import.meta.dirname, '..')

export function presenceSource() {
  return join(here, 'native', 'nexus-presence', 'nexus-presence.cs')
}

/** Compiles the SIP helper into `outDir` unless an up-to-date one is there. Returns its path. */
export function buildPresenceHelper(outDir = join(here, 'out', 'native')) {
  if (process.platform !== 'win32') throw new Error('The presence meter is a Windows program.')
  const source = presenceSource()
  const output = join(outDir, 'nexus-presence.exe')
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  mkdirSync(outDir, { recursive: true })
  const run = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0 || !existsSync(output)) throw new Error(`The presence meter did not compile:\n${run.stdout}\n${run.stderr}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildPresenceHelper(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
