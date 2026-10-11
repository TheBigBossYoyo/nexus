import { createHash } from 'node:crypto'
import type { CapacityPool, ProviderReservePolicy } from '@shared/capacity'

export const DISPATCH_POLICY = '0.7.2-advisory-1'

/** Physical worker slots are shared locally; this makes no claim about shared provider allowance. */
export function hostedSessionPool(runtimeOwner: string): CapacityPool {
  const binding = createHash('sha256').update(runtimeOwner).digest('hex')
  const unknown = { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN', observedAt: 0 } as const
  return {
    id: `hosted-session-slots:${binding}`, binding, consumers: ['claude', 'codex'],
    state: 'USAGE_UNKNOWN', scope: 'APP', resetAt: unknown, utilization: unknown,
    nextProbeAt: null, probeAttempts: 0,
  }
}

export function sessionReservePolicy(pools: CapacityPool[], maxAgents: number): ProviderReservePolicy {
  return {
    version: `${DISPATCH_POLICY}:${maxAgents}`, maxConcurrent: maxAgents + 1, advisorySlots: 1,
    poolLimits: Object.fromEntries(pools.filter((p) => p.consumers.includes('openai'))
      .map((p) => [p.id, { maxConcurrent: 1, advisorySlots: 0 }])),
  }
}
