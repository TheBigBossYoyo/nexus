import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import type { ExecutionBroker, ExecutionProfileName } from '@main/modules/isolation/execution-broker'
import type { ContainmentProfile } from '@main/modules/isolation/launcher'
import type { NetworkEvent } from '@main/modules/network/guard'
import { policyForPurpose, type LocalEndpoint } from '@main/modules/network/policy'
import { startPolicyProxy, type PolicyProxy } from '@main/modules/network/proxy'
import { spawnLong, type LongProcess } from '@main/modules/process/spawn-process'
import { discoverManifest, localEndpointIn, type AppManifest } from './manifest'
import type { BrowserAutomationProvider, BrowserSession } from './provider'

/**
 * 0.8: the application a project builds, started so that an agent can use it. Starting it is running the
 * repository's code, so it is started inside the project's containment, like any other command of the
 * project: needing a window or a port is not a reason to run outside it. The browser that looks at it is
 * NEXUS's own, outside the containment, with a profile made for the session, and with one way to the network:
 * a proxy that lets it reach the endpoints this session registered and nothing else.
 */

/** A local server a session started and NEXUS registered. Only these are "the local app" for that session's browser. */
export interface RegisteredEndpoint extends LocalEndpoint {
  projectId: string
  runId: string | null
  taskId: string | null
  appId: string
  url: string
  registeredAt: string
}

export interface AppOwner {
  projectId: string
  runId: string | null
  taskId: string | null
  /** One application per owner key: a task's session. */
  key: string
  worktree: string
}

export interface AppStatus {
  id: string
  type: 'web' | 'electron'
  state: 'starting' | 'running' | 'exited' | 'stopped'
  profile: ExecutionProfileName
  endpoint: string | null
  startedAt: string
  exitCode: number | null
  /** The last lines the application printed. */
  output: string[]
  artifactsDir: string
  note: string
}

interface Running {
  id: string
  owner: AppOwner
  manifest: AppManifest
  profile: ExecutionProfileName
  process: LongProcess | null
  session: BrowserSession | null
  proxy: PolicyProxy | null
  endpoint: RegisteredEndpoint | null
  startedAt: string
  state: AppStatus['state']
  artifactsDir: string
  note: string
  specPath: string | null
  artifacts: string[]
}

export interface AppManagerDeps {
  broker: ExecutionBroker
  browser: BrowserAutomationProvider
  /** The profile a project's code runs under. STANDARD: no containment (a project that is not enrolled does not get here). */
  profileFor: (projectId: string) => ExecutionProfileName
  /** Where the artifacts of application sessions go: `<dir>/<app id>/`. */
  artifactsDir: string
  /** What the user allowed the application of a project to reach besides itself. Default: nothing. */
  appNetwork?: (projectId: string) => { mode: 'LOCAL_ONLY' | 'APPROVED_HOSTS' | 'FULL_EXTERNAL'; approvedHosts: string[] }
  /** Ports of NEXUS's own loopback services: never reachable by a session's browser. */
  forbiddenLocalPorts?: () => number[]
  onNetwork?: (owner: AppOwner, event: NetworkEvent) => void
  /** Where the Electron binary of a project is, when it is not in the project's own node_modules. For tests. */
  electronBinary?: (cwd: string) => string | undefined
  onChange?: (owner: AppOwner) => void
}

