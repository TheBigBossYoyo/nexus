import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Notification, powerSaveBlocker, safeStorage, shell } from 'electron'
import { errorMessage } from '@shared/result'
import type { UiRequest, UiResponse } from '@shared/runtime-protocol'
import { startRuntimeCore, type RuntimeCore } from './runtime/core'
import { RuntimeTray } from './tray'

const require = createRequire(import.meta.url)

/** The argument that makes this executable the runtime instead of the window. */
export const RUNTIME_FLAG = '--nexus-runtime'

/** The SDK does not export its package.json, so read it next to the resolved entry point. */
export function readSdkVersion(): string {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Signs the overnight authorization and policy with a key that only this process holds. The key is kept
 * on disk encrypted for the Windows user (DPAPI) so a quick restart of the runtime can still verify a running
 * overnight record; when that is not possible the key lives in memory and a restart simply ends the
 * power authorization. A key file this process cannot decrypt (written by NEXUS 0.6 under another profile
 * directory) is replaced: the authorization it sealed ends, which is the safe direction.
 */
function createSealer(dataDir: string): { sign(payload: string): string } {
  const file = join(dataDir, 'overnight.key')
  let key: Buffer | null = null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      if (existsSync(file)) {
        try {
          key = Buffer.from(safeStorage.decryptString(readFileSync(file)), 'base64')
        } catch {
          key = null
        }
      }
      if (!key || key.length !== 32) {
        key = randomBytes(32)
        writeFileSync(file, safeStorage.encryptString(key.toString('base64')))
      }
    }
  } catch (e) {
    console.error(`[nexus] overnight key: ${errorMessage(e)}`)
    key = null
  }
  const secret = key ?? randomBytes(32)
  return { sign: (payload) => createHmac('sha256', secret).update(payload).digest('base64') }
}

/**
 * The runtime has no console anyone reads: what it would print goes to `<data>/runtime/runtime.log` as well.
 * One earlier file is kept. Lines are what the modules already log; they carry no prompt text and no secrets.
 */
