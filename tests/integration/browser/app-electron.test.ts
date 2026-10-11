import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplicationUnderTestManager, type AppOwner } from '@main/modules/browser/app-manager'
import { PlaywrightDirectProvider } from '@main/modules/browser/provider'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher, type ContainmentProfile } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// An Electron application under test, for real: a small application is started from an Electron binary inside
// the containment, on a desktop the launcher makes for it. Nothing appears on the user's screen: the desktop is
// not the one that is displayed, and if it cannot be made the launcher starts nothing. NEXUS reads and operates
// the window through the application's debugging endpoint.

const WINDOWS = process.platform === 'win32'
const ELECTRON = resolve('node_modules', 'electron', 'dist', 'electron.exe')
const d = WINDOWS && existsSync(ELECTRON) ? describe : describe.skip
const account = WINDOWS ? readSandboxAccount() : null
const SCRATCH = resolve('test-results', 'app-electron-tests')
const PROFILES: ContainmentProfile[] = account ? ['RESTRICTED', 'ISOLATED'] : ['RESTRICTED']

const MAIN = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'); const path = require('path');
app.whenReady().then(() => {
  ipcMain.handle('probe', () => {
    let outside = 'DENIED';
    try { fs.writeFileSync(process.env.FIXTURE_OUTSIDE, 'x'); outside = 'WROTE'; } catch (e) {}
    return { outside, key: process.env.ANTHROPIC_API_KEY || 'none', userData: app.getPath('userData') };
  });
  const win = new BrowserWindow({ width: 900, height: 600, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
`
const PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixture', { probe: () => ipcRenderer.invoke('probe') });
`
const INDEX = `<!doctype html><html><head><title>Fixture notes</title></head><body>
<h1>Notes</h1>
<label>Note <input id="note"></label>
<button id="save">Save note</button>
<ul id="notes" aria-label="notes"></ul>
<p id="probe" role="status">waiting</p>
<script>
save.onclick = () => { const li = document.createElement('li'); li.textContent = note.value; notes.appendChild(li); note.value = ''; };
window.fixture.probe().then((r) => { probe.textContent = 'outside:' + r.outside + ' key:' + r.key + ' data:' + r.userData; });
console.error('fixture-electron-error');
</script></body></html>`

let broker: ExecutionBroker
let apps: ApplicationUnderTestManager
const binaries = new Map<string, string>()

function project(profile: ContainmentProfile): AppOwner {
  const base = profile === 'ISOLATED' && account ? join(account.root, 'worktrees', 'app-electron-tests') : join(SCRATCH, 'worktrees')
  const worktree = join(base, `notes-${profile.toLowerCase()}`)
  mkdirSync(join(worktree, '.nexus'), { recursive: true })
  writeFileSync(join(worktree, 'main.js'), MAIN)
  writeFileSync(join(worktree, 'preload.js'), PRELOAD)
  writeFileSync(join(worktree, 'index.html'), INDEX)
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture-notes', private: true, main: 'main.js', devDependencies: { electron: '*' } }))
  writeFileSync(join(worktree, '.nexus', 'app.json'), JSON.stringify({ type: 'electron', startTimeoutSeconds: 90, env: { FIXTURE_OUTSIDE: join(SCRATCH, `outside-${profile}.txt`) } }))
  // The sandbox account reads nothing in the user's profile, so its Electron is a copy in its own root, as the
  // dependencies of a real project would be, installed in a worktree there.
  if (profile === 'ISOLATED' && account) {
    const copy = join(account.root, 'worktrees', 'app-electron-tests', 'electron-dist')
    if (!existsSync(join(copy, 'electron.exe'))) cpSync(resolve('node_modules', 'electron', 'dist'), copy, { recursive: true })
    binaries.set(worktree, join(copy, 'electron.exe'))
  } else binaries.set(worktree, ELECTRON)
  return { projectId: `app-electron-${profile}`, runId: 'run-1', taskId: `task-${profile}`, key: `run-1:task-${profile}`, worktree }
}

d('an Electron application under test, inside the containment, on a desktop of its own', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => account, baseEnv: () => ({ ...process.env, ANTHROPIC_API_KEY: 'fixture-secret-key' }), limits: { maxProcesses: 64 } })
    for (const profile of PROFILES) await broker.verify(profile)
    apps = new ApplicationUnderTestManager({
      broker,
      browser: new PlaywrightDirectProvider(),
      profileFor: (projectId) => (projectId.endsWith('ISOLATED') ? 'ISOLATED' : 'RESTRICTED'),
      artifactsDir: join(SCRATCH, 'artifacts'),
      electronBinary: (cwd) => binaries.get(cwd),
    })
    void homedir
  }, 240_000)

  afterAll(async () => {
    await apps?.stopAll()
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 })
    if (account) {
      rmSync(join(account.root, 'worktrees', 'app-electron-tests'), { recursive: true, force: true, maxRetries: 30, retryDelay: 300 })
      broker.sweep()
    }
  })

  for (const profile of PROFILES) {
    describe(profile, () => {
      let owner: AppOwner

      it('starts the application contained and reads its window', async () => {
        owner = project(profile)
        let status
        try {
          status = await apps.launch(owner)
        } catch (e) {
          throw new Error(`${(e as Error).message}\n${((e as { output?: string[] }).output ?? []).join('\n')}`, { cause: e })
        }
        expect(status).toMatchObject({ type: 'electron', state: 'running', profile })
        const snapshot = await apps.session(owner.key).snapshot()
        expect(snapshot.title).toBe('Fixture notes')
        expect(snapshot.text).toContain('heading "Notes"')
        expect(snapshot.text).toMatch(/button "Save note" \[ref=\w+\]/)
      }, 180_000)

      it('is operated by refs: a note is typed and saved', async () => {
        const browser = apps.session(owner.key)
        const field = /\[ref=(\w+)\]/.exec((await browser.find('textbox')).matches[0] ?? '')?.[1]
        const button = /\[ref=(\w+)\]/.exec((await browser.find('Save note')).matches[0] ?? '')?.[1]
        await browser.fill(field as string, 'remember the milk')
        await browser.click(button as string)
        await browser.wait({ text: 'remember the milk' })
        expect((await browser.snapshot()).text).toContain('remember the milk')
      }, 60_000)

      it('runs inside the containment: no secret, no write outside, its data in the session', async () => {
        const browser = apps.session(owner.key)
        await browser.wait({ text: 'outside:' })
        const probe = (await browser.find('outside:')).matches.join(' ')
        expect(probe).toContain('outside:DENIED')
        expect(probe).toContain('key:none')
        expect(probe).toContain('electron-user-data')
        expect(existsSync(join(SCRATCH, `outside-${profile}.txt`))).toBe(false)
      }, 60_000)

      it('gives its console and a screenshot of a window that is on no screen', async () => {
        const browser = apps.session(owner.key)
        expect(browser.kind).toBe('electron')
        await browser.reload()
        await browser.wait({ text: 'outside:' })
        expect(browser.console({ level: 'error' }).entries.some((e) => e.text.includes('fixture-electron-error'))).toBe(true)
        const shot = await browser.screenshot()
        expect(statSync(shot.path).size).toBeGreaterThan(1000)
        expect((await browser.windows()).length).toBe(1)
      }, 60_000)

      it('stops with everything below it', async () => {
        expect(await apps.stop(owner.key)).toBe(true)
        expect(apps.status(owner.key)?.state).toBe('stopped')
      }, 60_000)
    })
  }
})