function portListening(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const done = (answer: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function httpAnswers(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = httpRequest(url, { method: 'GET', timeout: timeoutMs, agent: false }, (res) => {
        res.resume()
        resolve((res.statusCode ?? 599) < 500)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    } catch {
      resolve(false)
    }
  })
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export class AppLaunchError extends Error {
  constructor(
    message: string,
    readonly output: string[] = [],
  ) {
    super(message)
    this.name = 'AppLaunchError'
  }
}

export class ApplicationUnderTestManager {
  private readonly apps = new Map<string, Running>()
  private readonly endpoints: RegisteredEndpoint[] = []

  constructor(private readonly deps: AppManagerDeps) {}

  /** The endpoints registered now. A session's browser reaches its own; nothing here trusts a port for being local. */
  registry(): RegisteredEndpoint[] {
    return [...this.endpoints]
  }

  private byOwner(key: string): Running | undefined {
    return [...this.apps.values()].find((a) => a.owner.key === key && (a.state === 'running' || a.state === 'starting'))
  }

  status(key: string): AppStatus | null {
    const app = [...this.apps.values()].filter((a) => a.owner.key === key).pop()
    return app ? this.view(app) : null
  }

  list(): AppStatus[] {
    return [...this.apps.values()].map((a) => this.view(a))
  }

  private view(app: Running): AppStatus {
    const code = app.process?.exitCode()
    return {
      id: app.id,
      type: app.manifest.type,
      state: app.state === 'running' && app.process !== null && code !== undefined ? 'exited' : app.state === 'running' && app.session !== null && !app.session.alive() ? 'exited' : app.state,
      profile: app.profile,
      endpoint: app.endpoint?.url ?? null,
      startedAt: app.startedAt,
      exitCode: code ?? null,
      output: app.process?.output(40) ?? [],
      artifactsDir: app.artifactsDir,
      note: app.note,
    }
  }

  /** The browser session of an owner's running application, for the tools that look at it. */
  session(key: string): BrowserSession {
    const app = this.byOwner(key)
    if (!app || app.session === null) throw new AppLaunchError('No application is running for this task. Launch it first.')
    if (!app.session.alive()) throw new AppLaunchError('The application is no longer running. Read its output, then launch it again.', app.process?.output(40) ?? [])
    return app.session
  }

  /** What the owner's application printed, newest last. */
  output(key: string, last = 40): string[] {
    const app = [...this.apps.values()].filter((a) => a.owner.key === key).pop()
    return app?.process?.output(Math.min(Math.max(last, 1), 200)) ?? []
  }

  /** A file made while looking at the application (a screenshot), kept with the session for the user. */
  noteArtifact(key: string, path: string): void {
    const app = [...this.apps.values()].filter((a) => a.owner.key === key).pop()
    if (app && !app.artifacts.includes(path)) app.artifacts.push(path)
  }

  artifacts(key: string): string[] {
    return [...([...this.apps.values()].filter((a) => a.owner.key === key).pop()?.artifacts ?? [])]
  }

  /**
   * An address of the owner's own web application, from a path or a full address: the same scheme, host and
   * port as its registered endpoint. Anything else (a file, a browser page, another host or port) is null.
   */
  resolveInApp(key: string, target: string): string | null {
    const app = this.byOwner(key)
    if (!app || app.endpoint === null) return null
    try {
      const base = new URL(app.endpoint.url)
      const url = new URL(target, base)
      if (url.protocol !== base.protocol || url.host !== base.host || url.username !== '' || url.password !== '') return null
      return url.toString()
    } catch {
      return null
    }
  }

  private contained(owner: AppOwner): { profile: ExecutionProfileName; contain: ContainmentProfile | null } {
    const profile = this.deps.profileFor(owner.projectId)
    if (profile === 'STANDARD') return { profile, contain: null }
    const usable = this.deps.broker.usable(profile)
    if (!usable.usable) throw new AppLaunchError(`The ${profile} execution profile is not available, so the application was not started: ${usable.detail} Nothing is run outside the containment in this project.`)
    return { profile, contain: profile }
  }

  /**
   * Starts the application of the project in the owner's worktree and opens a browser session on it. An
   * application already running for the owner is stopped first: one application per task.
   */
  async launch(owner: AppOwner, given?: AppManifest): Promise<AppStatus> {
    await this.stop(owner.key)
    const discovered = given ? { manifest: given, note: 'From the manifest given.' } : discoverManifest(owner.worktree)
    if (discovered.manifest === null) throw new AppLaunchError(discovered.note)
    const manifest = discovered.manifest
    const { profile, contain } = this.contained(owner)
    const id = randomBytes(6).toString('hex')
    const artifactsDir = join(this.deps.artifactsDir, id)
    mkdirSync(artifactsDir, { recursive: true })
    const app: Running = { id, owner, manifest, profile, process: null, session: null, proxy: null, endpoint: null, startedAt: new Date().toISOString(), state: 'starting', artifactsDir, note: discovered.note, specPath: null, artifacts: [] }
    this.apps.set(id, app)
    try {
      if (manifest.type === 'web') await this.launchWeb(app, contain)
      else await this.launchElectron(app, contain)
      app.state = 'running'
      this.deps.onChange?.(owner)
      return this.view(app)
    } catch (e) {
      const output = app.process?.output(60) ?? []
      await this.teardown(app, 'stopped')
      if (e instanceof AppLaunchError) throw e
      throw new AppLaunchError(`The application could not be started: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}`, output)
    }
  }

  private cwdOf(app: Running): string {
    const cwd = join(app.owner.worktree, app.manifest.cwd)
    if (!cwd.toLowerCase().startsWith(app.owner.worktree.toLowerCase()) || !existsSync(cwd)) throw new AppLaunchError('The directory of the application is not inside the worktree.')
    return cwd
  }

  private async openProxy(app: Running, endpoints: LocalEndpoint[]): Promise<PolicyProxy> {
    const network = this.deps.appNetwork?.(app.owner.projectId) ?? { mode: 'LOCAL_ONLY' as const, approvedHosts: [] }
    const policy = policyForPurpose('LOCAL_APP_TEST', { localEndpoints: endpoints, appNetwork: network.mode, approvedHosts: network.approvedHosts, forbiddenLocalPorts: this.deps.forbiddenLocalPorts?.() ?? [] })
    return startPolicyProxy({ policy, onEvent: (event) => this.deps.onNetwork?.(app.owner, event) })
  }

  private async launchWeb(app: Running, contain: ContainmentProfile | null): Promise<void> {
    const { manifest, owner } = app
    if (!manifest.launchCommand) throw new AppLaunchError('The manifest of a web application needs a launch command.')
    const cwd = this.cwdOf(app)
    const known = manifest.ready?.kind === 'port' ? manifest.ready.port : manifest.ready?.kind === 'http' ? Number(new URL(manifest.ready.url).port || 80) : null
    // A port that already answers before the application starts is somebody else's server: it is not adopted.
    if (known !== null && (await portListening(known))) throw new AppLaunchError(`Something already listens on port ${known}. NEXUS does not take a server it did not start for the application under test.`)
    const seen: { endpoint: ReturnType<typeof localEndpointIn> } = { endpoint: null }
    const pattern = manifest.ready?.kind === 'log' ? new RegExp(manifest.ready.pattern, 'i') : null
    const onLine = (line: string): void => {
      if (seen.endpoint === null && (pattern === null || pattern.test(line))) seen.endpoint = localEndpointIn(line)
    }
    if (contain === null) throw new AppLaunchError('The project is not contained; its application is not started by NEXUS.')
    const wrapped = await this.deps.broker.containProgram({
      profile: contain,
      projectId: owner.projectId,
      sessionKey: owner.key,
      worktree: owner.worktree,
      cwd,
      commandLine: manifest.launchCommand,
      set: { ...manifest.env, BROWSER: 'none', NODE_ENV: manifest.env['NODE_ENV'] ?? 'development', FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    if (!wrapped.ok) throw new AppLaunchError(wrapped.reason)
    app.specPath = wrapped.specPath
    const child = spawnLong(wrapped.file, wrapped.args, { cwd: owner.worktree, env: wrapped.launcherEnv, onLine })
    app.process = child

    const deadline = Date.now() + manifest.startTimeoutSeconds * 1000
    let endpoint: { host: LocalEndpoint['host']; port: number; url: string } | null = null
    while (Date.now() < deadline) {
      if (child.exitCode() !== undefined) throw new AppLaunchError(`The application ended while starting (exit ${child.exitCode() ?? 'unknown'}).`, child.output(60))
      const candidate: { host: LocalEndpoint['host']; port: number; url: string } | null =
        manifest.ready?.kind === 'port' ? { host: '127.0.0.1', port: manifest.ready.port, url: `http://127.0.0.1:${manifest.ready.port}/` } : manifest.ready?.kind === 'http' ? { host: '127.0.0.1', port: known as number, url: manifest.ready.url } : seen.endpoint
      if (candidate !== null && (await portListening(candidate.port, candidate.host === '::1' ? '::1' : '127.0.0.1'))) {
        if (manifest.ready?.kind !== 'http' || (await httpAnswers(manifest.ready.url))) {
          endpoint = candidate
          break
        }
      }
      await delay(250)
    }
    if (endpoint === null) throw new AppLaunchError(`The application was not ready after ${manifest.startTimeoutSeconds} seconds.`, child.output(60))
    app.endpoint = { ...endpoint, projectId: owner.projectId, runId: owner.runId, taskId: owner.taskId, appId: app.id, registeredAt: new Date().toISOString() }
    this.endpoints.push(app.endpoint)
    app.proxy = await this.openProxy(app, [{ host: endpoint.host, port: endpoint.port }])
    app.session = await this.deps.browser.open({ purpose: 'LOCAL_APP_TEST', proxy: { server: app.proxy.url, username: app.proxy.username, password: app.proxy.password }, artifactsDir: app.artifactsDir })
    await app.session.navigate(endpoint.url)
  }

  /**
   * An Electron application: its own binary, started inside the containment on a desktop made for it, so that
   * it shows nothing on the user's screen. NEXUS looks at it through the debugging endpoint it is started with.
   * Its network is its containment's: there is no browser of NEXUS's here and so no proxy of a session.
   */
  private async launchElectron(app: Running, contain: ContainmentProfile | null): Promise<void> {
    const { manifest, owner } = app
    const cwd = this.cwdOf(app)
    const electronExe = [join(cwd, 'node_modules', 'electron', 'dist', 'electron.exe'), join(owner.worktree, 'node_modules', 'electron', 'dist', 'electron.exe'), this.deps.electronBinary?.(cwd)].find((p): p is string => p !== undefined && existsSync(p))
    if (electronExe === undefined) throw new AppLaunchError("The project's Electron binary was not found (node_modules/electron/dist/electron.exe). Install the dependencies first.")
    if (contain === null) throw new AppLaunchError('The project is not contained; its application is not started by NEXUS.')
    const session = { profile: contain, projectId: owner.projectId, sessionKey: owner.key, worktree: owner.worktree }
    const roots = await this.deps.broker.roots(session)
    // A profile directory of the session: the application never opens the data of an installed copy of itself.
    const userData = join(roots.home, 'electron-user-data', app.id)
    mkdirSync(userData, { recursive: true })
    const seen: { endpoint: string | null } = { endpoint: null }
    const onLine = (line: string): void => {
      const m = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/_-]+)/.exec(line)
      if (m !== null && seen.endpoint === null) seen.endpoint = m[1] as string
    }
    const wrapped = await this.deps.broker.containProgram({
      ...session,
      cwd,
      file: electronExe,
      // Chromium's own sandbox cannot be set up from a process that is already at low integrity in a job (it ends
      // at once, measured on Electron 44). The application runs without it: every process of it, renderers
      // included, is inside the containment NEXUS made, which is the boundary that matters for what it can reach.
      args: [manifest.electron?.entry ?? '.', '--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`, ...(manifest.electron?.args ?? [])],
      window: { desktop: `nexus-app-${app.id}` },
      set: { ...manifest.env, NODE_ENV: manifest.env['NODE_ENV'] ?? 'development', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    })
    if (!wrapped.ok) throw new AppLaunchError(wrapped.reason)
    app.specPath = wrapped.specPath
    const child = spawnLong(wrapped.file, wrapped.args, { cwd: owner.worktree, env: wrapped.launcherEnv, onLine })
    app.process = child
    const deadline = Date.now() + manifest.startTimeoutSeconds * 1000
    while (seen.endpoint === null && Date.now() < deadline) {
      if (child.exitCode() !== undefined) throw new AppLaunchError(`The application ended while starting (exit ${child.exitCode() ?? 'unknown'}).`, child.output(60))
      await delay(200)
    }
    if (seen.endpoint === null) throw new AppLaunchError(`The application did not open its debugging endpoint within ${manifest.startTimeoutSeconds} seconds.`, child.output(60))
    app.session = await this.deps.browser.open({ purpose: 'LOCAL_APP_TEST', artifactsDir: app.artifactsDir, attach: { endpoint: seen.endpoint, timeoutMs: Math.max(5000, deadline - Date.now()) } })
  }

  private async teardown(app: Running, state: 'stopped' | 'exited'): Promise<void> {
    // Off the registry first: from here on the endpoint is nobody's "local application", whatever is still closing.
    app.state = state
    if (app.endpoint !== null) {
      const index = this.endpoints.indexOf(app.endpoint)
      if (index >= 0) this.endpoints.splice(index, 1)
    }
    const { session, proxy } = app
    app.session = null
    app.proxy = null
    await session?.close().catch(() => undefined)
    await app.process?.stop().catch(() => undefined)
    await proxy?.close().catch(() => undefined)
    if (app.specPath !== null) this.deps.broker.releaseSpec(app.specPath)
    app.specPath = null
  }

  /** Stops the owner's application, its browser, its proxy, and takes its endpoint off the registry. */
  async stop(key: string): Promise<boolean> {
    const app = this.byOwner(key)
    if (!app) return false
    await this.teardown(app, 'stopped')
    this.deps.onChange?.(app.owner)
    return true
  }

  /** Stops everything a mission started. Called when the mission ends, however it ends. */
  async stopForRun(runId: string): Promise<number> {
    const mine = [...this.apps.values()].filter((a) => a.owner.runId === runId && (a.state === 'running' || a.state === 'starting'))
    for (const app of mine) await this.teardown(app, 'stopped')
    return mine.length
  }

  async stopAll(): Promise<void> {
    for (const app of this.apps.values()) if (app.state === 'running' || app.state === 'starting') await this.teardown(app, 'stopped')
  }
}
