import { describe, expect, it } from 'vitest'
import { decideKeepAwake, OvernightPowerGuard, type AutonomousWorkItem, type AutonomousWorkStatus, type PowerLogEntry } from '@main/modules/connectivity/keep-awake'
import { FakeClock } from './fakes'

const HOUR = 3_600_000
const item = (status: AutonomousWorkStatus, over: Partial<AutonomousWorkItem> = {}): AutonomousWorkItem => ({ id: 'r1', kind: 'OVERNIGHT', status, lastProgressAt: 1000, ...over })

describe('keep-awake decision table', () => {
  it('holds while an autonomous run is working', () => {
    for (const kind of ['OVERNIGHT', 'PROGRAM', 'WORKSPACE_RUN', 'LONG_MISSION'] as const) {
      expect(decideKeepAwake([item('WORKING', { kind })], 2000).hold, kind).toBe(true)
    }
  })

  it('holds while the work waits for the network or the provider, because it will resume', () => {
    expect(decideKeepAwake([item('WAITING_FOR_NETWORK')], 2000).hold).toBe(true)
    expect(decideKeepAwake([item('WAITING_FOR_PROVIDER')], 2000).hold).toBe(true)
  })

  it('does not hold when nothing autonomous is active', () => {
    expect(decideKeepAwake([], 0)).toEqual({ hold: false, reason: 'nothing autonomous is active' })
    expect(decideKeepAwake([item('FINISHED')], 2000).hold).toBe(false)
  })

  it('does not hold when everything is paused by the user', () => {
    const d = decideKeepAwake([item('PAUSED_BY_USER'), item('PAUSED_BY_USER', { id: 'r2' })], 2000)
    expect(d).toEqual({ hold: false, reason: 'everything is paused by the user' })
  })

  it('does not hold when all remaining work waits on the user or on a boundary decision', () => {
    expect(decideKeepAwake([item('WAITING_FOR_USER')], 2000).hold).toBe(false)
    expect(decideKeepAwake([item('WAITING_FOR_USER_BOUNDARY'), item('WAITING_FOR_USER', { id: 'r2' })], 2000).reason).toBe('all remaining work waits on the user')
    expect(decideKeepAwake([item('PAUSED_BY_USER'), item('WAITING_FOR_USER', { id: 'r2' })], 2000).hold).toBe(false)
  })

  it('holds when one item works and another waits on the user', () => {
    expect(decideKeepAwake([item('WAITING_FOR_USER'), item('WORKING', { id: 'r2' })], 2000).hold).toBe(true)
  })

  it('names the work it holds for', () => {
    expect(decideKeepAwake([item('WAITING_FOR_NETWORK', { kind: 'PROGRAM', id: 'p9' })], 2000).reason).toBe('PROGRAM p9 waiting for network')
  })

  it('releases when the work has not moved for longer than the maximum holding time, and says so', () => {
    const d = decideKeepAwake([item('WAITING_FOR_NETWORK', { lastProgressAt: 0 })], 6 * HOUR + 1)
    expect(d.hold).toBe(false)
    expect(d.reason).toMatch(/no progress for 360 min.*maximum holding time of 360 min/)
    expect(decideKeepAwake([item('WORKING', { lastProgressAt: 0 })], 6 * HOUR).hold).toBe(true)
  })

  it('holds for the fresh item while a stalled one is ignored', () => {
    const d = decideKeepAwake([item('WORKING', { lastProgressAt: 0 }), item('WORKING', { id: 'r2', lastProgressAt: 5 * HOUR })], 7 * HOUR)
    expect(d.hold).toBe(true)
    expect(d.reason).toContain('r2')
    expect(d.reason).not.toContain('r1')
  })
})

describe('overnight power guard', () => {
  function build(maxHoldMs?: number) {
    const clock = new FakeClock(HOUR)
    const calls: boolean[] = []
    const sink: PowerLogEntry[] = []
    const guard = new OvernightPowerGuard({ setKeepAwake: (on) => calls.push(on), timers: clock, sink: (e) => sink.push(e), maxHoldMs })
    return { clock, calls, sink, guard }
  }

  it('asks for the request once when work starts and drops it at once when the work ends', () => {
    const { clock, calls, sink, guard } = build()
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    expect(calls).toEqual([true])
    guard.update([item('FINISHED')])
    expect(calls).toEqual([true, false])
    expect(guard.isHeld).toBe(false)
    expect(sink.map((e) => [e.action, e.reason])).toEqual([['ACQUIRE', 'OVERNIGHT r1 working'], ['RELEASE', 'nothing autonomous is active']])
    expect(guard.entries()).toEqual(sink)
  })

  it('releases at once when the user pauses everything', () => {
    const { clock, calls, guard } = build()
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    guard.update([item('PAUSED_BY_USER', { lastProgressAt: clock.now() })])
    expect(calls).toEqual([true, false])
    expect(guard.reason).toBe('everything is paused by the user')
  })

  it('releases by itself after the maximum holding time without progress, records why, and does not take the request again', async () => {
    const { clock, calls, guard } = build(2 * HOUR)
    guard.update([item('WAITING_FOR_NETWORK', { lastProgressAt: clock.now() })])
    expect(guard.isHeld).toBe(true)
    await clock.advance(2 * HOUR - 1)
    expect(guard.isHeld).toBe(true)
    await clock.advance(2)
    expect(guard.isHeld).toBe(false)
    expect(guard.entries().at(-1)?.reason).toMatch(/maximum holding time/)
    guard.update([item('WAITING_FOR_NETWORK', { lastProgressAt: HOUR })])
    expect(calls).toEqual([true, false])
  })

  it('takes the request again when the work makes progress after a release', async () => {
    const { clock, calls, guard } = build(HOUR)
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    await clock.advance(HOUR + 10)
    expect(guard.isHeld).toBe(false)
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    expect(calls).toEqual([true, false, true])
  })

  it('moves the release time forward when progress is reported', async () => {
    const { clock, guard } = build(HOUR)
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    await clock.advance(HOUR - 10)
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    await clock.advance(HOUR - 10)
    expect(guard.isHeld).toBe(true)
  })

  it('leaves no timer behind when it is not holding, and releases on dispose', () => {
    const { clock, calls, guard } = build()
    guard.update([item('FINISHED')])
    expect(clock.pending).toBe(0)
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    expect(clock.pending).toBe(1)
    guard.dispose()
    expect(calls).toEqual([true, false])
    expect(clock.pending).toBe(0)
  })

  it('does not claim a state it could not set', () => {
    const clock = new FakeClock()
    const logs: string[] = []
    const guard = new OvernightPowerGuard({ setKeepAwake: () => { throw new Error('blocker unavailable') }, timers: clock, logger: (l) => logs.push(l) })
    guard.update([item('WORKING', { lastProgressAt: clock.now() })])
    expect(guard.isHeld).toBe(false)
    expect(guard.entries()).toEqual([])
    expect(logs[0]).toContain('blocker unavailable')
  })

  it('goes on when the sink throws, and bounds its own log', () => {
    const clock = new FakeClock()
    const guard = new OvernightPowerGuard({ setKeepAwake: () => undefined, timers: clock, sink: () => { throw new Error('sink') }, keepLog: 3 })
    for (let i = 0; i < 6; i++) guard.update([item(i % 2 === 0 ? 'WORKING' : 'FINISHED', { lastProgressAt: clock.now() })])
    expect(guard.entries()).toHaveLength(3)
  })
})
