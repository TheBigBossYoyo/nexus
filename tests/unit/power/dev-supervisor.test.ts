import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakePowerController } from '@main/modules/power'
import { DevelopmentOvernightSupervisor, failsafeDelaySeconds, FINAL_DELAY_SECONDS, parseControl, type SupervisorState } from '../../../scripts/dev-supervisor/development-overnight-supervisor'

const HOUR = 3_600_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function make(hours = 12): { supervisor: DevelopmentOvernightSupervisor; power: FakePowerController; dir: string; advance(ms: number): void; state(): SupervisorState; drop(name: string, body: unknown): void } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-dev-supervisor-'))
  dirs.push(dir)
  let offset = 0
  const now = (): number => Date.now() + offset
  const power = new FakePowerController({ now })
  const supervisor = new DevelopmentOvernightSupervisor(dir, power, hours, now)
  return {
    supervisor,
    power,
    dir,
    advance: (ms) => void (offset += ms),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as SupervisorState,
    drop: (name, body) => writeFileSync(join(dir, 'control', name), typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

describe('DevelopmentOvernightSupervisor controls', () => {
  it('accepts exactly the three documented controls', () => {
    expect(parseControl({ command: 'status' })).toEqual({ command: 'status' })
    expect(parseControl({ command: 'finish-now' })).toEqual({ command: 'finish-now' })
    expect(parseControl({ command: 'extend', minutes: 30 })).toEqual({ command: 'extend', minutes: 30 })
  })

  it.each([
    ['an unknown command', { command: 'run' }],
    ['an executable', { command: 'finish-now', executable: 'cmd.exe' }],
    ['arguments', { command: 'status', args: ['/r'] }],
    ['a message', { command: 'finish-now', message: 'x' }],
    ['a delay', { command: 'finish-now', delaySeconds: 0 }],
    ['extend without minutes', { command: 'extend' }],
    ['extend with a string', { command: 'extend', minutes: '30 /f' }],
    ['extend with a fraction', { command: 'extend', minutes: 1.5 }],
    ['extend past the largest limit', { command: 'extend', minutes: 100_000 }],
    ['a negative extension', { command: 'extend', minutes: -5 }],
    ['an array', ['finish-now']],
    ['a string', 'finish-now'],
    ['null', null],
  ])('rejects %s', (_name, input) => {
    expect(parseControl(input)).toBeNull()
  })

  it('never computes a failsafe past the hard deadline or under a minute', () => {
    expect(failsafeDelaySeconds(0, 20 * HOUR, 12 * HOUR)).toBe(12 * 3600)
    expect(failsafeDelaySeconds(0, 2 * HOUR, 12 * HOUR)).toBe(2 * 3600)
    expect(failsafeDelaySeconds(12 * HOUR, 12 * HOUR, 12 * HOUR)).toBe(60)
  })
})

describe('DevelopmentOvernightSupervisor lifecycle', () => {
  it('arms a forced failsafe at the hard deadline and persists it', async () => {
    const { supervisor, power, state } = make(12)
    expect(await supervisor.arm()).toBe(true)
    expect(power.calls).toHaveLength(1)
    expect(power.calls[0]!.request).toEqual({ delaySeconds: 12 * 3600, force: true, purpose: 'failsafe' })
    expect(state()).toMatchObject({ phase: 'ARMED', finishRequestedAt: null })
    expect(Date.parse(state().hardDeadline) - Date.parse(state().startedAt)).toBe(12 * HOUR)
  })

  it('finish-now cancels the failsafe, schedules one forced shutdown about 90 seconds later, and is idempotent', async () => {
    const { supervisor, power, state } = make()
    await supervisor.arm()
    expect(await supervisor.handle({ command: 'finish-now' })).toMatch(/^final shutdown at /)
    expect(await supervisor.handle({ command: 'finish-now' })).toBe('already finishing')
    expect(power.calls.map((c) => c.request?.purpose ?? c.operation)).toEqual(['failsafe', 'cancelShutdown', 'final'])
    expect(power.calls[2]!.request).toEqual({ delaySeconds: FINAL_DELAY_SECONDS, force: true, purpose: 'final' })
    expect(state()).toMatchObject({ phase: 'FINAL_SCHEDULED', failsafeDeadline: null })
    expect(state().finalShutdownAt).not.toBeNull()
    // Extending is refused once the session is finishing.
    expect(await supervisor.handle({ command: 'extend', minutes: 60 })).toMatch(/refused/)
  })

  it('keeps a shutdown armed when the final one is refused', async () => {
    const { supervisor, power, state } = make()
    await supervisor.arm()
    power.failNext.scheduleShutdown = 2
    await supervisor.handle({ command: 'finish-now' })
    expect(state().phase).toBe('FINAL_FAILED')
    // The failsafe was cancelled to make room; a short failsafe replaces it rather than leaving nothing.
    expect(power.getState().pending).not.toBeNull()
  })

  it('extend moves the failsafe but never past the hard deadline', async () => {
    const { supervisor, power, state } = make(12)
    await supervisor.arm()
    await supervisor.handle({ command: 'extend', minutes: 600 })
    expect(power.calls.at(-1)!.request).toMatchObject({ purpose: 'failsafe', delaySeconds: 12 * 3600 })
    expect(Date.parse(state().failsafeDeadline!)).toBeLessThanOrEqual(Date.parse(state().hardDeadline) + 1000)
    expect(power.getState().pending?.purpose).toBe('failsafe')
  })

  it('reads control files, acts on valid ones and discards everything else', async () => {
    const { supervisor, power, state, drop, dir } = make()
    await supervisor.arm()
    drop('1-bad.json', { command: 'finish-now', executable: 'cmd.exe' })
    drop('2-garbage.json', '{ not json')
    drop('3-ignored.txt', { command: 'finish-now' })
    drop('4-status.json', { command: 'status' })
    await supervisor.drainControls()
    expect(power.calls).toHaveLength(1)
    expect(state().controlLog.map((c) => c.outcome)).toEqual(['rejected: invalid control', 'rejected: invalid control', 'ok'])
    expect(existsSync(join(dir, 'control', '1-bad.json'))).toBe(false)
    expect(state().phase).toBe('ARMED')

    drop('5-finish.json', { command: 'finish-now' })
    await supervisor.drainControls()
    expect(state().phase).toBe('FINAL_SCHEDULED')
  })

  it('shuts down at the hard deadline even if the timer was aborted from outside', async () => {
    const { supervisor, power, advance, state } = make(1)
    await supervisor.arm()
    await supervisor.enforceDeadline()
    expect(power.calls).toHaveLength(1)
    await power.cancelShutdown()
    advance(HOUR + 1000)
    await supervisor.enforceDeadline()
    expect(state().phase).toBe('FINAL_SCHEDULED')
    expect(power.getState().pending?.purpose).toBe('final')
  })

  it('refuses a hard limit outside the allowed range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-dev-supervisor-'))
    dirs.push(dir)
    expect(() => new DevelopmentOvernightSupervisor(dir, new FakePowerController(), 0)).toThrow()
    expect(() => new DevelopmentOvernightSupervisor(dir, new FakePowerController(), 48)).toThrow()
  })
})
