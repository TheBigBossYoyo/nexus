import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_CONFIG } from '@shared/v3'
import {
  POLICY_THRESHOLDS,
  aggregateEvidence,
  caseCaveat,
  decide,
  detectRegressions,
  proposeCandidates,
  rowsAt,
  summarize,
  suppressedStrategies,
  syntheticOutcome,
  syntheticTrial,
  wilsonInterval,
} from '@main/modules/policy'
import { DAY, NOW, decideInput, snapshot, statsFor, trialsFor } from './helpers'

const CTX = 'feature|medium|low'
const agg = (trials: ReturnType<typeof trialsFor>, outcomes: Parameters<typeof aggregateEvidence>[0]['outcomes'] = []) =>
  aggregateEvidence({ trials, outcomes, config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: {} })
const arena = (stats: ReturnType<typeof agg>, ctx: string, strategy: string) => stats.find((s) => s.contextKey === ctx && s.strategy === strategy && s.kind === 'arena')

describe('finding 1: harness failures are not strategy failures', () => {
  it('excludes infrastructure-blocked trials from n, failures and stability', () => {
    const row = arena(agg(trialsFor(CTX, { BUILD: { pass: 5, fail: 0, infra: 6 } })), CTX, 'BUILD')!
    expect(row.n).toBe(5)
    expect(row.stabilityFailures).toBe(0)
    expect(summarize(agg(trialsFor(CTX, { BUILD: { pass: 0, fail: 0, infra: 6 } })), CTX).rows).toEqual([])
  })

  it('counts run and timeout blocks as strategy failures; only a run block is a stability failure', () => {
    const base = trialsFor(CTX, { BUILD: { pass: 0, fail: 2 } })
    const mk = (id: string, blockKind: 'run' | 'timeout' | null, extra: { runId?: string | null; metrics?: null } = {}) => ({
      ...syntheticTrial({ id, contextKey: CTX, strategy: 'BUILD', passed: false, infrastructure: true, at: NOW }),
      blockKind,
      ...extra,
    })
    const stats = agg([...base, mk('run', 'run'), mk('timeout', 'timeout')])
    const row = arena(stats, CTX, 'BUILD')!
    expect(row.n).toBe(4)
    expect(row.successes).toBe(0)
    expect(row.stabilityFailures).toBe(1)
  })

  it('a legacy blocked row with no kind is infrastructure unless it has metrics and an ended run', () => {
    const legacy = { ...syntheticTrial({ id: 'l1', contextKey: CTX, strategy: 'BUILD', passed: false, infrastructure: true, at: NOW }), blockKind: null }
    expect(agg([legacy])).toEqual([])
    const ended = { ...legacy, id: 'l2', runId: 'run-1' }
    expect(arena(agg([ended]), CTX, 'BUILD')!.n).toBe(1)
    expect(agg([{ ...ended, metrics: null }])).toEqual([])
  })

  it('cancelled trials stay excluded', () => {
    const t = { ...trialsFor(CTX, { BUILD: { pass: 1, fail: 0 } })[0]!, state: 'cancelled' as const }
    expect(agg([t])).toEqual([])
  })
})

