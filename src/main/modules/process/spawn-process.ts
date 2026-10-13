import { spawn } from 'node:child_process'
import { killProcessTree } from './run-process'

/**
 * A process that stays running while NEXUS works with it: a development server, an application under test.
 * `runProcess` waits for an exit; this returns at once with a handle. Output is kept in a bounded ring, newest
 * last, and every line is offered to a listener (readiness is read from it).
 */
export interface LongProcess {
  readonly pid: number | null
  /** The last lines of stdout and stderr together, oldest first. */
  output(maxLines?: number): string[]
  /** Null while it runs. */
  exitCode(): number | null | undefined
  exited: Promise<{ code: number | null; signal: string | null }>
  /** Ends the process and everything below it, and waits until it is gone. */
  stop(): Promise<void>
}

export interface SpawnLongOptions {
  cwd: string
  env: Record<string, string>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Lines kept. Default 2000. */
  maxLines?: number
  /** The child's standard input is a pipe that stays open and is never written: for a helper that runs until its input closes. */
  keepStdinOpen?: boolean
}

/** The most of an unfinished line that is kept while waiting for its newline. */
const PENDING_LINE_LIMIT = 8192

export function spawnLong(file: string, args: readonly string[], options: SpawnLongOptions): LongProcess {
  const maxLines = options.maxLines ?? 2000
  const lines: string[] = []
  let code: number | null | undefined
  const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: [options.keepStdinOpen === true ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  child.stdin?.on('error', () => undefined)
  const take = (stream: 'stdout' | 'stderr') => {
    let rest = ''
    // The unfinished line is kept to a bounded size: an application that prints without a newline must not grow
    // the runtime's memory. Lines are cut to 4000 characters below, so what is kept here is more than enough.
    let dropping = false
    return (chunk: Buffer): void => {
      let text = chunk.toString('utf8')
      if (dropping) {
        // Everything up to the next newline belongs to a line that was already cut and emitted.
        const nl = text.indexOf('\n')
        if (nl < 0) return
        dropping = false
        text = text.slice(nl + 1)
      }
      text = rest + text
      const parts = text.split(/\r?\n/)
      rest = parts.pop() ?? ''
      if (rest.length > PENDING_LINE_LIMIT) {
        // Emitted once as the (cut) line it is, then dropped until the next newline.
        parts.push(rest.slice(0, PENDING_LINE_LIMIT))
        rest = ''
        dropping = true
      }
      for (const part of parts) {
        const line = part.slice(0, 4000)
        lines.push(line)
        if (lines.length > maxLines) lines.splice(0, lines.length - maxLines)
        try {
          options.onLine?.(line, stream)
        } catch {
          // A listener's failure is not the process's.
        }
      }
    }
  }
  child.stdout?.on('data', take('stdout'))
  child.stderr?.on('data', take('stderr'))
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', () => {
      code = null
      resolve({ code: null, signal: null })
    })
    child.on('exit', (exitCode, signal) => {
      code = exitCode
      resolve({ code: exitCode, signal })
    })
  })
  return {
    pid: child.pid ?? null,
    output: (n = 200) => lines.slice(-n),
    exitCode: () => code,
    exited,
    async stop() {
      if (code !== undefined) return
      if (child.pid !== undefined) await killProcessTree(child.pid)
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
    },
  }
}
