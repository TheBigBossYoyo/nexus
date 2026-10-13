// Builds native/nexus-launch/nexus-launch.cs with the C# compiler that ships with Windows (.NET Framework 4).
//
//   node scripts/build-launcher.mjs [outDir]     default outDir: out/native
//
// No toolchain is installed for this: csc.exe is part of Windows. The output is one small executable.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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
  // The POSIX shell of the isolated profile (vendor/busybox) lies beside the launcher in every build.
  const shell = join(here, 'vendor', 'busybox', 'busybox.exe')
  if (existsSync(shell)) {
    mkdirSync(outDir, { recursive: true })
    copyVerified(shell, join(outDir, 'busybox.exe'), vendoredSha256(join(here, 'vendor', 'busybox')))
  }
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) return output
  const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`The C# compiler of Windows was not found: ${csc}`)
  mkdirSync(outDir, { recursive: true })
  const run = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/r:System.Security.dll', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0 || !existsSync(output)) throw new Error(`The launcher did not compile:\n${run.stdout}\n${run.stderr}`)
  return output
}

/** The SHA-256 a vendored binary must have, from the record beside it (PROVENANCE.json). */
export function vendoredSha256(vendorDir) {
  const record = JSON.parse(readFileSync(join(vendorDir, 'PROVENANCE.json'), 'utf8'))
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error(`${vendorDir}: PROVENANCE.json names no SHA-256.`)
  return record.sha256
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * Puts a vendored binary into a build: only a file with the recorded hash is copied, and what lies at the
 * destination afterwards has it too. Anything else stops the build; nothing is copied "anyway".
 */
export function copyVerified(source, destination, expectedSha256) {
  const found = sha256Of(source)
  if (found !== expectedSha256) throw new Error(`${source} is not the file on record (SHA-256 ${found}, expected ${expectedSha256}). The build stops; nothing was copied.`)
  if (!existsSync(destination) || sha256Of(destination) !== expectedSha256) copyFileSync(source, destination)
  if (sha256Of(destination) !== expectedSha256) throw new Error(`${destination} does not have the recorded SHA-256 after the copy.`)
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildLauncher(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
