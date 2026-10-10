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
})
