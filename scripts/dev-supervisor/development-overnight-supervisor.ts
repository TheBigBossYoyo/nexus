import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WindowsPowerController } from '@main/modules/power'
import type { PowerCommandResult } from '@shared/overnight'

/**
 * DevelopmentOvernightSupervisor: the trusted helper that owns the Windows power lifecycle of an
 * unattended DEVELOPMENT session (a release train driven from a coding assistant). It is not part of
 * the application and no NEXUS agent can reach it: it is started by hand from a terminal, runs as its
 * own detached Node process, and uses the application's WindowsPowerController for every power call.
 *
 * It accepts exactly three controls, as small JSON files dropped in its control directory:
 *   status                 rewrite state.json
 *   extend {minutes}       move the failsafe later, never past the hard deadline fixed at start
 *   finish-now             cancel the distant failsafe and shut down about 90 seconds later
 * No control carries an executable, an argument or message text.
 *
 * The failsafe is the operating system's own shutdown timer, armed at start, so it stays effective if
 * this process, the assistant or the terminal dies.
 */

export const FINAL_DELAY_SECONDS = 90
export const MAX_HARD_LIMIT_HOURS = 16
const POLL_MS = 2000

export type ControlCommand = { command: 'status' } | { command: 'extend'; minutes: number } | { command: 'finish-now' }

export interface SupervisorState {
  pid: number
  startedAt: string
  hardDeadline: string
  failsafeDeadline: string | null
  phase: 'ARMING' | 'ARMED' | 'ARM_FAILED' | 'FINISHING' | 'FINAL_SCHEDULED' | 'FINAL_FAILED'
  finishRequestedAt: string | null
  finalShutdownAt: string | null
  updatedAt: string
  powerLog: (PowerCommandResult & { step: string })[]
  controlLog: { at: string; command: string; outcome: string }[]
}

/** Accepts only the three documented shapes; anything else (extra keys included) is rejected. */
export function parseControl(raw: unknown): ControlCommand | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record['command'] === 'status' && keys === 'command') return { command: 'status' }
  if (record['command'] === 'finish-now' && keys === 'command') return { command: 'finish-now' }
  if (record['command'] === 'extend' && keys === 'command,minutes') {
    const minutes = record['minutes']
    if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_HARD_LIMIT_HOURS * 60) return { command: 'extend', minutes }
  }
  return null
}

/** Seconds from `now` to the requested failsafe time, never past the hard deadline, never under a minute. */
export function failsafeDelaySeconds(nowMs: number, requestedMs: number, hardDeadlineMs: number): number {
  const target = Math.min(requestedMs, hardDeadlineMs)
  return Math.max(60, Math.round((target - nowMs) / 1000))
}

