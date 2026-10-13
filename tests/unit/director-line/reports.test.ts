import { describe, expect, it } from 'vitest'
import type { ReportEvent } from '@shared/director-line'
import type { ProgressSnapshot } from '@shared/progress'
import { DirectorLineReporter, statusSentence } from '@main/runtime/director-line-reports'

// 0.9: what the runtime raises to the Director Line, from the computed progress. The line's policy decides what
// is sent; here it is only checked what is raised, when, and that its text is made of the runtime's own facts.
const T0 = Date.parse('2026-10-13T22:00:00Z')

function snap(over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    subject: { kind: 'run', id: 'run-1' },
    at: new Date(T0).toISOString(),
    percent: 40,
    stage: 'Working on 2 tasks (7 of 19 done)',
    elapsedSeconds: 40 * 60,
    eta: { lowSeconds: 25 * 60, highSeconds: 40 * 60, text: '25–40 min', confidence: 'MEDIUM', uncertainty: null },
    wait: 'ACTIVE',
    summary: '25–40 min of active work remain.',
    tasks: { total: 19, completed: 7, running: 2, waiting: 0, failed: 0, remaining: 12 },
    workers: { active: 2, waiting: 0 },
    blocker: null,
    scopeChange: null,
    lastEvent: null,
    milestones: [],
    nextRefreshAt: null,
    ...over,
  }
}

function reporter() {
  let now = T0
  const raised: ReportEvent[] = []
  const r = new DirectorLineReporter({ report: (e) => void raised.push(e), now: () => now })
  return { r, raised, advance: (minutes: number) => (now += minutes * 60_000), kinds: () => raised.map((e) => e.kind) }
}

