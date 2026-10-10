import { randomUUID } from 'node:crypto'
import type {
  CapacityPool,
  CapacityRoutingRecord,
  IntelligenceRole,
  ProviderCapacityLease,
  ProviderReservePolicy,
  RoutingCandidate,
  ProviderUsageReceipt,
  CapacityRoutingDecision,
} from '@shared/capacity'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'
import { routeCapacity } from './policy'
import { z } from 'zod'

const PoolLimit = z
  .object({
    maxConcurrent: z.number().int().min(1).max(100),
    advisorySlots: z.number().int().min(0).max(99),
  })
  .strict()
  .refine((p) => p.advisorySlots < p.maxConcurrent)
const Reserve = z
  .object({
    version: z.string().min(1).max(200),
    maxConcurrent: z.number().int().min(1).max(100),
    advisorySlots: z.number().int().min(0).max(99),
    poolLimits: z.record(z.string().min(1).max(300), PoolLimit).optional(),
  })
  .strict()
  .refine((p) => p.advisorySlots < p.maxConcurrent)
const Lease = z
  .object({
    id: z.string().uuid(),
    poolId: z.string().min(1),
    operationId: z.string().min(1),
    role: z.enum(['strategic', 'technical', 'compiler', 'worker', 'reviewer']),
    bootId: z.string().min(1),
    state: z.enum(['HELD', 'RELEASED', 'QUARANTINED', 'INTERRUPTED']),
    createdAt: z.string().datetime(),
    owner: z
      .object({
        kind: z.enum(['PROCESS_HTTP', 'HOSTED_SESSION']),
        pid: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
const Leases = z.object({ leases: z.array(Lease).max(100) }).strict()

export class CapacityRoutingWaitError extends Error {
  constructor(readonly decision: CapacityRoutingRecord) {
    super(
      `Waiting for required provider capacity or quality admission: ${decision.reasons.join('; ')}`,
    )
    this.name = 'CapacityRoutingWaitError'
  }
}

/** One admission kernel for advisory and worker dispatch. Every decision precedes external work. */
export class CapacityAwareProviderRouter {
  constructor(
    private readonly store: IntelligenceStore,
    private readonly bootId: string,
    private readonly now: () => number = Date.now,
  ) {}

  decide(input: {
    projectId: string
    operationId: string
    stage: string
    role: IntelligenceRole
    candidates: RoutingCandidate[]
    pools: CapacityPool[]
    policy: ProviderReservePolicy
    activeSession?: { provider: RoutingCandidate['provider']; model: string }
    coherentBoundary: boolean
    allowExplicitProbe?: boolean
  }): CapacityRoutingRecord {
    Reserve.parse(input.policy)
    if (
      !input.stage ||
      !input.operationId ||
      new Set(input.candidates.map((c) => `${c.provider}:${c.model}`)).size !==
        input.candidates.length
    )
      throw new Error(
        'Routing requires unique provider/model candidates and a named operation stage',
      )
    const candidates = input.candidates.map((candidate) => ({
      ...candidate,
      available:
        candidate.available &&
        candidate.poolIds.every((id) => this.hasSlot(id, input.role, input.policy)),
    }))
    const probePoolIds =
      input.allowExplicitProbe && ['strategic', 'technical', 'compiler'].includes(input.role)
        ? input.pools
            .filter(
              (p) =>
                p.consumers.length === 1 &&
                p.consumers[0] === 'openai' &&
                p.state !== 'AUTH_REQUIRED' &&
                p.nextProbeAt !== null &&
                p.nextProbeAt <= this.now(),
            )
            .map((p) => p.id)
        : []
    const decision = routeCapacity({ ...input, candidates, allowPaid: false, probePoolIds })
    const selected = candidates.find(
      (c) => c.provider === decision.provider && c.model === decision.model,
    )
    const record: CapacityRoutingRecord = {
      ...decision,
      id: randomUUID(),
      projectId: input.projectId,
      operationId: input.operationId,
      role: input.role,
      stage: input.stage,
      state: decision.action === 'ROUTE' ? 'ADMITTED' : 'WAITING_FOR_CAPACITY',
      poolIds: selected?.poolIds ?? [],
      policyVersion: input.policy.version,
      reservePolicy: input.policy,
      createdAt: new Date(this.now()).toISOString(),
      endedAt: null,
      failure: null,
      consumption: 'NOT_SENT',
      usage: null,
    }
    this.store.saveRouting(record)
    return record
  }
  private leases(poolId: string): ProviderCapacityLease[] {
    const saved = this.store.readCheckpoint(`capacity-leases:${poolId}`)
    if (!saved) return []
    const leases = Leases.parse(saved.body).leases
    if (
      leases.some((l) => l.poolId !== poolId) ||
      new Set(leases.map((l) => l.id)).size !== leases.length
    )
      throw new Error('Capacity lease checkpoint binding is invalid')
    return leases
  }
  private hasSlot(poolId: string, role: IntelligenceRole, policy: ProviderReservePolicy): boolean {
    const limit = policy.poolLimits?.[poolId] ?? policy
    const held = this.leases(poolId).filter((l) => l.state === 'HELD' || l.state === 'QUARANTINED')
    const advisory = role === 'strategic' || role === 'technical' || role === 'compiler'
    return (
      held.length < limit.maxConcurrent &&
      (advisory ||
        held.filter((l) => l.role === 'worker' || l.role === 'reviewer').length <
          limit.maxConcurrent - limit.advisorySlots)
    )
  }
  assess(input: Parameters<typeof routeCapacity>[0] & { policy: ProviderReservePolicy }): CapacityRoutingDecision {
    Reserve.parse(input.policy)
    return routeCapacity({ ...input, candidates: input.candidates.map((candidate) => ({
      ...candidate, available: candidate.available && candidate.poolIds.every((id) => this.hasSlot(id, input.role, input.policy)),
    })) })
  }
  claim(record: CapacityRoutingRecord, policy: ProviderReservePolicy): ProviderCapacityLease[] {
    Reserve.parse(policy)
    if (record.action !== 'ROUTE') throw new CapacityRoutingWaitError(record)
    if (
      policy.version !== record.policyVersion ||
      JSON.stringify(record.reservePolicy) !== JSON.stringify(policy) ||
      !record.poolIds.length ||
      new Set(record.poolIds).size !== record.poolIds.length
    )
      throw new Error('Capacity claim requires the admitted reserve policy and pool binding')
    if (
      !this.store.checkpoint(`capacity-route-claim:${record.id}`, null, {
        bootId: this.bootId,
        operationId: record.operationId,
      })
    )
      throw new Error(
        'This routing decision has already been claimed; no duplicate dispatch is permitted',
      )
    const leases: ProviderCapacityLease[] = []
    try {
      for (const poolId of record.poolIds) {
        if (!this.hasSlot(poolId, record.role, policy)) throw new CapacityRoutingWaitError(record)
        const key = `capacity-leases:${poolId}`,
          saved = this.store.readCheckpoint(key)
        const existing = this.leases(poolId)
        const lease: ProviderCapacityLease = {
          id: randomUUID(),
          poolId,
          operationId: record.operationId,
          role: record.role,
          bootId: this.bootId,
          state: 'HELD',
          createdAt: new Date(this.now()).toISOString(),
          owner: {
            kind: record.provider === 'openai' ? 'PROCESS_HTTP' : 'HOSTED_SESSION',
            pid: process.pid,
          },
        }
        if (
          !this.store.checkpoint(key, saved?.revision ?? null, {
            leases: [
              ...existing.filter((l) => l.state === 'HELD' || l.state === 'QUARANTINED'),
              lease,
            ],
          })
        )
          throw new CapacityRoutingWaitError(record)
        leases.push(lease)
      }
      return leases
    } catch (error) {
      this.release(leases)
      if (error instanceof CapacityRoutingWaitError) {
        const waiting: CapacityRoutingRecord = {
          ...record,
          action: 'WAIT',
          state: 'WAITING_FOR_CAPACITY',
          reasons: [...record.reasons, 'SESSION_RESERVE_CHANGED'],
          failure: 'CAPACITY',
        }
        this.store.saveRouting(waiting)
        throw new CapacityRoutingWaitError(waiting)
      }
      throw error
    }
  }
  release(leases: ProviderCapacityLease[], quarantine = false): void {
    this.endLeases(leases, quarantine ? 'QUARANTINED' : 'RELEASED', false)
  }
  /**
   * Ends leases of this start whose session is known to have stopped, whatever state the earlier attempt left
   * them in: still held (its release could not be written) or quarantined. Leases that already ended are left.
   */
  settle(leases: ProviderCapacityLease[]): void {
    const state = (lease: ProviderCapacityLease): string | undefined => this.leases(lease.poolId).find((l) => l.id === lease.id)?.state
    const held = leases.filter((l) => state(l) === 'HELD')
    const quarantined = leases.filter((l) => state(l) === 'QUARANTINED')
    if (held.length) this.endLeases(held, 'RELEASED', false)
    if (quarantined.length) this.endLeases(quarantined, 'RELEASED', true)
  }
  /** Called only after the owning adapter confirms stop; no IPC channel can assert that evidence. */
  confirmStopped(leases: ProviderCapacityLease[]): void {
    this.endLeases(leases, 'RELEASED', true)
  }
  private endLeases(
    leases: ProviderCapacityLease[],
    state: 'QUARANTINED' | 'RELEASED',
    confirmed: boolean,
  ): void {
    this.store.atomic(() => {
      for (const lease of leases) {
        const key = `capacity-leases:${lease.poolId}`,
          saved = this.store.readCheckpoint(key)
        if (!saved) throw new Error('Capacity lease checkpoint is missing')
        const current = this.leases(lease.poolId)
        const held = current.find((l) => l.id === lease.id)
        if (!held || held.bootId !== this.bootId)
          throw new Error('Capacity lease ownership changed')
        if (held.state === 'QUARANTINED' && state === 'RELEASED' && !confirmed)
          throw new Error(
            'An unconfirmed session requires confirmed stop evidence before releasing capacity',
          )
        const next = current.map((l) => (l.id === lease.id ? { ...l, state } : l))
        if (
          confirmed &&
          !this.store.checkpoint(`capacity-stop-confirmed:${lease.id}`, null, {
            leaseId: lease.id,
            bootId: this.bootId,
            source: 'OWNING_ADAPTER',
            confirmedAt: new Date(this.now()).toISOString(),
          })
        )
          throw new Error('Capacity stop evidence has already been recorded')
        if (!this.store.checkpoint(key, saved.revision, { leases: next }))
          throw new Error('Capacity lease changed during release')
      }
    })
  }
  outcome(
    record: CapacityRoutingRecord,
    state: 'COMPLETED' | 'FAILED',
    failure: CapacityRoutingRecord['failure'] = null,
    usage: ProviderUsageReceipt | null = null,
  ): void {
    this.store.saveRouting({
      ...record,
      state,
      failure,
      usage,
      consumption: usage ? 'PROVIDER_REPORTED' : record.consumption,
      endedAt: new Date(this.now()).toISOString(),
    })
  }
  dispatched(record: CapacityRoutingRecord): void {
    record.consumption = 'UNKNOWN'
    this.store.saveRouting(record)
  }
}
