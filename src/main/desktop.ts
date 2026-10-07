import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { PushMessage } from '@shared/events'
import { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL } from '@shared/ipc'
import type { OvernightStatus } from '@shared/overnight'
import { errorMessage } from '@shared/result'
import type { UiRequest, UiResponse } from '@shared/runtime-protocol'
import { CLOSE_DIALOG, closeBehaviour, type CloseChoice } from './modules/overnight/tray-model'
import { RuntimeClient } from './modules/runtime/client'
import { RUNTIME_FLAG } from './runtime-electron'

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const rendererFile = join(import.meta.dirname, '../renderer/index.html')

/**
 * Automated runs (end-to-end tests, acceptance scripts) keep the window off-screen and never take the
 * focus, so they do not interrupt whoever is using the machine. The window is otherwise a normal one.
 */
const offscreen = process.env['NEXUS_WINDOW_OFFSCREEN'] === '1'
function reveal(window: BrowserWindow): void {
  if (offscreen) window.showInactive()
  else {
    window.show()
    window.focus()
  }
}

/** Decides what a click on the window's close button does. True means the close was handled. */
let onWindowClose: ((window: BrowserWindow) => boolean) | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    ...(offscreen ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    backgroundColor: '#f6f7f9',
    title: 'NEXUS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => (offscreen ? window.showInactive() : window.show()))
  window.on('close', (event) => {
    if (onWindowClose?.(window)) event.preventDefault()
  })

  // Agent output can contain links; never let them navigate the app window or open new ones.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(rendererFile)
  return window
}

/** Only our own renderer document may call the IPC surface. */
function isTrustedSender(url: string | undefined): boolean {
  if (!url) return false
  if (devUrl) return url.startsWith(devUrl)
  return url.startsWith(pathToFileURL(rendererFile).toString())
}

/**
 * The desktop role of the NEXUS executable: the window and nothing else. It owns no database, no scheduler and
 * no agent session; it is a client of the runtime process, which it starts when none is running. Closing the
 * window, or losing this whole process, stops no work.
 */