function logToFile(dataDir: string): void {
  const dir = join(dataDir, 'runtime')
  const file = join(dir, 'runtime.log')
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`)
  } catch {
    return
  }
  let written = 0
  const write = (level: string, args: unknown[]): void => {
    try {
      // Bounded while running too: a long-lived runtime starts a new file every 5 MB and keeps one earlier file.
      if (written > 5 * 1024 * 1024) {
        renameSync(file, `${file}.1`)
        written = 0
      }
      const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')
      written += line.length + 32
      appendFileSync(file, `${new Date().toISOString()} ${level} ${line.slice(0, 4000)}\n`)
    } catch {
      // Logging must never be the reason the runtime fails.
    }
  }
  const error = console.error.bind(console)
  const log = console.log.bind(console)
  console.error = (...args: unknown[]) => {
    write('E', args)
    error(...args)
  }
  console.log = (...args: unknown[]) => {
    write('I', args)
    log(...args)
  }
  process.on('uncaughtException', (e) => {
    write('E', ['uncaught exception', e])
  })
  process.on('unhandledRejection', (e) => {
    write('E', ['unhandled rejection', e])
  })
}

/**
 * The owner of the runtime's own dialogs: a window that is never shown and stays above the others, so a
 * confirmation asked by this background process appears in front of whatever the user is looking at instead of
 * behind it.
 */
let dialogOwner: BrowserWindow | null = null
function ownerWindow(): BrowserWindow {
  if (!dialogOwner || dialogOwner.isDestroyed()) {
    dialogOwner = new BrowserWindow({ width: 1, height: 1, center: true, show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    dialogOwner.setAlwaysOnTop(true, 'screen-saver')
  }
  return dialogOwner
}

/**
 * A question asked by the runtime itself. Every confirmation is asked here (see `ask` in the runtime core), and
 * so is anything asked while no window is connected (a click in the tray).
 */
async function askNatively(request: UiRequest, dataDir: string): Promise<UiResponse> {
  if (request.kind === 'confirm') {
    const options = { type: request.level, title: request.title, message: request.message, detail: request.detail, buttons: request.buttons, defaultId: request.defaultId, cancelId: request.cancelId, noLink: true }
    const { response } = await dialog.showMessageBox(ownerWindow(), options)
    return { response }
  }
  if (request.kind === 'pickDirectory') {
    const result = await dialog.showOpenDialog({ title: request.title, properties: ['openDirectory'] })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  }
  await shell.openPath(dataDir)
  return { done: true }
}

/**
 * The runtime role of the NEXUS executable: an Electron process without a window. It hosts the runtime core
 * and gives it what only the desktop session can: the tray icon, native notifications, the user-bound key
 * store and the power-save blocker.
 */
export async function runRuntime(): Promise<void> {
  // The data directory is the window's; this process keeps its own Chromium profile beside it so the two
  // processes never contend for one profile.
  const dataDir = process.env['NEXUS_DATA_DIR'] || app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  logToFile(dataDir)
  app.setPath('userData', join(dataDir, 'runtime-profile'))
  app.disableHardwareAcceleration()
  // One runtime per data directory: the lock is keyed by the profile directory set above.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  await app.whenReady()
  console.log(`[nexus] runtime ${app.getVersion()} starting, pid ${process.pid}`)
  app.setAppUserModelId('dev.nexus.controlplane')

  let core: RuntimeCore | null = null
  let tray: RuntimeTray | null = null
  let blocker: number | null = null
  let exiting = false

  const launchDesktop = (): void => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DATA_DIR: dataDir }
    delete env['ELECTRON_RUN_AS_NODE']
    const child = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { detached: true, stdio: 'ignore', env })
    child.on('error', (e) => console.error(`[nexus] could not open the window: ${errorMessage(e)}`))
    child.unref()
  }

  core = await startRuntimeCore({
    dataDir,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    // An installed NEXUS protects the user's credential stores for enrolled projects. A development run does when asked.
    protectUserStores: app.isPackaged || process.env['NEXUS_PROTECT_USER_STORES'] === '1',
    sandboxSetupDir: app.isPackaged ? join(process.resourcesPath, 'sandbox-setup') : join(app.getAppPath(), 'native', 'sandbox-setup'),
    launcherPath: app.isPackaged ? join(process.resourcesPath, 'bin', 'nexus-launch.exe') : join(app.getAppPath(), 'out', 'native', 'nexus-launch.exe'),
    casesDir: app.isPackaged ? join(process.resourcesPath, 'arena', 'cases') : join(app.getAppPath(), 'arena', 'cases'),
    tempDir: app.getPath('temp'),
    sdkVersion: readSdkVersion(),
    env: process.env,
    // Workers are this same executable run as plain Node, so a packaged app needs no second binary.
    worker: { entry: join(import.meta.dirname, 'worker.js'), execPath: process.execPath },
    createSealer,
    protectedStorage: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    openBrowser: async (url) => {
      const target = new URL(url)
      if (!(
        (target.origin === 'https://auth.openai.com' &&
          target.pathname === '/api/accounts/authorize') ||
        url === 'https://chatgpt.com/settings/usage'
      ))
        throw new Error('Unsupported provider browser destination')
      await shell.openExternal(url)
    },
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
    },
    setKeepAwake: (on) => {
      if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!on && blocker !== null) {
        if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
        blocker = null
      }
    },
    ask: (request) => askNatively(request, dataDir),
    launchDesktop,
    onStateChange: () => tray?.refresh(),
    exit: (code) => {
      exiting = true
      tray?.destroy()
      app.exit(code)
    },
  })

  // Automated runs keep everything off the screen, the tray icon included.
  if (process.env['NEXUS_WINDOW_OFFSCREEN'] !== '1') {
    const running = core
    tray = new RuntimeTray(
      () => running.tray(),
      (action, runId) => running.trayAction(action, runId),
    )
    tray.refresh()
  }

  // Signing out of Windows or an operating-system request to quit: stop cleanly, without a question.
  app.on('before-quit', (event) => {
    if (exiting) return
    event.preventDefault()
    void core?.shutdown()
  })
  // The runtime ends through Electron's own shutdown and is never cut short: that shutdown is when Chromium saves
  // the key that protects the overnight authorization (safeStorage). A runtime ended before it cannot verify the
  // authorization after a restart, and an interrupted overnight run then takes no power action. (The window's
  // process does end itself at `quit`, see desktop.ts; it stores nothing.) Known consequence: a runtime that
  // started a window from the tray is, once stopped, not reaped by Windows until that window is closed. It holds
  // nothing by then: its database is closed and its endpoint removed.
  // The runtime has no window of its own; the hidden owner of its dialogs must not end it when it goes.
  app.on('window-all-closed', () => undefined)
  // A second start of the runtime for the same data directory means a window is looking for it; nothing to do.
  app.on('second-instance', () => undefined)
}
