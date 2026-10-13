// 0.9: the release folder. From what electron-builder made, it lays out `release/v<version>/` with the
// installer, the build manifest, the bill of materials, the third-party notices, the sources a license asks
// for, and checksums of everything; then it reads every file back and checks it against the checksums.
//
//   node scripts/release-artifacts.mjs <builder-output-dir> [--allow-dirty] [--out <dir>]
//
// Nothing here is typed by hand: versions come from package.json and the lock, hashes from the files, the
// schema and the protocol from the source. A tree that is not clean is refused unless --allow-dirty is given,
// and then the manifest says so.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { release as osRelease } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const builderDir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null
if (!builderDir) throw new Error('usage: release-artifacts.mjs <builder-output-dir> [--allow-dirty] [--out <dir>]')
const allowDirty = args.includes('--allow-dirty')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const run = (file, argv, options = {}) => execFileSync(file, argv, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options }).trim()
const pnpm = (argv) => run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', argv, { shell: process.platform === 'win32' })
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const outIndex = args.indexOf('--out')
const dest = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(root, 'release', `v${version}`)

const status = run('git', ['status', '--porcelain'])
if (status !== '' && !allowDirty) throw new Error(`The tree is not clean; a release is laid out from a commit and nothing else.\n${status}`)
const commit = run('git', ['rev-parse', 'HEAD'])

const installer = join(builderDir, `NEXUS-Setup-${version}.exe`)
const unpacked = join(builderDir, 'win-unpacked')
if (!existsSync(installer)) throw new Error(`No installer of this version in ${builderDir} (${basename(installer)}).`)
if (!existsSync(join(unpacked, 'NEXUS.exe'))) throw new Error(`No unpacked application in ${builderDir}.`)

rmSync(dest, { recursive: true, force: true })
mkdirSync(join(dest, 'source'), { recursive: true })
mkdirSync(join(dest, 'licenses'), { recursive: true })
copyFileSync(installer, join(dest, basename(installer)))
if (existsSync(`${installer}.blockmap`)) copyFileSync(`${installer}.blockmap`, join(dest, `${basename(installer)}.blockmap`))

