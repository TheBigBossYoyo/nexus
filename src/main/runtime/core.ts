import { mkdirSync, statSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { PushMessage } from '@shared/events'
import type { AppInfo } from '@shared/ipc'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { RUNTIME_PROTOCOL_VERSION, type RuntimeIdentity, type RuntimeStatus, type UiRequest, type UiResponse } from '@shared/runtime-protocol'
import type { WorkersOverview } from '@shared/workers'
import { ArenaService } from '../modules/arena'
import { ClaudeSdkRuntime } from '../modules/agent-runtime/claude-sdk-runtime'
import { createDemoScript } from '../modules/agent-runtime/demo-script'
import { FakeAgentRuntime, FakeCacheSim } from '../modules/agent-runtime/fake-runtime'
import { resolveClaudeExecutable } from '../modules/agent-runtime/resolve-executable'
import type { AgentRuntime } from '../modules/agent-runtime/types'
import { activeAgentsOf, ControlPlane, createWorkloadAdapters, RuntimeNotifier, unownedActiveWorkloads, unownedRecoveryRuns } from '../modules/control-plane'
import { EventBus } from '../modules/events'
import { GitService, WorktreeManager } from '../modules/git'
import { createIpcHandlers, dispatchIpc } from '../modules/ipc/handlers'
import { ProjectService } from '../modules/ipc/services'
import { createV3Handlers } from '../modules/ipc/v3-handlers'
import { createV4Handlers } from '../modules/ipc/v4-handlers'
import { createV5Handlers } from '../modules/ipc/v5-handlers'
import { createV6Handlers } from '../modules/ipc/v6-handlers'
import { createV7Handlers } from '../modules/ipc/v7-handlers'
import { Orchestrator } from '../modules/orchestrator'
import { ArenaCampaignWorkload, OvernightSupervisor, ProgramWorkload, WorkspaceMissionWorkload } from '../modules/overnight'
import { buildTrayModel, type TrayAction } from '../modules/overnight/tray-model'
import { createRepositories, openDatabase } from '../modules/persistence'
import { attachOutcomeRecording, learnOnCampaignEnd, PolicyService } from '../modules/policy'
import { FakePowerController, WindowsPowerController, type PowerController } from '../modules/power'
import { killProcessTree } from '../modules/process'
import { BackgroundEngineering, ProgramEngine } from '../modules/program'
import { ClaudeAgentRuntimeProvider, CODEX_CAPABILITIES, CodexRuntimeProvider, FakeRuntimeProvider, GeminiRuntimeProvider, ProviderService } from '../modules/providers'
import { newPipeName, newToken, pipeAnswers, readEndpoint, removeEndpoint, writeEndpoint } from '../modules/runtime/endpoint'
import { RuntimeServer } from '../modules/runtime/server'
import { buildRuntimeTrayModel, type RuntimeTrayAction, type TraySnapshot } from '../modules/runtime/tray-model'
import { QuotaRecoveryController, RuntimeAvailabilityProbe, UsageIntelligenceService } from '../modules/usage'
import { forkLauncher, hostInWorkers, WorkerManager, type WorkerConfig } from '../modules/workers'
import { WorkspaceEngine } from '../modules/workspace'

/**
 * What the runtime needs from the process it lives in. The Electron host supplies notifications, the tray and
 * the key store; the plain Node host (tests, diagnostics) supplies none of them. Nothing in the core imports
 * Electron.
 */
export interface RuntimeHost {
  dataDir: string
  version: string
  isPackaged: boolean
  /** Electron's resources directory in a packaged app. */
  resourcesPath: string | undefined
  /** Where the built-in Arena cases are. */
  casesDir: string
  tempDir: string
  sdkVersion: string
  env: NodeJS.ProcessEnv
  /** The worker entry point and the binary that runs it (Electron as Node in the app; Node itself otherwise). */
  worker: { entry: string; execPath?: string }
  /** Signs the overnight authorization with a key only this user's runtime holds. */
  createSealer(dataDir: string): { sign(payload: string): string }
  /** Shows one native notification. */
  notify?(title: string, body: string): void
  /** Keeps Windows from suspending the process while unattended work runs. */
  setKeepAwake?(on: boolean): void
  /** Asks the user without a window, when no window is connected. Absent: such a question fails. */
  ask?(request: UiRequest): Promise<UiResponse>
  /** Starts the NEXUS window. */
  launchDesktop?(): void
  /** Something the tray shows may have changed. */
  onStateChange?(): void
  /** Ends the process once the runtime has stopped cleanly. */
  exit(code: number): void
  logger?(line: string): void
}

export interface RuntimeCore {
  identity: RuntimeIdentity
  status(): RuntimeStatus
  tray(): TraySnapshot
  /** A click in the tray. */
  trayAction(action: RuntimeTrayAction | TrayAction, runId?: string): void
  /** Stops the runtime cleanly. `ask`: the user confirms first when work is active. Resolves false when declined. */
  shutdown(options?: { ask?: boolean }): Promise<boolean>
}

/** A positive number from the environment, for automated tests only; never read in a packaged build. */
function testNumber(host: RuntimeHost, name: string): number | undefined {
  const value = !host.isPackaged ? Number(host.env[name] ?? '') : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Starts the NEXUS runtime in this process: the database, the engines, the global scheduler, the worker
 * manager, the schedules, the overnight supervisor, and the local server through which windows talk to it.
 * It needs no window, and a window that closes or crashes takes nothing with it.
 */
export async function startRuntimeCore(host: RuntimeHost): Promise<RuntimeCore> {
  const { dataDir, env } = host
  const worktreesDir = join(dataDir, 'worktrees')
  const dbPath = join(dataDir, 'nexus.db')
  mkdirSync(worktreesDir, { recursive: true })
  const logger = (line: string): void => (host.logger ?? ((l: string) => console.error(`[nexus] ${l}`)))(line)

  const identity: RuntimeIdentity = { protocol: RUNTIME_PROTOCOL_VERSION, version: host.version, pid: process.pid, bootId: newId(), startedAt: new Date().toISOString() }
  let phase: RuntimeStatus['phase'] = 'RECOVERING'
  const recoveryRecord: RuntimeStatus['recovery'] = { workloads: 0, workers: 0, leases: 0, finishedAt: null }

  // One runtime per data directory. The Electron host also holds a lock; this is what every host has.
  const left = readEndpoint(dataDir)
  if (left && (await pipeAnswers(left.pipe))) throw new Error(`A NEXUS runtime is already running for ${dataDir} (process ${left.pid}).`)

  // The runtime is the only writer of the database. Windows read through it.
  const db = openDatabase(dbPath)
  const repos = createRepositories(db)
  const bus = new EventBus(repos.events, repos.transaction)
  const git = new GitService()
  // In its own worktrees NEXUS never lets the `.git` file an agent can rewrite say where the repository is: the
  // Git directory comes from the repository NEXUS's own record names for the worktree.
  git.setWorktreesRoot(worktreesDir)
  git.setWorktreeResolver((worktreePath) => {
    const record = repos.worktrees.getByPath(worktreePath)
    const run = record ? repos.runs.get(record.runId) : null
    const repoRoot = run ? (repos.projects.get(run.projectId)?.rootPath ?? null) : null
    return repoRoot && record ? { repoRoot, branch: record.branch } : null
  })
  const settings = repos.settings.get()

  let server: RuntimeServer | null = null
  let stateQueued = false
  const stateChanged = (): void => {
    if (stateQueued) return
    stateQueued = true
    setTimeout(() => {
      stateQueued = false
      if (phase === 'STOPPING') return
      keepAwake()
      host.onStateChange?.()
    }, 1000).unref()
  }
  let notifier: RuntimeNotifier | null = null
  const push = (message: PushMessage): void => {
    server?.broadcast(message)
    try {
      notifier?.onPush(message)
    } catch (e) {
      console.error(`[nexus] notification: ${errorMessage(e)}`)
    }
    if (message.kind === 'control' || message.kind === 'overnight' || message.kind === 'runtime') stateChanged()
  }
  bus.subscribe((event) => {
    push({ kind: 'event', event })
    notifier?.onEvent(event)
    stateChanged()
  })

  // UI tests answer confirmations through the window they drive. Only with the scripted runtime, never in a package.
  const confirmThroughWindow = !host.isPackaged && env['NEXUS_FAKE_RUNTIME'] === '1' && env['NEXUS_FAKE_CONFIRM'] === 'window'
  /**
   * A question to the user. A confirmation (power control, trusting a case, a settings change that starts a
   * program, stopping while work runs) is shown by the runtime process itself and never travels over the pipe:
   * a client of the pipe, which only has to hold the token, must not be able to answer the question it caused.
   * Without a way to show it, the answer is no. A folder picker carries no authority (a path can be given
   * directly) and is shown by the connected window.
   */
  const ask = (request: UiRequest): Promise<UiResponse> => {
    if (request.kind === 'confirm') {
      if (confirmThroughWindow && server && server.clientCount('desktop') > 0) return server.requestUi(request)
      if (host.ask) return host.ask(request)
      return Promise.reject(new Error('This runtime has no way to ask the user, so the answer is no.'))
    }
    if (server && server.clientCount('desktop') > 0) return server.requestUi(request)
    if (host.ask) return host.ask(request)
    return Promise.reject(new Error('No NEXUS window is connected to answer this.'))
  }
  const confirm = async (title: string, message: string, detail: string, accept: string): Promise<boolean> => {
    const answer = await ask({ kind: 'confirm', level: 'warning', title, message, detail, buttons: [accept, 'Cancel'], defaultId: 1, cancelId: 1 })
    return 'response' in answer && answer.response === 0
  }
  const pickDirectory = async (title: string): Promise<string | null> => {
    const answer = await ask({ kind: 'pickDirectory', title })
    return 'path' in answer ? answer.path : null
  }

  // The scripted runtime exists for UI tests only and cannot be enabled in a packaged build.
  const useFake = !host.isPackaged && env['NEXUS_FAKE_RUNTIME'] === '1'
  const fakeRuntime = useFake ? new FakeAgentRuntime({ script: createDemoScript(), cache: new FakeCacheSim() }) : null
  // UI tests choose what the scripted runtime says about usage: `unknown` = no usage report at all (what a
  // runtime without that method looks like), a number = the plan window's reported percentage.
  const fakeUsage = env['NEXUS_FAKE_USAGE']
  if (fakeRuntime && fakeUsage === 'unknown') fakeRuntime.usage.set({ reportSupported: false })
  else if (fakeRuntime && fakeUsage && Number.isFinite(Number(fakeUsage))) fakeRuntime.usage.set({ utilizationPercent: Number(fakeUsage) })
  const claudeRuntime: AgentRuntime =
    fakeRuntime ??
    new ClaudeSdkRuntime({
      executablePath: settings.claude.executablePath || undefined,
      resolveExecutable: () => resolveClaudeExecutable({ ...(host.resourcesPath ? { resourcesPath: host.resourcesPath } : {}) }),
      debug: settings.advanced.debugSdk,
      logger: settings.advanced.debugSdk ? (line) => console.error(`[claude] ${line}`) : undefined,
    })

  // v0.7: the worker manager. Real provider sessions run in worker processes, one session per worker, each
  // under a lease. The scripted runtime runs in this process (its simulated account is shared by every
  // session) unless a test asks for scripted sessions in workers.
  const useWorkers = !useFake || env['NEXUS_FAKE_WORKERS'] === '1'
  let codexVersion: string | null = null
  const workerConfig = (): WorkerConfig => {
    const current = repos.settings.get()
    return {
      heartbeatMs: 2000,
      ...(useFake
        ? { fake: { script: env['NEXUS_FAKE_WORKERS_SCRIPT'] === 'probe' ? ('probe' as const) : ('demo' as const) } }
        : { claude: { ...(current.claude.executablePath ? { executablePath: current.claude.executablePath } : {}), ...(host.resourcesPath ? { resourcesPath: host.resourcesPath } : {}), debug: current.advanced.debugSdk }, codex: { version: codexVersion } }),
    }
  }
  const heartbeatTimeout = testNumber(host, 'NEXUS_WORKER_HEARTBEAT_TIMEOUT_MS')
  const workerManager = useWorkers
    ? new WorkerManager({
        workers: repos.workers,
        leases: repos.workerLeases,
        bootId: identity.bootId,
        launcher: forkLauncher({ entry: host.worker.entry, ...(host.worker.execPath ? { execPath: host.worker.execPath } : {}), env, killTree: killProcessTree, logger }),
        config: workerConfig,
        // One worker per agent session the queue may run, and one more for probes and reasoning sessions.
        maxWorkers: () => control.limits().maxAgents + 1,
        context: (agentId) => {
          const agent = repos.agents.get(agentId)
          return { runId: agent?.runId ?? null, taskId: agent?.taskId ?? null }
        },
        ...(heartbeatTimeout !== undefined ? { timings: { heartbeatTimeoutMs: heartbeatTimeout } } : {}),
        onChange: () => push({ kind: 'runtime' }),
        logger,
      })
    : null
  // Before anything can start a session: what the earlier start of the runtime left behind is stale.
  const staleWorkers = workerManager ? workerManager.recoverOnBoot() : { workers: repos.workers.listLive().length, leases: repos.workerLeases.listActive().length }
  if (!workerManager) {
    // Sessions run in this process: no worker of an earlier start can be alive under this runtime.
    const at = new Date().toISOString()
    for (const worker of repos.workers.listLive()) repos.workers.save({ ...worker, state: 'STOPPED', stoppedAt: at, error: 'The runtime restarted; this worker belonged to its earlier start.', assignment: null })
    for (const lease of repos.workerLeases.listActive()) repos.workerLeases.end(lease.id, 'EXPIRED', at, 'The runtime restarted while the lease was held.')
  }
  recoveryRecord.workers = staleWorkers.workers
  recoveryRecord.leases = staleWorkers.leases
  const hosted = (provider: string, runtime: AgentRuntime): AgentRuntime => (workerManager ? hostInWorkers(provider, runtime, workerManager) : runtime)

  // v0.6: every session passes through the provider router. Claude is the required provider; the others are
  // detected, off until the user enables them, and never needed. With the scripted runtime (UI tests) the
  // other providers are scripted too, so no test ever reaches a real provider.
  const subscriptionMode = (): boolean => repos.settings.get().claude.subscriptionMode
  const probeCwd = (): string => host.tempDir
  const providers = new ProviderService({
    providers: fakeRuntime
      ? [
          new FakeRuntimeProvider('claude', hosted('claude', fakeRuntime), { authDetail: 'Scripted runtime', health: 'healthy' }),
          new FakeRuntimeProvider('codex', hosted('codex', new FakeAgentRuntime({ script: createDemoScript() })), { capabilities: CODEX_CAPABILITIES, ...(env['NEXUS_FAKE_CODEX'] === 'auth' ? { auth: 'auth_required' as const, health: 'unavailable' as const } : {}) }, 'scripted-codex'),
          new FakeRuntimeProvider('gemini', null, { installed: 'not_installed', version: null, auth: 'unknown', authDetail: null, supportDetail: 'The Gemini command line tool was not found on PATH.', health: 'unavailable' }),
        ]
      : [
          new ClaudeAgentRuntimeProvider({ runtime: hosted('claude', claudeRuntime), subscriptionMode, probeCwd }),
          new CodexRuntimeProvider({ probeCwd, snapshot: (cwd) => git.workingState(cwd), host: (runtime) => hosted('codex', runtime) }),
          new GeminiRuntimeProvider(),
        ],
    sessions: repos.providerSessions,
    settings: repos.settings,
    runOfAgent: (agentId) => repos.agents.get(agentId)?.runId ?? null,
    onChange: () => {
      codexVersion = providers.list().find((s) => s.id === 'codex')?.version ?? null
      push({ kind: 'providers' })
    },
    logger,
  })
  repos.providerSessions.closeInterrupted(new Date().toISOString())
  void providers.refresh().catch((e: unknown) => logger(`provider detection: ${errorMessage(e)}`))
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
    nexusVersion: host.version,
    usage: { status: () => usage.status(), recentLimitWithin: (ms) => usage.recentLimitWithin(ms) },
    push,
  })
  policy.ensureDefault()
  attachOutcomeRecording(bus, policy)

  const orchestrator = new Orchestrator({ repos, bus, runtime, git, worktrees: new WorktreeManager(git, worktreesDir), push, logger, strategies: policy })
  orchestrator.setDispatchGate(usage)
  // Runs that were active when the runtime last stopped are paused, never judged: what became of their
  // sessions is read from the worktrees when they are resumed.
  recoveryRecord.workloads = orchestrator.recoverOnStartup().length

  // Quota recovery: a run paused for a usage limit is checkpointed, waited on and resumed without anyone
  // clicking. Timing overrides exist for automated tests only and cannot be set in a packaged build.
  const usageTick = testNumber(host, 'NEXUS_USAGE_TICK_MS')
  const resumeDelay = testNumber(host, 'NEXUS_USAGE_RESUME_DELAY_S')
  const probeSeconds = testNumber(host, 'NEXUS_USAGE_PROBE_S')
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
  // handler, agent tool, worker or MCP server ever holds it. Tests (and any run on the scripted runtime)
  // get the fake controller, which cannot be selected in a packaged build.
  const useFakePower = !host.isPackaged && (useFake || env['NEXUS_FAKE_POWER'] === '1')
  let power: PowerController | null = null
  try {
    power = useFakePower ? new FakePowerController({ logFile: join(dataDir, 'fake-power.log') }) : new WindowsPowerController()
  } catch (e) {
    logger(`power control unavailable: ${errorMessage(e)}`)
  }
  const overnightTick = testNumber(host, 'NEXUS_OVERNIGHT_TICK_MS')
  let keepAwake: () => void = () => undefined
  const overnight = power
    ? new OvernightSupervisor({
        repos,
        bus,
        orchestrator,
        power,
        git,
        push,
        flush: () => void db.pragma('wal_checkpoint(TRUNCATE)'),
        reportsDir: join(dataDir, 'reports'),
        sealer: host.createSealer(dataDir),
        probe,
        ...(overnightTick !== undefined && overnightTick >= 100 ? { tickIntervalMs: overnightTick } : {}),
        logger,
      })
    : undefined
  let awake = false
  keepAwake = () => {
    // Windows must not suspend the runtime in the middle of unattended work.
    const wanted = phase !== 'STOPPING' && (overnight?.hasActive() ?? false)
    if (wanted === awake) return
    awake = wanted
    host.setKeepAwake?.(wanted)
  }
  keepAwake()

  // Arena: controlled trials of the same task under different strategies. Each trial is an ordinary run
  // on its own throwaway repository; the hidden evaluators stay in the cases directory, outside every
  // path an agent may read.
  const arena = new ArenaService({
    repos,
    bus,
    git,
    dataDir,
    casesDir: host.casesDir,
    host: orchestrator,
    projects: new ProjectService(repos, git, logger),
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    policy: { activeSnapshotId: () => policy.active().id },
    // A finished campaign refreshes the evidence and may leave a policy candidate; it never promotes one.
    push: learnOnCampaignEnd(repos, policy, push, logger),
    nexusVersion: host.version,
    environment: async () => ({
      platform: `${process.platform} ${process.arch}`,
      osRelease: release(),
      nodeVersion: process.versions.node,
      sdkVersion: host.sdkVersion,
      gitVersion: await git.version().catch(() => null),
      modelTiers: { ...repos.settings.get().models.tiers },
    }),
    logger,
  })
  try {
    arena.syncBuiltinCases()
  } catch (e) {
    logger(`arena cases: ${errorMessage(e)}`)
  }
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

  // The control plane: one queue above every workload and one division of the machine's agent capacity
  // between them. It drives the engines above through adapters and reads their state; it holds no second
  // truth. The dispatch gate asks it, per run, how many sessions that run may hold.
  const control: ControlPlane = new ControlPlane({
    items: repos.workItems,
    schedules: repos.controlSchedules,
    incidents: repos.controlIncidents,
    firings: repos.scheduleFirings,
    decisions: repos.schedulerDecisions,
    transaction: repos.transaction,
    settings: repos.settings,
    adapters: createWorkloadAdapters(repos, { orchestrator, programs, arena, workspaces, background: backgroundJobs, defaultAgents: () => repos.settings.get().execution.maxParallelAgents }),
    usage: { canDispatch: () => usage.canDispatch(), onChange: (listener) => usage.onChange(listener) },
    unownedActiveWorkloads: () => unownedActiveWorkloads(repos, () => repos.settings.get().execution.maxParallelAgents),
    workers: () => {
      if (!workerManager) return null
      const counts = workerManager.counts()
      return { live: counts.live, busy: counts.busy, max: control.limits().maxAgents + 1 }
    },
    health: {
      database: () => {
        db.prepare('SELECT 1').get()
        return { level: 'HEALTHY', detail: 'The database answers. The runtime is its only writer.' }
      },
      workers: () => {
        const active = activeAgentsOf(repos, repos.runs.listActive().map((r) => r.id))
        if (!workerManager) return { level: 'HEALTHY', detail: `${active} scripted agent session${active === 1 ? '' : 's'} running inside the runtime (no worker processes with the scripted runtime).` }
        const counts = workerManager.counts()
        const failed = repos.workers.listEnded(10).filter((w) => w.state === 'FAILED' && w.bootId === identity.bootId && w.stoppedAt !== null && Date.now() - Date.parse(w.stoppedAt) < 5 * 60_000).length
        if (failed > 0) return { level: 'DEGRADED', detail: `${failed} worker${failed === 1 ? '' : 's'} failed in the last five minutes; their sessions were taken back. ${counts.live} worker process${counts.live === 1 ? '' : 'es'} alive, ${counts.busy} holding a session.` }
        return { level: 'HEALTHY', detail: `${counts.live} worker process${counts.live === 1 ? '' : 'es'} alive, ${counts.busy} holding a session${counts.waitingAssignments > 0 ? `, ${counts.waitingAssignments} session${counts.waitingAssignments === 1 ? '' : 's'} waiting for a worker` : ''}.` }
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
      ipc: () => {
        const windows = server?.clientCount('desktop') ?? 0
        if (!server) return { level: 'RECOVERING', detail: 'The local server is starting.' }
        return { level: 'HEALTHY', detail: `${windows} window${windows === 1 ? '' : 's'} connected over a local pipe (protocol ${RUNTIME_PROTOCOL_VERSION}, authenticated). Nothing listens on the network.` }
      },
    },
    notify: (_kind, title, body) => {
      if (useFake) return
      host.notify?.(title, body)
    },
    onChange: () => push({ kind: 'control' }),
    onAllocationChange: () => {
      for (const run of repos.runs.listActive()) orchestrator.requestTick(run.id)
    },
    logger,
  })
  // Restrained native notifications for what happens outside the queue: milestones, Arena regressions, the end
  // of an overnight run, refused tool calls. What was already so before this start is not announced.
  notifier = new RuntimeNotifier({
    announce: (kind, subject, title, body) => control.announce(kind, subject, title, body),
    milestones: (programId) => repos.milestones.listByProgram(programId),
    programName: (programId) => repos.programs.get(programId)?.name ?? null,
    campaign: (campaignId) => repos.arenaCampaigns.get(campaignId),
    regressions: (campaignId) => arena.results({ campaignId }).regressions.length,
  })
  notifier.prime(
    repos.programs.listOpen().map((p) => p.id),
    repos.arenaCampaigns.listByState(['completed']).map((c) => c.id),
  )
  const securityNotifier = notifier
  repos.securityDecisions.onRecord = (entry) => securityNotifier.onSecurityDecision(entry)

  orchestrator.setDispatchGate({
    canDispatch: (runId) => {
      if (!usage.canDispatch()) return false
      if (!runId) return true
      const run = repos.runs.get(runId)
      return !run || control.hasCapacityForRun(runId, run.config.maxParallelAgents, activeAgentsOf(repos, [runId]))
    },
    limit: (normal, runId) => {
      const byUsage = usage.limit(normal)
      return runId ? Math.min(byUsage, control.allowanceForRun(runId, normal, activeAgentsOf(repos, [runId]))) : byUsage
    },
    onChange: (listener) => usage.onChange(listener),
  })

  // Recovery runs behind the server: a window that connects meanwhile sees RECOVERING, not a frozen screen.
  const recovered = Promise.resolve()
    .then(() => arena.recover())
    .catch((e: unknown) => logger(`arena recovery: ${errorMessage(e)}`))
    .then(() => {
      backgroundJobs.recover()
      return programs.recover()
    })
    .then(() => workspaces.recover())
    .catch((e: unknown) => logger(`program recovery: ${errorMessage(e)}`))
    .then(() =>
      control.recoverOnBoot(
        (runId) => orchestrator.recover(runId, 'resume').then(() => undefined),
        () => unownedRecoveryRuns(repos),
      ),
    )
    .catch((e: unknown) => logger(`control plane recovery: ${errorMessage(e)}`))
    .finally(() => {
      // An overnight run that was active when the runtime stopped resumes without anyone clicking; the Windows
      // failsafe scheduled before the restart stays as it is. It is started here and not waited for: it lasts
      // as long as the run does.
      void overnight
        ?.recover()
        .then(() => stateChanged())
        .catch((e: unknown) => logger(`overnight recovery: ${errorMessage(e)}`))
      if (phase !== 'RECOVERING') return
      phase = 'READY'
      recoveryRecord.finishedAt = new Date().toISOString()
      if (recoveryRecord.workloads > 0 || recoveryRecord.workers > 0 || recoveryRecord.leases > 0) {
        repos.controlIncidents.insert({ id: newId(), at: recoveryRecord.finishedAt, summary: `The runtime started and reconciled ${recoveryRecord.workloads} interrupted run(s), ${recoveryRecord.workers} stale worker(s) and ${recoveryRecord.leases} stale lease(s).`, itemId: null })
      }
      push({ kind: 'runtime' })
    })

  // ───────────────────────────── the runtime about itself ─────────────────────────────

  let endpointAcl: RuntimeStatus['endpointAcl'] = 'inherited'
  const keepAliveReason = (): string | null => {
    if (phase === 'RECOVERING') return 'The runtime is recovering.'
    if ((server?.clientCount() ?? 0) > 0) return 'A window is connected.'
    if (overnight?.hasActive()) return 'An overnight run is active.'
    if (repos.runs.listActive().some((run) => run.state !== 'paused')) return 'A run is working.'
    if (repos.workItems.listOpen().some((item) => item.state !== 'PAUSED' && item.state !== 'BLOCKED')) return 'Work is on the queue.'
    if (repos.controlSchedules.list().some((schedule) => schedule.enabled)) return 'A schedule is switched on.'
    return null
  }
  const megabytes = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10
  const fileSize = (path: string): number => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }
  const resources = (): RuntimeStatus['resources'] => {
    const memory = process.memoryUsage()
    const active = process.getActiveResourcesInfo()
    const timers = active.filter((kind) => kind === 'Timeout' || kind === 'Immediate').length
    return { uptimeSeconds: Math.round(process.uptime()), rssMb: megabytes(memory.rss), heapUsedMb: megabytes(memory.heapUsed), timers, handles: active.length - timers, dbMb: megabytes(fileSize(dbPath)), walMb: megabytes(fileSize(`${dbPath}-wal`)) }
  }
  const status = (): RuntimeStatus => ({
    ...identity,
    phase,
    recovery: { ...recoveryRecord },
    clients: { desktop: server?.clientCount('desktop') ?? 0, tool: server?.clientCount('tool') ?? 0 },
    dispatchPaused: control.dispatchPaused(),
    endpointAcl,
    keepAlive: { reason: keepAliveReason() },
    resources: resources(),
  })
  const workersOverview = (): WorkersOverview =>
    workerManager
      ? workerManager.overview()
      : { workers: repos.workers.listEnded(15), leases: repos.workerLeases.recent(30), limits: { maxWorkers: 0 }, counts: { live: 0, busy: 0, idle: 0, waitingAssignments: 0 }, enabled: false, events: repos.workers.recentEvents(40) }

  const tray = (): TraySnapshot => {
    const active = overnight?.active()[0] ?? null
    const run = active ? repos.runs.get(active.runId) : null
    const campaign = active?.workloadType === 'arena_campaign' ? repos.arenaCampaigns.get(active.runId) : null
    const program = active?.workloadType === 'program' ? repos.programs.get(active.runId) : null
    const overnightModel = overnight
      ? buildTrayModel({
          overnight: active,
          projectName: program ? program.name : campaign ? campaign.name : (run && repos.projects.get(run.projectId)?.name) || 'project',
          runState: program ? (program.state === 'PAUSED' || program.state === 'BLOCKED' ? 'paused' : program.state) : campaign ? campaign.state : (run?.state ?? null),
          activeAgents: campaign || program ? orchestrator.activeAgentCount() : active ? repos.agents.listActive(active.runId).length : 0,
          time: (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      : null
    const overview = control.overview()
    return {
      overnight: overnightModel,
      runtime: buildRuntimeTrayModel({ phase, running: overview.active.length, waiting: overview.waiting.filter((i) => i.state !== 'BLOCKED').length + overview.scheduled.length, blocked: overview.waiting.filter((i) => i.state === 'BLOCKED').length, agents: overview.agents.active, health: overview.health.level, dispatchPaused: overview.dispatchPaused }),
    }
  }

  const openDesktop = (view: 'control' | null): void => {
    if (server && server.clientCount('desktop') > 0) push({ kind: 'desktop', action: 'show', view })
    else host.launchDesktop?.()
  }

  let stopping: Promise<boolean> | null = null
  const stop = async (): Promise<boolean> => {
    phase = 'STOPPING'
    push({ kind: 'runtime' })
    keepAwake()
    try {
      // A finalization in flight (report, power step) finishes before the database closes. An armed
      // overnight failsafe is left alone: it belongs to Windows and outlives this process on purpose.
      await (overnight ? Promise.race([overnight.idle(), new Promise((resolve) => setTimeout(resolve, 30_000))]) : Promise.resolve())
      overnight?.dispose()
      // Nothing new may start: the queue, programs, campaigns and quota recovery stop first. The usage
      // service stays until the agent sessions have ended, so what they used is still recorded.
      control.dispose()
      await control.idle()
      programs.dispose()
      backgroundJobs.dispose()
      workspaces.dispose()
      arena.dispose()
      recovery.dispose()
      // A probe in flight finishes before the sessions and the database go; nothing is resumed after dispose.
      await recovery.idle()
      await orchestrator.shutdown()
      await workerManager?.shutdown()
      usage.dispose()
    } catch (e) {
      logger(`shutdown: ${errorMessage(e)}`)
    }
    await server?.close()
    removeEndpoint(dataDir, identity.bootId)
    try {
      if (db.open) {
        db.pragma('wal_checkpoint(TRUNCATE)')
        db.close()
      }
    } catch (e) {
      logger(`database close: ${errorMessage(e)}`)
    }
    host.exit(0)
    return true
  }

  /** Whether the user agrees to stop the runtime while work is active. Without active work nobody is asked. */
  const confirmStop = async (): Promise<boolean> => {
    if (overnight?.hasActive()) {
      const pending = overnight.active().map((o) => overnight.pendingPowerAction(o.runId)).find((p) => p !== null)
      const answer = await ask({
        kind: 'confirm',
        level: 'warning',
        title: 'NEXUS',
        message: 'An overnight mission is still running.',
        detail: pending
          ? `Windows is set to ${pending.action === 'SHUTDOWN' ? 'shut down' : pending.action.toLowerCase()} this PC at ${new Date(pending.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. That timer belongs to Windows and stays armed after NEXUS stops.`
          : 'Stopping NEXUS stops the agents. The mission can be resumed the next time NEXUS starts.',
        buttons: [pending ? 'Stop NEXUS and leave the shutdown timer armed' : 'Stop NEXUS', 'Cancel the mission and its shutdown, then stop', 'Return'],
        defaultId: 2,
        cancelId: 2,
      })
      const response = 'response' in answer ? answer.response : 2
      if (response === 2) return false
      if (response === 1) for (const o of overnight.active()) await overnight.cancelMission(o.runId)
      return true
    }
    const working = repos.runs.listActive().filter((run) => run.state !== 'paused').length
    if (working === 0) return true
    const answer = await ask({
      kind: 'confirm',
      level: 'warning',
      title: 'NEXUS',
      message: `${working} run${working === 1 ? ' is' : 's are'} working.`,
      detail: 'Stopping NEXUS stops their agent sessions. Finished tasks keep their results; the runs are paused and can be resumed the next time NEXUS starts. Closing only the window does not stop anything.',
      buttons: ['Stop NEXUS', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
    })
    return 'response' in answer && answer.response === 0
  }

  const shutdown = (options: { ask?: boolean } = {}): Promise<boolean> => {
    if (stopping) return stopping
    const attempt = (async (): Promise<boolean> => {
      if (options.ask && !(await confirmStop().catch(() => false))) return false
      return stop()
    })()
    stopping = attempt
    // A declined question leaves the runtime as it was, and it can be asked again.
    void attempt.then((stopped) => {
      if (!stopped) stopping = null
    })
    return attempt
  }

  const appInfo = async (): Promise<AppInfo> => ({
    version: host.version,
    dataDir,
    dbPath,
    worktreesDir,
    platform: `${process.platform} ${process.arch}`,
    gitVersion: await git.version().catch(() => null),
    sdkVersion: host.sdkVersion,
    isPackaged: host.isPackaged,
  })

  const handlers = createIpcHandlers({
    repos,
    git,
    runtime,
    orchestrator,
    ...(overnight ? { overnight } : {}),
    appInfo,
    push,
    // Shown by the window's main process (or natively by the runtime when no window is connected), never by
    // page script: a script in the page cannot click it. Without anyone to ask, the answer is no.
    confirmPower: (message, detail) => confirm('NEXUS Overnight Mode', message, detail, 'Authorize').catch(() => false),
    confirmSettings: (changes) => confirm('NEXUS Settings', changes.length === 1 ? 'Allow this change to the NEXUS settings?' : `Allow these ${changes.length} changes to the NEXUS settings?`, changes.map((change) => `• ${change}`).join('\n').slice(0, 6000), 'Allow').catch(() => false),
    pickDirectory: () => pickDirectory('Open Project'),
    openDataDir: async () => {
      await ask({ kind: 'openDataDir' })
    },
    v3: createV3Handlers({
      repos,
      usage,
      recovery,
      arena,
      policy,
      ...(overnight ? { overnight } : {}),
      pickDirectory: () => pickDirectory('Import Arena case'),
      activeAgentCount: () => orchestrator.activeAgentCount(),
      confirmTrust: (message, detail) => confirm('NEXUS Arena', message, detail, 'Trust and allow').catch(() => false),
    }),
    v4: createV4Handlers({ repos, programs, background: backgroundJobs }),
    v6: createV6Handlers({ providers }),
    v7: createV7Handlers({
      control,
      decisions: repos.schedulerDecisions,
      runtime: {
        status,
        workers: workersOverview,
        workerSelfTest: async () => (workerManager ? workerManager.selfTest() : { ok: false, pid: null, capabilities: [], milliseconds: 0, detail: 'Sessions run inside the runtime in this mode; there are no worker processes.' }),
        tray,
        shutdown: async () => {
          // The answer goes back before the server closes; the stop itself follows.
          if (!(await confirmStop().catch(() => false))) return false
          setTimeout(() => void shutdown(), 50)
          return true
        },
      },
    }),
    v5: createV5Handlers({ workspaces, pickDirectory: () => pickDirectory('Enroll a repository') }),
  })

  // ───────────────────────────── the local server ─────────────────────────────

  const token = newToken()
  const pipe = newPipeName(dataDir)
  server = new RuntimeServer({
    pipe,
    token,
    identity,
    // The dispatcher accepts a channel of the closed contract and an input that passes its schema, nothing else.
    dispatch: (channel, input) => dispatchIpc(handlers, channel, input),
    onClientsChange: () => {
      push({ kind: 'runtime' })
      stateChanged()
    },
    logger,
  })
  await server.listen()
  const written = await writeEndpoint(dataDir, { protocol: RUNTIME_PROTOCOL_VERSION, version: host.version, pipe, token, pid: process.pid, bootId: identity.bootId, startedAt: identity.startedAt })
  endpointAcl = written.restricted ? 'restricted' : 'inherited'
  if (!written.restricted) logger('the endpoint file keeps its inherited access list')

  // A runtime with nothing to do and nobody connected does not stay in the background for good.
  const idleExitMs = testNumber(host, 'NEXUS_RUNTIME_IDLE_EXIT_MS') ?? 120_000
  let idleSince: number | null = null
  // The records the scheduler keeps about itself are history; they are kept bounded.
  const pruneTimer = setInterval(
    () => {
      try {
        repos.schedulerDecisions.prune()
        repos.scheduleFirings.prune()
      } catch (e) {
        logger(`pruning: ${errorMessage(e)}`)
      }
    },
    15 * 60_000,
  )
  pruneTimer.unref()
  const idleTimer = setInterval(() => {
    if (phase !== 'READY') return
    if (keepAliveReason() !== null) {
      idleSince = null
      return
    }
    idleSince ??= Date.now()
    if (Date.now() - idleSince >= idleExitMs) {
      clearInterval(idleTimer)
      logger('nothing to do and no window connected: the runtime stops')
      void shutdown()
    }
  }, Math.min(5000, Math.max(250, idleExitMs / 4)))
  idleTimer.unref()

  const trayAction = (action: RuntimeTrayAction | TrayAction, runId?: string): void => {
    const report = (e: unknown): void => logger(`tray ${action}: ${errorMessage(e)}`)
    if (action === 'open') return openDesktop(null)
    if (action === 'openControl') return openDesktop('control')
    if (action === 'pauseDispatch' || action === 'resumeDispatch') {
      control.setDispatchPaused(action === 'pauseDispatch')
      push({ kind: 'runtime' })
      return
    }
    if (action === 'stop') return void shutdown({ ask: true }).catch(report)
    if (!runId || !overnight) return
    const workload = repos.overnight.getByRun(runId)?.workloadType
    if (workload === 'program' && (action === 'pause' || action === 'resume')) void (action === 'pause' ? programs.pause(runId) : programs.resume(runId)).catch(report)
    else if (workload === 'arena_campaign' && (action === 'pause' || action === 'resume')) {
      try {
        if (action === 'pause') arena.pause(runId)
        else arena.resume(runId)
      } catch (e) {
        report(e)
      }
    } else if (action === 'pause') void orchestrator.pauseRun(runId).catch(report)
    else if (action === 'resume') void orchestrator.resumeRun(runId).catch(report)
    else if (action === 'cancelPower') void overnight.cancelPower(runId).catch(report)
    else if (action === 'cancelMission') void overnight.cancelMission(runId).catch(report)
  }

  void recovered
  return { identity, status, tray, trayAction, shutdown }
}
