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
import { OvernightSupervisor } from './modules/overnight'
import { CLOSE_DIALOG, closeBehaviour, type CloseChoice } from './modules/overnight/tray-model'
import { createRepositories, openDatabase } from './modules/persistence'
import { FakePowerController, WindowsPowerController, type PowerController } from './modules/power'
import { OvernightTray } from './tray'

const require = createRequire(import.meta.url)
const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const rendererFile = join(import.meta.dirname, '../renderer/index.html')

// Tests point NEXUS at a throwaway data directory (database, worktrees and Chromium profile).
const dataOverride = process.env['NEXUS_DATA_DIR']
if (dataOverride) app.setPath('userData', dataOverride)

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

/** Decides what a click on the window's close button does; set once the supervisor exists. */
let onWindowClose: ((window: BrowserWindow) => boolean) | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    ...(offscreen ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
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

  window.once('ready-to-show', () => (offscreen ? window.showInactive() : window.show()))
  window.on('close', (event) => {
    // True means the close was handled (hidden to the tray, or the user chose to stay).
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

let quitting = false
/** True while an overnight mission keeps the app alive without a window. */
let keepAliveWithoutWindow: () => boolean = () => false
/** What the tray currently shows; end-to-end tests read it through the main process. */
let trayModel: () => unknown = () => null
Object.defineProperty(globalThis, '__nexusTrayModel', { value: () => trayModel(), configurable: true })

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

  // Overnight Mode. The power controller is created here and handed to the supervisor only: no IPC
  // handler, agent tool or MCP server ever holds it. Tests (and any run on the scripted runtime) get
  // the fake controller, which cannot be selected in a packaged build.
  const useFakePower = !app.isPackaged && (useFake || process.env['NEXUS_FAKE_POWER'] === '1')
  let power: PowerController | null = null
  try {
    power = useFakePower ? new FakePowerController({ logFile: join(dataDir, 'fake-power.log') }) : new WindowsPowerController()
  } catch (e) {
    console.error(`[nexus] power control unavailable: ${errorMessage(e)}`)
  }
  const testTick = !app.isPackaged ? Number(process.env['NEXUS_OVERNIGHT_TICK_MS'] ?? '') : NaN
  let tray: OvernightTray | null = null
  const overnight = power
    ? new OvernightSupervisor({
        repos,
        bus,
        orchestrator,
        power,
        git,
        push: (message) => {
          push(message)
          tray?.refresh()
        },
        flush: () => void db.pragma('wal_checkpoint(TRUNCATE)'),
        reportsDir: join(dataDir, 'reports'),
        ...(Number.isFinite(testTick) && testTick >= 100 ? { tickIntervalMs: testTick } : {}),
        logger: (line) => console.error(`[nexus] ${line}`),
      })
    : undefined

  const showWindow = (): void => {
    const window = BrowserWindow.getAllWindows()[0] ?? createMainWindow()
    if (window.isMinimized()) window.restore()
    reveal(window)
  }
  if (overnight) {
    const supervisor = overnight
    const current = (): ReturnType<OvernightSupervisor['active']>[number] | null => supervisor.active()[0] ?? null
    tray = new OvernightTray(
      () => {
        const status = current()
        const run = status ? repos.runs.get(status.runId) : null
        return {
          overnight: status,
          projectName: (run && repos.projects.get(run.projectId)?.name) || 'project',
          runState: run?.state ?? null,
          activeAgents: status ? repos.agents.listActive(status.runId).length : 0,
          time: (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      },
      (action, runId) => {
        const report = (e: unknown): void => console.error(`[nexus] tray ${action}: ${errorMessage(e)}`)
        if (action === 'open') showWindow()
        else if (action === 'pause') void orchestrator.pauseRun(runId).catch(report)
        else if (action === 'resume') void orchestrator.resumeRun(runId).catch(report)
        else if (action === 'cancelPower') void supervisor.cancelPower(runId).catch(report)
        else void supervisor.cancelMission(runId).catch(report)
      },
    )
    const overnightTray = tray
    trayModel = () => overnightTray.model()
    let refreshQueued = false
    bus.subscribe(() => {
      // Agent counts and run state change with ordinary events; one refresh per second is plenty.
      if (refreshQueued) return
      refreshQueued = true
      setTimeout(() => {
        refreshQueued = false
        if (quitting) return
        overnightTray.refresh()
        // Nothing keeps the app in the background once the mission is over: bring the window back.
        if (!supervisor.hasActive() && BrowserWindow.getAllWindows().every((w) => !w.isVisible())) showWindow()
      }, 1000).unref()
    })

    onWindowClose = (window) => {
      if (quitting || closeBehaviour(supervisor.hasActive()) === 'close') return false
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
            window.hide()
            overnightTray.refresh()
          } else if (choice === 'cancel') {
            for (const status of supervisor.active()) await supervisor.cancelMission(status.runId)
            overnightTray.refresh()
            if (!supervisor.hasActive()) window.close()
          }
        })
        .catch((e: unknown) => console.error(`[nexus] close dialog: ${errorMessage(e)}`))
      return true
    }
    keepAliveWithoutWindow = () => supervisor.hasActive()
    // An overnight run that was active when NEXUS stopped resumes without anyone clicking; the Windows
    // failsafe scheduled before the restart stays as it is.
    void supervisor
      .recover()
      .then(() => overnightTray.refresh())
      .catch((e: unknown) => console.error(`[nexus] overnight recovery: ${errorMessage(e)}`))
  }

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
    ...(overnight ? { overnight } : {}),
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

  app.on('before-quit', (event) => {
    if (quitting) return
    // Stop agent processes and flush the database before the process exits. An armed overnight
    // failsafe is left alone: it belongs to Windows and outlives this process on purpose.
    event.preventDefault()
    quitting = true
    overnight?.dispose()
    tray?.destroy()
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
      // The window may be hidden in the tray during an overnight mission.
      reveal(window)
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
    if (keepAliveWithoutWindow()) return
    app.quit()
  })
}
