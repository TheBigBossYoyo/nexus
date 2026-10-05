import { describe, expect, it } from 'vitest'
import { decide, THROTTLE_WORKER_DIVISOR } from '@main/modules/policy'
import { decideInput, pref, snapshot, statsFor } from './helpers'

const CTX = 'bugfix|medium|low'

describe('decide: default and user layers', () => {
  it('uses the default policy when there is no promoted preference', () => {
    const d = decide(decideInput(CTX))
    expect(d.strategy).toBe('BUILD')
    expect(d.layer).toBe('default')
    expect(d.exploration).toBe(false)
    expect(d.seed).toBeNull()
    expect(d.policyVersion).toBe(1)
    expect(d.planningMode).toBe('single')
    expect(d.reviewDepth).toBe('auto')
    expect(d.workerCount).toBeGreaterThanOrEqual(1)
    expect(d.modelPolicies['worker']).toBeDefined()
  })

  it('does not change the strategy because of evidence alone, however good', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 5, fail: 20 }, SWARM: { pass: 30, fail: 0 } })
    const d = decide(decideInput(CTX, { stats }))
    expect(d.strategy).toBe('BUILD')
    expect(d.layer).toBe('default')
  })

  it('a user-forced strategy skips every other layer', () => {
    const d = decide(decideInput(CTX, { forced: 'SWARM', usageStatus: 'THROTTLED', recentLimit: true, snapshot: snapshot({}, [], { exploration: 'research' }) }))
    expect(d.strategy).toBe('SWARM')
    expect(d.layer).toBe('user')
    expect(d.exploration).toBe(false)
    expect(d.resourceNotes).toEqual([])
  })
})

describe('decide: evidence override', () => {
  it('applies a promoted preference and cites counts, never percentages of invented precision', () => {
    const stats = statsFor(CTX, {
      BUILD: { pass: 11, fail: 9, sessions: 3 },
      SWARM: { pass: 18, fail: 3, sessions: 5.4 },
    })
    const d = decide(decideInput(CTX, { stats, snapshot: snapshot({ version: 2 }, [pref(CTX, 'SWARM')]) }))
    expect(d.strategy).toBe('SWARM')
    expect(d.layer).toBe('evidence')
    expect(d.reason).toContain('SWARM passed 18 of 21 Arena trials')
    expect(d.reason).toContain('11 of 20')
    expect(d.reason).toContain('SWARM averaged 1.8x the sessions of BUILD')
    expect(d.reason).toContain('Evidence: MODERATE')
    expect(d.reason).not.toContain('Evidence: WEAK')
    expect(d.reason).not.toMatch(/\d+\.\d{2,}%/)
    expect(d.evidenceContextKey).toBe(CTX)
    expect(d.evidenceSummary.map((r) => r.strategy).sort()).toEqual(['BUILD', 'SWARM'])
  })

  it('names the cost of the other strategy when the chosen one is cheaper', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 18, fail: 3, sessions: 3 }, SWARM: { pass: 11, fail: 9, sessions: 5.4 } })
    const d = decide(decideInput(CTX, { stats, snapshot: snapshot({ version: 2 }, [pref(CTX, 'BUILD', 'SINGLE')]) }))
    expect(d.reason).toContain('BUILD passed 18 of 21 Arena trials versus 11 of 20 Arena trials for SWARM; SWARM also averaged 1.8x the sessions')
  })

  it('a preference for a category applies to its contexts through the fallback chain', () => {
    const d = decide(decideInput('bugfix|large|medium', { snapshot: snapshot({}, [pref('bugfix|*|*', 'SINGLE')]) }))
    expect(d.strategy).toBe('SINGLE')
    expect(d.layer).toBe('evidence')
  })

  it('a SPECULATIVE preference is inert while speculation is OFF', () => {
    const d = decide(decideInput(CTX, { snapshot: snapshot({}, [pref(CTX, 'SPECULATIVE')]) }))
    expect(d.strategy).toBe('BUILD')
  })

  it('reports counts of missions separately from Arena trials', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 12, fail: 2 } })
    const d = decide(decideInput(CTX, { stats }))
    const row = d.evidenceSummary[0]!
    expect(row.arenaN).toBe(14)
    expect(row.missionN).toBe(0)
  })
})

