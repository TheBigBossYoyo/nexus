// One-time setup (or removal) of the NEXUS sandbox account on this machine. Raises ONE elevation prompt.
//
//   node scripts/sandbox-setup.mjs           create or repair the account, the firewall rules and the sandbox root
//   node scripts/sandbox-setup.mjs --remove  undo all of it (add --remove-root to delete the sandbox root too)
//   node scripts/sandbox-setup.mjs --status  say what is recorded, without changing anything
//
// The password is generated here, handed to the elevated script in a file only this user can read, stored
// as a DPAPI blob under %LOCALAPPDATA%\NexusSandbox, and the file is deleted. It is never printed.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = resolve(import.meta.dirname, '..')
const launcher = join(here, 'out', 'native', 'nexus-launch.exe')
const stateDir = join(process.env.LOCALAPPDATA ?? '', 'NexusSandbox')
const statePath = join(stateDir, 'sandbox.json')
const credentialPath = join(stateDir, 'credential.bin')
const work = join(here, '.nexus-data', 'sandbox-setup')
const args = new Set(process.argv.slice(2))

if (process.platform !== 'win32') throw new Error('Windows only.')
if (args.has('--status')) {
  console.log(existsSync(statePath) ? readFileSync(statePath, 'utf8') : 'No sandbox account is recorded for this user.')
  process.exit(0)
}
if (!existsSync(launcher)) throw new Error(`Build the launcher first: ${launcher}`)

const system32 = join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
const sid = spawnSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout.match(/S-1-5-21-[0-9-]+/)?.[0]
if (!sid) throw new Error('The SID of the current user could not be read.')

mkdirSync(work, { recursive: true })
const resultFile = join(work, `result-${randomBytes(4).toString('hex')}.json`)
const passwordFile = join(work, `p-${randomBytes(8).toString('hex')}.txt`)

function elevated(script, parameters) {
  // -Verb RunAs raises the consent prompt. The script's own window is hidden; -Wait returns when it has ended.
  const list = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`, ...parameters].map((a) => `'${a.replace(/'/g, "''")}'`).join(', ')
  const command = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${list}; exit $p.ExitCode`
  return spawnSync(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 })
}

function readResult() {
  if (!existsSync(resultFile)) return null
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\ufeff/, ''))
  } finally {
    rmSync(resultFile, { force: true })
  }
}

if (args.has('--remove')) {
  const run = elevated(join(here, 'native', 'sandbox-setup', 'remove-sandbox.ps1'), ['-ResultFile', `"${resultFile}"`, ...(args.has('--remove-root') ? ['-RemoveRoot'] : [])])
  const result = readResult()
  if (result?.ok) {
    rmSync(credentialPath, { force: true })
    rmSync(statePath, { force: true })
  }
  console.log(JSON.stringify({ exit: run.status, result: result ?? 'no result: the elevation was declined or the script did not start' }, null, 2))
  process.exit(result?.ok ? 0 : 1)
}

const password = `${randomBytes(30).toString('base64url')}aA1!`
let result
let run
try {
  writeFileSync(passwordFile, password, { flag: 'wx' })
  spawnSync(join(system32, 'icacls.exe'), [passwordFile, '/inheritance:r', '/grant:r', `*${sid}:F`, '/grant:r', '*S-1-5-32-544:F'], { windowsHide: true })
  run = elevated(join(here, 'native', 'sandbox-setup', 'setup-sandbox.ps1'), ['-MainUserSid', sid, '-PasswordFile', `"${passwordFile}"`, '-ResultFile', `"${resultFile}"`])
  result = readResult()
} finally {
  rmSync(passwordFile, { force: true })
}
if (!result?.ok) {
  console.log(JSON.stringify({ exit: run?.status ?? null, result: result ?? 'no result: the elevation was declined or the script did not start', stderr: run?.stderr?.slice(0, 500) }, null, 2))
  process.exit(1)
}
mkdirSync(stateDir, { recursive: true })
const stored = spawnSync(launcher, ['credential', 'write', credentialPath], { input: `${result.account}\n${password}\n`, encoding: 'utf8', windowsHide: true })
if (stored.status !== 0) throw new Error(`The credential could not be stored: ${stored.stderr}`)
const state = { account: result.account, sid: result.sid, root: result.root, firewallOutbound: result.firewallOutbound, firewallInbound: result.firewallInbound, setupAt: new Date().toISOString(), credential: credentialPath }
writeFileSync(statePath, JSON.stringify(state, null, 2))
console.log(JSON.stringify({ ok: true, ...state, steps: result.steps }, null, 2))
