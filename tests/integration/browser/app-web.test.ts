import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplicationUnderTestManager, AppLaunchError, type AppOwner } from '@main/modules/browser/app-manager'
import { PlaywrightDirectProvider } from '@main/modules/browser/provider'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher, type ContainmentProfile } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { mirrorTools } from '@main/modules/isolation/tools'
import type { NetworkEvent } from '@main/modules/network/guard'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// A web application under test, for real: a small server of a "project" is started inside the containment, a
// headless browser with a profile of its own opens it through the session's proxy, and the page is read and
// operated through the same calls the agent tools make. No window is shown: the browser is headless and the
// server is a console program.
//
// What is asserted beyond "it works": the browser reaches the endpoint the session registered and nothing else
// (not another loopback service, not the Internet), and the server runs inside the containment.

const WINDOWS = process.platform === 'win32'
const provider = new PlaywrightDirectProvider()
const d = WINDOWS && provider.availability().browser !== null ? describe : describe.skip
const account = WINDOWS ? readSandboxAccount() : null
const SCRATCH = resolve('test-results', 'app-web-tests')
const PROFILES: ContainmentProfile[] = account ? ['RESTRICTED', 'ISOLATED'] : ['RESTRICTED']

const SERVER = `
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const items = ['first'];
const page = \`<!doctype html><html><head><title>Fixture shop</title></head><body>
<h1>Items</h1>
<ul id="list" aria-label="items"></ul>
<label>New item <input id="name" name="name"></label>
<button id="add">Add item</button>
<p id="probe" role="status">probing</p>
<script>
async function load() { const r = await fetch('/api/items'); const items = await r.json(); list.innerHTML = ''; for (const i of items) { const li = document.createElement('li'); li.textContent = i; list.appendChild(li); } }
add.onclick = async () => { await fetch('/api/items', { method: 'POST', body: document.getElementById('name').value }); document.getElementById('name').value = ''; await load(); };
load();
console.error('fixture-console-error');
(async () => {
  const out = [];
  for (const [name, url] of [['other-local', 'http://127.0.0.1:' + OTHER_PORT + '/'], ['internet', 'http://example.com/']]) {
    try { const r = await fetch(url); out.push(name + ':reached:' + (await r.text()).slice(0, 12)); } catch (e) { out.push(name + ':refused'); }
  }
  probe.textContent = out.join(' ');
})();
</script></body></html>\`;
const server = http.createServer((req, res) => {
  if (req.url === '/api/items' && req.method === 'POST') { let body = ''; req.on('data', (c) => body += c); req.on('end', () => { items.push(body); res.end('ok'); }); return; }
  if (req.url === '/api/items') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(items)); return; }
  if (req.url === '/whoami') {
    let outside = 'DENIED';
    try { fs.writeFileSync(process.env.FIXTURE_OUTSIDE, 'x'); outside = 'WROTE'; } catch (e) {}
    let user = 'unknown'; try { user = require('child_process').execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe')).toString().trim(); } catch (e) { user = 'whoami-failed'; }
    res.end(JSON.stringify({ user, outside, key: process.env.ANTHROPIC_API_KEY || '' })); return;
  }
  if (req.url === '/missing') { res.statusCode = 404; res.end('no'); return; }
  res.setHeader('content-type', 'text/html'); res.end(page.replace('OTHER_PORT', process.env.FIXTURE_OTHER_PORT));
});
server.listen(0, '127.0.0.1', () => console.log('  Local:   http://127.0.0.1:' + server.address().port + '/'));
`

let broker: ExecutionBroker
let apps: ApplicationUnderTestManager
let other: Server
let otherPort = 0
let otherHits = 0
const events: NetworkEvent[] = []

function project(profile: ContainmentProfile): AppOwner {
  const base = profile === 'ISOLATED' && account ? join(account.root, 'worktrees', 'app-web-tests') : join(SCRATCH, 'worktrees')
  const worktree = join(base, `shop-${profile.toLowerCase()}`)
  mkdirSync(join(worktree, '.nexus'), { recursive: true })
  writeFileSync(join(worktree, 'server.cjs'), SERVER)
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture-shop', private: true, scripts: { dev: 'node server.cjs' } }))
  writeFileSync(join(worktree, '.nexus', 'app.json'), JSON.stringify({ type: 'web', launchCommand: 'node server.cjs', ready: { kind: 'log', pattern: 'Local:' }, startTimeoutSeconds: 60, env: { FIXTURE_OTHER_PORT: String(otherPort), FIXTURE_OUTSIDE: join(SCRATCH, `outside-${profile}.txt`) } }))
  return { projectId: `app-web-${profile}`, runId: 'run-1', taskId: `task-${profile}`, key: `run-1:task-${profile}`, worktree }
}

