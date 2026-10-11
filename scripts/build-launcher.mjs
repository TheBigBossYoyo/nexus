// Builds native/nexus-launch/nexus-launch.cs with the C# compiler that ships with Windows (.NET Framework 4).
//
//   node scripts/build-launcher.mjs [outDir]     default outDir: out/native
//
// No toolchain is installed for this: csc.exe is part of Windows. The output is one small executable.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(import.meta.dirname, '..')

export function launcherSource() {
  return join(here, 'native', 'nexus-launch', 'nexus-launch.cs')
}

/** Compiles the launcher into `outDir` unless an up-to-date one is there. Returns its path. */
export function buildLauncher(outDir = join(here, 'out', 'native')) {
  if (process.platform !== 'win32') throw new Error('The launcher is a Windows program.')
  const source = launcherSource()
  const output = join(outDir, 'nexus-launch.exe')
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  mkdirSync(outDir, { recursive: true })
  const run = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/r:System.Security.dll', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0 || !existsSync(output)) throw new Error(`The launcher did not compile:\n${run.stdout}\n${run.stderr}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildLauncher(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
