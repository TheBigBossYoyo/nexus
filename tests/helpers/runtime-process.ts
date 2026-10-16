import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { RuntimeClient, type RuntimeClientOptions } from '../../src/main/modules/runtime/client'
import { readEndpoint } from '../../src/main/modules/runtime/endpoint'

/**
 * Real processes for tests: the runtime hosted by plain Node, and the worker it forks. Both are bundled once
 * from the sources into `out/test-runtime`, so the tests exercise what is in the working tree without needing
 * the Electron build.
 */

const REPO = resolve(import.meta.dirname, '..', '..')
const OUT = join(REPO, 'out', 'test-runtime')
export const RUNTIME_ENTRY = join(OUT, 'runtime-node.mjs')
export const WORKER_ENTRY = join(OUT, 'worker.mjs')

let built: Promise<void> | null = null

/** Bundles the runtime and the worker. Safe to call from every test file; the work happens once per process. */
export function buildRuntime(): Promise<void> {
  built ??= (async () => {
    mkdirSync(OUT, { recursive: true })
    await build({
      entryPoints: { 'runtime-node': join(REPO, 'src', 'main', 'runtime-node.ts'), worker: join(REPO, 'src', 'main', 'worker.ts') },
      outdir: OUT,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: { '@shared': join(REPO, 'src', 'shared'), '@main': join(REPO, 'src', 'main') },
      // Native and vendor packages are loaded from node_modules at run time, as in the app.
      external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'electron', 'playwright-core'],
      banner: { js: "import { createRequire as __nexusCreateRequire } from 'node:module'; const require = __nexusCreateRequire(import.meta.url);" },
      logLevel: 'silent',
    })
  })()
  return built
}

export function tempDataDir(prefix = 'rt'): string {
  return mkdtempSync(join(tmpdir(), `nexus-${prefix}-`))
}

export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // Windows may hold a handle for a moment after a process ended.
  }
}

export interface RuntimeProcess {
  child: ChildProcess
  bootId: string
  /** Everything the process wrote to stderr, for a failing test's message. */
  log(): string
  /** Ends the process at once, as a crash would. Resolves when it is gone. */
  kill(): Promise<void>
  /** Resolves with the exit code once the process has ended by itself. */
  exited(timeoutMs?: number): Promise<number | null>
}

/** Starts a runtime for `dataDir` with the scripted agent runtime and waits until it listens. */
export async function startRuntime(dataDir: string, env: Record<string, string> = {}): Promise<RuntimeProcess> {
  await buildRuntime()
  const child = spawn(process.execPath, [RUNTIME_ENTRY], {
    // NEXUS_RUNTIME_PRIORITY: a runtime of a test keeps normal priority. Below it (the default), it lost the processor
    // to the suite's other workers and a test bounded in time failed under load (0.9.1).
    env: { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_FAKE_RUNTIME: '1', NEXUS_WORKER_ENTRY: WORKER_ENTRY, NEXUS_CASES_DIR: join(REPO, 'arena', 'cases'), NEXUS_RUNTIME_PRIORITY: 'normal', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  let stdout = ''
  child.stderr?.on('data', (data: Buffer) => {
    stderr = `${stderr}${data.toString('utf8')}`.slice(-20_000)
  })
  const gone = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  const bootId = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`The runtime did not start in time.\n${stderr}`)), 60_000)
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
      const match = /NEXUS_RUNTIME_READY (\S+)/.exec(stdout)
      if (match?.[1]) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    })
    void gone.then((code) => {
      clearTimeout(timer)
      reject(new Error(`The runtime ended with code ${code} before it was ready.\n${stderr}`))
    })
  })
  return {
    child,
    bootId,
    log: () => stderr,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await gone
    },
    exited: (timeoutMs = 30_000) => Promise.race([gone, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`The runtime did not end in time.\n${stderr}`)), timeoutMs))]),
  }
}

/** A connected client of the runtime of `dataDir`. */
export async function connect(dataDir: string, options: Partial<RuntimeClientOptions> = {}): Promise<RuntimeClient> {
  const client = new RuntimeClient({ dataDir, kind: 'desktop', ...options })
  client.start()
  await client.whenConnected(30_000)
  return client
}

/** Calls a channel and returns the value, or throws the error the runtime answered with. */
export async function call<T = unknown>(client: RuntimeClient, channel: string, input: unknown = {}): Promise<T> {
  const result = await client.invoke(channel, input)
  if (!result.ok) throw new Error(`${channel}: ${result.error.code}: ${result.error.message}`)
  return result.value as T
}

export async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 30_000, what = 'the condition'): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last value: ${JSON.stringify(value)?.slice(0, 2000)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export { existsSync, readEndpoint, statSync }