// --- What the build is made of -------------------------------------------------------------------------------
const installed = (name) => JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
const sourceText = (path) => readFileSync(join(root, path), 'utf8')
const constant = (path, pattern, what) => {
  const m = pattern.exec(sourceText(path))
  if (!m) throw new Error(`${what} was not found in ${path}.`)
  return m[1]
}
const migrations = readdirSync(join(root, 'src', 'main', 'modules', 'persistence', 'migrations')).filter((f) => /^\d{3}-.*\.ts$/.test(f)).map((f) => Number(f.slice(0, 3)))
const busybox = JSON.parse(sourceText('vendor/busybox/PROVENANCE.json'))
const resources = join(unpacked, 'resources')
const packaged = (path) => {
  const file = join(resources, path)
  return existsSync(file) ? { path: `resources/${path.replace(/\\/g, '/')}`, sha256: sha256(file), bytes: statSync(file).size } : null
}
const setupScripts = readdirSync(join(root, 'native', 'sandbox-setup')).sort().map((name) => {
  const inPackage = packaged(join('sandbox-setup', name))
  const inSource = sha256(join(root, 'native', 'sandbox-setup', name))
  return { name, sha256: inPackage?.sha256 ?? null, sameBytesAsSource: inPackage?.sha256 === inSource }
})
const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const cscVersion = (() => {
  try {
    return (execFileSync(csc, ['/nologo', '/?'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0] ?? '').trim() || 'unknown'
  } catch (e) {
    return String(e.stdout ?? '').split(/\r?\n/)[0]?.trim() || 'unknown'
  }
})()
const packagedBusybox = packaged(join('bin', 'busybox.exe'))
if (packagedBusybox === null || packagedBusybox.sha256 !== busybox.sha256) throw new Error('The busybox in the package is not the one on record.')
const packagedLauncher = packaged(join('bin', 'nexus-launch.exe'))
if (packagedLauncher === null) throw new Error('The package carries no launcher.')
const packagedWlan = packaged(join('bin', 'nexus-wlan.exe'))
if (packagedWlan === null) throw new Error('The package carries no Wi-Fi helper.')

const manifest = {
  kind: 'nexus-build-manifest',
  manifestVersion: 1,
  product: 'NEXUS',
  version,
  channel: /^\d+\.\d+\.\d+$/.test(version) ? 'release' : /-rc(\.\d+)?$/.test(version) ? 'candidate' : 'development',
  commit,
  treeClean: status === '',
  builtAt: new Date().toISOString(),
  runtimeProtocol: Number(constant('src/shared/runtime-protocol.ts', /RUNTIME_PROTOCOL_VERSION = (\d+)/, 'the runtime protocol version')),
  databaseSchema: Math.max(...migrations),
  sandboxSetupVersion: Number(constant('native/sandbox-setup/setup-sandbox.ps1', /-Name 'Version' -PropertyType String -Value '(\d+)'/, 'the sandbox setup version')),
  autonomyPolicyVersion: constant('src/shared/autonomy.ts', /AUTONOMY_POLICY_VERSION = '([^']+)'/, 'the autonomy policy version'),
  appContainer: constant('src/main/modules/isolation/launcher.ts', /SANDBOX_APP_CONTAINER = '([^']+)'/, 'the AppContainer name'),
  locks: { 'pnpm-lock.yaml': sha256(join(root, 'pnpm-lock.yaml')), 'package.json': sha256(join(root, 'package.json')), 'pnpm-workspace.yaml': sha256(join(root, 'pnpm-workspace.yaml')) },
  runtimes: {
    electron: installed('electron'),
    claudeAgentSdk: installed('@anthropic-ai/claude-agent-sdk'),
    playwrightCore: installed('playwright-core'),
    betterSqlite3: installed('better-sqlite3'),
    browser: 'the Microsoft Edge installed on the machine (Playwright channel msedge); none is shipped',
    sandboxNode: "a copy NEXUS makes at run time of the machine's own node.exe, under the sandbox compatibility policy; none is shipped",
  },
  nativeBinaries: [
    { name: 'nexus-launch.exe', ...packagedLauncher, builtFrom: 'native/nexus-launch/nexus-launch.cs', sourceSha256: sha256(join(root, 'native', 'nexus-launch', 'nexus-launch.cs')), compiler: cscVersion, license: 'part of NEXUS' },
    { name: 'nexus-wlan.exe', ...packagedWlan, builtFrom: 'native/nexus-wlan/nexus-wlan.cs', sourceSha256: sha256(join(root, 'native', 'nexus-wlan', 'nexus-wlan.cs')), compiler: cscVersion, license: 'part of NEXUS' },
    { name: 'busybox.exe', ...packagedBusybox, build: busybox.build, license: busybox.license, binaryUrl: busybox.binaryUrl, sourceRepository: busybox.sourceRepository, sourceCommit: busybox.sourceCommit, modified: busybox.modified },
    { name: 'NEXUS.exe', path: 'NEXUS.exe', sha256: sha256(join(unpacked, 'NEXUS.exe')), bytes: statSync(join(unpacked, 'NEXUS.exe')).size, note: `the Electron ${installed('electron')} executable, renamed by electron-builder` },
  ],
  sandboxSetupScripts: setupScripts,
  toolchain: { node: process.version, pnpm: pnpm(['--version']), electronBuilder: installed('electron-builder'), electronVite: installed('electron-vite'), typescript: installed('typescript'), csc: cscVersion, os: `Windows ${osRelease()}` },
  signing: { signed: false, note: 'No code-signing certificate is owned. The installer and its executables are unsigned; Windows will say so.' },
}
writeFileSync(join(dest, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

// --- Bill of materials (CycloneDX), production dependencies and the binaries that are not npm packages --------
const bom = JSON.parse(pnpm(['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'application', '--prod', '--lockfile-only']))
const extra = [
  { type: 'application', name: 'electron', version: installed('electron'), purl: `pkg:npm/electron@${installed('electron')}`, description: 'The runtime the application is packaged with (includes Chromium and Node.js)', licenses: [{ license: { id: 'MIT' } }] },
  { type: 'application', name: 'busybox-w32', version: busybox.build, description: 'POSIX shell of the isolated profile; a separate program, not linked', licenses: [{ license: { id: 'GPL-2.0-only' } }], hashes: [{ alg: 'SHA-256', content: busybox.sha256 }], externalReferences: [{ type: 'distribution', url: busybox.binaryUrl }, { type: 'vcs', url: `${busybox.sourceRepository}/tree/${busybox.sourceCommit}` }] },
  { type: 'application', name: 'nexus-launch', version, description: "NEXUS's own launcher of contained commands, compiled from native/nexus-launch/nexus-launch.cs", hashes: [{ alg: 'SHA-256', content: packagedLauncher.sha256 }] },
]
bom.components = [...(bom.components ?? []).filter((c) => !extra.some((e) => e.name === c.name && c.purl === e.purl)), ...extra.map((c) => ({ 'bom-ref': c.purl ?? `nexus:${c.name}@${c.version}`, ...c }))]
writeFileSync(join(dest, 'sbom.cdx.json'), JSON.stringify(bom, null, 2) + '\n')

// --- Third-party notices -----------------------------------------------------------------------------------
const licenses = JSON.parse(pnpm(['licenses', 'list', '--prod', '--json']))
const rows = []
for (const [license, list] of Object.entries(licenses)) for (const p of list) for (const v of p.versions ?? [p.version]) rows.push({ name: p.name, version: v, license, author: p.author ?? '', homepage: p.homepage ?? '' })
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) if (existsSync(join(unpacked, file))) copyFileSync(join(unpacked, file), join(dest, 'licenses', file))
copyFileSync(join(root, 'vendor', 'busybox', 'COPYING'), join(dest, 'licenses', 'busybox-w32-COPYING-GPL-2.0.txt'))
// The corresponding source of the GPL program, beside the installer: section 3(a) of the license.
const sourceArchive = join(root, "vendor", "busybox", busybox.sourceArchive.file)
const sourceShipped = existsSync(sourceArchive)
if (sourceShipped && sha256(sourceArchive) !== busybox.sourceArchive.sha256) throw new Error(`${sourceArchive} is not the source archive on record.`)
if (sourceShipped) copyFileSync(sourceArchive, join(dest, 'source', basename(sourceArchive)))
const notices = [
  `# Third-party notices: NEXUS ${version}`,
  '',
  `Build ${commit.slice(0, 7)}. Generated by scripts/release-artifacts.mjs from the lock file and the package; not edited by hand.`,
  '',
  '## Programs shipped beside NEXUS, under their own licenses',
  '',
  `### busybox-w32 ${busybox.build} (GNU General Public License, version 2)`,
  '',
  `\`resources/bin/busybox.exe\` in the installed application, SHA-256 \`${busybox.sha256}\`, unmodified, from ${busybox.binaryUrl}.`,
  'NEXUS starts it as a separate program (the shell of the isolated profile) and links nothing of it; the license covers that file, not NEXUS.',
  'The license text is in `licenses/busybox-w32-COPYING-GPL-2.0.txt` and in the installed application under `resources/bin/busybox-license/`.',
  sourceShipped
    ? `Its complete corresponding source is in this folder: \`source/${basename(sourceArchive)}\` (commit ${busybox.sourceCommit} of ${busybox.sourceRepository}). Whoever passes the installer on passes that archive on with it.`
    : `**Its corresponding source is NOT in this folder.** Until the archive of commit ${busybox.sourceCommit} of ${busybox.sourceRepository} lies in \`source/\`, this build must not be given to anybody else (GPL-2.0, section 3).`,
  '',
  `### Electron ${installed('electron')} with Chromium and Node.js`,
  '',
  'MIT (Electron) and the licenses of Chromium and its parts: `licenses/LICENSE.electron.txt`, `licenses/LICENSES.chromium.html`; both are also in the installed application.',
  '',
  '## npm packages in the application (production dependencies)',
  '',
  '| Package | Version | License | Author | Home |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${String(r.author).replace(/\|/g, '/')} | ${r.homepage} |`),
  '',
  'The full license text of each package is in its folder inside the application archive (`resources/app.asar`, `node_modules/<package>/`).',
  '',
]
writeFileSync(join(dest, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'))

// --- Checksums, then every file read back against them -------------------------------------------------------
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const files = walk(dest).filter((f) => basename(f) !== 'SHA256SUMS').sort()
const sums = files.map((f) => `${sha256(f)}  ${relative(dest, f).replace(/\\/g, '/')}`)
writeFileSync(join(dest, 'SHA256SUMS'), sums.join('\n') + '\n')
let verified = 0
for (const line of readFileSync(join(dest, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [hash, name] = line.split('  ')
  if (sha256(join(dest, name)) !== hash) throw new Error(`${name} does not have the checksum that was just written for it.`)
  verified += 1
}
if (sha256(join(dest, basename(installer))) !== sha256(installer)) throw new Error('The installer in the release folder is not the one that was built.')
console.log(JSON.stringify({ dest, version, commit, treeClean: status === '', files: verified, busyboxSourceShipped: sourceShipped, distributable: sourceShipped ? 'license obligations of the shipped programs are met by this folder' : 'NOT distributable: the busybox source is missing' }, null, 2))
