// 0.9: what a start of NEXUS finds after a restart of Windows. It observes and repairs nothing: no setup, no
// elevation, no mission, no inference. The machine's sandbox state is read as an ordinary user reads it
// (scripts/v09-machine-state.ps1), then the packaged application is started on a data directory of its own with
// the window off-screen, and what it reports about the isolated profile is recorded as it is. NEXUS verifies
// ISOLATED at every start by running it (launcher.ts, verify): the account, the folders, the network, names,
// the name cache and the canonical form of a path.
//
//   node scripts/v09-reboot-observation.mjs <unpacked-dir> [label]
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stopNexus, waitForRuntime } from './acceptance-common.mjs'

const root = resolve(import.meta.dirname, '..')
const [unpacked, label = 'reboot'] = process.argv.slice(2)
if (!unpacked) throw new Error('usage: v09-reboot-observation.mjs <unpacked-dir> [label]')
const exe = join(resolve(unpacked), 'NEXUS.exe')
const output = join(root, 'test-results', 'v09-reboot')
const dataDir = join(output, 'data')
rmSync(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
mkdirSync(output, { recursive: true })

const machineState = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'v09-machine-state.ps1')], { encoding: 'utf8' }).trim())
// A UAC prompt is the process consent.exe. Seen at any moment of the run, it is recorded.
const consentSeen = []
const watch = setInterval(() => {
  try {
    if (/consent\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq consent.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }))) consentSeen.push(new Date().toISOString())
  } catch {
    // The list could not be read at that moment.
  }
}, 1000)

const evidence = { kind: 'v0.9-reboot-observation', label, executable: exe, startedAt: new Date().toISOString(), machineBeforeStart: machineState(), checks: {}, errors: [] }
const env = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
for (const name of ['NEXUS_FAKE_RUNTIME', 'NEXUS_FAKE_POWER', 'NEXUS_FAKE_WORKERS', 'NEXUS_CONTAINMENT', 'NEXUS_ACCEPT_CONFIRM']) delete env[name]

const launchedAt = Date.now()
const app = await electron.launch({ executablePath: exe, env })
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 90_000 })
  await waitForRuntime(page)
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const info = await call('app.info')
  evidence.app = { version: info.version, isPackaged: info.isPackaged, build: info.build }
  const status = await call('runtime.status')
  evidence.runtime = { phase: status.phase, endpointAcl: status.endpointAcl }
  // The first answer, as the application gives it by itself, and when.
  let isolation = await call('isolation.status')
  for (let i = 0; i < 240 && isolation.sandboxAccount && isolation.isolated == null; i++) {
    await new Promise((r) => setTimeout(r, 500))
    isolation = await call('isolation.status')
  }
  evidence.secondsFromLaunchToIsolationAnswer = Math.round((Date.now() - launchedAt) / 100) / 10
  evidence.isolation = { requested: isolation.requested, effective: isolation.effective, usable: isolation.usable, detail: isolation.detail, isolated: isolation.isolated, restricted: isolation.restricted, sandboxAccount: isolation.sandboxAccount, setupAvailable: isolation.setupAvailable }
  const detail = String(isolation.isolated?.detail ?? '')
  const available = isolation.isolated?.available === true
  evidence.checks['the runtime is ready'] = status.phase === 'READY'
  evidence.checks['ISOLATED is reported available, verified at this start by running it'] = available
  evidence.checks['a contained process ran as the sandbox account in the AppContainer'] = available && /in an AppContainer/.test(detail)
  evidence.checks['the filesystem containment holds (refused beside its directory, a protected file, a file of the user)'] = available && /refused beside it/.test(detail) && /refused a protected file and a file in your profile/.test(detail)
  evidence.checks['no direct route to the Internet'] = available && /no direct route to the Internet/.test(detail)
  evidence.checks['no name looked up (resolver, own query, request by name)'] = available && /got no name looked up/.test(detail)
  evidence.checks['names could be looked up outside the containment at that moment (so the refusal was really seen)'] = available && !/could not be looked up from this machine/.test(detail)
  evidence.checks["not shown the machine's name cache"] = available && /not shown the machine's name cache/.test(detail)
  // verify() reports ISOLATED as unavailable when the canonical form of a path is refused; available means it was given.
  evidence.checks['the canonical form of a path is given inside the containment'] = available
  evidence.checks['RESTRICTED is verified too'] = isolation.restricted?.available === true
  evidence.checks['the window reported no script error'] = evidence.errors.length === 0
} catch (error) {
  evidence.failure = String(error?.stack ?? error).slice(0, 2000)
  console.error(error)
} finally {
  await stopNexus(app, dataDir).catch((e) => evidence.errors.push(`stop: ${String(e)}`))
  clearInterval(watch)
  evidence.machineAfterStart = machineState()
  evidence.consentPromptsSeen = consentSeen
  evidence.checks['no elevation prompt appeared during the start'] = consentSeen.length === 0
  evidence.checks['the start changed nothing on the Mount Manager device'] = JSON.stringify(evidence.machineBeforeStart.mountManager?.after) === JSON.stringify(evidence.machineAfterStart.mountManager?.after)
  evidence.finishedAt = new Date().toISOString()
  evidence.verdict = evidence.failure === undefined && Object.values(evidence.checks).every(Boolean) ? 'PASS' : 'FAIL'
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  for (const [name, ok] of Object.entries(evidence.checks)) console.log(ok ? 'PASS' : 'FAIL', name)
  console.log(evidence.verdict, join(output, 'evidence.json'))
  if (evidence.verdict !== 'PASS') process.exitCode = 1
}
