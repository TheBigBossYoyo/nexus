import { describe, expect, it } from 'vitest'
import { EXPLORATION_RATES } from '@shared/v3'
import { PolicySimulator, simulate, type SimWorld } from '@main/modules/policy'

const CTX = 'feature|medium|low'
const truth = (passRate: number, sessions = 3, extra: { crashRate?: number } = {}) => ({ passRate, sessions, durationMs: 600_000, ...extra })

/** BUILD is mediocre, SWARM is clearly better, in the hidden world. */
const swarmBetter: SimWorld = { contexts: [{ contextKey: CTX, truth: { BUILD: truth(0.4), SWARM: truth(0.95), CONSENSUS: truth(0.5), SINGLE: truth(0.4) } }] }

describe('policy simulator scenarios', () => {
  it('weak evidence keeps the default', () => {
    const sim = new PolicySimulator(1, swarmBetter, 'off')
    for (let i = 0; i < 4; i++) sim.arenaTrial(CTX, 'SWARM')
    for (let i = 0; i < 8; i++) sim.arenaTrial(CTX, 'BUILD')
    const { candidates, notes } = sim.learn()
    expect(candidates).toEqual([])
    expect(notes.length).toBeGreaterThan(0)
    expect(sim.decideFor(CTX).strategy).toBe('BUILD')
    expect(sim.active.version).toBe(1)
  })

  it('missions alone cannot move policy when the default is the only thing ever run', () => {
    const trace = simulate({ seed: 3, steps: 60, world: swarmBetter, mode: 'off', autoPromote: true, learnEvery: 5 })
    expect(trace.steps.every((s) => s.strategy === 'BUILD')).toBe(true)
    expect(trace.final.version).toBe(1)
  })

  it('strong evidence changes the preference only through a candidate and a promotion', () => {
    const sim = new PolicySimulator(7, swarmBetter, 'off')
    for (let i = 0; i < 30; i++) {
      sim.arenaTrial(CTX, 'BUILD')
      sim.arenaTrial(CTX, 'SWARM')
    }
    expect(sim.decideFor(CTX).strategy).toBe('BUILD') // evidence exists, nothing promoted
    // One candidate for the exact context and one for its category level, each judged on its own evidence.
    const all = sim.learn().candidates
    expect(all.map((c) => c.contextKey).sort()).toEqual(['feature|*|*', CTX])
    const candidates = all.filter((c) => c.contextKey === CTX)
    expect(candidates[0]).toMatchObject({ fromStrategy: 'BUILD', toStrategy: 'SWARM' })
    expect(sim.decideFor(CTX).strategy).toBe('BUILD') // a candidate is not a policy
    const next = sim.promote(candidates[0]!.id)
    expect(next.version).toBe(2)
    expect(next.preferences).toHaveLength(1)
    const d = sim.decideFor(CTX)
    expect(d.strategy).toBe('SWARM')
    expect(d.layer).toBe('evidence')
    expect(d.reason).toMatch(/SWARM passed \d+ of 30 Arena trials/)
  })

  it('catastrophic failures suppress a strategy, even under research exploration', () => {
    const world: SimWorld = { contexts: [{ contextKey: CTX, truth: { BUILD: truth(0.7), SWARM: truth(0.9, 3, { crashRate: 1 }) } }] }
    const sim = new PolicySimulator(11, world, 'research')
    for (let i = 0; i < 3; i++) sim.arenaTrial(CTX, 'SWARM')
    for (let i = 0; i < 8; i++) sim.arenaTrial(CTX, 'BUILD')
    sim.learn()
    for (let i = 0; i < 300; i++) expect(sim.decideFor(CTX).strategy).not.toBe('SWARM')
  })

  it('old evidence decays and finally leaves the window', () => {
    const sim = new PolicySimulator(5, swarmBetter, 'off')
    for (let i = 0; i < 30; i++) {
      sim.arenaTrial(CTX, 'BUILD')
      sim.arenaTrial(CTX, 'SWARM')
    }
    expect(sim.learn().candidates.length).toBeGreaterThan(0)
    sim.advanceDays(200) // two half-lives: weight 0.2, so effective n falls below MODERATE
    const later = sim.learn()
    expect(later.candidates).toEqual([])
    expect(sim.candidates.every((c) => c.status === 'superseded')).toBe(true)
    sim.advanceDays(300) // beyond the 365-day window: nothing left
    sim.learn()
    expect(sim.stats).toEqual([])
  })

  it('explores at the configured rate, within tolerance', () => {
    for (const mode of ['conservative', 'balanced', 'research'] as const) {
      const sim = new PolicySimulator(21, swarmBetter, mode)
      const n = 4000
      let explored = 0
      for (let i = 0; i < n; i++) if (sim.decideFor(CTX).exploration) explored += 1
      expect(Math.abs(explored / n - EXPLORATION_RATES[mode])).toBeLessThan(0.03)
    }
  })

  it('keeps high-risk tasks conservative: no exploration, default consensus, even with promising unpromoted evidence', () => {
    const ctx = 'security|large|high'
    const world: SimWorld = { contexts: [{ contextKey: ctx, truth: { CONSENSUS: truth(0.6), SWARM: truth(0.99) } }] }
    const sim = new PolicySimulator(9, world, 'balanced')
    for (let i = 0; i < 30; i++) {
      sim.arenaTrial(ctx, 'CONSENSUS')
      sim.arenaTrial(ctx, 'SWARM')
    }
    sim.learn()
    for (let i = 0; i < 400; i++) {
      const d = sim.decideFor(ctx)
      expect(d.exploration).toBe(false)
      expect(d.strategy).toBe('CONSENSUS')
    }
  })

  it('rollback restores the earlier decision and rewrites no history', () => {
    const sim = new PolicySimulator(13, swarmBetter, 'off')
    for (let i = 0; i < 30; i++) {
      sim.arenaTrial(CTX, 'BUILD')
      sim.arenaTrial(CTX, 'SWARM')
    }
    const promoted = sim.promote(sim.learn().candidates.find((c) => c.contextKey === CTX)!.id)
    const before = JSON.stringify(promoted)
    const m = sim.mission(CTX)
    expect(m.decision.strategy).toBe('SWARM')
    const outcomes = JSON.stringify(sim.outcomes)
    sim.rollback()
    expect(sim.decideFor(CTX).strategy).toBe('BUILD')
    expect(sim.active.version).toBe(1)
    expect(JSON.stringify(promoted)).toBe(before) // the snapshot object is untouched
    expect(JSON.stringify(sim.outcomes)).toBe(outcomes)
    expect(sim.snapshots.map((s) => s.version)).toEqual([1, 2])
    expect(() => sim.rollback()).toThrow()
  })

  it('the same seed reproduces a whole history, including every exploration draw', () => {
    const opts = { steps: 80, world: swarmBetter, mode: 'research' as const, arenaPerStep: 2, autoPromote: true, learnEvery: 8 }
    const a = simulate({ seed: 99, ...opts })
    const b = simulate({ seed: 99, ...opts })
    const c = simulate({ seed: 100, ...opts })
    const key = (t: typeof a) => t.steps.map((s) => `${s.strategy}:${s.layer}:${s.seed}:${s.success}`)
    expect(key(a)).toEqual(key(b))
    expect(a.final.version).toBe(b.final.version)
    expect(key(a)).not.toEqual(key(c))
    expect(a.steps.some((s) => s.exploration)).toBe(true)
  })

  it('autoPromote simulations promote the better strategy and use it afterwards', () => {
    const trace = simulate({ seed: 4, steps: 60, world: swarmBetter, mode: 'off', arenaPerStep: 2, autoPromote: true, learnEvery: 10 })
    expect(trace.events.some((e) => e.kind === 'promote')).toBe(true)
    expect(trace.steps[trace.steps.length - 1]!.strategy).toBe('SWARM')
    expect(trace.steps[0]!.strategy).toBe('BUILD')
  })
})
