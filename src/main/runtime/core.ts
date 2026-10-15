import { execFile } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { BUILD_STAMP } from '@shared/build-identity'
import { ChatGPTConnection, type ProtectedStorage } from '../modules/intelligence/connection'
import { IntelligenceOperations } from '../modules/intelligence/operations'
import { TaskAdmissionService } from '../modules/intelligence/admission'
import { createProductionAdvisoryRouting } from '../modules/intelligence/production-routing'
import { createPrivilegedTools } from '../modules/privilege/tools'
import { privilegedActivitySpoken } from '../modules/privilege/report'
import { createPrivilegeHost } from './privilege-host'
import { createPresentationHost } from './presentation-host'
import { MIGRATIONS } from '../modules/persistence/migrations'
import { CapacityRegistry } from '../modules/capacity/registry'
import { WorkerCapacityRouting } from '../modules/capacity/worker-routing'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import type { PushMessage } from '@shared/events'
import type { AppInfo } from '@shared/ipc'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { Settings } from '@shared/settings'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeIdentity,
  type RuntimeStatus,
  type UiRequest,
  type UiResponse,
} from '@shared/runtime-protocol'
import type { WorkersOverview } from '@shared/workers'
import { TERMINAL_RUN_STATES, type Run } from '@shared/domain'
import { isReasoningRun } from '@shared/program'
import { ArenaService } from '../modules/arena'
import { AutonomyService } from '../modules/autonomy/service'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { ApplicationUnderTestManager } from '../modules/browser/app-manager'
import { PlaywrightDirectProvider } from '../modules/browser/provider'
import { createPackageConfigTools } from '../modules/agent-runtime/package-config-tool'
import { combineExtensions, createAppTools } from '../modules/browser/tools'
import type { GuardOptions } from '../modules/network/guard'
import { renderPublicPage } from '../modules/research/browser'
import { ExecutionBroker } from '../modules/isolation/execution-broker'
import { Launcher } from '../modules/isolation/launcher'
import { readSandboxAccount, sandboxStateDir, type SandboxAccount } from '../modules/isolation/sandbox-account'
import { BoundaryResumer } from '../modules/autonomy/resume'
import { setupSandboxAccount, verifySandboxSetup } from '../modules/isolation/sandbox-setup'
import { IsolationService } from '../modules/isolation/service'
import type { ContainmentSetting } from '../modules/isolation/session-containment'
import { mirrorTools, type ToolMirrorState } from '../modules/isolation/tools'
import { startPolicyProxy } from '../modules/network/proxy'
import { policyForProjectCommands, policyForPurpose } from '../modules/network/policy'
import { DEFAULT_SEARCH_URL, WebResearchProvider } from '../modules/research/provider'
import { isSecretEnvName } from '../modules/process/contained-env'
import { createResearchTools } from '../modules/research/tools'
import { ProgressService } from '../modules/progress/service'
import { sqliteOutageStore } from '../modules/connectivity/sqlite-outage-store'
import { startNetworkResilience, type NetworkResilience } from './network-resilience'
import type { FinishedTask } from '../modules/progress/estimator'
import { DEFAULT_PROGRESS_REFRESH_SECONDS, type ProgressSnapshot } from '@shared/progress'
import { createDirectorLineRuntime } from '../modules/director-line/runtime'
import type { HttpFetch } from '../modules/director-line'
import { createDirectorLineHost, protectedSecretStore } from './director-line-host'
import { createDirectorVoiceHost, createLocalVoiceSpeech } from './director-voice-host'
import { composeStatus } from '../modules/director-line/replies'
import { DirectorLineReporter } from './director-line-reports'
import { ClaudeSdkRuntime } from '../modules/agent-runtime/claude-sdk-runtime'
import { createDemoScript } from '../modules/agent-runtime/demo-script'
import { FakeAgentRuntime, FakeCacheSim } from '../modules/agent-runtime/fake-runtime'
import { resolveClaudeExecutable } from '../modules/agent-runtime/resolve-executable'
import type { AgentRuntime } from '../modules/agent-runtime/types'
import {
  activeAgentsOf,
  ControlPlane,
  createWorkloadAdapters,
  RuntimeNotifier,
  unownedActiveWorkloads,
  unownedRecoveryRuns,
} from '../modules/control-plane'
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
import {
  ArenaCampaignWorkload,
  OvernightSupervisor,
  ProgramWorkload,
  WorkspaceMissionWorkload,
} from '../modules/overnight'
import { buildTrayModel, type TrayAction } from '../modules/overnight/tray-model'
import { AUTONOMY_CAPABILITIES, boundaryResumeResource, cleanAgentText, quotedAction } from '@shared/autonomy'
import { createRepositories, openDatabase } from '../modules/persistence'
import { attachOutcomeRecording, learnOnCampaignEnd, PolicyService } from '../modules/policy'
import { attachAdviceOutcomes } from '../modules/intelligence/outcomes'
import { FakePowerController, WindowsPowerController, type PowerController } from '../modules/power'
import { killProcessTree } from '../modules/process'
import { BackgroundEngineering, ProgramEngine } from '../modules/program'
import {
  ClaudeAgentRuntimeProvider,
  CODEX_CAPABILITIES,
  CodexRuntimeProvider,
  FakeRuntimeProvider,
  GeminiRuntimeProvider,
  ProviderService,
} from '../modules/providers'
import {
  newPipeName,
  newToken,
  pipeAnswers,
  readEndpoint,
  removeEndpoint,
  writeEndpoint,
} from '../modules/runtime/endpoint'
import { RuntimeServer } from '../modules/runtime/server'
import {
  buildRuntimeTrayModel,
  type RuntimeTrayAction,
  type TraySnapshot,
} from '../modules/runtime/tray-model'
import {
  QuotaRecoveryController,
  RuntimeAvailabilityProbe,
  UsageIntelligenceService,
} from '../modules/usage'
import { forkLauncher, hostInWorkers, WorkerManager, type WorkerConfig } from '../modules/workers'
import { WorkspaceEngine } from '../modules/workspace'

/**
 * What the runtime needs from the process it lives in. The Electron host supplies notifications, the tray and
 * the key store; the plain Node host (tests, diagnostics) supplies none of them. Nothing in the core imports
 * Electron.
 */
export interface RuntimeHost {
  protectedStorage?: ProtectedStorage
  openBrowser?(url: string): Promise<void>
  dataDir: string
  version: string
  isPackaged: boolean
  /** Electron's resources directory in a packaged app. */
  resourcesPath: string | undefined
  /**
   * 0.8: whether the user's credential stores (~/.claude, ~/.ssh and the like) are marked unreadable for
   * contained code when a project is enrolled. The application sets it; a runtime started by a test does not,
   * so that a test never changes a folder of the person running it. NEXUS's own data is marked either way.
   */
  protectUserStores?: boolean
  /** 0.8: the directory of the sandbox account's setup scripts. Absent: the setup cannot be started from this runtime. */
  sandboxSetupDir?: string
  /** 0.8: where nexus-launch.exe is. Absent or missing: no containment exists, and enrolled projects run nothing until one does. */
  launcherPath?: string
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
/**
 * A boundary request as an artifact of the task it came from (and of the task that one repairs): what was
 * asked, that it was not done, and that it waits for the user. A reviewer or a verifier reads the task's
 * artifacts; without this the only evidence of a refused action is the word of the session that tried it.
 */
/**
 * 0.9.1: a folder of NEXUS's own made "not content indexed": Windows Search leaves alone what is created in it from
 * now on. The folder's own setting only; the owner's indexing options are not touched.
 */
function markNotIndexed(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    const child = execFile('attrib', ['+I', dir], { windowsHide: true, timeout: 15_000 }, () => undefined)
    child.on('error', () => undefined)
  } catch {
    // Indexed as before.
  }
}

export function recordBoundaryEvidence(repos: ReturnType<typeof createRepositories>, request: { id: string; runId: string | null; taskId: string | null; capability: string; action: string; occurrences: number }): void {
  if (request.runId === null) return
  const task = request.taskId !== null ? repos.tasks.get(request.taskId) : null
  const taskIds = task ? [task.id, ...(task.parentTaskId ? [task.parentTaskId] : [])] : [null]
  const label = (AUTONOMY_CAPABILITIES as Record<string, { label: string }>)[request.capability]?.label ?? request.capability
  for (const taskId of taskIds) {
    try {
      repos.artifacts.insert({
        id: randomUUID(),
        runId: request.runId,
        taskId,
        agentId: null,
        kind: 'boundary-request',
        title: `Boundary request: ${label} (not done; waits for the user)`,
        content: `NEXUS refused this action and put it to the user as boundary request ${request.id}: ${label}.\n${quotedAction(request.action)}\nIt was not carried out. Recorded at ${new Date().toISOString()}. A later attempt of the same action in this mission is the same request and is refused the same way.`,
        createdAt: new Date().toISOString(),
      })
    } catch {
      // Evidence for a checker; the request itself is on record whatever happens here.
    }
  }
}

