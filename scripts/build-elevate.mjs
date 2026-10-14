// Builds native/nexus-elevate/nexus-elevate.cs, the broker of privilege sessions, with the C# compiler of Windows.
//
//   node scripts/build-elevate.mjs [outDir]     default outDir: out/native
//
// Built the same way as the other helpers (scripts/build-sip.mjs). It is a window-less program (/target:winexe): the
// broker and its relay never open a console window, even when Windows starts the broker elevated.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(import.meta.dirname, '..')

export function elevateSource() {
  return join(here, 'native', 'nexus-elevate', 'nexus-elevate.cs')
}

/** Compiles the SIP helper into `outDir` unless an up-to-date one is there. Returns its path. */
export function buildElevateHelper(outDir = join(here, 'out', 'native')) {
  if (process.platform !== 'win32') throw new Error('The privilege broker is a Windows program.')
  const source = elevateSource()
  const output = join(outDir, 'nexus-elevate.exe')
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  mkdirSync(outDir, { recursive: true })
  const run = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0 || !existsSync(output)) throw new Error(`The privilege broker did not compile:\n${run.stdout}\n${run.stderr}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildElevateHelper(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
