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
}

export function spawnLong(file: string, args: readonly string[], options: SpawnLongOptions): LongProcess {
  const maxLines = options.maxLines ?? 2000
  const lines: string[] = []
  let code: number | null | undefined
  const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  const take = (stream: 'stdout' | 'stderr') => {
    let rest = ''
    return (chunk: Buffer): void => {
      const text = rest + chunk.toString('utf8')
      const parts = text.split(/\r?\n/)
      rest = parts.pop() ?? ''
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
  child.stdout.on('data', take('stdout'))
  child.stderr.on('data', take('stderr'))
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
