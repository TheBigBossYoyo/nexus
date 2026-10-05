import { describe, expect, it } from 'vitest'
import { CONCRETE_STRATEGIES, EXPLORATION_MODES, SPECULATION_POLICIES, type ConcreteStrategy, type UsageStatus } from '@shared/v3'
import {
  PolicySimulator,
  POLICY_THRESHOLDS,
  decide,
  defaultStrategy,
  evidenceLabel,
  labelAtLeast,
  mulberry32,
  type SimWorld,
} from '@main/modules/policy'
import { DEFAULT_SETTINGS } from '@shared/settings'

const RUNS = Number(process.env['NEXUS_POLICY_STRESS_RUNS'] ?? 1000)
const STEPS = 40
const CONTEXTS = ['feature|medium|low', 'bugfix|small|low', 'security|large|high', 'refactor|medium|medium', 'migration|large|high']
const STATUSES: UsageStatus[] = ['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'THROTTLED', 'LIMIT_APPROACHING', 'WAITING_FOR_RESET']

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

function makeWorld(rand: () => number, speculative: boolean): SimWorld {
  const count = 1 + Math.floor(rand() * 3)
  const keys = [...CONTEXTS].sort(() => rand() - 0.5).slice(0, count)
  const strategies: ConcreteStrategy[] = speculative ? [...CONCRETE_STRATEGIES] : CONCRETE_STRATEGIES.filter((s) => s !== 'SPECULATIVE')
  return {
    contexts: keys.map((contextKey) => ({
      contextKey,
      weight: 0.5 + rand(),
      truth: Object.fromEntries(
        strategies.map((s) => [
          s,
          {
            passRate: 0.05 + rand() * 0.9,
            crashRate: rand() < 0.1 ? 0.5 : 0,
            infraRate: rand() < 0.2 ? 0.3 : 0,
            sessions: 1 + Math.floor(rand() * 8),
            durationMs: 60_000 * (1 + Math.floor(rand() * 20)),
          },
        ]),
      ),
    })),
  }
}

describe('policy simulation stress', () => {
  it(`holds every invariant across ${RUNS} seeded simulations`, () => {
    const started = Date.now()
    let decisions = 0
    let candidatesSeen = 0
    let promotions = 0
    let explorations = 0

    for (let seed = 1; seed <= RUNS; seed++) {
      const rand = mulberry32(seed * 7919)
      const mode = pick(rand, EXPLORATION_MODES)
      const speculation = pick(rand, SPECULATION_POLICIES)
      const autoPromote = rand() < 0.5
      const world = makeWorld(rand, speculation !== 'OFF')
      const sim = new PolicySimulator(seed, world, mode, speculation)
      const ctx = `seed ${seed}`

      for (let step = 1; step <= STEPS; step++) {
        sim.step = step
        sim.advanceDays(3)
        sim.arenaRound(1 + Math.floor(rand() * 3))
        const contextKey = sim.pickContext()
        const status = pick(rand, STATUSES)
        const recentLimit = rand() < 0.15
        const snapshotBefore = sim.active
        const statsBefore = sim.stats

        const { decision } = sim.mission(contextKey, { status, recentLimit })
        decisions += 1
        const rows = decision.evidenceSummary

        // Decisions are reproducible from (seed, snapshot, evidence).
        const again = decide({
          profile: { id: null, projectId: null, runId: null, contextKey, features: sim.featuresOf(contextKey) },
          snapshot: snapshotBefore,
          stats: statsBefore,
          seed: decision.seed ?? 0,
          usageStatus: status,
          recentLimit,
          preset: 'balanced',
          settings: DEFAULT_SETTINGS,
          id: decision.id,
          now: sim.now,
        })
        expect(again, ctx).toEqual(decision)

        // Exploration bookkeeping and the high-risk rule.
        if (decision.exploration) {
          explorations += 1
          expect(decision.seed, ctx).not.toBeNull()
          expect(decision.layer, ctx).toBe('exploration')
        }
        if (contextKey.endsWith('|high') && mode !== 'research') expect(decision.exploration, ctx).toBe(false)
        if (mode === 'off') expect(decision.exploration, ctx).toBe(false)

        // SPECULATIVE needs an enabled speculation policy, and never appears under a recent limit or a non-AVAILABLE status.
        if (speculation === 'OFF') expect(decision.strategy, ctx).not.toBe('SPECULATIVE')
        if (recentLimit || status !== 'AVAILABLE') {
          expect(decision.strategy, ctx).not.toBe('SPECULATIVE')
          const alternatives = (['BUILD', 'SINGLE', 'CONSENSUS'] as const).filter((a) => !rows.find((r) => r.strategy === a)?.suppressed)
          if (alternatives.length > 0) expect(decision.strategy, ctx).not.toBe('SWARM')
        }
        if (status === 'THROTTLED' || status === 'LIMIT_APPROACHING') {
          const unthrottled = decide({
            profile: { id: null, projectId: null, runId: null, contextKey, features: sim.featuresOf(contextKey) },
            snapshot: snapshotBefore,
            stats: statsBefore,
            seed: decision.seed ?? 0,
            usageStatus: 'AVAILABLE',
            recentLimit,
            preset: 'balanced',
            settings: DEFAULT_SETTINGS,
            id: decision.id,
            now: sim.now,
          })
          if (unthrottled.strategy === decision.strategy) expect(decision.workerCount, ctx).toBeLessThanOrEqual(unthrottled.workerCount)
          expect(decision.workerCount, ctx).toBeGreaterThanOrEqual(1)
        }

        // A suppressed strategy is never chosen (unless everything with evidence is suppressed).
        const chosen = rows.find((r) => r.strategy === decision.strategy)
        const everyRowSuppressed = (rows.length >= CONCRETE_STRATEGIES.length - 1 && rows.every((r) => r.suppressed)) || decision.resourceNotes.some((n) => n.includes('suppressed by failures'))
        if (chosen?.suppressed && !everyRowSuppressed) throw new Error(`${ctx}: chose suppressed ${decision.strategy}: ${decision.reason} | ${JSON.stringify(rows.map((r) => [r.strategy, r.suppressed, r.effectiveN]))}`)

        // Without a promoted preference or suppression the layer cannot be "evidence", and the default is the base.
        if (decision.layer === 'default') expect(decision.strategy, ctx).toBe(defaultStrategy(contextKey))
        if (snapshotBefore.preferences.length === 0 && decision.layer === 'evidence') {
          expect(decision.reason.includes('suppressed') || decision.resourceNotes.length > 0, ctx).toBe(true)
        }
        // A decision recorded as exploration really is the explored arm, and a replaced one is not an exploration.
        if (decision.layer === 'exploration') expect(decision.exploration, ctx).toBe(true)

        // A user-forced strategy is honoured exactly.
        if (step % 5 === 0) {
          const forced = pick(rand, CONCRETE_STRATEGIES)
          const f = sim.decideFor(contextKey, { forced, status, recentLimit })
          expect(f.strategy, ctx).toBe(forced)
          expect(f.layer, ctx).toBe('user')
        }

        if (step % 8 === 0) {
          const versionBefore = sim.active.version
          const { candidates } = sim.learn()
          // Harness-blocked trials are never evidence: the global Arena count is exactly the trials that counted.
          const counted = sim.trials.filter((t) => t.blockKind !== 'infrastructure' && sim.now - Date.parse(t.finishedAt ?? t.createdAt) <= sim.active.config.evidenceWindowDays * 86_400_000).length
          const recorded = sim.stats.filter((r) => r.contextKey === '*|*|*' && r.kind === 'arena').reduce((a, r) => a + r.n, 0)
          expect(recorded, ctx).toBe(counted)
          candidatesSeen += candidates.length
          // Learning alone never changes the active policy.
          expect(sim.active.version, ctx).toBe(versionBefore)
          if (autoPromote) {
            for (const c of candidates) {
              sim.promote(c.id)
              promotions += 1
            }
          }
        }
      }

      // A preference exists only because a candidate was promoted.
      const promotedIds = new Set(sim.candidates.filter((c) => c.status === 'promoted').map((c) => c.id))
      expect(sim.events.filter((e) => e.kind === 'promote').length, `seed ${seed}`).toBe(sim.active.version - 1)
      if (!autoPromote) expect(sim.active.version, `seed ${seed}`).toBe(1)
      for (const snap of sim.snapshots) {
        for (const p of snap.preferences) expect(promotedIds.has(p.candidateId ?? ''), `seed ${seed}: preference without promotion`).toBe(true)
      }

      // Every candidate ever produced met the thresholds on its own recorded evidence.
      for (const c of sim.candidates) {
        const ch = c.evidence.find((r) => r.strategy === c.toStrategy)!
        const inc = c.evidence.find((r) => r.strategy === c.fromStrategy)
        expect(ch, `seed ${seed}`).toBeDefined()
        expect(ch.suppressed, `seed ${seed}`).toBe(false)
        expect(labelAtLeast(ch.label, POLICY_THRESHOLDS.challengerMin), `seed ${seed}: challenger evidence`).toBe(true)
        expect(inc && labelAtLeast(inc.label, POLICY_THRESHOLDS.incumbentMin), `seed ${seed}: incumbent evidence`).toBe(true)
        // Controlled evidence from enough distinct cases is mandatory; missions alone never make a candidate.
        expect(ch.arenaN, `seed ${seed}: arena trials`).toBeGreaterThanOrEqual(POLICY_THRESHOLDS.minArenaTrials)
        expect(ch.arenaCases, `seed ${seed}: arena cases`).toBeGreaterThanOrEqual(POLICY_THRESHOLDS.minDistinctCases)
        const ci = ch.passInterval!
        const ii = inc!.passInterval!
        const separated = ci.low > ii.high
        if (!separated) {
          expect(labelAtLeast(inc!.label, POLICY_THRESHOLDS.overlapBothMin), `seed ${seed}`).toBe(true)
          expect(ch.passRate!, `seed ${seed}`).toBeGreaterThanOrEqual(inc!.passRate!)
          expect(ci.low, `seed ${seed}: lower bound slack`).toBeGreaterThanOrEqual(ii.low - POLICY_THRESHOLDS.efficiencyLowerBoundSlack)
          const sessions = ch.meanSessions !== null && inc!.meanSessions !== null && ch.meanSessions < inc!.meanSessions * (1 - POLICY_THRESHOLDS.efficiencyBand)
          const time =
            ch.medianDurationMs !== null && inc!.medianDurationMs !== null && ch.medianDurationMs < inc!.medianDurationMs * (1 - POLICY_THRESHOLDS.efficiencyBand)
          expect(sessions || time, `seed ${seed}: overlap without a band of efficiency`).toBe(true)
        }
        // Sanity: the recorded label is what the recorded numbers say.
        expect(['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG'].indexOf(ch.label)).toBeLessThanOrEqual(['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG'].indexOf(evidenceLabel(ch.effectiveN, ch.passInterval)))
      }
    }

    const elapsed = Date.now() - started
    console.log(`policy stress: ${RUNS} simulations, ${decisions} decisions, ${explorations} explorations, ${candidatesSeen} candidate sightings, ${promotions} promotions, ${elapsed} ms`)
    expect(decisions).toBe(RUNS * STEPS)
    expect(elapsed).toBeLessThan(55_000)
  })
})
