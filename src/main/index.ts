import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage, shell } from 'electron'
import type { PushMessage } from '@shared/events'
import { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL, type AppInfo } from '@shared/ipc'
import { errorMessage } from '@shared/result'
import { ArenaService } from './modules/arena'
import { ClaudeSdkRuntime } from './modules/agent-runtime/claude-sdk-runtime'
import { createDemoScript } from './modules/agent-runtime/demo-script'
import { FakeAgentRuntime } from './modules/agent-runtime/fake-runtime'
import { resolveClaudeExecutable } from './modules/agent-runtime/resolve-executable'
import type { AgentRuntime } from './modules/agent-runtime/types'
import { EventBus } from './modules/events'
import { GitService, WorktreeManager } from './modules/git'
import { createIpcHandlers, dispatchIpc } from './modules/ipc/handlers'
import { ProjectService } from './modules/ipc/services'
import { createV3Handlers } from './modules/ipc/v3-handlers'
import { createV4Handlers } from './modules/ipc/v4-handlers'
import { createV5Handlers } from './modules/ipc/v5-handlers'
import { createV6Handlers } from './modules/ipc/v6-handlers'
import { createV7Handlers } from './modules/ipc/v7-handlers'
import { activeAgentsOf, ControlPlane, createWorkloadAdapters, unownedActiveWorkloads } from './modules/control-plane'
import { ClaudeAgentRuntimeProvider, CodexRuntimeProvider, FakeRuntimeProvider, GeminiRuntimeProvider, ProviderService } from './modules/providers'
import { Orchestrator } from './modules/orchestrator'
import { ArenaCampaignWorkload, OvernightSupervisor, ProgramWorkload, WorkspaceMissionWorkload } from './modules/overnight'
import { CLOSE_DIALOG, closeBehaviour, type CloseChoice } from './modules/overnight/tray-model'
import { createRepositories, openDatabase } from './modules/persistence'
import { attachOutcomeRecording, learnOnCampaignEnd, PolicyService } from './modules/policy'
import { BackgroundEngineering, ProgramEngine } from './modules/program'
import { FakePowerController, WindowsPowerController, type PowerController } from './modules/power'
import { QuotaRecoveryController, RuntimeAvailabilityProbe, UsageIntelligenceService } from './modules/usage'
import { WorkspaceEngine } from './modules/workspace'
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
  // Windows is shutting down or the user is signing out: nothing may hold that up with a question.
  window.on('session-end', () => {
    quitAllowed = true
  })
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

/**
 * Signs the overnight authorization and policy with a key that only this process holds. The key is kept
 * on disk encrypted for the Windows user (DPAPI) so a quick restart of NEXUS can still verify a running
 * overnight record; when that is not possible the key lives in memory and a restart simply ends the
 * power authorization.
 */