describe('finding 2: suppression is per level and judged on its own evidence', () => {
  it('a catastrophe in one context never suppresses a strategy in an unrelated one', () => {
    const stats = agg([...trialsFor('feature|large|high', { SWARM: { pass: 0, fail: 4 } }), ...trialsFor('bugfix|small|low', { BUILD: { pass: 8, fail: 2 } })])
    expect(suppressedStrategies(stats, 'feature|large|high').has('SWARM')).toBe(true)
    expect(suppressedStrategies(stats, 'bugfix|small|low').has('SWARM')).toBe(false)
    const d = decide(decideInput('bugfix|small|low', { stats, snapshot: snapshot({}, [{ contextKey: 'bugfix|small|low', strategy: 'SWARM', replaces: 'SINGLE', reason: 't', evidence: { arenaTrials: 9, missions: 0, label: 'MODERATE' }, candidateId: null }]) }))
    expect(d.strategy).toBe('SWARM')
  })

  it('a sibling context catastrophe suppresses only decisions that fall back to the category level', () => {
    const stats = agg([...trialsFor('bugfix|large|high', { SWARM: { pass: 0, fail: 4 }, BUILD: { pass: 8, fail: 2 } }), ...trialsFor('bugfix|small|low', { BUILD: { pass: 8, fail: 2 } })])
    // Own sufficient evidence at the exact level: the category-level suppression does not apply.
    expect(suppressedStrategies(stats, 'bugfix|small|low').has('SWARM')).toBe(false)
    // No evidence of its own: the decision uses the category level, where SWARM is suppressed.
    expect(suppressedStrategies(stats, 'bugfix|medium|medium').has('SWARM')).toBe(true)
  })

  it('stability suppression needs a majority of the observations, not just two crashes', () => {
    const stable = agg(trialsFor(CTX, { BUILD: { pass: 28, fail: 0, crashed: 2 } }))
    expect(suppressedStrategies(stable, CTX).has('BUILD')).toBe(false)
    const unstable = agg(trialsFor(CTX, { BUILD: { pass: 1, fail: 0, crashed: 3 } }))
    expect(suppressedStrategies(unstable, CTX).has('BUILD')).toBe(true)
  })

  it('a trial that passed is never a stability failure, even if an agent crashed on the way', () => {
    const t = trialsFor(CTX, { BUILD: { pass: 3, fail: 0 } }).map((x) => ({ ...x, metrics: { ...x.metrics!, crashedAgents: 1, schedulerFailures: 1 } }))
    expect(arena(agg(t), CTX, 'BUILD')!.stabilityFailures).toBe(0)
  })

  it('failed trials with crashed agents or scheduler failures are stability failures', () => {
    const t = trialsFor(CTX, { BUILD: { pass: 0, fail: 2 } }).map((x, i) => ({ ...x, metrics: { ...x.metrics!, crashedAgents: i === 0 ? 1 : 0, schedulerFailures: i === 1 ? 1 : 0 } }))
    expect(arena(agg(t), CTX, 'BUILD')!.stabilityFailures).toBe(2)
  })

  it('stability failures decay with the same weights as everything else', () => {
    const old = agg(trialsFor(CTX, { BUILD: { pass: 1, fail: 0, crashed: 3, ageDays: 180 } }))
    expect(arena(old, CTX, 'BUILD')!.stabilityFailures).toBeCloseTo(3 * 0.25)
    expect(suppressedStrategies(old, CTX).has('BUILD')).toBe(false)
  })
})

describe('findings 3 and 10: controlled evidence from distinct cases', () => {
  const spec = { BUILD: { pass: 10, fail: 10, cases: 5 }, SWARM: { pass: 28, fail: 2, cases: 5 } }
  const propose = (s: Parameters<typeof statsFor>[1]) => proposeCandidates({ stats: statsFor(CTX, s), active: snapshot(), knownContexts: [CTX], now: NOW, newId: () => 'c' })

  it('counts distinct cases and caps the Arena label at WEAK below three', () => {
    const one = rowsAt(statsFor(CTX, { SWARM: { pass: 28, fail: 2, cases: 1 } }), CTX)[0]!
    expect(one.arenaN).toBe(30)
    expect(one.arenaCases).toBe(1)
    expect(one.label).toBe('WEAK')
    expect(caseCaveat(one)).toBe('evidence comes from 1 case')
    const many = rowsAt(statsFor(CTX, { SWARM: { pass: 28, fail: 2, cases: 5 } }), CTX)[0]!
    expect(many.arenaCases).toBe(5)
    expect(many.label).not.toBe('WEAK')
    expect(caseCaveat(many)).toBeNull()
  })

  it('withholds a candidate whose evidence comes from fewer than three cases, and says so', () => {
    const r = propose({ ...spec, SWARM: { pass: 28, fail: 2, cases: 2 } })
    expect(r.candidates).toEqual([])
    expect(r.notes.join(' ')).toContain('evidence comes from 2 cases')
    expect(propose(spec).candidates).toHaveLength(1)
    expect(POLICY_THRESHOLDS.minDistinctCases).toBe(3)
  })

  it('observational evidence alone never produces a candidate', () => {
    const arenaStats = agg(trialsFor(CTX, { BUILD: { pass: 10, fail: 10 } }))
    const missions = Array.from({ length: 40 }, (_, i) => syntheticOutcome({ id: `m${i}`, contextKey: CTX, strategy: 'SWARM', success: true, at: NOW }))
    const stats = aggregateEvidence({ trials: trialsFor(CTX, { BUILD: { pass: 10, fail: 10 } }), outcomes: missions, config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: {} })
    expect(arenaStats.length).toBeGreaterThan(0)
    const r = proposeCandidates({ stats, active: snapshot(), knownContexts: [CTX], now: NOW })
    expect(r.candidates).toEqual([])
    expect(r.notes.join(' ')).toContain('only observational evidence; run an Arena campaign for this context')
  })

  it('needs at least five Arena trials even with several cases', () => {
    const r = propose({ BUILD: { pass: 10, fail: 10, cases: 5 }, SWARM: { pass: 4, fail: 0, cases: 4 } })
    expect(r.candidates).toEqual([])
  })

  it('missions still count (weighted) toward the comparison once Arena evidence qualifies', () => {
    const missions = Array.from({ length: 6 }, (_, i) => syntheticOutcome({ id: `m${i}`, contextKey: CTX, strategy: 'SWARM', success: true, at: NOW }))
    const stats = aggregateEvidence({ trials: trialsFor(CTX, spec), outcomes: missions, config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: {} })
    const r = proposeCandidates({ stats, active: snapshot(), knownContexts: [CTX], now: NOW })
    expect(r.candidates[0]).toMatchObject({ toStrategy: 'SWARM', arenaTrials: 30, missions: 6 })
    expect(r.candidates[0]!.reason).toContain('28 of 30 Arena trials and 6 of 6 real missions (observational)')
  })
})