function readControl(path: string): ControlCommand | null {
  try {
    return parseControl(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function defaultStateDir(): string {
  const base = process.env['LOCALAPPDATA'] ?? join(process.env['USERPROFILE'] ?? 'C:\\', 'AppData', 'Local')
  return join(base, 'NexusDevSupervisor')
}

interface PowerLike {
  scheduleShutdown(request: { delaySeconds: number; force: boolean; purpose: 'failsafe' | 'final' }): Promise<PowerCommandResult>
  cancelShutdown(): Promise<PowerCommandResult>
}

export class DevelopmentOvernightSupervisor {
  private state: SupervisorState
  private finishing = false

  constructor(
    private readonly dir: string,
    private readonly power: PowerLike,
    hardLimitHours: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(hardLimitHours > 0 && hardLimitHours <= MAX_HARD_LIMIT_HOURS)) throw new Error(`Hard limit must be within 0..${MAX_HARD_LIMIT_HOURS} hours`)
    mkdirSync(join(dir, 'control'), { recursive: true })
    const started = this.now()
    this.state = {
      pid: process.pid,
      startedAt: new Date(started).toISOString(),
      hardDeadline: new Date(started + hardLimitHours * 3_600_000).toISOString(),
      failsafeDeadline: null,
      phase: 'ARMING',
      finishRequestedAt: null,
      finalShutdownAt: null,
      updatedAt: new Date(started).toISOString(),
      powerLog: [],
      controlLog: [],
    }
  }

  getState(): SupervisorState {
    return this.state
  }

  private persist(): void {
    this.state.updatedAt = new Date(this.now()).toISOString()
    const file = join(this.dir, 'state.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.state, null, 2))
    renameSync(`${file}.tmp`, file)
  }

  private record(step: string, result: PowerCommandResult): void {
    this.state.powerLog.push({ step, ...result })
  }

  /** Arms the operating-system failsafe at the hard deadline. */
  async arm(): Promise<boolean> {
    const hard = Date.parse(this.state.hardDeadline)
    const ok = await this.armFailsafe(hard, 'arm-failsafe')
    this.state.phase = ok ? 'ARMED' : 'ARM_FAILED'
    this.persist()
    return ok
  }

  private async armFailsafe(requestedMs: number, step: string): Promise<boolean> {
    const hard = Date.parse(this.state.hardDeadline)
    const delaySeconds = failsafeDelaySeconds(this.now(), requestedMs, hard)
    const result = await this.power.scheduleShutdown({ delaySeconds, force: true, purpose: 'failsafe' })
    this.record(step, result)
    if (result.ok) this.state.failsafeDeadline = new Date(this.now() + delaySeconds * 1000).toISOString()
    return result.ok
  }

  async handle(control: ControlCommand): Promise<string> {
    let outcome: string
    if (control.command === 'status') outcome = 'ok'
    else if (control.command === 'extend') outcome = await this.extend(control.minutes)
    else outcome = await this.finish()
    this.state.controlLog.push({ at: new Date(this.now()).toISOString(), command: control.command, outcome })
    this.persist()
    return outcome
  }

  private async extend(minutes: number): Promise<string> {
    if (this.finishing) return 'refused: already finishing'
    const base = this.state.failsafeDeadline === null ? this.now() : Date.parse(this.state.failsafeDeadline)
    const previous = this.state.failsafeDeadline
    const cancel = await this.power.cancelShutdown()
    this.record('extend-cancel', cancel)
    if (await this.armFailsafe(base + minutes * 60_000, 'extend-arm')) return `failsafe now ${this.state.failsafeDeadline ?? ''}`
    // Could not re-arm at the new time: put the previous timer back rather than leave nothing armed.
    if (previous !== null) await this.armFailsafe(Date.parse(previous), 'extend-restore')
    return 'failed: failsafe restored'
  }

  /** Idempotent: one final shutdown, however many times it is asked for. */
  private async finish(): Promise<string> {
    if (this.finishing) return 'already finishing'
    this.finishing = true
    this.state.phase = 'FINISHING'
    this.state.finishRequestedAt = new Date(this.now()).toISOString()
    this.persist()
    const cancel = await this.power.cancelShutdown()
    this.record('finish-cancel-failsafe', cancel)
    let final = await this.power.scheduleShutdown({ delaySeconds: FINAL_DELAY_SECONDS, force: true, purpose: 'final' })
    this.record('finish-final', final)
    if (!final.ok) {
      final = await this.power.scheduleShutdown({ delaySeconds: FINAL_DELAY_SECONDS, force: true, purpose: 'final' })
      this.record('finish-final-retry', final)
    }
    if (final.ok) {
      this.state.phase = 'FINAL_SCHEDULED'
      this.state.failsafeDeadline = null
      this.state.finalShutdownAt = new Date(this.now() + FINAL_DELAY_SECONDS * 1000).toISOString()
      return `final shutdown at ${this.state.finalShutdownAt}`
    }
    // 1190: a shutdown is already scheduled (the failsafe survived the cancel). Leave it armed.
    this.state.phase = 'FINAL_FAILED'
    if (cancel.ok) await this.armFailsafe(this.now() + FINAL_DELAY_SECONDS * 1000, 'finish-fallback-failsafe')
    return 'final shutdown failed; failsafe kept'
  }

  /** Reads, validates and removes every control file. Invalid files are removed and logged, never acted on. */
  async drainControls(): Promise<void> {
    const controlDir = join(this.dir, 'control')
    for (const name of readdirSync(controlDir).sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(controlDir, name)
      const control = readControl(path)
      rmSync(path, { force: true })
      if (control === null) {
        this.state.controlLog.push({ at: new Date(this.now()).toISOString(), command: name, outcome: 'rejected: invalid control' })
        this.persist()
        continue
      }
      await this.handle(control)
    }
  }

  /** Past the hard deadline with no shutdown under way (someone aborted the timer): shut down now. */
  async enforceDeadline(): Promise<void> {
    if (this.finishing || this.now() < Date.parse(this.state.hardDeadline)) return
    await this.handle({ command: 'finish-now' })
  }
}

async function runDaemon(dir: string, hours: number): Promise<void> {
  const supervisor = new DevelopmentOvernightSupervisor(dir, new WindowsPowerController(), hours)
  const armed = await supervisor.arm()
  if (!armed) process.exitCode = 2
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    try {
      await supervisor.drainControls()
      await supervisor.enforceDeadline()
    } catch (e) {
      writeFileSync(join(dir, 'last-error.txt'), `${new Date().toISOString()} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    }
  }
}

function readState(dir: string): SupervisorState | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as SupervisorState
  } catch {
    return null
  }
}

async function signal(dir: string, control: ControlCommand): Promise<void> {
  const before = readState(dir)?.controlLog.length ?? 0
  const controlDir = join(dir, 'control')
  if (!existsSync(controlDir)) throw new Error(`No supervisor control directory at ${controlDir}`)
  const name = `${Date.now()}-${control.command}.json`
  writeFileSync(join(controlDir, `${name}.tmp`), JSON.stringify(control))
  renameSync(join(controlDir, `${name}.tmp`), join(controlDir, name))
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const state = readState(dir)
    if (state !== null && state.controlLog.length > before) {
      console.log(JSON.stringify({ acknowledged: true, phase: state.phase, hardDeadline: state.hardDeadline, failsafeDeadline: state.failsafeDeadline, finalShutdownAt: state.finalShutdownAt, last: state.controlLog.at(-1) }, null, 2))
      return
    }
  }
  console.log(JSON.stringify({ acknowledged: false, note: 'The supervisor did not answer within 30 s. The existing failsafe was left as it is.' }))
  process.exitCode = 3
}

async function main(argv: string[]): Promise<void> {
  const [mode, arg] = argv
  const dir = defaultStateDir()
  if (mode === 'daemon') {
    await runDaemon(dir, Number(arg ?? '12'))
  } else if (mode === 'start') {
    const hours = Number(arg ?? '12')
    if (!(hours > 0 && hours <= MAX_HARD_LIMIT_HOURS)) throw new Error('Invalid hard limit')
    mkdirSync(dir, { recursive: true })
    const script = process.argv[1]
    if (script === undefined) throw new Error('Unknown script path')
    const child = spawn(process.execPath, [script, 'daemon', String(hours)], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    console.log(JSON.stringify({ started: true, pid: child.pid, stateDir: dir }))
  } else if (mode === 'status') {
    await signal(dir, { command: 'status' })
  } else if (mode === 'extend') {
    const control = parseControl({ command: 'extend', minutes: Number(arg) })
    if (control === null) throw new Error('extend needs whole minutes')
    await signal(dir, control)
  } else if (mode === 'finish-now') {
    await signal(dir, { command: 'finish-now' })
  } else {
    console.log('usage: start [hours] | status | extend <minutes> | finish-now')
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && /development-overnight-supervisor\.(mjs|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
