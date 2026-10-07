import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CapacityPool, CapacityState } from '@shared/capacity'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'
import { classifyOpenAIError, planCapacityProbe } from './policy'

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
const Pool = z.object({
  id: z.string(),
  binding: z.string(),
  consumers: z.array(z.literal('openai')),
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

export class CapacityWaitError extends Error {
  constructor(readonly pool: CapacityPool) {
    super(
      `ChatGPT capacity is ${pool.state.toLowerCase().replaceAll('_', ' ')}. ${pool.nextProbeAt ? 'A later explicit request may probe after the saved backoff.' : 'Reconnect or restore the provider before retrying.'}`,
    )
  }
}

/** Evidence for an issued app registration. Never merges this pool with Codex by provider name. */
export class CapacityRegistry {
  private memory = new Map<string, { body: CapacityPool; revision: number }>()
  constructor(
    private readonly store?: IntelligenceStore,
    private readonly now: () => number = Date.now,
  ) {}
  binding(registration: { issuer: string; clientId: string; subject: string }): string {
    return createHash('sha256')
      .update(JSON.stringify([registration.issuer, registration.clientId, registration.subject]))
      .digest('hex')
  }
  pool(binding: string): CapacityPool {
    const id = `chatgpt-registration:${binding}`
    const record = this.store?.readCheckpoint(id) ?? this.memory.get(id)
    if (record) {
      const parsed = Pool.parse(record.body)
      if (parsed.id !== id || parsed.binding !== binding || parsed.consumers.length !== 1)
        throw new Error('Capacity checkpoint does not match registration')
      return parsed
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
      consumers: ['openai'],
      state: 'USAGE_UNKNOWN',
      scope: 'UNKNOWN',
      resetAt: unknown,
      utilization: unknown,
      nextProbeAt: null,
      probeAttempts: 0,
      stateEvidence: { ...unknown, value: 'USAGE_UNKNOWN' },
    }
  }
  private save(pool: CapacityPool): void {
    const record = this.store?.readCheckpoint(pool.id) ?? this.memory.get(pool.id)
    if (this.store) {
      if (!this.store.checkpoint(pool.id, record?.revision ?? null, pool))
        throw new Error('Capacity state changed; retry after reading its latest state')
    } else
      this.memory.set(pool.id, {
        body: structuredClone(pool),
        revision: (record?.revision ?? -1) + 1,
      })
  }
  admit(binding: string): CapacityPool {
    const pool = this.pool(binding)
    if (['AVAILABLE', 'LIMIT_APPROACHING', 'USAGE_UNKNOWN'].includes(pool.state)) return pool
    if (
      pool.state === 'AUTH_REQUIRED' ||
      pool.nextProbeAt === null ||
      this.now() < pool.nextProbeAt
    )
      throw new CapacityWaitError(pool)
    const probing: CapacityPool = {
      ...pool,
      state: 'PROBING',
      nextProbeAt: this.now() + 190000,
      stateEvidence: {
        value: 'PROBING',
        source: 'LOCAL',
        confidence: 'EXACT',
        observedAt: this.now(),
      },
    }
    this.save(probing)
    return probing
  }
  success(binding: string): void {
    const pool = this.pool(binding)
    this.save({
      ...pool,
      state: 'AVAILABLE',
      nextProbeAt: null,
      probeAttempts: 0,
      stateEvidence: {
        value: 'AVAILABLE',
        source: 'RESPONSE',
        confidence: 'OBSERVED',
        observedAt: this.now(),
      },
    })
  }
  failure(binding: string, status: number, code: string | null): CapacityPool {
    const state: CapacityState = classifyOpenAIError(status, code)
    const pool = this.pool(binding)
    let next: CapacityPool = {
      ...pool,
      state,
      stateEvidence: {
        value: state,
        source: 'SERVER_ERROR',
        confidence: 'OBSERVED',
        observedAt: this.now(),
      },
    }
    next =
      state === 'AUTH_REQUIRED'
        ? { ...next, nextProbeAt: null }
        : planCapacityProbe(next, this.now())
    this.save(next)
    return next
  }
  reconnect(binding: string): void {
    const pool = this.pool(binding)
    if (pool.state !== 'AUTH_REQUIRED') return
    this.save({
      ...pool,
      state: 'USAGE_UNKNOWN',
      nextProbeAt: null,
      stateEvidence: {
        value: 'USAGE_UNKNOWN',
        source: 'LOCAL',
        confidence: 'UNKNOWN',
        observedAt: this.now(),
      },
    })
  }
}