d('a web application under test, inside the containment', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    const mirrored = account ? mirrorTools({ sandboxRoot: account.root, userProfile: homedir(), path: process.env['PATH'] ?? '', names: ['node'] }) : null
    broker = new ExecutionBroker({
      launcher,
      sandboxDir: join(SCRATCH, 'sandbox'),
      account: () => account,
      baseEnv: () => ({ ...process.env, ANTHROPIC_API_KEY: 'fixture-secret-key' }),
      toolPath: (profile, path) => (profile === 'ISOLATED' && mirrored ? mirrored.path : path),
      limits: { maxProcesses: 64 },
    })
    for (const profile of PROFILES) await broker.verify(profile)
    other = createServer((_req, res) => {
      otherHits += 1
      res.setHeader('access-control-allow-origin', '*')
      res.end('another local service')
    })
    await new Promise<void>((done) => other.listen({ host: '127.0.0.1', port: 0 }, done))
    otherPort = (other.address() as AddressInfo).port
    apps = new ApplicationUnderTestManager({
      broker,
      browser: provider,
      profileFor: (projectId) => (projectId.endsWith('ISOLATED') ? 'ISOLATED' : projectId.endsWith('STANDARD') ? 'STANDARD' : 'RESTRICTED'),
      artifactsDir: join(SCRATCH, 'artifacts'),
      onNetwork: (_owner, event) => events.push(event),
    })
  }, 240_000)

  afterAll(async () => {
    await apps?.stopAll()
    await new Promise<void>((done) => other.close(() => done()))
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    if (account) {
      rmSync(join(account.root, 'worktrees', 'app-web-tests'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      broker.sweep()
    }
  })

  for (const profile of PROFILES) {
    describe(profile, () => {
      let owner: AppOwner

      it('starts the server contained, registers its endpoint, and opens it', async () => {
        owner = project(profile)
        const status = await apps.launch(owner)
        expect(status).toMatchObject({ type: 'web', state: 'running', profile })
        expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
        expect(apps.registry().filter((e) => e.projectId === owner.projectId)).toHaveLength(1)
        const snapshot = await apps.session(owner.key).snapshot()
        expect(snapshot.title).toBe('Fixture shop')
        expect(snapshot.text).toContain('heading "Items"')
        expect(snapshot.text).toMatch(/button "Add item" \[ref=\w+\]/)
      }, 120_000)

      it('is operated by refs from a snapshot: fill, click, read the result', async () => {
        const browser = apps.session(owner.key)
        const field = /\[ref=(\w+)\]/.exec((await browser.find('New item')).matches.find((l) => l.includes('textbox')) ?? '')?.[1]
        const button = /\[ref=(\w+)\]/.exec((await browser.find('Add item')).matches[0] ?? '')?.[1]
        expect(field, 'the field has a ref').toBeTruthy()
        expect(button, 'the button has a ref').toBeTruthy()
        await browser.fill(field as string, 'a second thing')
        await browser.click(button as string)
        await browser.wait({ text: 'a second thing' })
        const list = await browser.snapshot()
        expect(list.text).toContain('first')
        expect(list.text).toContain('a second thing')
        // A ref of a page that changed names nothing any more, and says so.
        await browser.reload()
        await expect(browser.click('zz99')).rejects.toThrow(/no longer on the page|did not succeed/)
      }, 60_000)

      it('reaches its own endpoint and nothing else: not another local service, not the Internet', async () => {
        const browser = apps.session(owner.key)
        await browser.wait({ text: 'internet:' })
        const probe = (await browser.find('other-local')).matches.join(' ')
        expect(probe).toContain('other-local:refused')
        expect(probe).toContain('internet:refused')
        expect(otherHits).toBe(0)
        const refusedHosts = events.filter((e) => !e.allowed).map((e) => `${e.host}:${e.port}`)
        expect(refusedHosts).toContain(`127.0.0.1:${otherPort}`)
        expect(refusedHosts).toContain('example.com:80')
        // An address that is not the application's is not a place to navigate to, whatever it is.
        for (const target of ['file:///C:/Windows/win.ini', `http://127.0.0.1:${otherPort}/`, 'https://example.com/', 'chrome://version', '//example.com/x']) expect(apps.resolveInApp(owner.key, target), target).toBeNull()
        expect(apps.resolveInApp(owner.key, '/missing')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/missing$/)
      }, 60_000)

      it('gives its console, its failed requests and a screenshot', async () => {
        const browser = apps.session(owner.key)
        await browser.navigate(apps.resolveInApp(owner.key, '/missing') as string)
        await browser.navigate(apps.resolveInApp(owner.key, '/') as string)
        const log = browser.console({ level: 'error' })
        expect(log.errors).toBeGreaterThan(0)
        expect(log.entries.some((e) => e.text.includes('fixture-console-error'))).toBe(true)
        const net = browser.network({ failedOnly: true })
        expect(net.entries.some((e) => e.url.endsWith('/missing') && e.status === 404)).toBe(true)
        const shot = await browser.screenshot()
        expect(existsSync(shot.path)).toBe(true)
        expect(statSync(shot.path).size).toBeGreaterThan(1000)
        expect(shot.width).toBe(1280)
      }, 60_000)

      it('runs the server inside the containment: no secret of the environment, no write outside', async () => {
        const browser = apps.session(owner.key)
        await browser.navigate(apps.resolveInApp(owner.key, '/whoami') as string)
        const text = (await browser.snapshot()).text
        expect(text).toContain('DENIED')
        expect(text).not.toContain('fixture-secret-key')
        expect(existsSync(join(SCRATCH, `outside-${profile}.txt`))).toBe(false)
        if (profile === 'ISOLATED') expect(text.toLowerCase()).toContain((account as { account: string }).account.toLowerCase())
      }, 60_000)

      it('stops everything it started and forgets the endpoint', async () => {
        const endpoint = apps.registry().find((e) => e.projectId === owner.projectId)
        expect(await apps.stop(owner.key)).toBe(true)
        expect(apps.registry().filter((e) => e.projectId === owner.projectId)).toHaveLength(0)
        expect(() => apps.session(owner.key)).toThrow(AppLaunchError)
        // The server is gone with its job: the port answers nobody.
        const answered = await new Promise<boolean>((done) => {
          import('node:net').then(({ connect }) => {
            const socket = connect({ host: '127.0.0.1', port: (endpoint as { port: number }).port })
            socket.once('connect', () => {
              socket.destroy()
              done(true)
            })
            socket.once('error', () => done(false))
          })
        })
        expect(answered).toBe(false)
        expect(apps.status(owner.key)?.state).toBe('stopped')
      }, 60_000)
    })
  }

  it('does not start an application of a project that has no containment, or whose profile is not available', async () => {
    const owner = { ...project('RESTRICTED'), projectId: 'app-web-STANDARD', key: 'run-1:standard' }
    await expect(apps.launch(owner)).rejects.toThrow(/not contained/)
    const fresh = new ApplicationUnderTestManager({
      broker: new ExecutionBroker({ launcher: new Launcher({ executable: join(SCRATCH, 'native', 'nexus-launch.exe'), specDir: join(SCRATCH, 'specs2') }), sandboxDir: join(SCRATCH, 'sandbox2'), account: () => null, baseEnv: () => process.env }),
      browser: provider,
      profileFor: () => 'RESTRICTED',
      artifactsDir: join(SCRATCH, 'artifacts2'),
    })
    await expect(fresh.launch({ ...owner, key: 'run-1:unverified' })).rejects.toThrow(/not available/)
  }, 60_000)

  it('does not adopt a server that was already listening', async () => {
    const owner = project('RESTRICTED')
    await expect(apps.launch({ ...owner, key: 'run-1:adopt' }, { type: 'web', launchCommand: 'node server.cjs', cwd: '.', ready: { kind: 'port', port: otherPort }, startTimeoutSeconds: 10, env: {} })).rejects.toThrow(/already listens/)
  }, 30_000)
})
