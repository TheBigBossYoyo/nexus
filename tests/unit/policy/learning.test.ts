import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_CONFIG, type TaskProfile } from '@shared/v3'
import {
  aggregateEvidence,
  detectRegressions,
  featuresForContext,
  isSuppressed,
  proposeCandidates,
  shadowEvaluate,
  summarize,
  syntheticOutcome,
} from '@main/modules/policy'
import { DAY, NOW, pref, snapshot, statsFor, trialsFor } from './helpers'

const CTX = 'feature|medium|low' // default BUILD

const agg = (over: Partial<Parameters<typeof aggregateEvidence>[0]>) =>
  aggregateEvidence({ trials: [], outcomes: [], config: DEFAULT_POLICY_CONFIG, now: NOW, currentModels: {}, ...over })

const find = (stats: ReturnType<typeof agg>, ctx: string, strategy: string, kind: string) =>
  stats.find((s) => s.contextKey === ctx && s.strategy === strategy && s.kind === kind)

describe('aggregateEvidence', () => {
  it('produces rows for the exact context and each fallback level', () => {
    const stats = agg({ trials: trialsFor(CTX, { BUILD: { pass: 3, fail: 1 } }) })
    for (const key of [CTX, 'feature|*|*', '*|*|*']) {
      const row = find(stats, key, 'BUILD', 'arena')!
      expect(row.n).toBe(4)
      expect(row.successes).toBe(3)
    }
  })

  it('a trial is a success only when the hidden evaluation passed', () => {
    const trials = trialsFor(CTX, { BUILD: { pass: 2, fail: 2 } })
    trials[0]!.metrics = null // not measured: not a success
    const row = find(agg({ trials }), CTX, 'BUILD', 'arena')!
    expect(row.n).toBe(4)
    expect(row.successes).toBe(1)
  })

  it('counts crashed and blocked trials as stability failures', () => {
    const row = find(agg({ trials: trialsFor(CTX, { BUILD: { pass: 5, fail: 0, crashed: 2 } }) }), CTX, 'BUILD', 'arena')!
    expect(row.stabilityFailures).toBe(2)
    expect(row.successes).toBe(5)
  })

  it('weights real missions by missionWeight and keeps them as a separate kind', () => {
    const outcomes = [1, 2, 3, 4].map((i) => syntheticOutcome({ id: `m${i}`, contextKey: CTX, strategy: 'BUILD', success: i <= 3, at: NOW }))
    const stats = agg({ trials: trialsFor(CTX, { BUILD: { pass: 2, fail: 0 } }), outcomes })
    const mission = find(stats, CTX, 'BUILD', 'mission')!
    expect(mission.n).toBe(4)
    expect(mission.effectiveN).toBeCloseTo(2)
    expect(mission.effectiveSuccesses).toBeCloseTo(1.5)
    const arena = find(stats, CTX, 'BUILD', 'arena')!
    expect(arena.n).toBe(2)
    expect(arena.effectiveN).toBeCloseTo(2)
  })

  it('excludes Arena-run outcomes and cancelled missions from mission evidence', () => {
    const outcomes = [
      syntheticOutcome({ id: 'a', contextKey: CTX, strategy: 'BUILD', success: true, at: NOW, isArena: true }),
      syntheticOutcome({ id: 'c', contextKey: CTX, strategy: 'BUILD', success: false, at: NOW, terminal: 'cancelled' }),
    ]
    expect(agg({ outcomes })).toEqual([])
  })

  it('decays old evidence by the half-life and keeps raw counts', () => {
    const row = find(agg({ trials: trialsFor(CTX, { BUILD: { pass: 4, fail: 0, ageDays: 90 } }) }), CTX, 'BUILD', 'arena')!
    expect(row.n).toBe(4)
    expect(row.effectiveN).toBeCloseTo(2)
    expect(row.effectiveSuccesses).toBeCloseTo(2)
  })

  it('halves the weight when the recorded model differs from the current one', () => {
    const trials = trialsFor(CTX, { BUILD: { pass: 4, fail: 0, models: { worker: 'claude-sonnet-4' } } })
    const same = find(agg({ trials, currentModels: { worker: 'sonnet' } }), CTX, 'BUILD', 'arena')!
    expect(same.effectiveN).toBeCloseTo(4)
    const drift = find(agg({ trials, currentModels: { worker: 'opus' } }), CTX, 'BUILD', 'arena')!
    expect(drift.effectiveN).toBeCloseTo(2)
  })

  it('drops evidence older than the window', () => {
    const trials = trialsFor(CTX, { BUILD: { pass: 3, fail: 0, ageDays: 400 } })
    expect(agg({ trials })).toEqual([])
    const wide = agg({ trials, config: { ...DEFAULT_POLICY_CONFIG, evidenceWindowDays: 500 } })
    expect(find(wide, CTX, 'BUILD', 'arena')!.n).toBe(3)
  })

  it('summarizes efficiency figures', () => {
    const row = find(agg({ trials: trialsFor(CTX, { BUILD: { pass: 2, fail: 2, sessions: 4, durationMs: 60_000 } }) }), CTX, 'BUILD', 'arena')!
    expect(row.meanSessions).toBe(4)
    expect(row.medianDurationMs).toBe(60_000)
    expect(row.passInterval!.low).toBeGreaterThan(0)
    expect(row.label).toBe('INSUFFICIENT')
  })

  it('is deterministic', () => {
    const trials = trialsFor(CTX, { BUILD: { pass: 3, fail: 1 }, SWARM: { pass: 1, fail: 2 } })
    expect(agg({ trials })).toEqual(agg({ trials }))
  })
})

