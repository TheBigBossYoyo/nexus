import type { DisturbanceEvent, DisturbanceKind } from '@shared/presentation'
import { spawnLong, type LongProcess, type SpawnLongOptions } from '../process/spawn-process'

/**
 * 0.9.1: the presence meter (native/nexus-presence), read. It watches the owner's desktop and reports the windows
 * shown there and every change of the foreground; this classifies what descends from the runtime (NEXUS's work)
 * into the disturbance kinds of the owner's metrics. Nothing else is kept: a window that is not NEXUS's is not
 * recorded at all, and of NEXUS's own only the process file name and the window class.
 *
 * A window of NEXUS's work that takes the foreground within a few seconds of appearing took it by itself: a
 * FOREGROUND_STEAL. One that comes forward later was most likely chosen by the owner (C10): recorded as
 * FOCUSED_LATER and not counted. The runtime's own windows are its confirmations, asked on purpose.
 */

export interface PresenceLine {
  e: 'ready' | 'shown' | 'foreground'
  pid?: number
  process?: string
  class?: string
  nexus?: boolean
  console?: boolean
  dialog?: boolean
  at?: number
}

/** How long after a window appears its taking the foreground counts as taking it by itself. */
export const STEAL_WINDOW_MS = 3000

export class DisturbanceClassifier {
  private readonly shownAt = new Map<number, number>()

  constructor(private readonly runtimePid: number) {}

  /** The kind of a line of the meter, or null when it is not NEXUS's or not a disturbance. */
  classify(line: PresenceLine): DisturbanceKind | null {
    if (line.e === 'ready' || line.nexus !== true || line.pid === undefined) return null
    const at = line.at ?? Date.now()
    if (line.pid === this.runtimePid) return line.e === 'shown' ? 'NEXUS_CONFIRMATION' : null
    if (line.e === 'shown') {
      this.shownAt.set(line.pid, at)
      if (this.shownAt.size > 500) this.shownAt.delete(this.shownAt.keys().next().value as number)
      return line.console === true ? 'CONSOLE_FLASH' : line.dialog === true ? 'SYSTEM_DIALOG' : 'VISIBLE_WINDOW'
    }
    const shown = this.shownAt.get(line.pid)
    return shown !== undefined && at - shown <= STEAL_WINDOW_MS ? 'FOREGROUND_STEAL' : 'FOCUSED_LATER'
  }
}

export interface PresenceMeterOptions {
  helperPath: string
  runtimePid: number
  cwd: string
  /** The runs at work now: an event is counted for each of them. */
  activeRuns: () => string[]
  onEvent: (event: DisturbanceEvent) => void
  spawn?: (file: string, args: readonly string[], options: SpawnLongOptions) => LongProcess
  log?: (line: string) => void
}

/** Runs the meter for as long as the runtime runs; restarts it (at most every minute) when it ends. */
export class PresenceMeter {
  private proc: LongProcess | null = null
  private stopped = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly classifier: DisturbanceClassifier
  private ready = false

  constructor(private readonly o: PresenceMeterOptions) {
    this.classifier = new DisturbanceClassifier(o.runtimePid)
  }

  get running(): boolean {
    return this.ready && this.proc !== null && this.proc.exitCode() === undefined
  }

  start(): void {
    if (this.stopped || this.proc !== null) return
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    try {
      this.proc = (this.o.spawn ?? spawnLong)(this.o.helperPath, ['watch', '--roots', String(this.o.runtimePid)], {
        cwd: this.o.cwd,
        env: { SystemRoot: systemRoot, windir: systemRoot },
        keepStdinOpen: true,
        maxLines: 20,
        onLine: (line, stream) => (stream === 'stdout' ? this.onLine(line) : this.o.log?.(`presence: ${line.slice(0, 200)}`)),
      })
    } catch (e) {
      this.o.log?.(`presence: the meter could not be started (${e instanceof Error ? e.message : 'unknown'})`)
      return
    }
    void this.proc.exited.then(() => {
      this.proc = null
      this.ready = false
      if (this.stopped) return
      this.restartTimer = setTimeout(() => this.start(), 60_000)
      this.restartTimer.unref?.()
    })
  }

  private onLine(text: string): void {
    let line: PresenceLine
    try {
      line = JSON.parse(text) as PresenceLine
    } catch {
      return
    }
    if (line.e === 'ready') {
      this.ready = true
      return
    }
    const kind = this.classifier.classify(line)
    if (kind === null) return
    const runIds = this.o.activeRuns()
    try {
      this.o.onEvent({ at: new Date(line.at ?? Date.now()).toISOString(), kind, process: String(line.process ?? '').slice(0, 80), windowClass: String(line.class ?? '').slice(0, 80), runIds })
    } catch {
      // A listener's failure is not the meter's.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const proc = this.proc
    this.proc = null
    proc?.endInput()
    await Promise.race([proc?.exited ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))])
    await proc?.stop().catch(() => undefined)
  }
}