describe('reports raised to the Director Line', () => {
  it('a status sentence is the computed progress in plain words', () => {
    expect(statusSentence('RaceDeck: telemetry', snap())).toBe('RaceDeck: telemetry: 40%, working on 2 tasks (7 of 19 done). 7 of 19 tasks completed. 25–40 min of active work remain.')
    expect(statusSentence('Night', snap({ wait: 'FINISHED', stage: 'Completed', percent: 100, elapsedSeconds: 3 * 3600 + 5 * 60, tasks: { total: 19, completed: 17, running: 0, waiting: 0, failed: 2, remaining: 0 } }))).toBe('Night: completed. 17 of 19 tasks completed, 2 failed. It took 3h 05m.')
  })

  it('the end of a mission is one completion, a failure is a critical failure, and an overnight run brings its report', () => {
    const done = reporter()
    done.r.onProgress(snap({ wait: 'FINISHED', stage: 'Completed', percent: 100 }), 'A')
    expect(done.raised.at(-1)).toMatchObject({ kind: 'PROGRAM_COMPLETE', subjectId: 'run-1', resolved: true })
    const failed = reporter()
    failed.r.onProgress(snap({ wait: 'FINISHED', stage: 'Failed' }), 'A')
    expect(failed.raised.at(-1)?.kind).toBe('CRITICAL_FAILURE')
    const night = reporter()
    night.r.onProgress(snap({ wait: 'FINISHED', stage: 'Completed', percent: 100 }), 'Night', 'All tests passed on completed work.\nOne task waits on a dependency.')
    expect(night.raised.at(-1)?.kind).toBe('MORNING_OVERNIGHT_REPORT')
    expect(night.raised.at(-1)?.text).toContain('One task waits on a dependency.')
  })

  it('a network outage is raised with how long it has lasted, at growing intervals, and once more when it ends', () => {
    const w = reporter()
    const offline = snap({ wait: 'WAITING_FOR_NETWORK', stage: 'Waiting for the Internet', summary: '25–40 min of active work remain. Waiting for the Internet; when that ends is not known, so neither is the time on the clock.' })
    w.r.onProgress(offline, 'Night')
    for (let minute = 1; minute <= 70; minute += 1) {
      w.advance(1)
      w.r.tick()
    }
    const outages = w.raised.filter((e) => e.kind === 'NETWORK_OFFLINE')
    expect(outages.map((e) => e.minutes)).toEqual([5, 15, 30, 60])
    expect(outages[0]?.text).toContain('nothing failed')
    w.r.onProgress(snap(), 'Night')
    const back = w.raised.filter((e) => e.kind === 'NETWORK_OFFLINE').at(-1)
    expect(back).toMatchObject({ resolved: true, minutes: 70 })
    expect(back?.text).toContain('the network is back after 70 min')
  })

  it('a boundary request is said at once and as something that cannot be granted from the phone; a blocker that lasts is raised again; its end is said', () => {
    const w = reporter()
    const waiting = snap({ wait: 'WAITING_FOR_USER_BOUNDARY', blocker: 'Waiting for your decision on a boundary request: 1 boundary request to decide' })
    w.r.onProgress(waiting, 'A')
    const first = w.raised.find((e) => e.kind === 'SECURITY_BOUNDARY_REQUIRED')
    expect(first?.text).toContain('It cannot be given from here')
    w.r.onProgress(waiting, 'A')
    expect(w.raised.filter((e) => e.kind === 'SECURITY_BOUNDARY_REQUIRED')).toHaveLength(1)
    for (let minute = 1; minute <= 16; minute += 1) {
      w.advance(1)
      w.r.tick()
    }
    expect(w.raised.filter((e) => e.kind === 'MISSION_BLOCKED' && !e.resolved).map((e) => e.minutes)).toEqual([5, 15])
    w.r.onProgress(snap(), 'A')
    expect(w.raised.filter((e) => e.kind === 'MISSION_BLOCKED').at(-1)).toMatchObject({ resolved: true })
  })

  it('an estimate that slips is raised when it has slipped by a quarter and ten minutes, with the reason when the scope grew; waiting is not a slip', () => {
    const w = reporter()
    w.r.onProgress(snap(), 'A')
    w.advance(10)
    // On time: ten minutes later, ten minutes less.
    w.r.onProgress(snap({ eta: { lowSeconds: 15 * 60, highSeconds: 30 * 60, text: '15–30 min', confidence: 'MEDIUM', uncertainty: null } }), 'A')
    expect(w.kinds()).not.toContain('ETA_SLIPPED')
    w.advance(10)
    w.r.onProgress(snap({ eta: { lowSeconds: 30 * 60, highSeconds: 45 * 60, text: '30–45 min', confidence: 'MEDIUM', uncertainty: null }, scopeChange: 'Scope expanded: 2 tasks were added after verification.' }), 'A')
    const slip = w.raised.find((e) => e.kind === 'ETA_SLIPPED')
    expect(slip).toMatchObject({ slippedMinutes: 25 })
    expect(slip?.text).toContain('Scope expanded: 2 tasks were added after verification')
    // The same slip is not raised twice.
    w.advance(1)
    w.r.onProgress(snap({ eta: { lowSeconds: 29 * 60, highSeconds: 44 * 60, text: '30–45 min', confidence: 'MEDIUM', uncertainty: null } }), 'A')
    expect(w.raised.filter((e) => e.kind === 'ETA_SLIPPED')).toHaveLength(1)
    // An estimate made while waiting, or a LOW one, is held against nothing.
    const quiet = reporter()
    quiet.r.onProgress(snap({ eta: { lowSeconds: 60, highSeconds: 120, text: 'under 2 min', confidence: 'LOW', uncertainty: 'x' } }), 'B')
    quiet.advance(60)
    quiet.r.onProgress(snap({ wait: 'WAITING_FOR_PROVIDER' }), 'B')
    expect(quiet.kinds()).not.toContain('ETA_SLIPPED')
  })

  it('a line that throws does not stop the runtime', () => {
    const r = new DirectorLineReporter({ report: () => { throw new Error('away') }, now: () => T0 })
    expect(() => r.onProgress(snap(), 'A')).not.toThrow()
    expect(() => r.tick()).not.toThrow()
  })
})
