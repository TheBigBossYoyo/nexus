import { spawn as nodeSpawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import type { PowerCommandResult } from '@shared/overnight'
import { nowIso } from '@shared/ids'
import { errorMessage, NexusError } from '@shared/result'
import {
  buildShutdownArgs,
  CANCEL_SHUTDOWN_ARGS,
  HIBERNATE_ARGS,
  isEffectivelyForced,
  SLEEP_POWERSHELL_ARGS,
  type PendingShutdown,
  type PowerController,
  type PowerState,
  type ShutdownRequest,
} from './types'

/** The slice of child_process.spawn the controller uses; tests substitute it to capture the command. */
export type SpawnLike = (
  executable: string,
  args: readonly string[],
  options: { windowsHide: true; shell: false; stdio: ['ignore', 'pipe', 'pipe'] },
) => {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(): unknown
}

export interface WindowsPowerControllerOptions {
  spawn?: SpawnLike
  /** Windows directory; defaults to %SystemRoot%. Only an absolute path is accepted. */
  systemRoot?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
}

const COMMAND_TIMEOUT_MS = 20_000
const OUTPUT_LIMIT = 4000

/**
 * Windows power control through the operating system's own tools, spawned directly with an argument
 * array (never through a shell, never from a command string). Lives in the Electron main process and
 * is handed only to the OvernightSupervisor.
 */
export class WindowsPowerController implements PowerController {
  private readonly spawn: SpawnLike
  private readonly system32: string
  private readonly timeoutMs: number
  private pending: PendingShutdown | null = null

  constructor(options: WindowsPowerControllerOptions = {}) {
    if ((options.platform ?? process.platform) !== 'win32') {
      throw new NexusError('runtime_unavailable', 'WindowsPowerController only runs on Windows')
    }
    const root = options.systemRoot ?? process.env['SystemRoot'] ?? 'C:\\Windows'
    // A relative or UNC "SystemRoot" would let the environment choose which binary runs.
    const safeRoot = isAbsolute(root) && /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows'
    this.system32 = join(safeRoot, 'System32')
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike)
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  }

  get shutdownExecutable(): string {
    return join(this.system32, 'shutdown.exe')
  }

  get powershellExecutable(): string {
    return join(this.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }

  async scheduleShutdown(request: ShutdownRequest): Promise<PowerCommandResult> {
    const args = buildShutdownArgs(request)
    const result = await this.execute(this.shutdownExecutable, args)
    if (result.ok) {
      this.pending = {
        purpose: request.purpose,
        scheduledAt: result.at,
        deadline: new Date(Date.parse(result.at) + request.delaySeconds * 1000).toISOString(),
        forced: isEffectivelyForced(request),
      }
    }
    return result
  }

  async cancelShutdown(): Promise<PowerCommandResult> {
    const result = await this.execute(this.shutdownExecutable, CANCEL_SHUTDOWN_ARGS)
    // 1116: no shutdown was in progress. Either way nothing is pending afterwards.
    if (result.ok || result.exitCode === 1116) this.pending = null
    return result
  }

  sleep(): Promise<PowerCommandResult> {
    return this.execute(this.powershellExecutable, SLEEP_POWERSHELL_ARGS)
  }

  hibernate(): Promise<PowerCommandResult> {
    return this.execute(this.shutdownExecutable, HIBERNATE_ARGS)
  }

  getState(): PowerState {
    return { pending: this.pending }
  }

  private execute(executable: string, args: readonly string[]): Promise<PowerCommandResult> {
    const at = nowIso()
    const finish = (ok: boolean, exitCode: number | null, output: string): PowerCommandResult => ({
      ok,
      exitCode,
      output: output.trim().slice(0, OUTPUT_LIMIT),
      executable,
      args: [...args],
      at,
    })
    return new Promise<PowerCommandResult>((resolve) => {
      let output = ''
      let settled = false
      const settle = (result: PowerCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      let child: ReturnType<SpawnLike>
      try {
        child = this.spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        resolve(finish(false, null, `Could not start ${executable}: ${errorMessage(e)}`))
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        settle(finish(false, null, `${output}\nTimed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      const collect = (chunk: Buffer): void => {
        if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8')
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', (error) => settle(finish(false, null, `${output}\n${error.message}`)))
      child.on('close', (code) => settle(finish(code === 0, code, output)))
    })
  }
}