function createSealer(dataDir: string): { sign(payload: string): string } {
  const file = join(dataDir, 'overnight.key')
  let key: Buffer | null = null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      if (existsSync(file)) key = Buffer.from(safeStorage.decryptString(readFileSync(file)), 'base64')
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

/** Only our own renderer document may call the IPC surface. */
function isTrustedSender(url: string | undefined): boolean {
  if (!url) return false
  if (devUrl) return url.startsWith(devUrl)
  return url.startsWith(pathToFileURL(rendererFile).toString())
}

let quitting = false
/** False while a live overnight mission requires the user to confirm a quit. */
let quitAllowed = false
let confirmQuit: () => Promise<boolean> = async () => true
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
  const fakeRuntime = useFake ? new FakeAgentRuntime({ script: createDemoScript() }) : null
  // UI tests choose what the scripted runtime says about usage: `unknown` = no usage report at all (what a
  // runtime without that method looks like), a number = the plan window's reported percentage.
  const fakeUsage = process.env['NEXUS_FAKE_USAGE']
  if (fakeRuntime && fakeUsage === 'unknown') fakeRuntime.usage.set({ reportSupported: false })
  else if (fakeRuntime && fakeUsage && Number.isFinite(Number(fakeUsage))) fakeRuntime.usage.set({ utilizationPercent: Number(fakeUsage) })
  const claudeRuntime: AgentRuntime =
    fakeRuntime ??
    new ClaudeSdkRuntime({
        executablePath: settings.claude.executablePath || undefined,
        resolveExecutable: () => resolveClaudeExecutable({ resourcesPath: process.resourcesPath }),
        debug: settings.advanced.debugSdk,
        logger: settings.advanced.debugSdk ? (line) => console.error(`[claude] ${line}`) : undefined,
      })

  const logger = (line: string): void => console.error(`[nexus] ${line}`)

  // v0.6: every session passes through the provider router. Claude is the required provider; the others are
  // detected, off until the user enables them, and never needed. With the scripted runtime (UI tests) the
  // other providers are scripted too, so no test ever reaches a real provider.
  const subscriptionMode = (): boolean => repos.settings.get().claude.subscriptionMode
  const probeCwd = (): string => app.getPath('temp')
  const providers = new ProviderService({
    providers: fakeRuntime
      ? [
          new FakeRuntimeProvider('claude', fakeRuntime, { authDetail: 'Scripted runtime', health: 'healthy' }),
          new FakeRuntimeProvider('codex', new FakeAgentRuntime({ script: createDemoScript() }), process.env['NEXUS_FAKE_CODEX'] === 'auth' ? { auth: 'auth_required', health: 'unavailable' } : {}, 'scripted-codex'),
          new FakeRuntimeProvider('gemini', null, { installed: 'not_installed', version: null, auth: 'unknown', authDetail: null, supportDetail: 'The Gemini command line tool was not found on PATH.', health: 'unavailable' }),
        ]
      : [
          new ClaudeAgentRuntimeProvider({ runtime: claudeRuntime, subscriptionMode, probeCwd }),
          new CodexRuntimeProvider({ probeCwd, snapshot: (cwd) => git.workingState(cwd) }),
          new GeminiRuntimeProvider(),
        ],
    sessions: repos.providerSessions,
    settings: repos.settings,
    runOfAgent: (agentId) => repos.agents.get(agentId)?.runId ?? null,
    onChange: () => push({ kind: 'providers' }),
    logger,
  })
  repos.providerSessions.closeInterrupted(new Date().toISOString())
  void providers.refresh().catch((e: unknown) => logger(`provider detection: ${e instanceof Error ? e.message : String(e)}`))
  const runtime: AgentRuntime = providers.router

  // Usage intelligence observes what the runtime reports (limits, resets, per-session usage) and is the
  // gate every new Claude session passes. It reads nothing but the Agent SDK's own events and calls.
  const isOtherProvider = (agentId: string): boolean => {
    const provider = repos.providerSessions.latestProviderOfAgent(agentId)
    return provider !== null && provider !== 'claude'
  }
  const usage = new UsageIntelligenceService({ repos, bus, runtime, push, logger, isOtherProvider })
  const probe = new RuntimeAvailabilityProbe({ runtime, settings: () => repos.settings.get() })
  // The policy engine decides the strategy of ADAPTIVE runs from stored evidence and records every
  // mission's outcome. It never changes the active policy by itself.
  const policy = new PolicyService({
    repos,
    nexusVersion: app.getVersion(),
    usage: { status: () => usage.status(), recentLimitWithin: (ms) => usage.recentLimitWithin(ms) },
    push,
  })
  policy.ensureDefault()
  attachOutcomeRecording(bus, policy)

  const orchestrator = new Orchestrator({
    repos,
    bus,
    runtime,
    git,
    worktrees: new WorktreeManager(git, worktreesDir),
    push,
    logger,
    strategies: policy,
  })
  orchestrator.setDispatchGate(usage)
  // Runs that were active when the app last stopped are paused and offered for recovery in the UI.
  orchestrator.recoverOnStartup()

  // Quota recovery: a run paused for a usage limit is checkpointed, waited on and resumed without anyone
  // clicking. Timing overrides exist for automated tests only and cannot be set in a packaged build.
  const testNumber = (name: string): number | undefined => {
    const value = !app.isPackaged ? Number(process.env[name] ?? '') : NaN
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const usageTick = testNumber('NEXUS_USAGE_TICK_MS')
  const resumeDelay = testNumber('NEXUS_USAGE_RESUME_DELAY_S')
  const probeSeconds = testNumber('NEXUS_USAGE_PROBE_S')
  const recovery = new QuotaRecoveryController({
    repos,
    bus,
    usage,
    probe,
    orchestrator,
    push,
    isOvernightRun: (runId) => repos.overnight.getByRun(runId) !== null,
    ...(usageTick !== undefined && usageTick >= 100 ? { tickIntervalMs: usageTick } : {}),
    overrides: {
      ...(resumeDelay !== undefined ? { resumeDelaySeconds: resumeDelay } : {}),
      ...(probeSeconds !== undefined ? { probeSeconds } : {}),
    },
    logger,
  })
  recovery.recover()

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
  // Windows must not put the PC to sleep in the middle of an unattended mission.
  let awakeBlocker: number | null = null
  let keepAwake: () => void = () => undefined
  let recoverOvernight: () => void = () => undefined
  /** Pause and resume of the live overnight workload from the tray, when it is an Arena campaign. */
  let campaignControl: { pause(id: string): unknown; resume(id: string): unknown } | null = null
  let programControl: { pause(id: string): Promise<unknown>; resume(id: string): Promise<unknown> } | null = null
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
          keepAwake()
        },
        flush: () => void db.pragma('wal_checkpoint(TRUNCATE)'),
        reportsDir: join(dataDir, 'reports'),
        sealer: createSealer(dataDir),
        probe,
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
    keepAwake = () => {
      const wanted = supervisor.hasActive() && !quitting
      if (wanted && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!wanted && awakeBlocker !== null) {
        if (powerSaveBlocker.isStarted(awakeBlocker)) powerSaveBlocker.stop(awakeBlocker)
        awakeBlocker = null
      }
    }
    keepAwake()
    const current = (): ReturnType<OvernightSupervisor['active']>[number] | null => supervisor.active()[0] ?? null
    tray = new OvernightTray(
      () => {
        const status = current()
        const run = status ? repos.runs.get(status.runId) : null
        const campaign = status?.workloadType === 'arena_campaign' ? repos.arenaCampaigns.get(status.runId) : null
        const program = status?.workloadType === 'program' ? repos.programs.get(status.runId) : null
        return {
          overnight: status,
          projectName: program ? program.name : campaign ? campaign.name : (run && repos.projects.get(run.projectId)?.name) || 'project',
          runState: program ? (program.state === 'PAUSED' || program.state === 'BLOCKED' ? 'paused' : program.state) : campaign ? campaign.state : (run?.state ?? null),
          activeAgents: campaign || program ? orchestrator.activeAgentCount() : status ? repos.agents.listActive(status.runId).length : 0,
          time: (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      },
      (action, runId) => {
        const report = (e: unknown): void => console.error(`[nexus] tray ${action}: ${errorMessage(e)}`)
        if (action === 'open') showWindow()
        else if (repos.overnight.getByRun(runId)?.workloadType === 'program' && (action === 'pause' || action === 'resume')) {
          void (action === 'pause' ? programControl?.pause(runId) : programControl?.resume(runId))?.catch(report)
        } else if (repos.overnight.getByRun(runId)?.workloadType === 'arena_campaign' && (action === 'pause' || action === 'resume')) {
          try {
            if (action === 'pause') campaignControl?.pause(runId)
            else campaignControl?.resume(runId)
          } catch (e) {
            report(e)
          }
        } else if (action === 'pause') void orchestrator.pauseRun(runId).catch(report)
        else if (action === 'resume') void orchestrator.resumeRun(runId).catch(report)
        else if (action === 'cancelPower') void supervisor.cancelPower(runId).catch(report)
        else void supervisor.cancelMission(runId).catch(report)
      },
    )
    const overnightTray = tray
    trayModel = () => overnightTray.model()
    let hiddenToTray = false
    let refreshQueued = false
    bus.subscribe(() => {
      // Agent counts and run state change with ordinary events; one refresh per second is plenty.
      if (refreshQueued) return
      refreshQueued = true
      setTimeout(() => {
        refreshQueued = false
        if (quitting) return
        overnightTray.refresh()
        keepAwake()
        // Nothing keeps the app in the background once the mission is over: bring back the window that was
        // hidden to the tray (and only that; a window the user minimized is left alone).
        if (hiddenToTray && !supervisor.hasActive()) {
          hiddenToTray = false
          showWindow()
        }
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
            hiddenToTray = true
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
    // Quitting (menu, taskbar, Alt+F4 on a hidden app) during an overnight mission: the Windows timer
    // outlives NEXUS, so the user decides knowingly. Returns true when the quit may proceed.
    confirmQuit = async () => {
      if (!supervisor.hasActive()) return true
      const pending = supervisor.active().map((o) => supervisor.pendingPowerAction(o.runId)).find((p) => p !== null)
      const window = BrowserWindow.getAllWindows()[0]
      const options = {
        type: 'warning' as const,
        title: 'NEXUS',
        message: 'An overnight mission is still running.',
        detail: pending
          ? `Windows is set to ${pending.action === 'SHUTDOWN' ? 'shut down' : pending.action.toLowerCase()} this PC at ${new Date(pending.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. That timer belongs to Windows and stays armed after NEXUS quits.`
          : 'Quitting stops the agents. The mission can be resumed the next time NEXUS starts.',
        buttons: [pending ? 'Quit and leave the shutdown timer armed' : 'Quit', 'Cancel the mission and its shutdown, then quit', 'Return'],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      if (response === 2) return false
      if (response === 1) for (const status of supervisor.active()) await supervisor.cancelMission(status.runId)
      return true
    }
    // An overnight run that was active when NEXUS stopped resumes without anyone clicking; the Windows
    // failsafe scheduled before the restart stays as it is. Called once the Arena exists, because the
    // workload that was live may be a campaign.
    recoverOvernight = () =>
      void supervisor
        .recover()
        .then(() => overnightTray.refresh())
        .catch((e: unknown) => console.error(`[nexus] overnight recovery: ${errorMessage(e)}`))
  }

  const sdkVersion = readSdkVersion()

  // Arena: controlled trials of the same task under different strategies. Each trial is an ordinary run
  // on its own throwaway repository; the hidden evaluators stay in the cases directory, outside every
  // path an agent may read. Built-in cases ship next to the app (extraResources) when packaged.
  const arena = new ArenaService({
    repos,
    bus,
    git,
    dataDir,
    casesDir: app.isPackaged ? join(process.resourcesPath, 'arena', 'cases') : join(app.getAppPath(), 'arena', 'cases'),
    host: orchestrator,
    projects: new ProjectService(repos, git, logger),
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    policy: { activeSnapshotId: () => policy.active().id },
    // A finished campaign refreshes the evidence and may leave a policy candidate; it never promotes one.
    push: learnOnCampaignEnd(repos, policy, push, logger),
    nexusVersion: app.getVersion(),
    environment: async () => ({
      platform: `${process.platform} ${process.arch}`,
      osRelease: release(),
      nodeVersion: process.versions.node,
      sdkVersion,
      gitVersion: await git.version().catch(() => null),
      modelTiers: { ...repos.settings.get().models.tiers },
    }),
    logger,
  })
  try {
    arena.syncBuiltinCases()
  } catch (e) {
    console.error(`[nexus] arena cases: ${errorMessage(e)}`)
  }
  campaignControl = arena
  // An Arena campaign can be an overnight workload: the supervisor owns its deadline, failsafe and end action.
  overnight?.registerWorkload(
    'arena_campaign',
    (id) => new ArenaCampaignWorkload(id, { repos, host: arena, quotaResetsAt: () => usage.machineState().resetAt, now: () => Date.now(), log: logger }),
    arena,
  )
  // Programs: long-horizon goals pursued across milestones. The engine owns the state; missions and the
  // reasoning sessions (plan, verify, reassess) are ordinary runs of the orchestrator.
  const programs = new ProgramEngine({
    repos,
    bus,
    git,
    host: orchestrator,
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    evidence: () => {
      const evidence = policy.overview().evidence
      return `Recorded evidence: ${evidence.arenaTrials} Arena trial(s), ${evidence.missions} mission outcome(s). Active policy version ${policy.active().version}.`
    },
    push,
    logger,
  })
  // Background engineering is off until the user turns it on, and only ever proposes.
  const backgroundJobs = new BackgroundEngineering({
    repos,
    bus,
    host: orchestrator,
    addBacklog: (projectId, programId, proposals, provenance) => programs.addBacklog(projectId, programId, proposals, provenance),
    repositoryFacts: (projectId) => programs.repositoryFacts(projectId),
    push,
    logger,
  })
  programControl = programs
  // Workspaces: related repositories changed together. Each cross-repository task is an ordinary mission in its
  // own repository; the engine orders them, verifies the whole and prepares (never publishes) the release.
  const workspaces = new WorkspaceEngine({
    repos,
    bus,
    git,
    host: orchestrator,
    projects: new ProjectService(repos, git, logger),
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    push,
    logger,
  })
  // A cross-repository mission can be an overnight workload.
  overnight?.registerWorkload('workspace_mission', (id) => new WorkspaceMissionWorkload(id, { host: workspaces, get: (missionId) => repos.workspaceMissions.get(missionId), quotaResetsAt: () => usage.machineState().resetAt }))
  // A program can be an overnight workload for one autonomous work window.
  overnight?.registerWorkload('program', (id) => new ProgramWorkload(id, { host: programs, get: (programId) => repos.programs.get(programId), quotaResetsAt: () => usage.machineState().resetAt }))
  // v0.7: the control plane. One queue above every workload and one division of the machine's agent
  // capacity between them. It drives the engines above through adapters and reads their state; it holds no
  // second truth. The dispatch gate now asks it, per run, how many sessions that run may hold.
  const control = new ControlPlane({
    items: repos.workItems,
    schedules: repos.controlSchedules,
    incidents: repos.controlIncidents,
    settings: repos.settings,
    adapters: createWorkloadAdapters(repos, { orchestrator, programs, arena, workspaces, background: backgroundJobs, defaultAgents: () => repos.settings.get().execution.maxParallelAgents }),
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    unownedActiveWorkloads: () => unownedActiveWorkloads(repos, () => repos.settings.get().execution.maxParallelAgents),
    health: {
      database: () => {
        db.prepare('SELECT 1').get()
        return { level: 'HEALTHY', detail: 'The database answers.' }
      },
      workers: () => {
        const active = activeAgentsOf(repos, repos.runs.listActive().map((r) => r.id))
        return { level: 'HEALTHY', detail: `${active} agent session${active === 1 ? '' : 's'} running. Sessions run inside the NEXUS process; there is no separate worker pool in 0.7.` }
      },
      providers: () => {
        const claude = providers.list().find((s) => s.id === 'claude')
        if (!claude) return { level: 'RECOVERING', detail: 'Providers are being detected.' }
        if (claude.auth === 'auth_required') return { level: 'BLOCKED', detail: 'Claude needs authentication.' }
        return claude.health === 'unavailable' ? { level: 'DEGRADED', detail: claude.healthDetail ?? 'Claude is unavailable.' } : { level: 'HEALTHY', detail: `Claude: ${claude.authDetail ?? 'available'}.` }
      },
      usage: () => (usage.canDispatch() ? { level: 'HEALTHY', detail: `Claude usage: ${usage.status()}.` } : { level: 'RECOVERING', detail: `Waiting for Claude usage (${usage.status()}). Work continues by itself after the reset.` }),
      power_supervisor: () => (overnight ? { level: 'HEALTHY', detail: overnight.active().length > 0 ? 'An overnight run holds the shutdown timer.' : 'No end-of-run action is armed.' } : { level: 'HEALTHY', detail: 'The overnight supervisor is not available on this platform.' }),
      git: () => ({ level: 'HEALTHY', detail: 'Git operations go through the Git service.' }),
      ipc: () => ({ level: 'HEALTHY', detail: 'The window talks to the runtime over Electron IPC; there is no network listener.' }),
    },
    notify: (_kind, title, body) => {
      if (useFake || !Notification.isSupported()) return
      new Notification({ title, body, silent: true }).show()
    },
    onChange: () => push({ kind: 'control' }),
    onAllocationChange: () => {
      for (const run of repos.runs.listActive()) orchestrator.requestTick(run.id)
    },
    logger,
  })
  orchestrator.setDispatchGate({
    canDispatch: () => usage.canDispatch(),
    limit: (normal, runId) => {
      const byUsage = usage.limit(normal)
      return runId ? Math.min(byUsage, control.allowanceForRun(runId, normal, activeAgentsOf(repos, [runId]))) : byUsage
    },
    onChange: (listener) => usage.onChange(listener),
  })
  void Promise.resolve()
    .then(() => arena.recover())
    .catch((e: unknown) => console.error(`[nexus] arena recovery: ${errorMessage(e)}`))
    .then(() => {
      backgroundJobs.recover()
      return programs.recover()
    })
    .then(() => workspaces.recover())
    .catch((e: unknown) => console.error(`[nexus] program recovery: ${errorMessage(e)}`))
    .then(() => control.recoverOnBoot((runId) => orchestrator.recover(runId, 'resume').then(() => undefined)))
    .catch((e: unknown) => console.error(`[nexus] control plane recovery: ${errorMessage(e)}`))
    .finally(() => recoverOvernight())
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
    confirmPower: async (message, detail) => {
      const window = BrowserWindow.getAllWindows()[0]
      const options = { type: 'warning' as const, title: 'NEXUS Overnight Mode', message, detail, buttons: ['Authorize', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      return response === 0
    },
    pickDirectory: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { title: 'Open Project', properties: ['openDirectory' as const] }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openDataDir: async () => {
      await shell.openPath(dataDir)
    },
    v3: createV3Handlers({
      repos,
      usage,
      recovery,
      arena,
      policy,
      ...(overnight ? { overnight } : {}),
      pickDirectory: async () => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = { title: 'Import Arena case', properties: ['openDirectory' as const] }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      activeAgentCount: () => orchestrator.activeAgentCount(),
      confirmTrust: async (message, detail) => {
        const window = BrowserWindow.getAllWindows()[0]
        const options = { type: 'warning' as const, title: 'NEXUS Arena', message, detail, buttons: ['Trust and allow', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }
        const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
        return response === 0
      },
    }),
    v4: createV4Handlers({ repos, programs, background: backgroundJobs }),
    v6: createV6Handlers({ providers }),
    v7: createV7Handlers({ control }),
    v5: createV5Handlers({
      workspaces,
      pickDirectory: async () => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = { title: 'Enroll a repository', properties: ['openDirectory' as const] }
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
    }),
  })

  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return { ok: false, error: { code: 'invalid_input', message: 'Untrusted sender' } }
    }
    return dispatchIpc(handlers, channel, input)
  })

  let quitAsked = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (!quitAllowed) {
      // One question at a time; "Return" leaves everything as it was.
      if (quitAsked) return
      quitAsked = true
      void confirmQuit()
        .then((go) => {
          quitAsked = false
          if (!go) return
          quitAllowed = true
          app.quit()
        })
        .catch((e: unknown) => {
          quitAsked = false
          console.error(`[nexus] quit: ${errorMessage(e)}`)
        })
      return
    }
    // Stop agent processes and flush the database before the process exits. An armed overnight
    // failsafe is left alone: it belongs to Windows and outlives this process on purpose.
    quitting = true
    keepAwake()
    tray?.destroy()
    // A finalization in flight (report, power step) finishes before the database closes.
    const settled = overnight ? Promise.race([overnight.idle(), new Promise((resolve) => setTimeout(resolve, 30_000))]) : Promise.resolve()
    void settled
      .then(() => {
        overnight?.dispose()
        // Nothing new may start: programs, campaigns and quota recovery stop first. The usage service stays until
        // the agent sessions have ended, so what they used is still recorded.
        programs.dispose()
        backgroundJobs.dispose()
        workspaces.dispose()
        arena.dispose()
        recovery.dispose()
        // A probe in flight finishes before the sessions and the database go; nothing is resumed after dispose.
        return recovery.idle()
      })
      .then(() => orchestrator.shutdown())
      .then(() => {
        usage.dispose()
      })
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
