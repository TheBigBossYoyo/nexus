import { createHash } from 'node:crypto'
import type { CapacityPool, IntelligenceRole } from '@shared/capacity'
import type { Repositories } from '../persistence'
import type { ProviderService } from '../providers/service'
import type { UsageIntelligenceService } from '../usage/service'
import type { ChatGPTConnection } from './connection'
import { ProviderQualityRegistry } from '../capacity/quality'
import { RuntimeCapacityPools } from '../capacity/runtime-pools'
import { CapacityAwareProviderRouter } from '../capacity/router'
import { AdvisoryRoutingService, type AdvisoryCandidate } from './routing'
import { ClaudeTechnicalDirector } from './technical'
import { DISPATCH_POLICY, hostedSessionPool, sessionReservePolicy } from '../capacity/reserves'

export const ADVISORY_POLICY = DISPATCH_POLICY

/** Wiring is complete even while real technical quality acceptance remains a separate closed gate. */
export function createProductionAdvisoryRouting(input: {
  repos: Repositories
  providers: ProviderService
  usage: UsageIntelligenceService
  chatgpt: ChatGPTConnection
  bootId: string
  dataDir: string
  maxAgents: () => number
}): { service: AdvisoryRoutingService; dispose: () => Promise<void> } {
  const store = input.repos.intelligenceArtifacts
  const quality = new ProviderQualityRegistry(store)
  const pools = new RuntimeCapacityPools(store, input.dataDir)
  const adapters = new Set<ClaudeTechnicalDirector>()
  let disposed = false
  const service = new AdvisoryRoutingService(new CapacityAwareProviderRouter(store, input.bootId), {
    reserve: (capacity) => sessionReservePolicy(capacity, input.maxAgents()),
    snapshot: async (role: IntelligenceRole) => {
      const candidates: AdvisoryCandidate[] = [],
        capacity: CapacityPool[] = []
      const status = input.chatgpt.status(),
        strategic = input.chatgpt.provider()
      if (
        (role === 'strategic' || role === 'compiler') &&
        strategic &&
        status.model &&
        status.capacity
      ) {
        capacity.push(status.capacity)
        candidates.push({
          provider: 'openai',
          model: status.model,
          roles: ['strategic', 'compiler'],
          poolIds: [status.capacity.id],
          available: !disposed && input.chatgpt.canInfer(),
          qualityApproved: true,
          // Explicit primary-role policy. This is not a comparative fallback-quality claim.
          qualityEvidence: [
            `PRIMARY_ROLE_POLICY:${ADVISORY_POLICY}:${status.activeProfile}:${status.model}`,
          ],
          reserve: 'STRATEGIC',
          paid: false,
          binding: JSON.stringify([
            status.activeProfile,
            status.model,
            status.capacity.binding,
            ADVISORY_POLICY,
          ]),
          create: () =>
            input.chatgpt.provider() ?? {
              complete: async () => {
                throw new Error('ChatGPT primary configuration changed')
              },
            },
        })
      }
      const runtime = input.providers.pinnedRuntime('claude')
      const discovered = input.providers.list().find((s) => s.id === 'claude')
      if (!runtime || !discovered || disposed) return { candidates, pools: capacity }
      // No inference: only the runtime's own authenticated-account report supplies the profile binding.
      const account = await runtime.getAccountInfo({ subscriptionMode: true }).catch(() => null)
      if (
        !account ||
        account.state !== 'authenticated' ||
        account.mode !== 'subscription' ||
        !account.email ||
        !discovered.supported ||
        !discovered.capabilities.sessions ||
        !discovered.capabilities.toolAuthorization
      )
        return { candidates, pools: capacity }
      const profile = createHash('sha256')
        .update(JSON.stringify([account.email, account.organization, account.mode]))
        .digest('hex')
      const settings = input.repos.settings.get()
      const model = settings.models.tiers.strongest
      if (!model || !settings.claude.subscriptionMode) return { candidates, pools: capacity }
      const scope = {
        provider: 'claude' as const,
        model,
        role,
        profile,
        policyVersion: ADVISORY_POLICY,
        runtimeVersion: discovered.version ?? 'unknown',
      }
      // The Technical Director is Claude's own role, as the strategic one is ChatGPT's: it is the provider the
      // design names for it, not a stand-in, and needs no comparative evidence. (Nothing in production writes
      // such evidence, so with this requirement the Technical Director could never be admitted: every level 1 and
      // level 3 request, and every TECHNICAL or COUNCIL compilation, waited for ever.) In the strategic and
      // compiler roles Claude would stand in for ChatGPT, and that still needs evidence.
      const primary = role === 'technical'
      const evidence = primary ? [`PRIMARY_ROLE_POLICY:${ADVISORY_POLICY}:claude:${model}`] : quality.evidence(scope)
      let pool = pools.pool('claude', profile)
      const machine = input.usage.machineState()
      const observed = input.usage.capacityObservation()
      if (observed && observed.observedAt >= (pool.stateEvidence?.observedAt ?? 0))
        pool = pools.observe(pool, observed.state, {
          resetAt: observed.resetAt,
          utilization: observed.utilization,
          observedAt: observed.observedAt,
        })
      if (!input.usage.canDispatch() && pool.state !== machine.status)
        pool = pools.observe(pool, machine.status, {
          resetAt: machine.resetAt,
          utilization: machine.utilizationPercent,
        })
      capacity.push(pool)
      const hostPool = hostedSessionPool(input.dataDir)
      capacity.push(hostPool)
      candidates.push({
        provider: 'claude',
        model,
        roles: [role],
        poolIds: [pool.id, hostPool.id],
        available: !disposed && input.usage.canDispatch(),
        qualityApproved: evidence.length > 0,
        qualityEvidence: evidence,
        reserve: 'NONE',
        paid: false,
        binding: JSON.stringify(scope),
        create: () => {
          const adapter = new ClaudeTechnicalDirector({
            runtime,
            model,
            cwd: input.dataDir,
            admitted: () =>
              !disposed && input.usage.canDispatch() && (primary || quality.evidence(scope).length > 0),
          })
          adapters.add(adapter)
          return {
            usage: () => adapter.usage(),
            stopConfirmed: () => adapter.stopConfirmed(),
            dispose: () => adapter.dispose(),
            complete: async (instructions, data) => {
              try {
                return await adapter.complete(instructions, data)
              } finally {
                await adapter.dispose()
                if (adapter.stopConfirmed()) adapters.delete(adapter)
              }
            },
          }
        },
      })
      return { candidates, pools: capacity }
    },
  })
  return {
    service,
    dispose: async () => {
      disposed = true
      await Promise.allSettled([...adapters].map((a) => a.dispose()))
      await service.reconcileStops()
    },
  }
}
