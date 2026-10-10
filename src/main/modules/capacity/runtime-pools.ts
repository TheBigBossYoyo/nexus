import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CapacityPool, CapacityState, IntelligenceProvider } from '@shared/capacity'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'

const State = z.enum([
  'AVAILABLE',
  'LIMIT_APPROACHING',
  'THROTTLED',
  'QUOTA_PAUSED',
  'WAITING_FOR_RESET',
  'AUTH_REQUIRED',
  'RUNTIME_UNAVAILABLE',
  'USAGE_UNKNOWN',
  'USAGE_SERVICE_UNAVAILABLE',
  'PROBING',
])
const Fact = z.object({
  value: z.number().finite().nullable(),
  source: z.enum(['PROVIDER_RUNTIME', 'RESPONSE', 'SERVER_ERROR', 'LOCAL', 'USER', 'UNKNOWN']),
  confidence: z.enum(['EXACT', 'OBSERVED', 'ESTIMATED', 'UNKNOWN']),
  observedAt: z.number().finite(),
})
const Pool = z
  .object({
    id: z.string(),
    binding: z.string(),
    consumers: z.array(z.enum(['claude', 'codex'])).length(1),
    state: State,
    scope: z.literal('UNKNOWN'),
    resetAt: Fact,
    utilization: Fact,
    nextProbeAt: z.number().finite().nullable(),
    probeAttempts: z.number().int().min(0),
    stateEvidence: z
      .object({
        value: State.nullable(),
        source: Fact.shape.source,
        confidence: Fact.shape.confidence,
        observedAt: Fact.shape.observedAt,
      })
      .optional(),
  })
  .strict()

/** A runtime binding is not proof of an account pool or of sharing with any other provider. */
export class RuntimeCapacityPools {
  constructor(
    private readonly store: IntelligenceStore,
    private readonly runtimeOwner: string,
    private readonly now = Date.now,
  ) {}
  pool(provider: Exclude<IntelligenceProvider, 'openai'>, profile: string): CapacityPool {
    const binding = createHash('sha256')
      .update(JSON.stringify([this.runtimeOwner, provider, profile]))
      .digest('hex')
    const id = `runtime-capacity:${provider}:${binding}`
    const saved = this.store.readCheckpoint(id)
    if (saved) {
      const pool = Pool.parse(saved.body)
      if (pool.id !== id || pool.binding !== binding || pool.consumers[0] !== provider)
        throw new Error('Runtime capacity binding mismatch')
      return pool
    }
    const unknown = {
      value: null,
      source: 'UNKNOWN',
      confidence: 'UNKNOWN',
      observedAt: this.now(),
    } as const
    return {
      id,
      binding,
      consumers: [provider],
      state: 'USAGE_UNKNOWN',
      scope: 'UNKNOWN',
      resetAt: unknown,
      utilization: unknown,
      nextProbeAt: null,
      probeAttempts: 0,
      stateEvidence: { ...unknown, value: 'USAGE_UNKNOWN' },
    }
  }
  /**
   * A pause whose evidence has run out: the reset time it named has passed, or nothing has been heard for the
   * retry interval. The pool is unknown again, by NEXUS's own reckoning and labelled so; the next session is
   * the probe. Without this a provider that has no probe of its own (Codex) stayed paused for ever after one
   * rejection.
   */
  expire(pool: CapacityPool): CapacityPool {
    const local = { value: null, source: 'LOCAL', confidence: 'ESTIMATED', observedAt: this.now() } as const
    const next: CapacityPool = { ...pool, state: 'USAGE_UNKNOWN', stateEvidence: { ...local, value: 'USAGE_UNKNOWN' }, resetAt: { ...local }, utilization: { ...local } }
    const saved = this.store.readCheckpoint(pool.id)
    if (!this.store.checkpoint(pool.id, saved?.revision ?? null, Pool.parse(next))) throw new Error('Runtime capacity changed during expiry')
    return next
  }
  observe(
    pool: CapacityPool,
    state: CapacityState,
    facts?: { resetAt?: number | null; utilization?: number | null; observedAt?: number },
  ): CapacityPool {
    const unknown = {
      value: null,
      source: 'UNKNOWN',
      confidence: 'UNKNOWN',
      observedAt: this.now(),
    } as const
    const reported = (value: number | null | undefined) =>
      value == null
        ? unknown
        : {
            value,
            source: 'PROVIDER_RUNTIME' as const,
            confidence: 'OBSERVED' as const,
            observedAt: this.now(),
          }
    const next: CapacityPool = {
      ...pool,
      state,
      stateEvidence: {
        value: state,
        source: 'PROVIDER_RUNTIME',
        confidence: 'OBSERVED',
        observedAt: facts?.observedAt ?? this.now(),
      },
      ...(facts
        ? { resetAt: reported(facts.resetAt), utilization: reported(facts.utilization) }
        : {}),
    }
    const saved = this.store.readCheckpoint(pool.id)
    if (!this.store.checkpoint(pool.id, saved?.revision ?? null, Pool.parse(next)))
      throw new Error('Runtime capacity changed during observation')
    return next
  }
}
