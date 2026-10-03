import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { PushMessage } from '@shared/events'
import { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL, type AppInfo } from '@shared/ipc'
import { errorMessage } from '@shared/result'
import { ClaudeSdkRuntime } from './modules/agent-runtime/claude-sdk-runtime'
import { createDemoScript } from './modules/agent-runtime/demo-script'
import { FakeAgentRuntime } from './modules/agent-runtime/fake-runtime'
import { resolveClaudeExecutable } from './modules/agent-runtime/resolve-executable'
import type { AgentRuntime } from './modules/agent-runtime/types'
import { EventBus } from './modules/events'
import { GitService, WorktreeManager } from './modules/git'
import { createIpcHandlers, dispatchIpc } from './modules/ipc/handlers'
import { Orchestrator } from './modules/orchestrator'
import { createRepositories, openDatabase } from './modules/persistence'

const require = createRequire(import.meta.url)
const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const rendererFile = join(import.meta.dirname, '../renderer/index.html')

// Tests point NEXUS at a throwaway data directory (database, worktrees and Chromium profile).
const dataOverride = process.env['NEXUS_DATA_DIR']
if (dataOverride) app.setPath('userData', dataOverride)

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
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

  window.once('ready-to-show', () => window.show())

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

/** The SDK does not export its package.json, so read it next to the resolved entry point. */
function readSdkVersion(): string {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Only our own renderer document may call the IPC surface. */
function isTrustedSender(url: string | undefined): boolean {
  if (!url) return false
  if (devUrl) return url.startsWith(devUrl)
  return url.startsWith(pathToFileURL(rendererFile).toString())
}

async function bootstrap(): Promise<void> {
  const dataDir = app.getPath('userData')
  const worktreesDir = join(dataDir, 'worktrees')
  const dbPath = join(dataDir, 'nexus.db')
  mkdirSync(worktreesDir, { recursive: true })

  const db = openDatabase(dbPath)
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const git = new GitService()
  const settings = repos.settings.get()

  const push = (message: PushMessage): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_PUSH_CHANNEL, message)
    }
  }
  bus.subscribe((event) => push({ kind: 'event', event }))

  // The scripted runtime exists for UI tests only and cannot be enabled in a packaged build.
  const useFake = !app.isPackaged && process.env['NEXUS_FAKE_RUNTIME'] === '1'
  const runtime: AgentRuntime = useFake
    ? new FakeAgentRuntime({ script: createDemoScript() })
    : new ClaudeSdkRuntime({
        executablePath: settings.claude.executablePath || undefined,
        resolveExecutable: () => resolveClaudeExecutable({ resourcesPath: process.resourcesPath }),
        debug: settings.advanced.debugSdk,
        logger: settings.advanced.debugSdk ? (line) => console.error(`[claude] ${line}`) : undefined,
      })

  const orchestrator = new Orchestrator({
    repos,
    bus,
    runtime,
    git,
    worktrees: new WorktreeManager(git, worktreesDir),
    push,
    logger: (line) => console.error(`[nexus] ${line}`),
  })
  // Runs that were active when the app last stopped are paused and offered for recovery in the UI.
  orchestrator.recoverOnStartup()

  const sdkVersion = readSdkVersion()
  const appInfo = async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    dataDir,
    dbPath,
    worktreesDir,
    platform: `${process.platform} ${process.arch}`,
    gitVersion: await git.version().catch(() => null),
    sdkVersion,
    isPackaged: app.isPackaged,
  })

  const handlers = createIpcHandlers({
    repos,
    git,
    runtime,
    orchestrator,
    appInfo,
    push,
    pickDirectory: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { title: 'Open Project', properties: ['openDirectory' as const] }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openDataDir: async () => {
      await shell.openPath(dataDir)
    },
  })

  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return { ok: false, error: { code: 'invalid_input', message: 'Untrusted sender' } }
    }
    return dispatchIpc(handlers, channel, input)
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    // Stop agent processes and flush the database before the process exits.
    event.preventDefault()
    quitting = true
    void orchestrator
      .shutdown()
      .catch((e: unknown) => console.error(`[nexus] shutdown: ${errorMessage(e)}`))
      .finally(() => {
        if (db.open) db.close()
        app.quit()
      })
  })

  createMainWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(() =>
    bootstrap().catch((e: unknown) => {
      // A database or wiring failure at startup is terminal; say why instead of showing a blank window.
      console.error(`[nexus] startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      dialog.showErrorBox('NEXUS failed to start', errorMessage(e))
      app.exit(1)
    }),
  )

  app.on('window-all-closed', () => {
    app.quit()
  })
}
