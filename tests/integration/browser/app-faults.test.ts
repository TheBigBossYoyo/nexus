import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplicationUnderTestManager, AppLaunchError, type AppOwner } from '@main/modules/browser/app-manager'
import { PlaywrightDirectProvider } from '@main/modules/browser/provider'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher } from '@main/modules/isolation/launcher'
import type { NetworkEvent } from '@main/modules/network/guard'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// What happens to an application under test when things go wrong: it never starts, it ends at once, it dies
// while it is used, its launcher is killed, its proxy goes away; and what two sessions can see of each other.
// RESTRICTED, headless: nothing is shown.

const provider = new PlaywrightDirectProvider()
const d = process.platform === 'win32' && provider.availability().browser !== null ? describe : describe.skip
const SCRATCH = resolve('test-results', 'app-fault-tests')

const SERVER = `
const http = require('http');
const mode = process.env.FIXTURE_MODE || 'ok';
if (mode === 'exit') { console.log('about to fail'); console.error('fixture: cannot start'); process.exit(3); }
if (mode === 'silent') { setInterval(() => {}, 1000); }
else {
  const server = http.createServer((req, res) => {
    if (req.url === '/die') { res.end('dying'); setTimeout(() => process.exit(7), 50); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>' + (process.env.FIXTURE_NAME || 'app') + '</title><h1>' + (process.env.FIXTURE_NAME || 'app') + '</h1><p role="status" id="p">idle</p>' +
      '<script>window.probe = async (url) => { try { const r = await fetch(url); p.textContent = "probe:reached:" + (await r.text()).slice(0, 20) } catch (e) { p.textContent = "probe:refused" } }</script>');
  });
  server.listen(0, '127.0.0.1', () => console.log('ready on http://127.0.0.1:' + server.address().port + '/'));
}
`

let broker: ExecutionBroker
let apps: ApplicationUnderTestManager
const events: NetworkEvent[] = []

function owner(name: string, env: Record<string, string> = {}, startTimeoutSeconds = 30): AppOwner {
  const worktree = join(SCRATCH, 'worktrees', name)
  mkdirSync(join(worktree, '.nexus'), { recursive: true })
  writeFileSync(join(worktree, 'server.cjs'), SERVER)
  writeFileSync(join(worktree, '.nexus', 'app.json'), JSON.stringify({ type: 'web', launchCommand: 'node server.cjs', ready: { kind: 'log', pattern: 'ready on' }, startTimeoutSeconds, env: { FIXTURE_NAME: name, ...env } }))
  return { projectId: 'faults', runId: `run-${name}`, taskId: `task-${name}`, key: `run-${name}:task`, worktree }
}

const listening = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => (socket.destroy(), done(true)))
    socket.once('error', () => done(false))
  })

const portOf = (endpoint: string | null): number => Number(new URL(endpoint ?? 'http://127.0.0.1:1/').port)