describe('decide: suppression', () => {
  it('never uses a suppressed strategy, even if promoted', () => {
    const stats = statsFor(CTX, { SWARM: { pass: 0, fail: 4 }, BUILD: { pass: 10, fail: 4 } })
    const d = decide(decideInput(CTX, { stats, snapshot: snapshot({}, [pref(CTX, 'SWARM')]) }))
    expect(d.strategy).not.toBe('SWARM')
    expect(d.reason).toContain('not used')
  })

  it('replaces a suppressed default with the best remaining strategy', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 0, fail: 3 }, CONSENSUS: { pass: 8, fail: 2 } })
    const d = decide(decideInput(CTX, { stats }))
    expect(d.strategy).toBe('CONSENSUS')
    expect(d.reason).toContain('BUILD is suppressed')
  })

  it('a majority of stability failures (at least two) suppresses a strategy', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 1, fail: 0, crashed: 3 } })
    const d = decide(decideInput(CTX, { stats }))
    expect(d.strategy).not.toBe('BUILD')
  })

  it('exploration never selects a suppressed strategy', () => {
    const stats = statsFor(CTX, { SWARM: { pass: 0, fail: 5 } })
    for (let seed = 0; seed < 300; seed++) {
      const d = decide(decideInput(CTX, { stats, seed, snapshot: snapshot({}, [], { exploration: 'research' }) }))
      expect(d.strategy).not.toBe('SWARM')
    }
  })
})

describe('decide: exploration', () => {
  const research = snapshot({}, [], { exploration: 'research' })

  it('same seed gives the same decision', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 10, fail: 5 }, SWARM: { pass: 5, fail: 5 } })
    const a = decide(decideInput(CTX, { stats, seed: 12345, snapshot: research }))
    const b = decide(decideInput(CTX, { stats, seed: 12345, snapshot: research }))
    expect(a).toEqual(b)
    expect(a.seed).toBe(12345)
  })

  it('explores near the configured rate and different seeds pick different arms', () => {
    const n = 2000
    let explored = 0
    const arms = new Set<string>()
    for (let seed = 1; seed <= n; seed++) {
      const d = decide(decideInput(CTX, { seed, snapshot: research }))
      if (d.exploration) {
        explored += 1
        expect(d.layer).toBe('exploration')
        arms.add(d.strategy)
      }
    }
    expect(explored / n).toBeGreaterThan(0.34)
    expect(explored / n).toBeLessThan(0.46)
    expect(arms.size).toBeGreaterThanOrEqual(3)
    // SPECULATIVE is not eligible while the policy is OFF.
    expect(arms.has('SPECULATIVE')).toBe(false)
  })

  it('conservative mode explores about 5% of the time', () => {
    const n = 4000
    let explored = 0
    for (let seed = 1; seed <= n; seed++) {
      if (decide(decideInput(CTX, { seed, snapshot: snapshot({}, [], { exploration: 'conservative' }) })).exploration) explored += 1
    }
    expect(explored / n).toBeGreaterThan(0.035)
    expect(explored / n).toBeLessThan(0.065)
  })

  it('off never explores and stores no seed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const d = decide(decideInput(CTX, { seed }))
      expect(d.exploration).toBe(false)
      expect(d.seed).toBeNull()
    }
  })

  it('high-risk tasks never explore outside research mode', () => {
    const ctx = 'security|large|high'
    for (const mode of ['conservative', 'balanced'] as const) {
      for (let seed = 1; seed <= 300; seed++) {
        const d = decide(decideInput(ctx, { seed, snapshot: snapshot({}, [], { exploration: mode }) }))
        expect(d.exploration).toBe(false)
        expect(d.strategy).toBe('CONSENSUS')
      }
    }
    let explored = 0
    for (let seed = 1; seed <= 300; seed++) if (decide(decideInput(ctx, { seed, snapshot: research })).exploration) explored += 1
    expect(explored).toBeGreaterThan(0)
  })

  it('SPECULATIVE is reachable only when speculation is not OFF', () => {
    const auto = snapshot({}, [], { exploration: 'research', speculation: 'AUTO' })
    let seen = false
    for (let seed = 1; seed <= 600 && !seen; seed++) seen = decide(decideInput(CTX, { seed, snapshot: auto })).strategy === 'SPECULATIVE'
    expect(seen).toBe(true)
  })

  it('favours strategies with better evidence when it explores', () => {
    const stats = statsFor(CTX, { BUILD: { pass: 40, fail: 2 }, SWARM: { pass: 1, fail: 25 }, SINGLE: { pass: 1, fail: 25 }, CONSENSUS: { pass: 1, fail: 25 } })
    let build = 0
    let explored = 0
    for (let seed = 1; seed <= 600; seed++) {
      const d = decide(decideInput(CTX, { stats, seed, snapshot: research }))
      if (d.exploration) {
        explored += 1
        if (d.strategy === 'BUILD') build += 1
      }
    }
    expect(build / explored).toBeGreaterThan(0.8)
  })
})

