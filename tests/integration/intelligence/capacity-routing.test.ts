import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { CapacityPool, IntelligenceRole, RoutingCandidate } from '@shared/capacity'
import { CapacityAwareProviderRouter } from '@main/modules/capacity/router'
import { ProviderQualityRegistry } from '@main/modules/capacity/quality'
import { AdvisoryRoutingService } from '@main/modules/intelligence/routing'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import { TechnicalAdvisoryError } from '@main/modules/intelligence/technical'
import { graphHarness } from '../../helpers/context-graph'

const policy = { version: 'test-policy', maxConcurrent: 3, advisorySlots: 1 }
const unknown = { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN', observedAt: 1 } as const
const pool = (provider: 'claude' | 'openai' | 'codex'): CapacityPool => ({
  id: `pool:${provider}`,
  binding: `profile:${provider}`,
  consumers: [provider],
  state: 'USAGE_UNKNOWN',
  scope: 'UNKNOWN',
  resetAt: unknown,
  utilization: unknown,
  nextProbeAt: null,
  probeAttempts: 0,
})
const candidate = (
  provider: 'claude' | 'openai' | 'codex',
  role: IntelligenceRole,
): RoutingCandidate => ({
  provider,
  model: `${provider}-test`,
  roles: [role],
  poolIds: [pool(provider).id],
  available: true,
  qualityApproved: true,
  qualityEvidence: ['fake-controlled-validation'],
  paid: false,
  reserve: 'NONE',
})
const memo = {
  objective: 'Scope',
  recommendation: 'Verify',
  rationale: [],
  alternatives: [],
  risks: [],
  unknowns: [],
  requestedExperiments: [],
  evidenceRefs: [],
  confidence: 'MEDIUM',
}

describe('durable capacity admission controls real advisory dispatch', () => {
  it('permits a due explicit GPT probe without changing quota facts, never an auth bypass or worker probe', () => {
    const h = graphHarness()
    try {
      const router = new CapacityAwareProviderRouter(
        h.repos.intelligenceArtifacts,
        'boot',
        () => 1000,
      )
      const paused = { ...pool('openai'), state: 'QUOTA_PAUSED' as const, nextProbeAt: 900 }
      const input = {
        projectId: h.project.id,
        operationId: randomUUID(),
        stage: 'explicit-retry',
        role: 'strategic' as const,
        candidates: [candidate('openai', 'strategic')],
        pools: [paused],
        policy,
        coherentBoundary: true,
      }
      expect(router.decide(input).action).toBe('WAIT')
      expect(router.decide({ ...input, allowExplicitProbe: true }).reasons).toContain(
        'EXPLICIT_PROBE_DUE',
      )
      expect(paused.state).toBe('QUOTA_PAUSED')
      expect(paused.utilization.value).toBeNull()
      expect(
        router.decide({
          ...input,
          pools: [{ ...paused, nextProbeAt: 1100 }],
          allowExplicitProbe: true,
        }).action,
      ).toBe('WAIT')
      expect(
        router.decide({
          ...input,
          pools: [{ ...paused, state: 'AUTH_REQUIRED' }],
          allowExplicitProbe: true,
        }).action,
      ).toBe('WAIT')
      expect(
        router.decide({
          ...input,
          role: 'worker',
          candidates: [candidate('openai', 'worker')],
          allowExplicitProbe: true,
        }).action,
      ).toBe('WAIT')
    } finally {
      h.close()
    }
  })
  it('reclaims only confirmed dead process-owned HTTP leases; hosted children retain their quarantine', () => {
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts,
        router = new CapacityAwareProviderRouter(store, 'old-boot')
      const admit = (provider: 'openai' | 'claude') =>
        router.decide({
          projectId: h.project.id,
          operationId: randomUUID(),
          stage: 'request',
          role: 'technical',
          candidates: [candidate(provider, 'technical')],
          pools: [pool(provider)],
          policy,
          coherentBoundary: true,
        })
      const http = router.claim(admit('openai'), policy),
        hosted = router.claim(admit('claude'), policy)
      store.reconcileInterrupted(() => false)
      expect(
        (
          store.readCheckpoint(`capacity-leases:${http[0]!.poolId}`)!.body as {
            leases: { state: string }[]
          }
        ).leases[0]?.state,
      ).toBe('QUARANTINED')
      store.reconcileInterrupted(() => true)
      expect(
        (
          store.readCheckpoint(`capacity-leases:${http[0]!.poolId}`)!.body as {
            leases: { state: string }[]
          }
        ).leases[0]?.state,
      ).toBe('INTERRUPTED')
      expect(
        (
          store.readCheckpoint(`capacity-leases:${hosted[0]!.poolId}`)!.body as {
            leases: { state: string }[]
          }
        ).leases[0]?.state,
      ).toBe('QUARANTINED')
      router.confirmStopped(hosted)
      expect(
        (
          store.readCheckpoint(`capacity-leases:${hosted[0]!.poolId}`)!.body as {
            leases: { state: string }[]
          }
        ).leases[0]?.state,
      ).toBe('RELEASED')
    } finally {
      h.close()
    }
  })
  it('enforces the actual exclusive OpenAI slot independently of the worker-session reserve', () => {
    const h = graphHarness()
    try {
      const router = new CapacityAwareProviderRouter(h.repos.intelligenceArtifacts, 'boot')
      const limit = {
        ...policy,
        poolLimits: { 'pool:openai': { maxConcurrent: 1, advisorySlots: 0 } },
      }
      const input = {
        projectId: h.project.id,
        operationId: randomUUID(),
        stage: 'request',
        role: 'strategic' as const,
        candidates: [candidate('openai', 'strategic')],
        pools: [pool('openai')],
        policy: limit,
        coherentBoundary: true,
      }
      const first = router.decide(input),
        race = router.decide({ ...input, operationId: randomUUID() })
      const leases = router.claim(first, limit)
      expect(() => router.claim(race, limit)).toThrow('SESSION_RESERVE_CHANGED')
      expect(router.decide({ ...input, operationId: randomUUID() }).action).toBe('WAIT')
      router.release(leases)
      expect(router.decide({ ...input, operationId: randomUUID() }).action).toBe('ROUTE')
    } finally {
      h.close()
    }
  })
  it('holds the advisory reserve, records races as WAIT, prevents duplicate claims and preserves unknown facts', () => {
    const h = graphHarness()
    try {
      const router = new CapacityAwareProviderRouter(h.repos.intelligenceArtifacts, 'boot')
      const decide = (role: IntelligenceRole) =>
        router.decide({
          projectId: h.project.id,
          operationId: randomUUID(),
          stage: 'start',
          role,
          candidates: [candidate('claude', role)],
          pools: [pool('claude')],
          policy,
          coherentBoundary: true,
        })
      const first = decide('worker'),
        race = decide('worker')
      const leases = router.claim(first, policy)
      expect(() => router.claim(first, policy)).toThrow('already been claimed')
      const second = decide('reviewer'),
        secondLeases = router.claim(second, policy)
      expect(decide('worker').action).toBe('WAIT')
      expect(() => router.claim(race, policy)).toThrow('SESSION_RESERVE_CHANGED')
      expect(
        h.repos.intelligenceArtifacts.routingHistory(h.project.id, race.operationId)[0]?.state,
      ).toBe('WAITING_FOR_CAPACITY')
      const advisory = decide('technical'),
        advisoryLeases = router.claim(advisory, policy)
      expect(decide('strategic').action).toBe('WAIT')
      expect(pool('claude').utilization.value).toBeNull()
      router.release(leases)
      router.release(secondLeases)
      router.release(advisoryLeases)
      expect(decide('worker').action).toBe('ROUTE')
      expect(() => decide('worker')).not.toThrow()
    } finally {
      h.close()
    }
  })
  it('rejects missing quality, quota sharing, paid fallback, unsafe transitions and malformed checkpoint policy', () => {
    const h = graphHarness()
    try {
      const router = new CapacityAwareProviderRouter(h.repos.intelligenceArtifacts, 'boot')
      const input = {
        projectId: h.project.id,
        operationId: randomUUID(),
        stage: 'handoff',
        role: 'worker' as const,
        candidates: [candidate('codex', 'worker')],
        pools: [pool('codex')],
        policy,
        coherentBoundary: true,
      }
      expect(
        router.decide({
          ...input,
          candidates: [{ ...input.candidates[0]!, qualityApproved: false }],
        }).action,
      ).toBe('WAIT')
      expect(router.decide({ ...input, pools: [pool('openai')] }).action).toBe('WAIT')
      expect(
        router.decide({ ...input, candidates: [{ ...input.candidates[0]!, paid: true }] }).action,
      ).toBe('WAIT')
      expect(
        router.decide({
          ...input,
          coherentBoundary: false,
          activeSession: { provider: 'claude', model: 'claude-test' },
        }).action,
      ).toBe('WAIT')
      expect(() => router.decide({ ...input, policy: { ...policy, advisorySlots: 3 } })).toThrow()
      h.repos.intelligenceArtifacts.checkpoint('capacity-leases:pool:codex', null, {
        leases: [{ state: 'RELEASED' }],
      })
      expect(() => router.decide(input)).toThrow()
    } finally {
      h.close()
    }
  })
  it('quarantines unconfirmed stops and never frees old-boot leases merely because the host restarted', async () => {
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts,
        router = new CapacityAwareProviderRouter(store, 'boot-1')
      const routing = new AdvisoryRoutingService(router, {
        reserve: () => ({ ...policy, maxConcurrent: 1, advisorySlots: 0 }),
        snapshot: async () => ({
          pools: [pool('claude')],
          candidates: [
            {
              ...candidate('claude', 'technical'),
              binding: 'profile',
              create: () => ({
                complete: async () => {
                  throw new TechnicalAdvisoryError('TIMEOUT', false)
                },
              }),
            },
          ],
        }),
      })
      const providers = await routing.providers(h.project.id, randomUUID(), 'DIRECTOR')
      await expect(providers.technical!.complete('instructions', {})).rejects.toThrow(
        'stop was not confirmed',
      )
      expect(store.routingHistory(h.project.id).some((r) => r.failure === 'STOP_UNCONFIRMED')).toBe(
        true,
      )
      const saved = store.readCheckpoint('capacity-leases:pool:claude')!.body as {
        leases: { state: string }[]
      }
      expect(saved.leases[0]?.state).toBe('QUARANTINED')
      const next = new CapacityAwareProviderRouter(store, 'boot-2')
      expect(
        next.decide({
          projectId: h.project.id,
          operationId: randomUUID(),
          stage: 'retry',
          role: 'technical',
          candidates: [candidate('claude', 'technical')],
          pools: [pool('claude')],
          policy: { ...policy, maxConcurrent: 1, advisorySlots: 0 },
          coherentBoundary: true,
        }).action,
      ).toBe('WAIT')
    } finally {
      h.close()
    }
  })
  it('binds immutable quality evidence to the exact provider/model/role/profile/policy/runtime', () => {
    const h = graphHarness()
    try {
      const registry = new ProviderQualityRegistry(h.repos.intelligenceArtifacts)
      const scope = {
        provider: 'claude' as const,
        model: 'claude-test',
        role: 'technical' as const,
        profile: 'profile',
        policyVersion: 'p1',
        runtimeVersion: 'r1',
      }
      registry.recordValidated(scope, ['controlled-fixture'], new Date().toISOString())
      expect(registry.evidence(scope)).toEqual(['controlled-fixture'])
      for (const change of [
        { model: 'other' },
        { profile: 'other' },
        { policyVersion: 'other' },
        { runtimeVersion: 'other' },
        { provider: 'codex' as const },
        { role: 'worker' as const },
      ])
        expect(registry.evidence({ ...scope, ...change })).toEqual([])
      expect(() => registry.recordValidated(scope, ['replaced'], new Date().toISOString())).toThrow(
        'immutable',
      )
    } finally {
      h.close()
    }
  })
  it('persists each Council stage and routing before inference, retains disagreement, and links decisions/outcomes/escalations', async () => {
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts
      let strategicCalls = 0
      const strategic = {
        complete: vi.fn(async () => {
          const routes = store.routingHistory(h.project.id)
          expect(routes.some((r) => r.state === 'ADMITTED')).toBe(true)
          if (++strategicCalls === 1) return memo
          expect(store.listDirectors(h.project.id)[0]?.challenge?.disagreements).toEqual([
            'Need evidence',
          ])
          return {
            decision: 'Test first',
            acceptedClaims: [],
            rejectedClaims: [],
            unresolvedUnknowns: [],
            nextActions: [],
            evidenceRefs: [],
          }
        }),
      }
      const technical = {
        complete: vi.fn(async () => {
          expect(store.listDirectors(h.project.id)[0]?.memo).toEqual(memo)
          return {
            agreements: [],
            disagreements: ['Need evidence'],
            missingEvidence: [],
            proposedChanges: [],
            evidenceRefs: [],
          }
        }),
      }
      const routing = new AdvisoryRoutingService(new CapacityAwareProviderRouter(store, 'boot'), {
        reserve: () => policy,
        snapshot: async (role) => ({
          pools: [pool('openai'), pool('claude')],
          candidates: [
            {
              ...candidate(role === 'technical' ? 'claude' : 'openai', role),
              binding: 'profile',
              create: () => (role === 'technical' ? technical : strategic),
            },
          ],
        }),
      })
      const gateway = new DirectorGateway(store, routing)
      const escalation = gateway.escalate({
        projectId: h.project.id,
        objective: 'Scope',
        level: 3,
        reasons: ['Evidence conflicts'],
        runId: null,
        taskId: null,
      })
      expect(strategic.complete).not.toHaveBeenCalled()
      const request = {
        projectId: h.project.id,
        objective: 'Scope',
        level: 3 as const,
        reasons: [],
        context: [],
        provider: null,
        model: null,
        escalationId: escalation.id,
      }
      const result = await gateway.invoke(request)
      expect(result.state).toBe('COMPLETED')
      const decision = store.directorRecord(h.project.id, result.decisionId!)!
      expect(decision).toMatchObject({
        kind: 'DECISION',
        unresolvedDisagreements: ['Need evidence'],
        executionAuthorized: false,
      })
      expect(store.directorRecord(h.project.id, result.outcomeId!)).toMatchObject({
        completedStages: ['MEMO', 'CHALLENGE', 'SYNTHESIS'],
        replayAllowed: false,
      })
      expect(store.directorRecord(h.project.id, escalation.id)).toMatchObject({
        state: 'COMPLETED',
        invocationId: result.id,
      })
      await expect(gateway.invoke(request)).rejects.toThrow('new explicit request')
      expect(strategic.complete).toHaveBeenCalledTimes(2)
      expect(technical.complete).toHaveBeenCalledTimes(1)
    } finally {
      h.close()
    }
  })
  it('an escalation whose request failed can be invoked again by the user, and is closed once it has completed', async () => {
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts
      let calls = 0
      const strategic = {
        complete: vi.fn(async () => {
          if (++calls === 1) throw new Error('provider went away')
          return memo
        }),
      }
      const routing = new AdvisoryRoutingService(new CapacityAwareProviderRouter(store, 'boot'), {
        reserve: () => policy,
        snapshot: async (role) => ({ pools: [pool('openai')], candidates: [{ ...candidate('openai', role), binding: 'profile', create: () => strategic }] }),
      })
      const gateway = new DirectorGateway(store, routing)
      const escalation = gateway.escalate({ projectId: h.project.id, objective: 'Scope', level: 2, reasons: ['Evidence conflicts'], runId: null, taskId: null })
      const request = { projectId: h.project.id, objective: 'Scope', level: 2 as const, reasons: [], context: [], provider: null, model: null, escalationId: escalation.id }
      const failed = await gateway.invoke(request)
      expect(failed.state).not.toBe('COMPLETED')
      expect(['FAILED', 'WAITING_FOR_PROVIDER']).toContain((store.directorRecord(h.project.id, escalation.id) as { state?: string }).state)
      // The message of the failure says "retry explicitly": the same escalation takes that retry.
      const again = await gateway.invoke(request)
      expect(again.state).toBe('COMPLETED')
      expect(store.directorRecord(h.project.id, escalation.id)).toMatchObject({ state: 'COMPLETED', invocationId: again.id })
      await expect(gateway.invoke(request)).rejects.toThrow()
      expect(strategic.complete).toHaveBeenCalledTimes(2)
    } finally {
      h.close()
    }
  })
  it('preflights all required Council capabilities and never spends the first stage while technical admission is closed', async () => {
    const h = graphHarness()
    try {
      const complete = vi.fn(async () => memo)
      const routing = new AdvisoryRoutingService(
        new CapacityAwareProviderRouter(h.repos.intelligenceArtifacts, 'boot'),
        {
          reserve: () => policy,
          snapshot: async (role) => ({
            pools: [pool('openai')],
            candidates:
              role === 'technical'
                ? []
                : [
                    {
                      ...candidate('openai', role),
                      binding: 'profile',
                      create: () => ({ complete }),
                    },
                  ],
          }),
        },
      )
      const result = await new DirectorGateway(h.repos.intelligenceArtifacts, routing).invoke({
        projectId: h.project.id,
        objective: 'Scope',
        level: 3,
        reasons: [],
        context: [],
        provider: null,
        model: null,
      })
      expect(result.state).toBe('WAITING_FOR_PROVIDER')
      expect(complete).not.toHaveBeenCalled()
      expect(
        h.repos.intelligenceArtifacts.directorRecord(h.project.id, result.outcomeId!),
      ).toMatchObject({ consumption: 'NONE' })
    } finally {
      h.close()
    }
  })
})