export async function runDesktop(): Promise<void> {
  // Tests point NEXUS at a throwaway data directory (database, worktrees and Chromium profile).
  const dataOverride = process.env['NEXUS_DATA_DIR']
  if (dataOverride) app.setPath('userData', dataOverride)

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  const showWindow = (): void => {
    const window = BrowserWindow.getAllWindows()[0] ?? createMainWindow()
    if (window.isMinimized()) window.restore()
    reveal(window)
  }
  // A second start of NEXUS, by the user or by the runtime's tray: bring the window forward.
  app.on('second-instance', () => {
    if (app.isReady()) showWindow()
  })

  await app.whenReady()
  const dataDir = app.getPath('userData')

  const toWindows = (message: PushMessage): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_PUSH_CHANNEL, message)
    }
  }

  let lastSpawnAt = 0
  const ensureRuntime = async (): Promise<void> => {
    // The runtime takes a lock per data directory, so a second start ends by itself; still, do not start a
    // process on every reconnect attempt while one is coming up.
    if (Date.now() - lastSpawnAt < 15_000) return
    lastSpawnAt = Date.now()
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DATA_DIR: dataDir }
    delete env['ELECTRON_RUN_AS_NODE']
    delete env['ELECTRON_RENDERER_URL']
    await new Promise<void>((resolve, reject) => {
      // Detached: the runtime is not a child that ends with this window.
      const child = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), RUNTIME_FLAG], { detached: true, stdio: 'ignore', windowsHide: true, env })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  const showUi = async (request: UiRequest): Promise<UiResponse> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (request.kind === 'confirm') {
      const options = { type: request.level, title: request.title, message: request.message, detail: request.detail, buttons: request.buttons, defaultId: request.defaultId, cancelId: request.cancelId, noLink: true }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      return { response }
    }
    if (request.kind === 'pickDirectory') {
      const options = { title: request.title, properties: ['openDirectory' as const] }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    }
    await shell.openPath(dataDir)
    return { done: true }
  }

  // What the close button needs to know without waiting: whether an overnight mission is live.
  let overnightLive: OvernightStatus[] = []
  let hiddenToTray = false
  let replacedBoot: string | null = null
  const refreshOvernight = async (): Promise<void> => {
    const result = await client.invoke('overnight.active', {})
    overnightLive = result.ok ? (result.value as OvernightStatus[]) : []
    // Nothing keeps the window hidden once the mission is over: bring back the window that was hidden to the
    // tray (and only that; a window the user minimized is left alone).
    if (hiddenToTray && overnightLive.length === 0 && client.isConnected()) {
      hiddenToTray = false
      showWindow()
    }
  }

  const client: RuntimeClient = new RuntimeClient({
    dataDir,
    kind: 'desktop',
    ensureRuntime,
    onUiRequest: showUi,
    onPush: (raw) => {
      const message = raw as PushMessage
      if (message.kind === 'desktop') showWindow()
      if (message.kind === 'overnight') void refreshOvernight()
      toWindows(message)
    },
    onState: (state) => {
      toWindows({ kind: 'connection', state })
      if (state.phase !== 'READY' && state.phase !== 'RECOVERING') return
      void refreshOvernight()
      // A runtime left running by another version of NEXUS is asked to stop; this window then starts its own.
      if (state.runtime && state.runtime.version !== app.getVersion() && replacedBoot !== state.runtime.bootId) {
        replacedBoot = state.runtime.bootId
        void client.invoke('runtime.stop', {}).then((result) => {
          if (result.ok && (result.value as { stopping: boolean }).stopping) client.allowRespawn()
        })
      }
    },
    logger: (line) => console.error(`[nexus] ${line}`),
  })
  // End-to-end tests read what the tray shows through this process.
  Object.defineProperty(globalThis, '__nexusTrayModel', {
    value: async () => {
      const result = await client.invoke('runtime.tray', {})
      return result.ok ? (result.value as { overnight: unknown }).overnight : null
    },
    configurable: true,
  })

  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return { ok: false, error: { code: 'invalid_input', message: 'Untrusted sender' } }
    }
    if (typeof channel !== 'string') return { ok: false, error: { code: 'invalid_input', message: 'Unknown IPC channel' } }
    // The window's own connection: answered here, because it must work exactly when the runtime does not.
    if (channel === 'desktop.connection') return { ok: true, value: client.state() }
    if (channel === 'desktop.reconnect') {
      client.retry()
      return { ok: true, value: client.state() }
    }
    // Everything else is the runtime's to validate and answer.
    return client.invoke(channel, input)
  })

  // Quitting this process (not only closing its window) asks nothing: the runtime and its work are not affected.
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })

  onWindowClose = (window) => {
    if (quitting) return false
    if (closeBehaviour(overnightLive.length > 0 && client.isConnected()) === 'close') return false
    void dialog
      .showMessageBox(window, {
        type: 'question',
        title: 'NEXUS',
        message: CLOSE_DIALOG.message,
        detail: CLOSE_DIALOG.detail,
        buttons: [...CLOSE_DIALOG.buttons],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(async ({ response }) => {
        const choice: CloseChoice = CLOSE_DIALOG.choices[response] ?? 'return'
        if (choice === 'hide') {
          hiddenToTray = true
          window.hide()
        } else if (choice === 'cancel') {
          for (const status of overnightLive) await client.invoke('overnight.cancelMission', { runId: status.runId })
          await refreshOvernight()
          if (overnightLive.length === 0) window.close()
        }
      })
      .catch((e: unknown) => console.error(`[nexus] close dialog: ${errorMessage(e)}`))
    return true
  }

  // Closing the last window ends this process. The runtime goes on by itself; its tray icon says so.
  app.on('window-all-closed', () => {
    client.close()
    app.quit()
  })
  // Measured on Windows: after the whole quit sequence has run (`before-quit`, `will-quit`, `quit`, Node's own
  // `exit`), this process is not reaped for as long as the runtime it started is alive; it ends the moment the
  // runtime does. Every close of the window would leave one more finished process behind. This process owns
  // nothing durable (no database, no session; the runtime has it all), so once Electron has said `quit` it ends
  // itself outright.
  app.on('quit', () => {
    try {
      process.kill(process.pid)
    } catch {
      // Already going.
    }
  })

  client.start()
  createMainWindow()
}