describe('decide: resource availability', () => {
  it('halves the worker count when throttled, with a note', () => {
    const base = decide(decideInput(CTX))
    const d = decide(decideInput(CTX, { usageStatus: 'THROTTLED' }))
    expect(d.workerCount).toBe(Math.max(1, Math.floor(base.workerCount / THROTTLE_WORKER_DIVISOR)))
    expect(d.resourceNotes.join(' ')).toContain('Worker count reduced')
    expect(d.usageStatus).toBe('THROTTLED')
    const approaching = decide(decideInput(CTX, { usageStatus: 'LIMIT_APPROACHING' }))
    expect(approaching.workerCount).toBe(d.workerCount)
  })

  it('never goes below one worker', () => {
    const d = decide(decideInput('bugfix|small|low', { usageStatus: 'THROTTLED' })) // SINGLE: 1 worker
    expect(d.workerCount).toBe(1)
    expect(d.resourceNotes).toEqual([])
  })

  it('defers SWARM to BUILD after a recent limit or when not AVAILABLE', () => {
    const snap = snapshot({}, [pref(CTX, 'SWARM')])
    expect(decide(decideInput(CTX, { snapshot: snap })).strategy).toBe('SWARM')
    const limited = decide(decideInput(CTX, { snapshot: snap, recentLimit: true }))
    expect(limited.strategy).toBe('BUILD')
    expect(limited.resourceNotes.join(' ')).toContain('SWARM deferred to BUILD')
    expect(decide(decideInput(CTX, { snapshot: snap, usageStatus: 'WAITING_FOR_RESET' })).strategy).toBe('BUILD')
  })

  it('never chooses SPECULATIVE under a recent limit or a non-AVAILABLE status', () => {
    const snap = snapshot({}, [pref(CTX, 'SPECULATIVE')], { speculation: 'AUTO' })
    expect(decide(decideInput(CTX, { snapshot: snap })).strategy).toBe('SPECULATIVE')
    expect(decide(decideInput(CTX, { snapshot: snap, recentLimit: true })).strategy).not.toBe('SPECULATIVE')
    expect(decide(decideInput(CTX, { snapshot: snap, usageStatus: 'THROTTLED' })).strategy).not.toBe('SPECULATIVE')
  })

  it('never writes a capacity number into its notes', () => {
    const d = decide(decideInput(CTX, { usageStatus: 'THROTTLED', recentLimit: true }))
    const text = [d.reason, ...d.resourceNotes].join(' ')
    expect(text).not.toMatch(/remaining|% (left|remaining)|capacity/i)
  })
})
