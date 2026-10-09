import type {
  CapacityPool,
  IntelligenceRole,
  ProviderReservePolicy,
  RoutingCandidate,
  ProviderCapacityLease,
} from '@shared/capacity'
import type { AdvisoryProvider } from './compiler'
import { type CapacityAwareProviderRouter, CapacityRoutingWaitError } from '../capacity/router'
import { CapacityWaitError } from '../capacity/registry'
import { PlanInferenceError } from './openai'
import { TechnicalAdvisoryError } from './technical'
import { ChatGPTBusyError } from './connection'

export interface AdvisoryCandidate extends RoutingCandidate {
  /** Includes account/profile, quality policy, adapter and runtime versions. Never a credential. */
  binding: string
  create(): AdvisoryProvider
}
export interface AdvisoryRoutingDeps {
  snapshot(
    role: IntelligenceRole,
  ): Promise<{ candidates: AdvisoryCandidate[]; pools: CapacityPool[] }>
  reserve(pools: CapacityPool[]): ProviderReservePolicy
}

/** The same kernel admits every Director/compiler call, including the semantic drift check. */
export class AdvisoryRoutingService {
  private readonly quarantined = new Map<AdvisoryProvider, ProviderCapacityLease[]>()
  private stopping: Promise<void> | null = null
  constructor(
    private readonly router: CapacityAwareProviderRouter,
    private readonly deps: AdvisoryRoutingDeps,
  ) {}
  async reconcileStops(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      for (const [adapter, leases] of this.quarantined) {
        await adapter.dispose?.()
        if (adapter.stopConfirmed?.()) {
          this.router.confirmStopped(leases)
          this.quarantined.delete(adapter)
        }
      }
    })()
    try {
      await this.stopping
    } finally {
      this.stopping = null
    }
  }
  async providers(
    projectId: string,
    operationId: string,
    purpose: 'DIRECTOR' | 'COMPILER',
  ): Promise<{ strategic?: AdvisoryProvider; technical?: AdvisoryProvider }> {
    await this.reconcileStops() // Lifecycle cleanup only; never replays advisory inference.
    const strategic = await this.select(
      projectId,
      operationId,
      purpose,
      purpose === 'COMPILER' ? 'compiler' : 'strategic',
    )
    const technical = await this.select(projectId, operationId, purpose, 'technical')
    return { ...(strategic ? { strategic } : {}), ...(technical ? { technical } : {}) }
  }
  private async select(
    projectId: string,
    operationId: string,
    purpose: string,
    role: IntelligenceRole,
  ): Promise<AdvisoryProvider | undefined> {
    const snapshot = await this.deps.snapshot(role)
    const preflight = this.router.decide({
      projectId,
      operationId,
      role,
      stage: `${purpose}:${role}:ADMISSION`,
      ...snapshot,
      policy: this.deps.reserve(snapshot.pools),
      coherentBoundary: true,
      allowExplicitProbe: true,
    })
    if (preflight.action !== 'ROUTE') return undefined
    this.router.outcome(preflight, 'COMPLETED') // Admission only; no inference was sent.
    const selected = snapshot.candidates.find(
      (c) => c.provider === preflight.provider && c.model === preflight.model,
    )!
    let sequence = 0
    return {
      complete: async (instructions, data) => {
        const fresh = await this.deps.snapshot(role)
        const candidate = fresh.candidates.find(
          (c) =>
            c.provider === selected.provider &&
            c.model === selected.model &&
            c.binding === selected.binding,
        )
        const policy = this.deps.reserve(fresh.pools)
        const route = this.router.decide({
          projectId,
          operationId,
          role,
          stage: `${purpose}:${role}:${++sequence}`,
          candidates: candidate ? [candidate] : [],
          pools: fresh.pools,
          policy,
          coherentBoundary: true,
          allowExplicitProbe: true,
        })
        if (route.action !== 'ROUTE') throw new CapacityRoutingWaitError(route)
        const leases = this.router.claim(route, policy)
        let quarantine = false
        let adapter: AdvisoryProvider | undefined
        try {
          adapter = candidate!.create()
          this.router.dispatched(route)
          const result = await adapter.complete(instructions, data)
          this.router.outcome(route, 'COMPLETED', null, adapter.usage?.() ?? null)
          return result
        } catch (error) {
          quarantine =
            error instanceof TechnicalAdvisoryError &&
            !error.stopConfirmed &&
            !adapter?.stopConfirmed?.()
          if (quarantine && adapter) this.quarantined.set(adapter, leases)
          this.router.outcome(
            route,
            'FAILED',
            quarantine
              ? 'STOP_UNCONFIRMED'
              : error instanceof CapacityWaitError ||
                  error instanceof ChatGPTBusyError ||
                  error instanceof CapacityRoutingWaitError ||
                  error instanceof PlanInferenceError
                ? 'CAPACITY'
                : 'PROVIDER',
            adapter?.usage?.() ?? null,
          )
          throw error
        } finally {
          this.router.release(leases, quarantine)
        }
      },
    }
  }
}