export async function startRuntimeCore(host: RuntimeHost): Promise<RuntimeCore> {
  const { dataDir, env } = host
  let worktreesDir = join(dataDir, 'worktrees')
  const dbPath = join(dataDir, 'nexus.db')
  mkdirSync(worktreesDir, { recursive: true })
  const logger = (line: string): void =>
    (host.logger ?? ((l: string) => console.error(`[nexus] ${l}`)))(line)

  const identity: RuntimeIdentity = {
    protocol: RUNTIME_PROTOCOL_VERSION,
    version: host.version,
    pid: process.pid,
    bootId: newId(),
    startedAt: new Date().toISOString(),
  }
  let phase: RuntimeStatus['phase'] = 'RECOVERING'
  const recoveryRecord: RuntimeStatus['recovery'] = {
    workloads: 0,
    workers: 0,
    leases: 0,
    finishedAt: null,
  }

  // One runtime per data directory. The Electron host also holds a lock; this is what every host has.
  const left = readEndpoint(dataDir)
  if (left && (await pipeAnswers(left.pipe)))
    throw new Error(`A NEXUS runtime is already running for ${dataDir} (process ${left.pid}).`)

  // The runtime is the only writer of the database. Windows read through it.
  const db = openDatabase(dbPath)
  const repos = createRepositories(db)
  const processStopped = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }
  repos.intelligenceArtifacts.reconcileInterrupted(processStopped)
  // Hosted sessions of an earlier start stay quarantined until its processes are proven gone. The first pass
  // runs here, before the worker records of that start are closed, so that their process ids are on record.
  const reclaimHostedLeases = (): number =>
    repos.intelligenceArtifacts.reclaimHostedLeases({
      currentBootId: identity.bootId,
      isProcessStopped: processStopped,
      childPids: (bootId) => repos.workers.listLive().flatMap((w) => (w.bootId === bootId && w.pid !== null ? [w.pid] : [])),
      settleMs: 30_000,
      currentPid: process.pid,
    })
  reclaimHostedLeases()
  // Read here, before the worker records of the earlier start are closed: the processes a new session waits for.
  const earlierWorkerPids = repos.workers.listLive().flatMap((w) => (w.bootId !== identity.bootId && w.pid !== null ? [w.pid] : []))
  // 0.8: the containment of project code. Both profiles are run once here, before anything is dispatched, and
  // what a session may rely on is what that run showed. Tests that drive the runtime with scripted agents may
  // name the profile; a packaged build takes it from Settings only.
  const containmentOverride = !host.isPackaged && ['STRONGEST', 'ISOLATED', 'RESTRICTED', 'STANDARD'].includes(env['NEXUS_CONTAINMENT'] ?? '') ? (env['NEXUS_CONTAINMENT'] as ContainmentSetting) : null
  const launcher = new Launcher({ executable: host.launcherPath ?? join(dataDir, 'missing', 'nexus-launch.exe'), specDir: join(dataDir, 'sandbox', 'specs') })
  // What project code may reach on the network when it installs dependencies: the approved registries, through
  // a proxy of NEXUS's own. Under ISOLATED it is the only network the code has.
  // The hosts on its list are for fetching: a connection that sends more than a few megabytes to one of them is not
  // an install, and is cut. (The list has registries and github.com's downloads; what goes through is brokered
  // here, host by host, and is no network of the contained code's own.)
  const depsProxy = await startPolicyProxy({ policy: policyForProjectCommands({ network: true }), maxUploadBytesPerConnection: 4 * 1024 * 1024 }).catch(() => null)
  const proxyUrl = depsProxy ? `http://${depsProxy.username}:${depsProxy.password}@127.0.0.1:${depsProxy.port}` : null
  let toolState: ToolMirrorState | null = null
  // 0.8: the account on record is looked at before it is used: that Windows has an account of that name with
  // that identifier, made by NEXUS's setup, in no group but Users; that its folder is a real folder of this
  // user's with the access the setup gives and nothing of anybody else's in it. When that does not hold, the
  // isolated profile is not available, and says why.
  let sandboxProblem: string | null = null
  /** There is a record of the account, whether or not it passed: the isolated profile was set up on this machine. */
  let sandboxRecorded = false
  // The account that was looked at, and no other: the record is not read again when the account is used, so a
  // record that changes while NEXUS runs changes nothing until it has been verified in its turn.
  let sandboxAccount: SandboxAccount | null = null
  const checkSandboxAccount = async (): Promise<void> => {
    const recorded = readSandboxAccount(env)
    sandboxRecorded = recorded !== null
    let problem: string | null = null
    if (recorded !== null) {
      if (host.sandboxSetupDir === undefined) problem = 'this build cannot verify it (the verification script is not part of it)'
      else {
        // The AppContainer the launcher will use, by the launcher's own derivation: the machine's record, the
        // sandbox root and the two folders above it must all be set up for that one.
        const container = await Promise.all([launcher.appContainerSid(), launcher.capabilitySid()]).then(([sid, capabilitySid]) => ({ sid, capabilitySid }), () => null)
        const verdict = container === null ? { ok: false, problems: ["the launcher could not derive the AppContainer's identifier"], notes: [] } : await verifySandboxSetup(recorded, host.sandboxSetupDir, env, container)
        if (!verdict.ok) problem = verdict.problems.join('; ').slice(0, 600)
        for (const note of verdict.notes) logger(`isolation: ${note}`)
        logger(`isolation: sandbox account ${verdict.ok ? 'verified' : `NOT usable: ${problem}`}`)
      }
    }
    sandboxAccount = recorded
    sandboxProblem = problem
  }
  await checkSandboxAccount()
  const executionBroker = new ExecutionBroker({
    launcher,
    sandboxDir: join(dataDir, 'sandbox'),
    account: () => sandboxAccount,
    accountProblem: () => sandboxProblem,
    baseEnv: () => env,
    // The POSIX shell of the isolated profile lies beside the launcher, in every build.
    posixShell: () => {
      const candidate = join(dirname(launcher.executable), 'busybox.exe')
      return existsSync(candidate) ? candidate : null
    },
    gitIdentity: () => {
      const g = repos.settings.get().git
      return { name: g.commitAuthorName, email: g.commitAuthorEmail }
    },
    toolPath: (profile, path) => {
      if (profile !== 'ISOLATED') return path
      const account = sandboxAccount
      if (account === null) return path
      // The copies are made the first time a contained command needs them, and reused.
      toolState ??= mirrorTools({ sandboxRoot: account.root, userProfile: env['USERPROFILE'] ?? homedir(), path })
      return toolState.path
    },
    networkEnv: (): Record<string, string> =>
      proxyUrl === null ? {} : { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, npm_config_proxy: proxyUrl, npm_config_https_proxy: proxyUrl, NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' },
    onFailure: (info) => {
      logger(`isolation: ${info.profile} could not be made: ${info.detail}`)
      isolationFailed?.(info.projectId, info.detail)
    },
  })
  let isolationFailed: ((projectId: string | null, detail: string) => void) | null = null
  const isolation = new IsolationService({
    broker: executionBroker,
    launcher,
    containment: () => containmentOverride ?? repos.settings.get().execution.containment,
    enrolled: (projectId) => repos.enrollments.get(projectId) !== null,
    gitWritable: async (worktree) => (await git.ownedGitLayout(worktree))?.writable ?? [],
    dataDir,
    sandboxStateDir: sandboxStateDir(env),
    sandboxOnRecord: () => sandboxRecorded,
    // 0.9.1: the commands of projects that are not contained start on a desktop of their own (zero-disturbance).
    quietCommands: () => process.platform === 'win32' && host.launcherPath !== undefined && existsSync(host.launcherPath) && repos.settings.get().execution.quietCommands !== false && (host.isPackaged || env['NEXUS_QUIET_COMMANDS'] !== '0'),
    onVisibleCommand: (reason) => logger(`presentation: a command ran visibly (${reason})`),
    logger,
  })
  const isolationStatus = await isolation.start()
  logger(`isolation: ${isolationStatus.effective} (${isolationStatus.usable ? 'verified' : 'NOT available'}): ${isolationStatus.detail}`)
  // Under ISOLATED a worktree must be where the sandbox account can go: in its root, outside the user's profile.
  const isolatedRoot = executionBroker.isolatedWorktreesRoot()
  if (isolationStatus.effective === 'ISOLATED' && isolationStatus.usable && isolatedRoot !== null) {
    worktreesDir = join(isolatedRoot, createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 12))
    mkdirSync(worktreesDir, { recursive: true })
  } else if (isolationStatus.effective === 'RESTRICTED' && isolationStatus.usable) {
    // Under RESTRICTED a worktree must not lie inside NEXUS's data: that directory is closed to code at low
    // integrity once a project is enrolled, and a program that looks at the directories above its own (Node
    // does, for every file it loads) is refused there. Found by the first real mission under RESTRICTED: the
    // tests of the project could not start. The worktrees go beside the data directory, in a directory that
    // carries no mark of its own.
    worktreesDir = `${dataDir.replace(/[\\/]+$/, '')}-worktrees`
    mkdirSync(worktreesDir, { recursive: true })
  }
  executionBroker.sweep()
  const bus = new EventBus(repos.events, repos.transaction)
  // 0.9.1: the owner's PC suffered during missions (measured on NEXUS itself: 23 % CPU on average and peaks at 73 %
  // while its suite ran, two thousand pages a second at times). Missions' work runs below normal priority: Windows
  // gives it to every process started from here (workers, Claude Code, shells, checks, git), so the owner's own
  // programs come first and, with nobody else asking, the work gets the whole machine as before. The window and
  // the call helper set their own priority back to normal.
  const applyWorkPriority = (s: Settings): void => {
    if (process.platform !== 'win32') return
    try {
      setPriority(process.pid, s.execution.backgroundPriority === false ? osConstants.priority.PRIORITY_NORMAL : osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch (e) {
      logger(`work priority: ${errorMessage(e)}`)
    }
  }
  applyWorkPriority(repos.settings.get())
  // The worktrees and the sandbox's state are written and rewritten by every check: Windows Search indexing them
  // (measured: 2 % of the machine during a suite) is work for nothing. New files there are made unindexed.
  if (process.platform === 'win32') for (const dir of [worktreesDir, join(dataDir, 'sandbox')]) markNotIndexed(dir)
  const git = new GitService()
  // In its own worktrees NEXUS never lets the `.git` file an agent can rewrite say where the repository is: the
  // Git directory comes from the repository NEXUS's own record names for the worktree.
  git.setWorktreesRoot(worktreesDir)
  // 0.8: NEXUS's own index of every worktree it created, where contained code cannot write; and a line of
  // evidence for every commit NEXUS makes there: what it meant to commit and what the commit holds.
  git.setTrustedIndexDir(join(dataDir, 'git-index'))
  // A worktree's entry in the repository holds three files that say where the repository is and what
  // configuration applies. They are made unwritable for project code when the worktree is created, before the
  // first command of the project (its dependency setup) runs there.
  if (process.platform === 'win32' && host.launcherPath !== undefined && existsSync(host.launcherPath)) git.onWorktreeCreated((gitDir) => executionBroker.pinGit(gitDir))
  git.onCommitEvidence((evidence) => {
    try {
      appendFileSync(join(dataDir, 'commit-evidence.jsonl'), `${JSON.stringify(evidence)}
`)
    } catch (e) {
      logger(`git: commit evidence could not be written: ${errorMessage(e)}`)
    }
  })
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
    if (message.kind === 'control' || message.kind === 'overnight' || message.kind === 'runtime')
      stateChanged()
  }
  bus.subscribe((event) => {
    push({ kind: 'event', event })
    notifier?.onEvent(event)
    stateChanged()
  })
  // 0.9: progress and time remaining, from the task graph and from how long tasks took here before. Looked at
  // again when something happens in a mission (tool calls and token counts are not "something"), and on a tick
  // for the refresh of what is shown. No session is started for it and no model is asked.
  const finishedTaskRows = db.prepare("SELECT kind, complexity, started_at AS s, finished_at AS f FROM tasks WHERE state = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?")
  const repairRateRow = db.prepare("SELECT AVG(CASE WHEN repair_cycles > 0 THEN 1.0 ELSE 0.0 END) AS r, COUNT(*) AS n FROM tasks WHERE state = 'completed' AND kind = 'implement'")
  const progressListeners: ((snapshot: ProgressSnapshot, why: string) => void)[] = []
  const taskCheckRows = db.prepare("SELECT commands FROM verification_results WHERE run_id = ? AND task_id IS NOT NULL AND kind = 'checks' ORDER BY created_at DESC LIMIT 50")
  const finaleRows = db.prepare("SELECT v.commands FROM verification_results v JOIN runs r ON r.id = v.run_id WHERE r.project_id = ? AND (v.run_id != ? OR v.created_at < ?) AND v.task_id IS NULL AND v.kind = 'checks' ORDER BY v.created_at DESC LIMIT 20")
  const progress = new ProgressService({
    now: () => Date.now(),
    run: (runId) => repos.runs.get(runId) ?? null,
    tasks: (runId) => repos.tasks.listByRun(runId),
    dependencies: (runId) => repos.dependencies.listByRun(runId),
    events: (runId, afterSeq) => repos.events.listByRun(runId, afterSeq, 5000),
    finishedTasks: (limit) => (finishedTaskRows.all(limit) as { kind: string; complexity: string; s: string; f: string }[]).map((r) => ({ kind: r.kind as FinishedTask['kind'], complexity: r.complexity as FinishedTask['complexity'], seconds: (Date.parse(r.f) - Date.parse(r.s)) / 1000 })),
    repairRate: () => {
      const row = repairRateRow.get() as { r: number | null; n: number }
      return row.n >= 8 && row.r !== null ? row.r : null
    },
    parallelism: (run) => Math.max(1, run.config.maxParallelAgents),
    refreshSeconds: () => repos.settings.get().execution.progressRefreshSeconds ?? DEFAULT_PROGRESS_REFRESH_SECONDS,
    waitOf: (run) => progressWaitOf(run),
    // 0.9.1: how long the final checks of this project's earlier missions took (the integration's checks).
    finaleSeconds: (projectId, runId, before) =>
      (finaleRows.all(projectId, runId, before ?? '') as { commands: string }[]).flatMap((r) => {
        try {
          const total = (JSON.parse(r.commands) as { durationMs?: number }[]).reduce((n, c) => n + (c.durationMs ?? 0), 0) / 1000
          return total > 0 ? [total] : []
        } catch {
          return []
        }
      }),
    // 0.9.1: the run's check commands as its tasks ran them whole (not scoped, not skipped), the latest of each.
    fullChecksSeconds: (runId) => {
      const run = repos.runs.get(runId)
      if (run === null) return null
      const configured = Object.entries(run.config.checks).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
      if (configured.length === 0) return null
      const latest = new Map<string, number>()
      for (const row of taskCheckRows.all(runId) as { commands: string }[]) {
        try {
          for (const c of JSON.parse(row.commands) as { name?: string; command?: string; durationMs?: number; output?: string }[]) {
            const whole = configured.some(([n, cmd]) => n === c.name && cmd === c.command) && (c.durationMs ?? 0) > 0 && !(c.output ?? '').startsWith('[')
            if (whole && c.name !== undefined && !latest.has(c.name)) latest.set(c.name, (c.durationMs ?? 0) / 1000)
          }
        } catch {
          // A row that cannot be read measures nothing.
        }
      }
      return configured.every(([n]) => latest.has(n)) ? [...latest.values()].reduce((a, b) => a + b, 0) : null
    },
    onChange: (snapshot, why) => {
      push({ kind: 'progress', snapshot })
      for (const listener of progressListeners) listener(snapshot, why)
    },
  })
  // What a run waits on beyond its own state: the network (set by the connectivity supervisor), or a decision
  // of the user's on a boundary request of that mission.
  let network: NetworkResilience | null = null
  const progressWaitOf = (run: Run): { kind: 'WAITING_FOR_NETWORK' | 'WAITING_FOR_PROVIDER' | 'WAITING_FOR_USER_BOUNDARY'; detail: string } | null => {
    if (TERMINAL_RUN_STATES.includes(run.state)) return null
    const offline = network?.waitOf() ?? null
    if (offline !== null) return offline
    // A request that some task waits on while others work is a blocker of that task, not a wait of the mission.
    if (repos.tasks.listByRun(run.id).some((t) => t.state === 'running' || t.state === 'assigned')) return null
    const pending = repos.boundaryRequests.listPending(run.projectId).filter((r) => r.runId === run.id)
    return pending.length > 0 ? { kind: 'WAITING_FOR_USER_BOUNDARY', detail: `${pending.length} boundary ${pending.length === 1 ? 'request' : 'requests'} to decide` } : null
  }
  const QUIET_FOR_PROGRESS = new Set(['agent.usage', 'agent.tool.started', 'agent.tool.completed', 'agent.message', 'agent.state_changed', 'context.composed'])
  bus.subscribe((event) => {
    if (QUIET_FOR_PROGRESS.has(event.type)) return
    try {
      progress.refresh(event.runId)
    } catch (e) {
      console.error(`[nexus] progress: ${errorMessage(e)}`)
    }
  })
  const progressTick = setInterval(() => {
    for (const runId of progress.open()) {
      try {
        progress.refresh(runId)
      } catch (e) {
        console.error(`[nexus] progress: ${errorMessage(e)}`)
      }
    }
  }, 30_000)
  progressTick.unref()

  // UI tests answer confirmations through the window they drive: with the scripted runtime, or in an acceptance
  // run of a development build that says so. Never in a package: there the question is always the runtime's own.
  const confirmThroughWindow =
    !host.isPackaged && ((env['NEXUS_FAKE_RUNTIME'] === '1' && env['NEXUS_FAKE_CONFIRM'] === 'window') || env['NEXUS_ACCEPT_CONFIRM'] === 'window')
  /**
   * A question to the user. A confirmation (power control, trusting a case, a settings change that starts a
   * program, stopping while work runs) is shown by the runtime process itself and never travels over the pipe:
   * a client of the pipe, which only has to hold the token, must not be able to answer the question it caused.
   * Without a way to show it, the answer is no. A folder picker carries no authority (a path can be given
   * directly) and is shown by the connected window.
   */
  const ask = (request: UiRequest): Promise<UiResponse> => {
    if (request.kind === 'confirm') {
      if (confirmThroughWindow && server && server.clientCount('desktop') > 0)
        return server.requestUi(request)
      if (host.ask) return host.ask(request)
      return Promise.reject(
        new Error('This runtime has no way to ask the user, so the answer is no.'),
      )
    }
    if (server && server.clientCount('desktop') > 0) return server.requestUi(request)
    if (host.ask) return host.ask(request)
    return Promise.reject(new Error('No NEXUS window is connected to answer this.'))
  }
  const confirm = async (
    title: string,
    message: string,
    detail: string,
    accept: string,
  ): Promise<boolean> => {
    const answer = await ask({
      kind: 'confirm',
      level: 'warning',
      title,
      message,
      detail,
      buttons: [accept, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    return 'response' in answer && answer.response === 0
  }
  const pickDirectory = async (title: string): Promise<string | null> => {
    const answer = await ask({ kind: 'pickDirectory', title })
    return 'path' in answer ? answer.path : null
  }

  // The scripted runtime exists for UI tests only and cannot be enabled in a packaged build.
  const useFake = !host.isPackaged && env['NEXUS_FAKE_RUNTIME'] === '1'
  const fakeRuntime = useFake
    ? new FakeAgentRuntime({ script: createDemoScript(), cache: new FakeCacheSim() })
    : null
  // UI tests choose what the scripted runtime says about usage: `unknown` = no usage report at all (what a
  // runtime without that method looks like), a number = the plan window's reported percentage.
  const fakeUsage = env['NEXUS_FAKE_USAGE']
  if (fakeRuntime && fakeUsage === 'unknown') fakeRuntime.usage.set({ reportSupported: false })
  else if (fakeRuntime && fakeUsage && Number.isFinite(Number(fakeUsage)))
    fakeRuntime.usage.set({ utilizationPercent: Number(fakeUsage) })
  const claudeRuntime: AgentRuntime =
    fakeRuntime ??
    new ClaudeSdkRuntime({
      executablePath: settings.claude.executablePath || undefined,
      resolveExecutable: () =>
        resolveClaudeExecutable({
          ...(host.resourcesPath ? { resourcesPath: host.resourcesPath } : {}),
        }),
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
        ? {
            fake: {
              script:
                env['NEXUS_FAKE_WORKERS_SCRIPT'] === 'probe'
                  ? ('probe' as const)
                  : ('demo' as const),
            },
          }
        : {
            claude: {
              ...(current.claude.executablePath
                ? { executablePath: current.claude.executablePath }
                : {}),
              ...(host.resourcesPath ? { resourcesPath: host.resourcesPath } : {}),
              debug: current.advanced.debugSdk,
            },
            codex: { version: codexVersion },
          }),
    }
  }
  const heartbeatTimeout = testNumber(host, 'NEXUS_WORKER_HEARTBEAT_TIMEOUT_MS')
  const workerManager = useWorkers
    ? new WorkerManager({
        workers: repos.workers,
        leases: repos.workerLeases,
        bootId: identity.bootId,
        launcher: forkLauncher({
          entry: host.worker.entry,
          ...(host.worker.execPath ? { execPath: host.worker.execPath } : {}),
          env,
          killTree: killProcessTree,
          logger,
        }),
        config: workerConfig,
        workingState: (cwd) => git.workingState(cwd),
        // One worker per agent session the queue may run, and one more for probes and reasoning sessions.
        maxWorkers: () => control.limits().maxAgents + 1,
        context: (agentId) => {
          const agent = repos.agents.get(agentId)
          return { runId: agent?.runId ?? null, taskId: agent?.taskId ?? null }
        },
        ...(heartbeatTimeout !== undefined
          ? { timings: { heartbeatTimeoutMs: heartbeatTimeout } }
          : {}),
        onChange: () => push({ kind: 'runtime' }),
        logger,
      })
    : null
  // Before anything can start a session: what the earlier start of the runtime left behind is stale.
  const staleWorkers = workerManager
    ? workerManager.recoverOnBoot()
    : { workers: repos.workers.listLive().length, leases: repos.workerLeases.listActive().length }
  if (!workerManager) {
    // Sessions run in this process: no worker of an earlier start can be alive under this runtime.
    const at = new Date().toISOString()
    for (const worker of repos.workers.listLive())
      repos.workers.save({
        ...worker,
        state: 'STOPPED',
        stoppedAt: at,
        error: 'The runtime restarted; this worker belonged to its earlier start.',
        assignment: null,
      })
    for (const lease of repos.workerLeases.listActive())
      repos.workerLeases.end(
        lease.id,
        'EXPIRED',
        at,
        'The runtime restarted while the lease was held.',
      )
  }
  recoveryRecord.workers = staleWorkers.workers
  recoveryRecord.leases = staleWorkers.leases
  const hosted = (provider: string, runtime: AgentRuntime): AgentRuntime =>
    workerManager ? hostInWorkers(provider, runtime, workerManager) : runtime

  // v0.6: every session passes through the provider router. Claude is the required provider; the others are
  // detected, off until the user enables them, and never needed. With the scripted runtime (UI tests) the
  // other providers are scripted too, so no test ever reaches a real provider.
  const subscriptionMode = (): boolean => repos.settings.get().claude.subscriptionMode
  const probeCwd = (): string => host.tempDir
  const providers = new ProviderService({
    providers: fakeRuntime
      ? [
          new FakeRuntimeProvider('claude', hosted('claude', fakeRuntime), {
            authDetail: 'Scripted runtime',
            health: 'healthy',
          }),
          new FakeRuntimeProvider(
            'codex',
            hosted('codex', new FakeAgentRuntime({ script: createDemoScript() })),
            {
              capabilities: CODEX_CAPABILITIES,
              ...(env['NEXUS_FAKE_CODEX'] === 'auth'
                ? { auth: 'auth_required' as const, health: 'unavailable' as const }
                : {}),
            },
            'scripted-codex',
          ),
          new FakeRuntimeProvider('gemini', null, {
            installed: 'not_installed',
            version: null,
            auth: 'unknown',
            authDetail: null,
            supportDetail: 'The Gemini command line tool was not found on PATH.',
            health: 'unavailable',
          }),
        ]
      : [
          new ClaudeAgentRuntimeProvider({
            runtime: hosted('claude', claudeRuntime),
            subscriptionMode,
            probeCwd,
          }),
          new CodexRuntimeProvider({
            probeCwd,
            snapshot: (cwd) => git.workingState(cwd),
            host: (runtime) => hosted('codex', runtime),
          }),
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
  attachAdviceOutcomes(bus, repos, logger)

  // 0.8: enrolled projects, grants and boundary requests. A new request is one notification; the same need met
  // again changes nothing the user sees but its count.
  const autonomy = new AutonomyService({
    repos,
    contained: (projectId) => isolation.isolated(projectId),
    confined: (projectId) => isolation.contained(projectId),
    // The applications NEXUS launched for a session: a fetch from one of their ports is the project's own endpoint.
    localPorts: (session) => apps.portsOf(session),
    runActive: (runId) => {
      const run = repos.runs.get(runId)
      return run !== null && !TERMINAL_RUN_STATES.includes(run.state)
    },
    onChange: (change) => {
      const pending = repos.boundaryRequests.countPending()
      push({ kind: 'autonomy', pending })
      if (change.kind === 'enrollment') protectStores()
      // 0.8: the user's answer restarts what waited for it. After the decision is stored, not inside its transaction.
      if (change.kind === 'request' && change.created !== true && change.request && (change.request.state === 'GRANTED' || change.request.state === 'DENIED')) {
        const decided = change.request
        setImmediate(
          () =>
            void boundaryResumer
              ?.decided(decided)
              // What was done is part of what the inbox shows: the window reads it again.
              .then(() => push({ kind: 'autonomy', pending: repos.boundaryRequests.countPending() }))
              .catch((e: unknown) => logger(`autonomy: auto-resume failed: ${errorMessage(e)}`)),
        )
      }
      if (change.kind === 'request' && change.created === true && change.request) {
        // On the task's own record too, where whoever checks the task finds it: that the action was put to the
        // user and did not happen is a fact of the task, not something to take from the session that asked.
        recordBoundaryEvidence(repos, change.request)
        const text = pending === 1 ? '1 boundary request is waiting for your decision.' : `${pending} boundary requests are waiting for your decision.`
        announceBoundary?.(change.request.projectId, text)
      }
    },
  })
  let announceBoundary: ((projectId: string, text: string) => void) | null = null
  let boundaryResumer: BoundaryResumer | null = null
  // What contained code must not read is marked when there is a project whose code is contained, and not before.
  function protectStores(): void {
    // The sandbox account keeps its access to the Git data of the projects that are enrolled, and of no other.
    const enrolledGitDirs = repos.projects.list().filter((p) => repos.enrollments.get(p.id) !== null).map((p) => join(p.rootPath, '.git'))
    void executionBroker.revokeGitExcept(enrolledGitDirs).catch((e: unknown) => logger(`isolation: taking back Git access failed: ${errorMessage(e)}`))
    if (repos.enrollments.count() === 0) {
      void isolation.unprotect().catch((e: unknown) => logger(`isolation: removing the protection failed: ${errorMessage(e)}`))
      return
    }
    void isolation.protect({ userStores: host.protectUserStores === true }).catch((e: unknown) => logger(`isolation: protection failed: ${errorMessage(e)}`))
  }
  protectStores()
  let announceIsolationFailure: ((subject: string, detail: string) => void) | null = null
  autonomy.watch(bus)
  // A containment that was asked for and could not be made: on record, and worth telling the user, because
  // work in that project now runs nothing until it is put right.
  isolationFailed = (projectId, detail) => {
    autonomy.record({ projectId, runId: null, taskId: null, agentId: null, severity: 'ISOLATION_FAILURE', action: 'containment', resource: 'execution profile', reason: detail })
    announceIsolationFailure?.(projectId ?? 'machine', detail)
  }
  // 0.8: web research. NEXUS's own fetch under the public-research policy: no credential, no body, no local
  // or private address, every redirect judged again. The texts and the quarantine are under the data directory,
  // which no worktree is in.
  const researchPolicy = policyForPurpose('PUBLIC_RESEARCH', {})
  const browserProvider = new PlaywrightDirectProvider()
  const research = new WebResearchProvider({
    artifacts: repos.researchArtifacts,
    downloads: repos.researchDownloads,
    dir: join(dataDir, 'research'),
    guard: () => ({ policy: researchPolicy }),
    searchUrl: DEFAULT_SEARCH_URL,
    // 0.8: pages that show nothing until their script has run are rendered in a browser of NEXUS's own, behind the
    // same public-only filter, with a profile made for the page and thrown away.
    ...(browserProvider.availability().browser !== null ? { render: (url: string, guard: GuardOptions) => renderPublicPage(browserProvider, url, guard, { artifactsDir: join(dataDir, 'research', 'browser') }) } : {}),
    onNetwork: (context, event) => {
      // What was refused is a denial worth keeping; what was reached is in the artifact that came of it.
      if (!event.allowed) autonomy.record({ projectId: context.projectId, runId: context.runId, taskId: context.taskId, agentId: null, severity: 'POLICY_DENIAL', action: `${event.via} ${event.method}`, resource: `host: ${event.host}:${event.port}`, reason: `Refused by the research network policy (${event.denial ?? 'policy'}).` })
    },
  })
  bus.subscribe((event) => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') research.forget(event.runId)
  })
  // 0.8: the application a project builds, started inside its containment and looked at by a browser of
  // NEXUS's own. The browser of a session reaches the endpoint the session registered and nothing else; the
  // runtime's own loopback services are named so that no policy ever lets it reach them.
  const apps = new ApplicationUnderTestManager({
    broker: executionBroker,
    browser: browserProvider,
    profileFor: (projectId) => isolation.profileFor(projectId),
    artifactsDir: join(dataDir, 'app-sessions'),
    forbiddenLocalPorts: () => (depsProxy ? [depsProxy.port] : []),
    onNetwork: (owner, event) => {
      if (!event.allowed) autonomy.record({ projectId: owner.projectId, runId: owner.runId, taskId: owner.taskId, agentId: null, severity: 'POLICY_DENIAL', action: `app browser ${event.method}`, resource: `host: ${event.host}:${event.port}`, reason: `Refused by the network policy of the application under test (${event.denial ?? 'policy'}).` })
    },
    onChange: () => push({ kind: 'apps' }),
  })
  bus.subscribe((event) => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled' || event.type === 'run.paused') void apps.stopForRun(event.runId).catch(() => undefined)
  })
  const researchTools = createResearchTools({
    research,
    gateFor: (session) => autonomy.gateFor({ projectId: session.run.projectId, runId: session.run.id, taskId: session.task?.id ?? null, role: session.role, provider: null, cwd: session.cwd }),
    legacyNetworkTools: () => repos.settings.get().permissions.allowNetworkTools,
    policy: () => researchPolicy,
    secrets: () => Object.entries(process.env).flatMap(([name, value]) => (value !== undefined && value.length >= 12 && isSecretEnvName(name) ? [value] : [])),
    record: (session, severity, action, resource, reason) => autonomy.record({ projectId: session.run.projectId, runId: session.run.id, taskId: session.task?.id ?? null, agentId: session.agentId, severity, action, resource, reason }),
  })
  const appTools = createAppTools({
    apps,
    recordEvidence: (session, title, content) => {
      const taskIds = session.task ? [session.task.id, ...(session.task.parentTaskId ? [session.task.parentTaskId] : [])] : [null]
      for (const taskId of taskIds) repos.artifacts.insert({ id: randomUUID(), runId: session.run.id, taskId, agentId: session.agentId, kind: 'app-evidence', title: cleanAgentText(title), content: cleanAgentText(content), createdAt: new Date().toISOString() })
    },
    gateFor: (session) => autonomy.gateFor({ projectId: session.run.projectId, runId: session.run.id, taskId: session.task?.id ?? null, role: session.role, provider: null, cwd: session.cwd }),
  })
  const packageConfigTools = createPackageConfigTools({
    gateFor: (session) => autonomy.gateFor({ projectId: session.run.projectId, runId: session.run.id, taskId: session.task?.id ?? null, role: session.role, provider: null, cwd: session.cwd }),
  })
  // 0.9.1: privilege sessions: one UAC prompt for a mission or a night, a temporary broker that holds the elevated
  // token, every privileged attempt checked, reviewed and recorded. The reviewers come from the advisory routing
  // built further down (asked only when an operation is submitted).
  const privilegeHost = createPrivilegeHost({
    db,
    dataDir,
    launcherPath: host.launcherPath,
    resourcesPath: host.resourcesPath,
    sandboxSetupDir: host.sandboxSetupDir,
    isPackaged: host.isPackaged,
    env,
    runtimePid: process.pid,
    projectRoots: (runId) => {
      const run = runId !== null ? repos.runs.get(runId) : null
      if (!run) return []
      const project = repos.projects.get(run.projectId)
      return [...(project ? [project.rootPath] : []), ...repos.worktrees.listByRun(run.id).map((w) => w.path)]
    },
    reviewers: (projectId, operationId) => advisoryRouting.service.providers(projectId ?? 'nexus', operationId, 'DIRECTOR'),
    securityEvent: (e) => autonomy.record({ projectId: e.projectId, runId: e.runId, taskId: e.taskId, agentId: e.agentId, severity: e.severity, action: e.action, resource: 'privilege session', reason: e.reason.slice(0, 600) }),
    onChange: (status) => push({ kind: 'privilege', status }),
    // 0.9.1 (review F3): natively, as Overnight's authorization: no page script can answer it; nobody there is a no.
    confirmOwner: (o) => confirm(o.title, o.message, o.detail, 'Run as administrator').catch(() => false),
    // 0.9.1 (second review, H1): a mission whose commands run as the owner, outside any containment (a project that is
    // not enrolled, or no containment on this machine), could reach the broker's relay as the owner and use the
    // session. No session while one is in progress, and none for such a mission itself.
    blockedBy: (runId) => {
      const uncontained = repos.runs.listActive().filter((r) => !isolation.contained(r.projectId))
      const own = runId !== null ? repos.runs.get(runId) : null
      if (own && !isolation.contained(own.projectId)) return "This mission's project does not run its commands inside NEXUS's containment, so its agents act as you: administrator sessions are offered only to contained projects (enroll the project, with the sandbox set up)."
      if (uncontained.length > 0) return `A mission of a project whose commands are not contained is in progress (${uncontained[0]?.prompt.split('\n')[0]?.slice(0, 80) ?? 'a mission'}): no administrator session while it runs.`
      return null
    },
    log: logger,
  })
  bus.subscribe((event) => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      void privilegeHost.service?.endForRun(event.runId, `the run ${event.type.slice(4)}`).catch(() => undefined)
      // 0.9.1 (second review, L2): an UNTIL_IDLE session ends when no mission is left.
      if (repos.runs.listActive().length === 0) void privilegeHost.service?.idle().catch(() => undefined)
    }
    // A mission of an uncontained project that starts now ends the session in progress (second review, H1).
    if (event.type === 'run.created' || event.type === 'run.started') void privilegeHost.service?.recheck().catch(() => undefined)
  })
  const privilegedTools = createPrivilegedTools({ service: () => privilegeHost.service })
  // 0.9.1: zero-disturbance testing: the presence meter and the per-mission metrics of what NEXUS's work did to the
  // owner's screen.
  const presentationHost = createPresentationHost({
    db,
    launcherPath: host.launcherPath,
    isPackaged: host.isPackaged,
    scripted: !host.isPackaged && (env['NEXUS_FAKE_RUNTIME'] === '1' || env['NEXUS_FAKE_WORKERS'] === '1'),
    env,
    runtimePid: process.pid,
    uacPrompts: (runId) => privilegeHost.uacPrompts(runId),
    quietCommands: () => executionBroker.quietCount(),
    onChange: (runIds) => push({ kind: 'presentation', runIds }),
    log: logger,
  })
  const extensionTools = combineExtensions(researchTools, appTools, packageConfigTools, privilegedTools)
  // The worker admission is built further down; the scheduler asks it before it retries a held task.
  let heldTaskReady: ((taskId: string) => Promise<boolean>) | null = null
  const orchestrator = new Orchestrator({
    repos,
    bus,
    runtime,
    capacityReady: (taskId) => (heldTaskReady ? heldTaskReady(taskId) : Promise.resolve(true)),
    git,
    worktrees: new WorktreeManager(git, worktreesDir),
    push,
    logger,
    strategies: policy,
    requireEngineeringAdmission: true,
    autonomy,
    extensions: extensionTools,
    execution: isolation,
    // 0.9: a session that ended because the provider could not be reached is a wait. Judged by the network
    // supervisor, which is started further down (and not at all where agents are scripted).
    networkLoss: (error) => network?.networkLoss(error) ?? false,
  })
  orchestrator.setDispatchGate(usage)
  boundaryResumer = new BoundaryResumer({
    repos,
    orchestrator,
    enrolled: (projectId) => repos.enrollments.get(projectId) !== null,
    record: (request, action, reason) => autonomy.record({ projectId: request.projectId, runId: request.runId, taskId: request.taskId, agentId: null, severity: 'NORMAL_AUTONOMOUS_ACTION', action, resource: boundaryResumeResource(request.id), reason: reason.slice(0, 600) }),
    logger,
  })
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
    power = useFakePower
      ? new FakePowerController({ logFile: join(dataDir, 'fake-power.log') })
      : new WindowsPowerController()
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
        privilege: { endForRun: (runId, reason) => privilegeHost.service?.endForRun(runId, reason) ?? Promise.resolve(), section: (runId) => `${privilegeHost.section(runId)}\n\n${presentationHost.service.section(runId)}` },
        ...(overnightTick !== undefined && overnightTick >= 100
          ? { tickIntervalMs: overnightTick }
          : {}),
        logger,
      })
    : undefined
  let awake = false
  // 0.9: held for an Overnight run as before, and also while any mission, Program or Workspace run is working or
  // will resume by itself (the guard of the network module decides that, and lets go when nothing moves for hours).
  let guardWantsAwake = false
  keepAwake = () => {
    // Windows must not suspend the runtime in the middle of unattended work.
    const wanted = phase !== 'STOPPING' && ((overnight?.hasActive() ?? false) || guardWantsAwake)
    if (wanted === awake) return
    awake = wanted
    host.setKeepAwake?.(wanted)
    logger(`power: the idle-sleep request is ${wanted ? 'held' : 'released'}`)
  }
  keepAwake()
  let voiceNetworkChanged: () => void = () => undefined
  // Network resilience. Not where agents are scripted (the tests of the runtime make no connectivity check),
  // unless a test asks for it.
  const scripted = env['NEXUS_FAKE_RUNTIME'] === '1' || env['NEXUS_FAKE_WORKERS'] === '1'
  if (process.platform === 'win32' && (!scripted || env['NEXUS_NETWORK_RESILIENCE'] === '1') && env['NEXUS_NETWORK_RESILIENCE'] !== '0') {
    const lastProgress = db.prepare('SELECT MAX(finished_at) AS at FROM tasks WHERE run_id = ?')
    const openRunRows = db.prepare("SELECT id FROM runs WHERE state NOT IN ('completed', 'failed', 'cancelled')")
    network = startNetworkResilience({
      ...(host.launcherPath !== undefined ? { wlanHelperPath: join(dirname(host.launcherPath), 'nexus-wlan.exe') } : {}),
      providerHosts: () => ['api.anthropic.com'],
      quota: () => null,
      openRuns: () => (openRunRows.all() as { id: string }[]).flatMap((r) => repos.runs.get(r.id) ?? []),
      workOf: (run) => {
        const at = (lastProgress.get(run.id) as { at: string | null }).at
        const kind = repos.overnight.getByRun(run.id) !== null ? 'OVERNIGHT' : 'LONG_MISSION'
        const waitsOnBoundary = repos.boundaryRequests.listPending(run.projectId).some((r) => r.runId === run.id) && !repos.tasks.listByRun(run.id).some((t) => t.state === 'running' || t.state === 'assigned')
        return { kind, lastProgressAt: Date.parse(at ?? run.startedAt ?? run.createdAt), waitsOnBoundary }
      },
      resumeRun: (runId) => orchestrator.resumeRun(runId),
      setKeepAwake: (on) => {
        guardWantsAwake = on
        keepAwake()
      },
      policy: () => repos.settings.get().execution.networkRecovery ?? null,
      store: sqliteOutageStore(db),
      onState: (snapshot) => {
        push({ kind: 'connectivity', snapshot })
        for (const runId of progress.open()) progress.refresh(runId)
        // 0.9.1: the voice line registers again when the network is back or has changed.
        voiceNetworkChanged()
      },
      logger,
    })
    const networkOf = network
    bus.subscribe((event) => {
      if (event.type.startsWith('run.') || event.type === 'task.completed') networkOf.workChanged()
    })
    networkOf.workChanged()
  }

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
    usage: {
      canDispatch: () => usage.canDispatch(),
      onChange: (listener) => usage.onChange(listener),
    },
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
    (id) =>
      new ArenaCampaignWorkload(id, {
        repos,
        host: arena,
        quotaResetsAt: () => usage.machineState().resetAt,
        now: () => Date.now(),
        log: logger,
      }),
    arena,
  )
  // Programs: long-horizon goals pursued across milestones. The engine owns the state; missions and the
  // reasoning sessions (plan, verify, reassess) are ordinary runs of the orchestrator.
  const chatgpt = new ChatGPTConnection(
    dataDir,
    host.protectedStorage,
    host.openBrowser,
    fetch,
    new CapacityRegistry(repos.intelligenceArtifacts),
  )
  const intelligenceOperations = new IntelligenceOperations()
  const advisoryRouting = createProductionAdvisoryRouting({
    repos,
    providers,
    usage,
    chatgpt,
    bootId: identity.bootId,
    dataDir,
    maxAgents: () => control.limits().maxAgents,
  })
  const workerRouting = new WorkerCapacityRouting({
    repos, providers, usage, bootId: identity.bootId, dataDir,
    maxAgents: () => control.limits().maxAgents,
    earlierStart: { pids: earlierWorkerPids, isProcessStopped: processStopped },
  })
  heldTaskReady = (taskId) => workerRouting.taskReady(taskId)
  const taskAdmission = new TaskAdmissionService(
    repos,
    git,
    chatgpt,
    intelligenceOperations,
    undefined,
    advisoryRouting.service,
  )
  const programs = new ProgramEngine({
    repos,
    bus,
    git,
    host: orchestrator,
    admission: taskAdmission,
    usage: {
      canDispatch: () => usage.canDispatch(),
      onChange: (listener) => usage.onChange(listener),
    },
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
    addBacklog: (projectId, programId, proposals, provenance) =>
      programs.addBacklog(projectId, programId, proposals, provenance),
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
    admission: taskAdmission,
    projects: new ProjectService(repos, git, logger),
    usage: {
      canDispatch: () => usage.canDispatch(),
      onChange: (listener) => usage.onChange(listener),
    },
    push,
    logger,
  })
  // A cross-repository mission can be an overnight workload.
  overnight?.registerWorkload(
    'workspace_mission',
    (id) =>
      new WorkspaceMissionWorkload(id, {
        host: workspaces,
        get: (missionId) => repos.workspaceMissions.get(missionId),
        quotaResetsAt: () => usage.machineState().resetAt,
      }),
  )
  // A program can be an overnight workload for one autonomous work window.
  overnight?.registerWorkload(
    'program',
    (id) =>
      new ProgramWorkload(id, {
        host: programs,
        get: (programId) => repos.programs.get(programId),
        quotaResetsAt: () => usage.machineState().resetAt,
      }),
  )

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
    adapters: createWorkloadAdapters(repos, {
      orchestrator,
      programs,
      arena,
      workspaces,
      background: backgroundJobs,
      defaultAgents: () => repos.settings.get().execution.maxParallelAgents,
    }),
    usage: {
      canDispatch: () => usage.canDispatch(),
      onChange: (listener) => usage.onChange(listener),
    },
    unownedActiveWorkloads: () =>
      unownedActiveWorkloads(repos, () => repos.settings.get().execution.maxParallelAgents),
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
        const active = activeAgentsOf(
          repos,
          repos.runs.listActive().map((r) => r.id),
        )
        if (!workerManager)
          return {
            level: 'HEALTHY',
            detail: `${active} scripted agent session${active === 1 ? '' : 's'} running inside the runtime (no worker processes with the scripted runtime).`,
          }
        const counts = workerManager.counts()
        const failed = repos.workers
          .listEnded(10)
          .filter(
            (w) =>
              w.state === 'FAILED' &&
              w.bootId === identity.bootId &&
              w.stoppedAt !== null &&
              Date.now() - Date.parse(w.stoppedAt) < 5 * 60_000,
          ).length
        if (failed > 0)
          return {
            level: 'DEGRADED',
            detail: `${failed} worker${failed === 1 ? '' : 's'} failed in the last five minutes; their sessions were taken back. ${counts.live} worker process${counts.live === 1 ? '' : 'es'} alive, ${counts.busy} holding a session.`,
          }
        return {
          level: 'HEALTHY',
          detail: `${counts.live} worker process${counts.live === 1 ? '' : 'es'} alive, ${counts.busy} holding a session${counts.waitingAssignments > 0 ? `, ${counts.waitingAssignments} session${counts.waitingAssignments === 1 ? '' : 's'} waiting for a worker` : ''}.`,
        }
      },
      providers: () => {
        const claude = providers.list().find((s) => s.id === 'claude')
        if (!claude) return { level: 'RECOVERING', detail: 'Providers are being detected.' }
        if (claude.auth === 'auth_required')
          return { level: 'BLOCKED', detail: 'Claude needs authentication.' }
        return claude.health === 'unavailable'
          ? { level: 'DEGRADED', detail: claude.healthDetail ?? 'Claude is unavailable.' }
          : { level: 'HEALTHY', detail: `Claude: ${claude.authDetail ?? 'available'}.` }
      },
      usage: () =>
        usage.canDispatch()
          ? { level: 'HEALTHY', detail: `Claude usage: ${usage.status()}.` }
          : {
              level: 'RECOVERING',
              detail: `Waiting for Claude usage (${usage.status()}). Work continues by itself after the reset.`,
            },
      power_supervisor: () =>
        overnight
          ? {
              level: 'HEALTHY',
              detail:
                overnight.active().length > 0
                  ? 'An overnight run holds the shutdown timer.'
                  : 'No end-of-run action is armed.',
            }
          : {
              level: 'HEALTHY',
              detail: 'The overnight supervisor is not available on this platform.',
            },
      git: () => ({ level: 'HEALTHY', detail: 'Git operations go through the Git service.' }),
      ipc: () => {
        const windows = server?.clientCount('desktop') ?? 0
        if (!server) return { level: 'RECOVERING', detail: 'The local server is starting.' }
        return {
          level: 'HEALTHY',
          detail: `${windows} window${windows === 1 ? '' : 's'} connected over a local pipe (protocol ${RUNTIME_PROTOCOL_VERSION}, authenticated). Nothing listens on the network.`,
        }
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
  announceBoundary = (projectId, text) => control.announce('boundary_request', projectId, text, 'Open NEXUS to decide. Work that does not depend on it goes on.')
  announceIsolationFailure = (subject, detail) => control.announce('isolation_failure', subject, 'Project code could not be contained', `${detail.slice(0, 200)} Nothing was run outside the containment.`)
  const securityNotifier = notifier
  repos.securityDecisions.onRecord = (entry) => securityNotifier.onSecurityDecision(entry)

  orchestrator.setDispatchGate({
    canDispatch: (runId) => {
      // Physical fairness is global; provider/quality/allowance admission is enforced per session.
      if (!runId) return true
      const run = repos.runs.get(runId)
      return (
        !run ||
        control.hasCapacityForRun(
          runId,
          run.config.maxParallelAgents,
          activeAgentsOf(repos, [runId]),
        )
      )
    },
    limit: (normal, runId) => {
      // The ramp after Claude returns (one new session at a time at first) still applies. While Claude is
      // limited the count is not cut here: admission decides per session, so work another provider may take goes on.
      const byUsage = usage.canDispatch() ? usage.limit(normal) : normal
      return runId
        ? Math.min(byUsage, control.allowanceForRun(runId, normal, activeAgentsOf(repos, [runId])))
        : byUsage
    },
    onChange: (listener) => {
      const offUsage = usage.onChange(listener), offWorkers = workerRouting.onChange(listener)
      return () => { offUsage(); offWorkers() }
    },
  })
  const capacityRecoveryTimer = setInterval(() => {
    try {
      if (reclaimHostedLeases() > 0) logger('capacity: slots of an earlier start were freed; its processes are gone')
    } catch (e) {
      logger(`capacity lease reclamation: ${errorMessage(e)}`)
    }
    void workerRouting.recover((runId) => orchestrator.resumeRun(runId)).catch((e: unknown) => logger(`capacity recovery: ${errorMessage(e)}`))
  }, 2000)
  capacityRecoveryTimer.unref()

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
        repos.controlIncidents.insert({
          id: newId(),
          at: recoveryRecord.finishedAt,
          summary: `The runtime started and reconciled ${recoveryRecord.workloads} interrupted run(s), ${recoveryRecord.workers} stale worker(s) and ${recoveryRecord.leases} stale lease(s).`,
          itemId: null,
        })
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
    if (
      repos.workItems.listOpen().some((item) => item.state !== 'PAUSED' && item.state !== 'BLOCKED')
    )
      return 'Work is on the queue.'
    if (repos.controlSchedules.list().some((schedule) => schedule.enabled))
      return 'A schedule is switched on.'
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
    return {
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: megabytes(memory.rss),
      heapUsedMb: megabytes(memory.heapUsed),
      timers,
      handles: active.length - timers,
      dbMb: megabytes(fileSize(dbPath)),
      walMb: megabytes(fileSize(`${dbPath}-wal`)),
    }
  }
  const status = (): RuntimeStatus => ({
    ...identity,
    phase,
    recovery: { ...recoveryRecord },
    clients: {
      desktop: server?.clientCount('desktop') ?? 0,
      tool: server?.clientCount('tool') ?? 0,
    },
    dispatchPaused: control.dispatchPaused(),
    endpointAcl,
    keepAlive: { reason: keepAliveReason() },
    resources: resources(),
  })
  const workersOverview = (): WorkersOverview =>
    workerManager
      ? workerManager.overview()
      : {
          workers: repos.workers.listEnded(15),
          leases: repos.workerLeases.recent(30),
          limits: { maxWorkers: 0 },
          counts: { live: 0, busy: 0, idle: 0, waitingAssignments: 0 },
          enabled: false,
          events: repos.workers.recentEvents(40),
        }

  const tray = (): TraySnapshot => {
    const active = overnight?.active()[0] ?? null
    const run = active ? repos.runs.get(active.runId) : null
    const campaign =
      active?.workloadType === 'arena_campaign' ? repos.arenaCampaigns.get(active.runId) : null
    const program = active?.workloadType === 'program' ? repos.programs.get(active.runId) : null
    const overnightModel = overnight
      ? buildTrayModel({
          overnight: active,
          projectName: program
            ? program.name
            : campaign
              ? campaign.name
              : (run && repos.projects.get(run.projectId)?.name) || 'project',
          runState: program
            ? program.state === 'PAUSED' || program.state === 'BLOCKED'
              ? 'paused'
              : program.state
            : campaign
              ? campaign.state
              : (run?.state ?? null),
          activeAgents:
            campaign || program
              ? orchestrator.activeAgentCount()
              : active
                ? repos.agents.listActive(active.runId).length
                : 0,
          time: (iso) =>
            new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      : null
    const overview = control.overview()
    return {
      overnight: overnightModel,
      runtime: buildRuntimeTrayModel({
        phase,
        running: overview.active.length,
        waiting:
          overview.waiting.filter((i) => i.state !== 'BLOCKED').length + overview.scheduled.length,
        blocked: overview.waiting.filter((i) => i.state === 'BLOCKED').length,
        agents: overview.agents.active,
        health: overview.health.level,
        dispatchPaused: overview.dispatchPaused,
      }),
    }
  }

  const openDesktop = (view: 'control' | null): void => {
    if (server && server.clientCount('desktop') > 0) push({ kind: 'desktop', action: 'show', view })
    else host.launchDesktop?.()
  }

  let stopping: Promise<boolean> | null = null
  const stop = async (): Promise<boolean> => {
    phase = 'STOPPING'
    intelligenceOperations.closeAdmission()
    clearInterval(capacityRecoveryTimer)
    clearInterval(progressTick)
    clearInterval(lineTick)
    void directorLine.stop().catch(() => undefined)
    // No administrator broker outlives the runtime (it would end with it anyway: it watches this process).
    void privilegeHost.service?.dispose().catch(() => undefined)
    void presentationHost.stop().catch(() => undefined)
    void localSpeech.dispose().catch(() => undefined)
    void network?.stop().catch(() => undefined)
    chatgpt.dispose()
    const advisoryStopping = advisoryRouting.dispose()
    push({ kind: 'runtime' })
    keepAwake()
    try {
      // A finalization in flight (report, power step) finishes before the database closes. An armed
      // overnight failsafe is left alone: it belongs to Windows and outlives this process on purpose.
      await (overnight
        ? Promise.race([overnight.idle(), new Promise((resolve) => setTimeout(resolve, 30_000))])
        : Promise.resolve())
      overnight?.dispose()
      await advisoryStopping
      await intelligenceOperations.idle()
      await chatgpt.idle()
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
      await apps.stopAll().catch(() => undefined)
      // Session admission closes only now. The orchestrator has given every unit of work its stop reason, so a
      // session refused from here on ends as stopped for shutdown. Closed earlier (it used to be the first step,
      // up to 30 s before), a session a running pipeline started in between ended stopped with no reason, which
      // reads as a crash: the task failed and an attempt was spent on a shutdown.
      workerRouting.closeAdmission()
      await workerManager?.shutdown()
      await workerRouting.dispose()
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
      const pending = overnight
        .active()
        .map((o) => overnight.pendingPowerAction(o.runId))
        .find((p) => p !== null)
      const answer = await ask({
        kind: 'confirm',
        level: 'warning',
        title: 'NEXUS',
        message: 'An overnight mission is still running.',
        detail: pending
          ? `Windows is set to ${pending.action === 'SHUTDOWN' ? 'shut down' : pending.action.toLowerCase()} this PC at ${new Date(pending.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. That timer belongs to Windows and stays armed after NEXUS stops.`
          : 'Stopping NEXUS stops the agents. The mission can be resumed the next time NEXUS starts.',
        buttons: [
          pending ? 'Stop NEXUS and leave the shutdown timer armed' : 'Stop NEXUS',
          'Cancel the mission and its shutdown, then stop',
          'Return',
        ],
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
      detail:
        'Stopping NEXUS stops their agent sessions. Finished tasks keep their results; the runs are paused and can be resumed the next time NEXUS starts. Closing only the window does not stop anything.',
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
    build: {
      ...BUILD_STAMP,
      runtimeProtocol: RUNTIME_PROTOCOL_VERSION,
      databaseSchema: MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0),
    },
    version: host.version,
    dataDir,
    dbPath,
    worktreesDir,
    platform: `${process.platform} ${process.arch}`,
    gitVersion: await git.version().catch(() => null),
    sdkVersion: host.sdkVersion,
    isPackaged: host.isPackaged,
  })

  // 0.9: the Director Line. It is given facts to read, pause and continue for the user's own missions, and the
  // ordinary creation of a mission; nothing that grants. Off until the user turns it on in Settings, with a
  // native confirmation; while off, nothing is polled and nothing is sent.
  const openRunIds = db.prepare("SELECT id FROM runs WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at")
  const lastOvernightReport = db.prepare("SELECT run_id FROM overnight_runs WHERE final_report IS NOT NULL ORDER BY rowid DESC LIMIT 1")
  const missionName = (run: Run): string => `${repos.projects.get(run.projectId)?.name ?? 'project'}: ${run.prompt.replace(/\s+/g, ' ').slice(0, 60)}`
  let createMissionFromLine: (input: { projectId: string; prompt: string }) => Promise<{ id: string }> = async () => {
    throw new Error('The runtime is still starting.')
  }
  const directorLineHost = createDirectorLineHost({
    openRuns: () => (openRunIds.all() as { id: string }[]).flatMap((r) => repos.runs.get(r.id) ?? []).filter((r) => !isReasoningRun(r)),
    projectName: (projectId) => repos.projects.get(projectId)?.name ?? null,
    projects: () => repos.projects.list().map((p) => ({ id: p.id, name: p.name })),
    progressOf: (runId) => progress.snapshot(runId),
    eventsOf: (runId, afterSeq) => repos.events.listByRun(runId, afterSeq, 5000),
    pendingBoundaryRequests: () => repos.boundaryRequests.countPending(),
    isOnline: () => network?.isOnline() ?? true,
    privilegedActivity: () => privilegedActivitySpoken(privilegeHost.service?.receipts({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), limit: 200 }) ?? []),
    latestOvernightReport: () => {
      try {
        const row = lastOvernightReport.get() as { run_id: string } | undefined
        return row === undefined ? null : (overnight?.report(row.run_id).text ?? null)
      } catch {
        return null
      }
    },
    pauseRun: (runId, detail) => orchestrator.pauseRun(runId, 'user', detail),
    resumeRun: (runId) => orchestrator.resumeRun(runId),
    createMission: (input) => createMissionFromLine(input),
    subscribe: (listener) => bus.subscribe(listener),
    logger,
  })
  // 0.9.1: speech for calls is recognised and made on this PC. Nothing of it is loaded where agents are scripted.
  const localSpeech = createLocalVoiceSpeech({ launcherPath: useFake ? undefined : host.launcherPath, resourcesPath: useFake ? undefined : host.resourcesPath, languages: ['en', 'fr'], log: (line) => logger(`director line: ${line}`) })
  const directorLine = createDirectorLineRuntime({
    db,
    secrets: protectedSecretStore(join(dataDir, 'director-line'), host.protectedStorage),
    fetch: ((url, init) => fetch(url, init as RequestInit)) as HttpFetch,
    reads: directorLineHost.reads,
    actions: directorLineHost.actions,
    isOnline: () => network?.isOnline() ?? true,
    localNotify: async (title, text) => host.notify?.(title, text.slice(0, 400)),
    recordNote: (note) => logger(`director line: refused a remote request (${note.topic})`),
    log: (line) => logger(`director line: ${line}`),
    // 0.9.1: the voice line (SIP). The session that words an answer is the plain runtime, not a worker session:
    // a call takes no slot from the work in progress.
    voice: createDirectorVoiceHost({
      launcherPath: host.launcherPath,
      resourcesPath: host.resourcesPath,
      dataDir,
      runtime: claudeRuntime,
      model: () => repos.settings.get().models.tiers.fast,
      subscriptionMode: () => repos.settings.get().claude.subscriptionMode,
      admitted: () => usage.canDispatch(),
      status: async () => composeStatus(await directorLineHost.reads.getStatus()),
      speech: localSpeech.speech,
      onCall: () => localSpeech.setHints(repos.projects.list().map((p) => p.name)),
      log: (line) => logger(`director line: ${line}`),
    }),
  })
  voiceNetworkChanged = () => directorLine.networkChanged()
  const lineReporter = new DirectorLineReporter({ report: (event) => directorLine.line.report(event), now: () => Date.now() })
  progressListeners.push((snapshot) => {
    const run = repos.runs.get(snapshot.subject.id)
    if (!run || isReasoningRun(run)) return
    const overnightText = snapshot.wait === 'FINISHED' && repos.overnight.getByRun(run.id) !== null ? (overnight?.report(run.id).text ?? null) : null
    lineReporter.onProgress(snapshot, missionName(run), overnightText)
  })
  const lineTick = setInterval(() => lineReporter.tick(), 60_000)
  lineTick.unref()
  void directorLine.start().catch((e: unknown) => logger(`director line: could not start: ${errorMessage(e)}`))
  // The models are loaded ahead only where the voice line is set up: they take some hundred megabytes.
  void directorLine
    .settingsView()
    .then((view) => (view.enabled && view.voice.configured ? localSpeech.warm() : undefined))
    .catch(() => logger('director line: the speech models could not be loaded ahead'))

  const handlers = createIpcHandlers({
    progress,
    directorLine,
    chatgpt,
    intelligenceOperations,
    taskAdmission,
    advisoryRouting: advisoryRouting.service,
    repos,
    git,
    runtime,
    orchestrator,
    ...(overnight ? { overnight } : {}),
    appInfo,
    push,
    // Shown by the window's main process (or natively by the runtime when no window is connected), never by
    // page script: a script in the page cannot click it. Without anyone to ask, the answer is no.
    confirmPower: (message, detail) =>
      confirm('NEXUS Overnight Mode', message, detail, 'Authorize').catch(() => false),
    autonomy,
    confirmAutonomy: (title, message, detail, accept) => confirm(title, message, detail.slice(0, 6000), accept).catch(() => false),
    presentation: { metrics: (runId) => presentationHost.service.metrics(runId) },
    privilege: {
      service: () => privilegeHost.service,
      unavailableReason: privilegeHost.unavailableReason,
      projectOfRun: (runId) => repos.runs.get(runId)?.projectId ?? null,
      // 0.9.1 (review F5): as Overnight's authorization, natively; nobody there is a no.
      confirm: (message, detail) => confirm('NEXUS administrator session', message, detail, 'Prepare').catch(() => false),
    },
    isolation: {
      status: () => ({ ...isolation.status(), setupAvailable: process.platform === 'win32' && host.sandboxSetupDir !== undefined && existsSync(join(host.sandboxSetupDir, 'setup-sandbox.ps1')) && host.launcherPath !== undefined && existsSync(host.launcherPath) }),
      setup: async () => {
        if (host.sandboxSetupDir === undefined || host.launcherPath === undefined) return { ok: false, detail: 'This build cannot set up the sandbox account.' }
        // The folder the account's credential is written to is closed to code at low integrity before the
        // credential exists, not at some later start.
        const stateDir = sandboxStateDir(env)
        if (stateDir !== null) {
          mkdirSync(stateDir, { recursive: true })
          await launcher.label('protect', stateDir).catch((e: unknown) => logger(`isolation: the sandbox state folder could not be protected before the setup: ${errorMessage(e)}`))
        }
        const outcome = await setupSandboxAccount({ launcher: host.launcherPath, scriptsDir: host.sandboxSetupDir, workDir: join(dataDir, 'sandbox', 'setup'), env })
        logger(`isolation: sandbox setup ${outcome.ok ? 'completed' : 'not completed'}`)
        if (outcome.ok) {
          // What the setup left is looked at as at a start, and the isolated profile is tried for real, now: the
          // window is told what is so, not what will be so after a restart.
          await checkSandboxAccount()
          await executionBroker.verify('ISOLATED', true).catch(() => undefined)
          await isolation.protect({ userStores: host.protectUserStores === true && repos.enrollments.count() > 0 }).catch((e: unknown) => logger(`isolation: protection failed: ${errorMessage(e)}`))
        }
        autonomy.record({ projectId: null, runId: null, taskId: null, agentId: null, severity: 'NORMAL_AUTONOMOUS_ACTION', action: 'sandbox setup', resource: 'machine', reason: outcome.detail.slice(0, 400) })
        return outcome
      },
      apps: () => apps.sessions(),
    },
    onSettingsSaved: (s) => applyWorkPriority(s),
    confirmSettings: (changes) =>
      confirm(
        'NEXUS Settings',
        changes.length === 1
          ? 'Allow this change to the NEXUS settings?'
          : `Allow these ${changes.length} changes to the NEXUS settings?`,
        changes
          .map((change) => `• ${change}`)
          .join('\n')
          .slice(0, 6000),
        'Allow',
      ).catch(() => false),
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
      confirmTrust: (message, detail) =>
        confirm('NEXUS Arena', message, detail, 'Trust and allow').catch(() => false),
    }),
    v4: createV4Handlers({ repos, programs, background: backgroundJobs }),
    v6: createV6Handlers({ providers }),
    v7: createV7Handlers({
      control,
      decisions: repos.schedulerDecisions,
      runtime: {
        status,
        workers: workersOverview,
        workerSelfTest: async () =>
          workerManager
            ? workerManager.selfTest()
            : {
                ok: false,
                pid: null,
                capabilities: [],
                milliseconds: 0,
                detail:
                  'Sessions run inside the runtime in this mode; there are no worker processes.',
              },
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

  // A task sent over the Director Line is created the way the window creates one: the same channel, the same
  // admission, Task Compiler and capability broker. The line adds nothing to it.
  createMissionFromLine = async ({ projectId, prompt }) => {
    const result = await dispatchIpc(handlers, 'runs.create', { projectId, mode: 'build', preset: repos.settings.get().execution.defaultPreset, prompt })
    if (!result.ok) throw new Error(result.error.message)
    return { id: (result.value as Run).id }
  }

  const token = newToken()
  const pipe = newPipeName(dataDir)
  server = new RuntimeServer({
    pipe,
    token,
    identity,
    // The dispatcher accepts a channel of the closed contract and an input that passes its schema, nothing else.
    dispatch: (channel, input) => dispatchIpc(handlers, channel, input),
    // 0.8: only this user and the system open the pipe, and nothing below medium integrity: project code inside
    // a containment finds the name by listing and cannot open what it names. Without a launcher there is no
    // containment either, and no project code that this would keep out.
    ...(process.platform === 'win32' && host.launcherPath !== undefined && existsSync(host.launcherPath) ? { protect: (name: string) => launcher.protectPipe(name) } : {}),
    onClientsChange: () => {
      push({ kind: 'runtime' })
      stateChanged()
    },
    logger,
  })
  await server.listen()
  const written = await writeEndpoint(dataDir, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    version: host.version,
    pipe,
    token,
    pid: process.pid,
    bootId: identity.bootId,
    startedAt: identity.startedAt,
  })
  endpointAcl = written.restricted ? 'restricted' : 'inherited'
  if (!written.restricted) logger('the endpoint file keeps its inherited access list')

  // A runtime with nothing to do and nobody connected does not stay in the background for good.
  const idleExitMs = testNumber(host, 'NEXUS_RUNTIME_IDLE_EXIT_MS') ?? 120_000
  let idleSince: number | null = null
  // The records the scheduler keeps about itself are history; they are kept bounded.
  const pruneTimer = setInterval(() => {
    try {
      repos.schedulerDecisions.prune()
      repos.scheduleFirings.prune()
    } catch (e) {
      logger(`pruning: ${errorMessage(e)}`)
    }
  }, 15 * 60_000)
  pruneTimer.unref()
  const idleTimer = setInterval(
    () => {
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
    },
    Math.min(5000, Math.max(250, idleExitMs / 4)),
  )
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
    if (workload === 'program' && (action === 'pause' || action === 'resume'))
      void (action === 'pause' ? programs.pause(runId) : programs.resume(runId)).catch(report)
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
