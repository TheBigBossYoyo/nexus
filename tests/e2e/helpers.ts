import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { IpcChannel, IpcOutputs } from '../../src/shared/ipc'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
export const SCREENSHOT_DIR = join(REPO_ROOT, 'test-results', 'screenshots')
/** Baseline execution scenarios explicitly bypass external enrichment; AUTO is covered separately. */
export async function selectExactCompilation(page: Page): Promise<void> {
  const panel = page.getByTestId('compilation-preview')
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click()
  await page.getByTestId('compilation-mode').selectOption('EXACT')
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `nexus-e2e-${prefix}-`))
}

export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // Best effort: Windows may still hold a handle for a moment after the app exits.
  }
}

/** A throwaway Git repository with one commit on `main`; the test project. */
export function createRepo(): string {
  const root = tempDir('repo')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'E2E Tester')
  git(root, 'config', 'user.email', 'e2e@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), '# Scratch project\n')
  // An entry point and a source file give repository intelligence something to find.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', main: 'src/index.js' }, null, 2) + '\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.js'), "module.exports = { name: 'scratch' }\n")
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Initial commit')
  return root
}

export interface Launched {
  app: ElectronApplication
  page: Page
}

/** Launches the built app against `dataDir` with the scripted runtime; the folder picker returns `pickPath`. */
export async function launchApp(dataDir: string, pickPath: string | null, extraEnv: Record<string, string> = {}): Promise<Launched> {
  mkdirSync(dataDir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env['NEXUS_DATA_DIR'] = dataDir
  env['NEXUS_FAKE_RUNTIME'] = '1'
  // Confirmations are shown by the runtime process itself; with the scripted runtime they come to this window, where the stubs below answer them.
  env['NEXUS_FAKE_CONFIRM'] = 'window'
  // Off-screen and never focused: a test run must not put windows in front of whoever is using the machine.
  if (process.env['NEXUS_E2E_SHOW'] !== '1') env['NEXUS_WINDOW_OFFSCREEN'] = '1'
  // The scripted runtime always comes with the fake power controller; a faster supervisor pass keeps the tests short.
  env['NEXUS_OVERNIGHT_TICK_MS'] = '500'
  Object.assign(env, extraEnv)
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({ args: ['.'], cwd: REPO_ROOT, env })
  launchedDataDirs.set(app, dataDir)
  if (pickPath) {
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, pickPath)
  }
  // Native confirmations (overnight authorization, close and quit questions) are answered with their first
  // button: authorize / hide to tray / quit and leave the timer armed. Tests that care replace this stub.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // The window is a client: it is usable once its runtime answers and has finished recovering.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = (await (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<unknown> } }).nexus.invoke('desktop.connection', {})) as { ok: boolean; value?: { phase: string } }
          return result.ok ? (result.value?.phase ?? null) : null
        }),
      { timeout: 90_000, intervals: [100] },
    )
    .toBe('READY')
  return { app, page }
}

/** Every data directory an app was launched for, so that no runtime process outlives the test run. */
const launchedDataDirs = new Map<ElectronApplication, string>()

function runtimePid(dataDir: string): number | null {
  try {
    const file = join(dataDir, 'runtime', 'endpoint.json')
    if (!existsSync(file)) return null
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Ends the runtime process of `dataDir` at once, with what it started, as a crash would. The pid comes from
 * the endpoint file of this test's own throwaway data directory.
 */
export function killRuntime(dataDir: string): void {
  const pid = runtimePid(dataDir)
  if (pid === null || !alive(pid)) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // Already gone.
  }
}

/** Asks the runtime to stop cleanly (as "Stop NEXUS" does) and waits until its process is gone. */
export async function stopRuntime(page: Page, dataDir: string): Promise<void> {
  const pid = runtimePid(dataDir)
  await page
    .evaluate(() => (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<unknown> } }).nexus.invoke('runtime.stop', {}))
    .catch(() => undefined)
  const until = Date.now() + 45_000
  while (pid !== null && alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
  if (pid !== null && alive(pid)) killRuntime(dataDir)
}

