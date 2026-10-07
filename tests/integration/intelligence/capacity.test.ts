import { describe, expect, it } from 'vitest'
import { CapacityRegistry, CapacityWaitError } from '@main/modules/capacity/registry'
import { graphHarness } from '../../helpers/context-graph'

const registration = {
  issuer: 'https://auth.openai.com',
  clientId: 'app-one',
  subject: 'account-one',
}
describe('durable provider capacity evidence', () => {
  it('keeps unknown allowance distinct from zero and does not infer Codex sharing', () => {
    const registry = new CapacityRegistry(undefined, () => 1000)
    const pool = registry.pool(registry.binding(registration))
    expect(pool.state).toBe('USAGE_UNKNOWN')
    expect(pool.utilization.value).toBeNull()
    expect(pool.resetAt.value).toBeNull()
    expect(pool.scope).toBe('UNKNOWN')
    expect(pool.consumers).toEqual(['openai'])
    expect(registry.binding({ ...registration, clientId: 'app-two' })).not.toBe(pool.binding)
  })
  it('persists quota backoff across restart and only a successful request proves recovery', () => {
    const h = graphHarness()
    let now = 1000
    try {
      const registry = new CapacityRegistry(h.repos.intelligenceArtifacts, () => now)
      const binding = registry.binding(registration)
      const blocked = registry.failure(binding, 429, 'subscription_sharing_usage_limit_exceeded')
      expect(blocked.state).toBe('QUOTA_PAUSED')
      expect(() => registry.admit(binding)).toThrow(CapacityWaitError)
      const recovered = new CapacityRegistry(h.repos.intelligenceArtifacts, () => now)
      expect(recovered.pool(binding)).toEqual(blocked)
      now = blocked.nextProbeAt!
      expect(recovered.admit(binding).state).toBe('PROBING')
      expect(() => registry.admit(binding)).toThrow(CapacityWaitError)
      // A crashed probe has a bounded lease; expiration allows another probe, not availability.
      now += 190000
      expect(registry.admit(binding).state).toBe('PROBING')
      registry.success(binding)
      expect(recovered.pool(binding).state).toBe('AVAILABLE')
      expect(recovered.pool(binding).utilization.value).toBeNull()
      expect(recovered.pool(binding).resetAt.value).toBeNull()
    } finally {
      h.close()
    }
  })
  it('does not clear quota evidence on reconnect and keeps temporary service failure distinct', () => {
    const registry = new CapacityRegistry(undefined, () => 1000)
    const binding = registry.binding(registration)
    expect(registry.failure(binding, 429, 'subscription_sharing_usage_unavailable').state).toBe(
      'USAGE_SERVICE_UNAVAILABLE',
    )
    registry.failure(binding, 429, 'subscription_sharing_usage_limit_exceeded')
    registry.reconnect(binding)
    expect(registry.pool(binding).state).toBe('QUOTA_PAUSED')
    registry.failure(binding, 401, null)
    expect(() => registry.admit(binding)).toThrow(CapacityWaitError)
    registry.reconnect(binding)
    expect(registry.pool(binding).state).toBe('USAGE_UNKNOWN')
  })
  it('handles thousands of quota and throttle transitions without invented reset times', () => {
    let now = 0
    const registry = new CapacityRegistry(undefined, () => now)
    const binding = registry.binding(registration)
    for (let i = 0; i < 5000; i++) {
      const pool = registry.failure(
        binding,
        429,
        i % 2 ? null : 'subscription_sharing_usage_limit_exceeded',
      )
      expect(pool.resetAt.value).toBeNull()
      expect(pool.nextProbeAt).toBeGreaterThan(now)
      now = pool.nextProbeAt!
      expect(registry.admit(binding).state).toBe('PROBING')
      registry.success(binding)
      expect(registry.pool(binding).stateEvidence?.confidence).toBe('OBSERVED')
    }
  })
})
