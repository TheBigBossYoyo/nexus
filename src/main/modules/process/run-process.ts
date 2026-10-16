import { spawn } from 'node:child_process'
import { NexusError, errorMessage } from '@shared/result'

export interface RunProcessOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Cap per captured stream (and for the combined output). Default 10 MiB. */
  maxOutputBytes?: number
  /** Which end survives when output exceeds the cap. Default 'tail'. */
  keep?: 'head' | 'tail'
  signal?: AbortSignal
  /** Written to stdin, then stdin is closed. Without it stdin is closed immediately. */
  input?: string
  /** Pass arguments to the child verbatim (Windows only; needed for cmd.exe /c). */
  windowsVerbatimArguments?: boolean
  /**
   * 0.9.1: lines of the whole output (colour codes removed) that match, kept apart from the capped output, at most
   * KEPT_LINES of them: what a long run said early (a test runner's failed files) survives a cap that keeps its end.
   */
  keepLines?: RegExp
}

const KEPT_LINES = 400

export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** stdout and stderr interleaved in arrival order. */
  output: string
  timedOut: boolean
  aborted: boolean
  /** True when any captured stream exceeded maxOutputBytes and was cut. */
  truncated: boolean
  /** The lines `keepLines` matched, in order (absent without it). */
  keptLines?: string[]
  durationMs: number
}

const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024
const POST_KILL_GRACE_MS = 3000

class CappedBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(
    private readonly max: number,
    private readonly keep: 'head' | 'tail',
  ) {}

  push(chunk: Buffer): void {
    if (this.keep === 'head') {
      if (this.size >= this.max) {
        this.truncated = true
        return
      }
      const room = this.max - this.size
      if (chunk.length > room) {
        this.truncated = true
        chunk = chunk.subarray(0, room)
      }
      this.chunks.push(chunk)
      this.size += chunk.length
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max && this.chunks.length > 0) {
      const first = this.chunks[0]!
      const excess = this.size - this.max
      this.truncated = true
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** Kills a process and all its descendants. On Windows that needs taskkill /T. */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      resolve()
      return
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => resolve())
    killer.on('close', () => resolve())
  })
}

/** Variables that carry Claude credentials or redirect Node. Project commands never need them. */
// NEXUS_DATA_DIR: where NEXUS keeps its database, its endpoint and its stored credentials (0.7.2).
const WITHHELD_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'NEXUS_DATA_DIR'])

/**
 * 0.9.1: whether a variable is one of NEXUS's own switches (its data folder, how a test instance answers
 * confirmations, scripted runtimes, the window off-screen...). A test instance's NEXUS_ACCEPT_CONFIRM reached the
 * tests NEXUS ran on itself, which then ran as a test instance and failed. A project's own NEXUS_-named variables
 * are not these and are kept.
 */
const NEXUS_SWITCH = /^NEXUS_(?:DATA_DIR|ACCEPT_\w*|FAKE_\w*|E2E_\w*|WINDOW_\w*|CAMPAIGN_\w*|USAGE_\w*|RUNTIME_\w*|WORKER_\w*|V0\w*|ARENA_\w*|PUBLISH_\w*|CONTAINMENT|NETWORK_RESILIENCE|OVERNIGHT_TICK_MS|PRESENCE_METER|PRIVILEGE_UNELEVATED_TEST|QUIET_COMMANDS|PROTECT_USER_STORES|PACKAGED_DIR|CASES_DIR|LAUNCHER|ENDPOINT|RESEARCH_BROWSER|UI_REVIEW|LIVE_STEPS|HTTP_FETCH|HTML_SEARCH)$/i

export function isNexusSwitch(name: string): boolean {
  return NEXUS_SWITCH.test(name)
}

/**
 * The environment for commands NEXUS itself runs in a project (dependency setup, check commands, Arena
 * evaluators): the process environment without Claude credentials and without variables that could redirect
 * the Node runtime. Agent-written code runs in these commands, so it must not see what agents do not see.
 */
export function projectCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    // 0.9.1: and none of NEXUS's own switches: a project's tests must not run as if inside NEXUS.
    if (value !== undefined && !WITHHELD_ENV.has(key.toUpperCase()) && !isNexusSwitch(key)) env[key] = value
  }
  return env
}

export function runProcess(file: string, args: readonly string[], opts: RunProcessOptions): Promise<ProcessResult> {
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const keep = opts.keep ?? 'tail'
  const started = Date.now()

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
        aborted: true,
        truncated: false,
        durationMs: 0,
      })
      return
    }

    let child
    try {
      child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
      })
    } catch (e) {
      reject(new NexusError('internal', `Failed to spawn ${file}: ${errorMessage(e)}`))
      return
    }

    const out = new CappedBuffer(max, keep)
    const err = new CappedBuffer(max, keep)
    const combined = new CappedBuffer(max, keep)
    const kept: string[] = []
    const partial = { out: '', err: '' }
    const watch = (stream: 'out' | 'err', chunk: Buffer | null): void => {
      if (opts.keepLines === undefined) return
      const text = partial[stream] + (chunk === null ? '\n' : chunk.toString('utf8'))
      const lines = text.split(/\r?\n/)
      partial[stream] = lines.pop() ?? ''
      for (const line of lines) {
        // eslint-disable-next-line no-control-regex
        const plain = line.replace(/\u001b\[[0-9;]*m/g, '')
        if (kept.length < KEPT_LINES && opts.keepLines.test(plain)) kept.push(plain.slice(0, 400))
      }
    }
    let timedOut = false
    let aborted = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      watch('out', null)
      watch('err', null)
      resolve({
        ...(opts.keepLines !== undefined ? { keptLines: kept } : {}),
        exitCode,
        stdout: out.toString(),
        stderr: err.toString(),
        output: combined.toString(),
        timedOut,
        aborted,
        truncated: out.truncated || err.truncated || combined.truncated,
        durationMs: Date.now() - started,
      })
    }

    const kill = (): void => {
      if (child.pid !== undefined) void killProcessTree(child.pid)
      // Grandchildren that escaped the tree may keep the pipes open; do not wait for them forever.
      graceTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(child.exitCode)
      }, POST_KILL_GRACE_MS)
    }

    const onAbort = (): void => {
      aborted = true
      kill()
    }

    child.stdout.on('data', (c: Buffer) => {
      out.push(c)
      combined.push(c)
      watch('out', c)
    })
    child.stderr.on('data', (c: Buffer) => {
      err.push(c)
      combined.push(c)
      watch('err', c)
    })
    child.stdin.on('error', () => {
      // child exited before reading stdin
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      const code = e.code === 'ENOENT' ? 'not_found' : 'internal'
      reject(new NexusError(code, `Failed to run ${file}: ${e.message}`, { file, cwd: opts.cwd, errno: e.code }))
    })
    child.on('close', (code) => finish(code))

    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, opts.timeoutMs)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