/**
 * Closes NEXUS as a whole: the runtime is stopped cleanly first, then the window. Closing only the window
 * leaves the runtime (and its work) running, which is what `closeWindowOnly` is for.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const dataDir = launchedDataDirs.get(app)
  launchedDataDirs.delete(app)
  if (dataDir) {
    const page = app.windows()[0]
    if (page && !page.isClosed()) await stopRuntime(page, dataDir)
    else killRuntime(dataDir)
  }
  await app.close().catch(() => undefined)
  if (dataDir) killRuntime(dataDir)
}

/** Closes the window's process and leaves the runtime running. The caller stops it later (`killRuntime`, or a relaunch and `closeApp`). */
export async function closeWindowOnly(app: ElectronApplication): Promise<void> {
  launchedDataDirs.delete(app)
  // Not `app.close()`: Playwright waits for the launched process's output streams to close, and the runtime it
  // started holds them open for as long as it lives. The window is closed as a user closes it.
  const child = app.process()
  const exited = new Promise<void>((resolveExit) => (child.exitCode !== null ? resolveExit() : child.once('exit', () => resolveExit())))
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => undefined)
  await Promise.race([exited, new Promise((resolveLate) => setTimeout(resolveLate, 20_000))])
}

/** Calls an IPC channel through the real preload bridge and returns the unwrapped value. */
export async function invoke<C extends IpcChannel>(page: Page, channel: C, input: object = {}): Promise<IpcOutputs[C]> {
  const result = await page.evaluate(
    ([c, i]) => (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<unknown> } }).nexus.invoke(c, i),
    [channel, input] as const,
  )
  const r = result as { ok: boolean; value?: unknown; error?: { message: string } }
  if (!r.ok) throw new Error(`${channel} failed: ${r.error?.message ?? 'unknown'}`)
  return r.value as IpcOutputs[C]
}

export async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const path = join(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path })
  return path
}

/**
 * Replaces the stub that answers native confirmations with one that also counts them, so that a test can say
 * whether a change asked. The count is read with `confirmationCount`.
 */
export async function countConfirmations(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const counter = globalThis as unknown as { __nexusConfirmations?: number }
    counter.__nexusConfirmations = 0
    dialog.showMessageBox = (async () => {
      counter.__nexusConfirmations = (counter.__nexusConfirmations ?? 0) + 1
      return { response: 0, checkboxChecked: false }
    }) as never
  })
}

export function confirmationCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __nexusConfirmations?: number }).__nexusConfirmations ?? 0)
}

/** The marker that makes the scripted worker try `git push origin main` three times (see the demo script). */
export const BOUNDARY_MARKER = '[demo:boundary-push]'

/**
 * Enrolls the project in the Autonomous project profile and starts a mission whose scripted worker attempts one
 * out-of-boundary action; returns once that attempt is one pending boundary request. The mission stays alive
 * for a while after it, so the request can be answered before the mission ends.
 */
export async function startBoundaryMission(page: Page, projectId: string): Promise<{ runId: string; requestId: string }> {
  await invoke(page, 'autonomy.enroll', { projectId, profile: 'AUTONOMOUS_PROJECT' })
  const run = await invoke(page, 'runs.create', {
    projectId,
    mode: 'build',
    preset: 'balanced',
    prompt: `Add an API module and a UI module. ${BOUNDARY_MARKER}`,
    compilationMode: 'EXACT',
    requirePlanApproval: false,
  })
  await expect.poll(async () => (await invoke(page, 'autonomy.pending', { projectId })).length, { timeout: 90_000, intervals: [250] }).toBe(1)
  // All three attempts have been made once the request has been met three times.
  await expect
    .poll(async () => (await invoke(page, 'autonomy.pending', { projectId }))[0]?.occurrences ?? 0, { timeout: 30_000, intervals: [250] })
    .toBeGreaterThanOrEqual(3)
  const request = (await invoke(page, 'autonomy.pending', { projectId }))[0]
  if (!request) throw new Error('No boundary request')
  return { runId: run.id, requestId: request.id }
}

/** A plan approval is answered in the plan panel, so the drawer must not cover it. */
export async function dismissApprovalDrawer(page: Page): Promise<void> {
  // Plan approvals no longer auto-open the drawer; the pending-approval bar must still be shown.
  await expect(page.getByTestId('approval-drawer')).toBeHidden()
}