describe('summarize and suppression', () => {
  it('uses a fallback level only when it has its own sufficient evidence', () => {
    // Exact context: 3 trials (insufficient). Sibling context in the same category: 14 trials.
    const trials = [...trialsFor('bugfix|small|low', { BUILD: { pass: 2, fail: 1 } }), ...trialsFor('bugfix|large|low', { BUILD: { pass: 10, fail: 4 } })]
    const stats = agg({ trials })
    const fallback = summarize(stats, 'bugfix|small|low')
    expect(fallback.evidenceContextKey).toBe('bugfix|*|*')
    const none = summarize(agg({ trials: trialsFor('bugfix|small|low', { BUILD: { pass: 2, fail: 1 } }) }), 'ui|small|low')
    expect(none.evidenceContextKey).toBeNull()
    expect(none.rows).toEqual([])
  })

  it('suppresses on 3 effective samples with no success, or 2 stability failures', () => {
    expect(isSuppressed({ effectiveN: 3, effectiveSuccesses: 0, stabilityFailures: 0 })).toBe(true)
    expect(isSuppressed({ effectiveN: 2.9, effectiveSuccesses: 0, stabilityFailures: 0 })).toBe(false)
    expect(isSuppressed({ effectiveN: 10, effectiveSuccesses: 1, stabilityFailures: 1 })).toBe(false)
    expect(isSuppressed({ effectiveN: 10, effectiveSuccesses: 9, stabilityFailures: 2 })).toBe(true)
  })

  it('old failures decay below the suppression sample size', () => {
    const fresh = summarize(statsFor(CTX, { SWARM: { pass: 0, fail: 4 } }), CTX)
    expect(fresh.rows[0]!.suppressed).toBe(true)
    const old = summarize(statsFor(CTX, { SWARM: { pass: 0, fail: 4, ageDays: 180 } }), CTX)
    expect(old.rows[0]!.suppressed).toBe(false)
  })

  it('pooled rows keep Arena and mission counts apart', () => {
    const outcomes = [1, 2, 3].map((i) => syntheticOutcome({ id: `m${i}`, contextKey: CTX, strategy: 'BUILD', success: true, at: NOW }))
    const s = summarize(agg({ trials: trialsFor(CTX, { BUILD: { pass: 5, fail: 0 } }), outcomes }), CTX)
    expect(s.rows[0]).toMatchObject({ arenaN: 5, arenaSuccesses: 5, missionN: 3, missionSuccesses: 3 })
  })
})