describe('finding 8: model drift compares recorded ids exactly', () => {
  it('does not down-weight items that record no model', () => {
    const t = [...trialsFor(CTX, { BUILD: { pass: 3, fail: 0 } }, 'a'), ...trialsFor(CTX, { BUILD: { pass: 2, fail: 0, models: { worker: 'm2' } } }, 'b')]
    expect(arena(agg(t), CTX, 'BUILD')!.effectiveN).toBeCloseTo(5)
  })

  it('an alias configured in settings does not make every recorded id look drifted', () => {
    const t = trialsFor(CTX, { BUILD: { pass: 4, fail: 0, models: { worker: 'claude-sonnet-4' } } })
    const row = arena(aggregateEvidence({ trials: t, outcomes: [], config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: { worker: 'sonnet' } }), CTX, 'BUILD')!
    expect(row.effectiveN).toBeCloseTo(4)
  })

  it('the newest evidence defines the current model; older ones with another model are down-weighted', () => {
    const older = trialsFor(CTX, { BUILD: { pass: 4, fail: 0, ageDays: 1, models: { worker: 'claude-sonnet-4' } } }, 'o')
    const newer = trialsFor(CTX, { BUILD: { pass: 1, fail: 0, models: { worker: 'claude-sonnet-5' } } }, 'n')
    const row = arena(agg([...older, ...newer]), CTX, 'BUILD')!
    expect(row.effectiveN).toBeLessThan(1 + 4 * 0.6)
    expect(row.effectiveN).toBeGreaterThan(1 + 4 * 0.4)
  })
})

describe('finding 14: efficiency is a tie-break, over passing runs only', () => {
  it('efficiency means cover passed trials only', () => {
    const trials = [
      ...trialsFor(CTX, { BUILD: { pass: 3, fail: 0, sessions: 6, durationMs: 100_000 } }, 'p'),
      ...trialsFor(CTX, { BUILD: { pass: 0, fail: 3, sessions: 1, durationMs: 1_000 } }, 'f'),
    ]
    const row = arena(agg(trials), CTX, 'BUILD')!
    expect(row.meanSessions).toBe(6)
    expect(row.medianDurationMs).toBe(100_000)
  })

  it('a cheaper challenger whose lower bound is clearly below the incumbent is not proposed', () => {
    const r = proposeCandidates({
      stats: statsFor(CTX, { BUILD: { pass: 60, fail: 20, sessions: 6, cases: 5 }, SINGLE: { pass: 12, fail: 4, sessions: 1, cases: 5 } }),
      active: snapshot(),
      knownContexts: [CTX],
      now: NOW,
    })
    expect(r.candidates).toEqual([])
    expect(r.notes.join(' ')).toContain('lower bound')
  })
})