d('an application under test when things go wrong', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => null, baseEnv: () => process.env, limits: { maxProcesses: 64 } })
    await broker.verify('RESTRICTED')
    apps = new ApplicationUnderTestManager({ broker, browser: provider, profileFor: () => 'RESTRICTED', artifactsDir: join(SCRATCH, 'artifacts'), onNetwork: (_o, e) => events.push(e) })
  }, 120_000)

  afterAll(async () => {
    await apps?.stopAll()
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  it('an application that ends while starting is reported with what it printed, and leaves nothing', async () => {
    const o = owner('exits', { FIXTURE_MODE: 'exit' })
    const error = await apps.launch(o).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppLaunchError)
    expect((error as AppLaunchError).message).toContain('ended while starting (exit 3)')
    expect((error as AppLaunchError).output.join('\n')).toContain('fixture: cannot start')
    expect(apps.registry()).toEqual([])
    expect(apps.status(o.key)?.state).toBe('stopped')
  }, 60_000)

  it('an application that never becomes ready is given up at its time limit and ended', async () => {
    const o = owner('silent', { FIXTURE_MODE: 'silent' }, 3)
    const started = Date.now()
    await expect(apps.launch(o)).rejects.toThrow(/not ready after 3 seconds/)
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(apps.registry()).toEqual([])
    // Its process is gone with its job: no node of this fixture is left.
    const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'app-fault-tests' -and $_.CommandLine -match 'server.cjs' } | Measure-Object).Count"], { encoding: 'utf8', windowsHide: true }).trim()
    expect(left).toBe('0')
  }, 60_000)

  it('an application that dies while it is used is seen as ended, says so, and can be launched again', async () => {
    const o = owner('dies')
    const first = await apps.launch(o)
    const port = portOf(first.endpoint)
    await apps.session(o.key).navigate(apps.resolveInApp(o.key, '/die') as string)
    await expect.poll(() => apps.status(o.key)?.state, { timeout: 15_000 }).toBe('exited')
    expect(apps.status(o.key)?.exitCode).toBe(7)
    expect(() => apps.session(o.key)).toThrow(/has ended \(exit 7\)/)
    expect(await listening(port)).toBe(false)
    const again = await apps.launch(o)
    expect(again.state).toBe('running')
    expect((await apps.session(o.key).snapshot()).text).toContain('heading "dies"')
    expect(apps.registry().filter((e) => e.runId === o.runId)).toHaveLength(1)
    await apps.stop(o.key)
  }, 120_000)

  it('killing the launcher ends the application with it', async () => {
    const o = owner('killed')
    const status = await apps.launch(o)
    const port = portOf(status.endpoint)
    expect(await listening(port)).toBe(true)
    // The launcher of this fixture, found by its spec; ended from outside, as a crash or a task manager would.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='nexus-launch.exe'\" | Where-Object { $_.CommandLine -match 'app-fault-tests' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { windowsHide: true })
    await expect.poll(() => listening(port), { timeout: 15_000 }).toBe(false)
    await expect.poll(() => apps.status(o.key)?.state, { timeout: 15_000 }).toBe('exited')
    await apps.stop(o.key)
  }, 60_000)

  it('two sessions do not reach each other: each browser has its own endpoint and no other', async () => {
    const a = owner('alpha')
    const b = owner('beta')
    const [sa, sb] = await Promise.all([apps.launch(a), apps.launch(b)])
    expect(sa.endpoint).not.toBe(sb.endpoint)
    expect(apps.registry()).toHaveLength(2)
    const browserA = apps.session(a.key)
    // Not as an address to open, and not as something a page of A can fetch.
    expect(apps.resolveInApp(a.key, sb.endpoint as string)).toBeNull()
    await (browserA as unknown as { navigate(url: string): Promise<unknown> }).navigate(sb.endpoint as string).catch(() => undefined)
    expect((await browserA.snapshot()).text).not.toContain('heading "beta"')
    await browserA.navigate(sa.endpoint as string)
    expect((await browserA.snapshot()).text).toContain('heading "alpha"')
    expect(events.some((e) => !e.allowed && e.port === portOf(sb.endpoint))).toBe(true)
    // Stopping one leaves the other.
    await apps.stop(a.key)
    expect(apps.registry().map((e) => e.runId)).toEqual([b.runId])
    expect((await apps.session(b.key).snapshot()).text).toContain('heading "beta"')
    await apps.stop(b.key)
  }, 120_000)

  it('when the proxy of a session goes away the browser reaches nothing: there is no direct way', async () => {
    const o = owner('noproxy')
    const status = await apps.launch(o)
    const browser = apps.session(o.key)
    expect((await browser.snapshot()).text).toContain('heading "noproxy"')
    await apps.closeProxyForTest(o.key)
    // The server itself is still there, on the loopback, one hop away.
    expect(await listening(portOf(status.endpoint))).toBe(true)
    await browser.reload().catch(() => undefined)
    expect((await browser.snapshot().catch(() => ({ text: '' }))).text).not.toContain('heading "noproxy"')
    await apps.stop(o.key)
  }, 60_000)

  it('everything a mission started is stopped when the mission ends', async () => {
    const a = owner('m1')
    const b = { ...owner('m2'), runId: a.runId }
    const [sa, sb] = [await apps.launch(a), await apps.launch(b)]
    expect(await apps.stopForRun(a.runId as string)).toBe(2)
    expect(apps.registry()).toEqual([])
    expect(await listening(portOf(sa.endpoint))).toBe(false)
    expect(await listening(portOf(sb.endpoint))).toBe(false)
  }, 120_000)
})