describe('proposeCandidates', () => {
  const propose = (spec: Parameters<typeof statsFor>[1], active = snapshot()) =>
    proposeCandidates({ stats: statsFor(CTX, spec), active, knownContexts: [CTX], now: NOW, newId: () => 'c1' })

  it('proposes when the challenger separates from the incumbent (Wilson low > incumbent high)', () => {
    const r = propose({ BUILD: { pass: 10, fail: 10 }, SWARM: { pass: 28, fail: 2 } })
    expect(r.candidates).toHaveLength(1)
    const c = r.candidates[0]!
    expect(c).toMatchObject({ contextKey: CTX, fromStrategy: 'BUILD', toStrategy: 'SWARM', status: 'proposed', baseSnapshotId: 'snap-test', arenaTrials: 30 })
    expect(c.reason).toContain('SWARM passed 28 of 30 Arena trials versus 10 of 20 Arena trials for BUILD')
    expect(c.evidence.map((e) => e.strategy)).toEqual(['BUILD', 'SWARM'])
  })

  it('does not propose when the challenger has only WEAK evidence, however good', () => {
    const r = propose({ BUILD: { pass: 3, fail: 9 }, SWARM: { pass: 8, fail: 0 } })
    expect(r.candidates).toEqual([])
    expect(r.notes.join(' ')).toContain('WEAK')
  })

  it('does not propose when the incumbent has no evidence', () => {
    const r = propose({ SWARM: { pass: 20, fail: 0 } })
    expect(r.candidates).toEqual([])
    expect(r.notes[0]).toContain('incumbent BUILD')
  })

  it('does not propose when intervals overlap and efficiency is not a band better', () => {
    const r = propose({ BUILD: { pass: 14, fail: 6, sessions: 5 }, SWARM: { pass: 15, fail: 5, sessions: 4.5 } })
    expect(r.candidates).toEqual([])
    expect(r.notes[0]).toContain('overlap')
  })

  it('proposes an overlapping challenger that is a band better on sessions with no lower pass rate', () => {
    const r = propose({ BUILD: { pass: 14, fail: 6, sessions: 5 }, SWARM: { pass: 15, fail: 5, sessions: 3 } })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]!.toStrategy).toBe('SWARM')
    expect(r.candidates[0]!.reason).toContain('one band better')
  })

  it('does not propose a cheaper challenger with a lower pass proportion', () => {
    const r = propose({ BUILD: { pass: 16, fail: 4, sessions: 5 }, SWARM: { pass: 14, fail: 6, sessions: 2 } })
    expect(r.candidates).toEqual([])
    expect(r.notes[0]).toContain('lower')
  })

  it('does not propose a suppressed or non-eligible challenger', () => {
    expect(propose({ BUILD: { pass: 2, fail: 14 }, SWARM: { pass: 14, fail: 0, crashed: 2 } }).candidates).toEqual([])
    expect(propose({ BUILD: { pass: 10, fail: 10 }, SPECULATIVE: { pass: 29, fail: 1 } }).candidates).toEqual([])
    const allowed = snapshot({}, [], { speculation: 'AUTO' })
    expect(propose({ BUILD: { pass: 10, fail: 10 }, SPECULATIVE: { pass: 29, fail: 1 } }, allowed).candidates).toHaveLength(1)
  })

  it('judges against the active preference, not the default', () => {
    const active = snapshot({}, [pref(CTX, 'SWARM')])
    const r = propose({ BUILD: { pass: 28, fail: 2 }, SWARM: { pass: 10, fail: 10 } }, active)
    expect(r.candidates[0]).toMatchObject({ fromStrategy: 'SWARM', toStrategy: 'BUILD' })
  })

  it('says why for every context with evidence and nothing for contexts without', () => {
    const r = proposeCandidates({
      stats: statsFor(CTX, { BUILD: { pass: 5, fail: 5 }, SWARM: { pass: 6, fail: 4 } }),
      active: snapshot(),
      knownContexts: [CTX, 'ui|small|low'],
      now: NOW,
    })
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toContain(CTX)
  })

  it('old evidence decays out of candidacy', () => {
    const r = propose({ BUILD: { pass: 10, fail: 10 }, SWARM: { pass: 28, fail: 2, ageDays: 270 } })
    expect(r.candidates).toEqual([])
  })
})

describe('shadowEvaluate', () => {
  const profile = (ctx: string, arena: string | null = null): TaskProfile => ({
    id: `p-${ctx}-${arena}`,
    projectId: 'p',
    runId: 'r',
    arenaTrialId: arena,
    contextKey: ctx,
    features: featuresForContext(ctx),
    profilerVersion: 'profiler-v1',
    createdAt: '',
  })

  it('counts decisions that would change and calls itself a sanity check', () => {
    const cand = proposeCandidates({
      stats: statsFor(CTX, { BUILD: { pass: 10, fail: 10 }, SWARM: { pass: 28, fail: 2 } }),
      active: snapshot(),
      knownContexts: [CTX],
      now: NOW,
    }).candidates[0]!
    const profiles = [profile(CTX), profile(CTX), profile('bugfix|small|low'), profile(CTX, 'trial-1')]
    const outcomes = [syntheticOutcome({ id: 'm', contextKey: CTX, strategy: 'SWARM', success: true, at: NOW })]
    const shadow = shadowEvaluate(cand, profiles, outcomes, snapshot())
    expect(shadow.profilesReplayed).toBe(3) // the Arena profile is excluded
    expect(shadow.decisionsChanged).toBe(2)
    expect(shadow.changedWithKnownOutcome).toBe(2)
    expect(shadow.note).toMatch(/sanity check, not an effect estimate/i)
  })
})

describe('detectRegressions', () => {
  const group = (g: string, order: number, n: number, successes: number) => ({ group: g, order, strategy: 'BUILD' as const, caseKey: 'cases-a', n, successes })

  it('establishes a regression only when the newer upper bound is below the older lower bound', () => {
    const flags = detectRegressions([group('v1', 1, 40, 38), group('v2', 2, 40, 20)])
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ verdict: 'established', label: 'ORCHESTRATION REGRESSION', strategy: 'BUILD' })
    expect(flags[0]!.baseline.group).toBe('v1')
  })

  it('reports "lower, not established" when only the point estimate is lower', () => {
    const flags = detectRegressions([group('v1', 1, 10, 9), group('v2', 2, 10, 7)])
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ verdict: 'lower', label: 'Lower, not established' })
  })

  it('reports nothing when the newer group is not lower, or the case sets differ', () => {
    expect(detectRegressions([group('v1', 1, 10, 7), group('v2', 2, 10, 9)])).toEqual([])
    expect(detectRegressions([group('v1', 1, 10, 7), group('v2', 2, 10, 7)])).toEqual([])
    expect(detectRegressions([group('v1', 1, 40, 38), { ...group('v2', 2, 40, 5), caseKey: 'other' }])).toEqual([])
  })
})

describe('window constants', () => {
  it('uses DAY as one day', () => expect(DAY).toBe(86_400_000))
})