describe('docs review: the separated interval is on raw Arena counts', () => {
  it('uses the Wilson interval of the raw counts even when evidence has decayed', () => {
    const row = rowsAt(statsFor(CTX, { BUILD: { pass: 10, fail: 10, ageDays: 90 } }), CTX)[0]!
    expect(row.passInterval).toEqual(wilsonInterval(10, 20))
    expect(row.effectiveN).toBeCloseTo(10)
  })
})

describe('finding 16: the resource layer cannot leave a false exploration record', () => {
  it('a replaced explored strategy is no longer recorded as exploration', () => {
    const research = snapshot({}, [], { exploration: 'research' })
    let seed = 0
    for (let s = 1; s <= 2000 && seed === 0; s++) {
      const d = decide(decideInput(CTX, { seed: s, snapshot: research }))
      if (d.exploration && d.strategy === 'SWARM') seed = s
    }
    expect(seed).toBeGreaterThan(0)
    const limited = decide(decideInput(CTX, { seed, snapshot: research, recentLimit: true }))
    expect(limited.strategy).not.toBe('SWARM')
    expect(limited.exploration).toBe(false)
    expect(limited.layer).not.toBe('exploration')
    expect(limited.resourceNotes.join(' ')).toContain('not recorded as an exploration')
  })

  it('states Arena and mission counts separately in the suppression reason', () => {
    const missions = Array.from({ length: 3 }, (_, i) => syntheticOutcome({ id: `m${i}`, contextKey: CTX, strategy: 'BUILD', success: false, at: NOW }))
    const stats = aggregateEvidence({ trials: trialsFor(CTX, { BUILD: { pass: 0, fail: 3 }, CONSENSUS: { pass: 8, fail: 2 } }), outcomes: missions, config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: {} })
    const d = decide(decideInput(CTX, { stats }))
    expect(d.reason).toContain('0 of 3 Arena trials and 0 of 3 real missions (observational)')
  })

  it('a usage note is recorded in resourceNotes', () => {
    const d = decide(decideInput(CTX, { usageNote: 'The usage service could not be read', usageStatus: 'RUNTIME_UNAVAILABLE' }))
    expect(d.resourceNotes).toContain('The usage service could not be read')
  })
})

describe('regression grouping', () => {
  const g = (group: string, order: number, n: number, successes: number, extra: object = {}) => ({ group, order, strategy: 'BUILD' as const, n, successes, ...extra })

  it('compares only the same case set, whatever the order of the ids', () => {
    const flags = detectRegressions([g('v1', 1, 40, 38, { caseIds: ['b', 'a'] }), g('v2', 2, 40, 20, { caseIds: ['a', 'b'] })])
    expect(flags).toHaveLength(1)
    expect(detectRegressions([g('v1', 1, 40, 38, { caseIds: ['a', 'b'] }), g('v2', 2, 40, 20, { caseIds: ['a', 'c'] })])).toEqual([])
  })

  it('compares groups keyed by version and model signature, and never a group with itself', () => {
    const groups = [
      g('0.3.0 / m1', 1, 40, 38, { caseIds: ['a'], nexusVersion: '0.3.0', modelSignature: 'worker=m1' }),
      g('0.3.1 / m2', 2, 40, 20, { caseIds: ['a'], nexusVersion: '0.3.1', modelSignature: 'worker=m2' }),
      g('0.3.1 / m2', 3, 40, 5, { caseIds: ['a'], nexusVersion: '0.3.1', modelSignature: 'worker=m2' }),
    ]
    const flags = detectRegressions(groups)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.current.group).toBe('0.3.1 / m2')
    expect(flags[0]!.baseline.group).toBe('0.3.0 / m1')
  })

  it('different strategies are never compared', () => {
    expect(detectRegressions([g('v1', 1, 40, 38, { caseIds: ['a'] }), { ...g('v2', 2, 40, 5, { caseIds: ['a'] }), strategy: 'SWARM' as const }])).toEqual([])
  })
})

describe('window cut-off still applies to evidence counted for stability', () => {
  it('drops old stability failures with the window', () => {
    const t = trialsFor(CTX, { BUILD: { pass: 1, fail: 0, crashed: 3, ageDays: 400 } })
    expect(agg(t)).toEqual([])
    expect(DAY).toBe(86_400_000)
  })
})
