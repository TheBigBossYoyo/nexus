// Builds native/nexus-elevate/nexus-elevate.cs, the broker of privilege sessions, with the C# compiler of Windows.
//
//   node scripts/build-elevate.mjs [outDir]     default outDir: out/native
//
// Built the same way as the other helpers (scripts/build-sip.mjs). It is a window-less program (/target:winexe): the
// broker and its relay never open a console window, even when Windows starts the broker elevated.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trustedCsc } from './trusted-csc.mjs'

const here = resolve(import.meta.dirname, '..')

export function elevateSource() {
  return join(here, 'native', 'nexus-elevate', 'nexus-elevate.cs')
}

/** Compiles the privilege broker into `outDir`, always afresh. Returns its path. */
export function buildElevateHelper(outDir = join(here, 'out', 'native'), { findCsc = trustedCsc, run = spawnSync } = {}) {
  if (process.platform !== 'win32') throw new Error('The privilege broker is a Windows program.')
  const source = elevateSource()
  const output = join(outDir, 'nexus-elevate.exe')
  // Always rebuilt (it takes a second): a binary left from an earlier build, or one put there by someone else, is never reused
  // for a package. (Review L13.)
  const csc = findCsc()
  mkdirSync(outDir, { recursive: true })
  rmSync(output, { force: true })
  const result = run(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !existsSync(output)) {
    rmSync(output, { force: true })
    throw new Error(`The privilege broker did not compile:\n${result.stdout}\n${result.stderr}`)
  }
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildElevateHelper(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
