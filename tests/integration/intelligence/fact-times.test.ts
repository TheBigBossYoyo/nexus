import { describe, expect, it } from 'vitest'
import { FakeAgentRuntime, defaultFakeAuthStatus } from '@main/modules/agent-runtime/fake-runtime'
import { RuntimeCapacityPools } from '@main/modules/capacity/runtime-pools'
import { EventBus } from '@main/modules/events'
import { UsageIntelligenceService } from '@main/modules/usage/service'
import { graphHarness } from '../../helpers/context-graph'

/**
 * Finding 3.5: a percentage and a reset time the provider gave earlier were stamped "observed now" each time a
 * later event was read. A fact keeps the time the provider gave it.
 */
describe('capacity facts carry the time they were observed', () => {
  it('a percentage kept across a later event keeps its own time, in the usage service and in the pool', () => {
    const h = graphHarness()
    let now = 1_000_000
    const claude = new FakeAgentRuntime({ authStatus: defaultFakeAuthStatus(), script: async () => undefined })
    const usage = new UsageIntelligenceService({ repos: h.repos, bus: new EventBus(h.repos.events, h.repos.transaction), runtime: claude, push: () => undefined, now: () => now })
    try {
      const resetsAt = new Date(now + 3_600_000).toISOString()
      usage.apply({ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 40, resetsAt }] })
      expect(usage.capacityObservation()).toMatchObject({ observedAt: 1_000_000, utilization: 40, utilizationObservedAt: 1_000_000 })

      // Ten minutes later a session ends well: the account works now, and nothing new is known about the percentage.
      now += 600_000
      usage.apply({ type: 'session_ok' })
      const later = usage.capacityObservation()!
      expect(later).toMatchObject({ observedAt: 1_600_000, utilization: 40, utilizationObservedAt: 1_000_000 })

      const pools = new RuntimeCapacityPools(h.repos.intelligenceArtifacts, 'fact-fixture', () => now)
      const pool = pools.observe(pools.pool('claude', 'profile'), later.state, later)
      expect(pool.stateEvidence).toMatchObject({ observedAt: 1_600_000 })
      expect(pool.utilization).toMatchObject({ value: 40, observedAt: 1_000_000 })

      // A new report is a new observation.
      now += 60_000
      usage.apply({ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 45, resetsAt }] })
      expect(usage.capacityObservation()).toMatchObject({ utilization: 45, utilizationObservedAt: 1_660_000 })
    } finally {
      usage.dispose()
      h.close()
    }
  })
  // Finding 3.5, the other half: two sessions routed at once each read the pool, and the later write used to put
  // an older copy over the newer one.
  it('an observation is applied to the pool as saved, and an older one does not replace a newer one', () => {
    const h = graphHarness()
    let now = 1_000_000
    try {
      const pools = new RuntimeCapacityPools(h.repos.intelligenceArtifacts, 'fact-fixture', () => now)
      const stale = pools.pool('claude', 'profile')
      const paused = pools.observe(pools.pool('claude', 'profile'), 'QUOTA_PAUSED', { resetAt: 5_000_000, observedAt: 1_000_000 })
      // The copy read before the pause still says unknown. A percentage observed after the pause is added to the
      // pause that is saved, not to the copy.
      now = 1_100_000
      const merged = pools.observe(stale, 'QUOTA_PAUSED', { resetAt: 5_000_000, utilization: 100, observedAt: 1_050_000 })
      expect(merged.state).toBe('QUOTA_PAUSED')
      expect(merged.utilization.value).toBe(100)
      // An observation older than what is saved changes nothing.
      const older = pools.observe(stale, 'AVAILABLE', { observedAt: 900_000 })
      expect(older).toEqual(merged)
      expect(pools.pool('claude', 'profile')).toEqual(merged)
      expect(paused.state).toBe('QUOTA_PAUSED')
    } finally {
      h.close()
    }
  })

  // Finding 3.4: the usage service watches one Claude installation. After another account is signed in, what
  // it observed before is the other account's.
  it('what was observed before a change of account belongs to the other account', () => {
    const h = graphHarness()
    let now = 1_000_000
    const claude = new FakeAgentRuntime({ authStatus: defaultFakeAuthStatus(), script: async () => undefined })
    const usage = new UsageIntelligenceService({ repos: h.repos, bus: new EventBus(h.repos.events, h.repos.transaction), runtime: claude, push: () => undefined, now: () => now })
    try {
      usage.apply({ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 96, resetsAt: new Date(now + 3_600_000).toISOString() }] })
      // The first account named owns everything observed so far, also what was observed before it was named.
      expect(usage.observationsSince('account-a')).toBe(0)
      expect(usage.capacityObservation()!.observedAt).toBeGreaterThanOrEqual(usage.observationsSince('account-a'))
      now += 60_000
      const since = usage.observationsSince('account-b')
      expect(since).toBe(1_060_000)
      expect(usage.capacityObservation()!.observedAt).toBeLessThan(since)
      expect(usage.machineState().since).toBeLessThan(since)
      // Asking again for the same account does not move the line; a new observation is on the right side of it.
      now += 60_000
      expect(usage.observationsSince('account-b')).toBe(1_060_000)
      usage.apply({ type: 'report', windows: [{ limitType: 'five_hour', utilizationPercent: 10, resetsAt: null }] })
      expect(usage.capacityObservation()!.observedAt).toBeGreaterThanOrEqual(since)
    } finally {
      usage.dispose()
      h.close()
    }
  })
})
