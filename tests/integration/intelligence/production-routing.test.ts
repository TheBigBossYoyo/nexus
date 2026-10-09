import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeAgentRuntime, defaultFakeAuthStatus } from '@main/modules/agent-runtime/fake-runtime'
import { ProviderService } from '@main/modules/providers/service'
import { FakeRuntimeProvider } from '@main/modules/providers/providers'
import { UsageIntelligenceService } from '@main/modules/usage/service'
import { EventBus } from '@main/modules/events'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import {
  createProductionAdvisoryRouting,
  ADVISORY_POLICY,
} from '@main/modules/intelligence/production-routing'
import { ProviderQualityRegistry } from '@main/modules/capacity/quality'
import { TaskAdmissionService } from '@main/modules/intelligence/admission'
import { createV72Handlers } from '@main/modules/ipc/v72-handlers'
import type { CapacityPool } from '@shared/capacity'
import { graphHarness } from '../../helpers/context-graph'

const unknown = { value: null, source: 'UNKNOWN', confidence: 'UNKNOWN', observedAt: 1 } as const
const pool: CapacityPool = {
  id: 'test-registration',
  binding: 'profile',
  consumers: ['openai'],
  state: 'USAGE_UNKNOWN',
  scope: 'UNKNOWN',
  resetAt: unknown,
  utilization: unknown,
  nextProbeAt: null,
  probeAttempts: 0,
}
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

async function harness() {
  const h = graphHarness()
  const settings = h.repos.settings.get()
  h.repos.settings.set({
    ...settings,
    models: {
      ...settings.models,
      tiers: { ...settings.models.tiers, strongest: 'fake-claude-strong' },
    },
  })
  const technical = new FakeAgentRuntime({
    authStatus: { ...defaultFakeAuthStatus(), email: 'controlled-fixture@example.invalid' },
    script: async (spec, ctx) => {
      expect(spec.tools).toEqual([])
      expect(spec.nexusTools).toBeUndefined()
      expect(spec.loadProjectSettings).toBe(false)
      await ctx.completeTurn({ text: JSON.stringify(memo) })
    },
  })
  const start = vi.spyOn(technical, 'startSession')
  const providers = new ProviderService({
    providers: [new FakeRuntimeProvider('claude', technical)],
    sessions: h.repos.providerSessions,
    settings: h.repos.settings,
    runOfAgent: () => null,
  })
  await providers.refresh()
  let inferReady = true
  const complete = vi.fn(async (instructions: string) =>
    instructions.startsWith('INTENT_DRIFT_CHECK')
      ? { changesIntent: false, expandsScope: false, conflicts: [], unjustifiedRequirements: [] }
      : instructions.includes('Produce objective')
        ? memo
        : { recommendations: [], scopeChanged: false, ambiguities: [] },
  )
  const connection = {
    status: () => ({
      state: 'SIGNED_IN_PLAN_USAGE',
      activeProfile: 'test',
      model: 'fake-gpt',
      capacity: pool,
      includedOnlyConfirmed: true,
      profiles: [],
      models: [],
      error: null,
    }),
    provider: () => ({ complete }),
    canInfer: () => inferReady,
  } as unknown as ChatGPTConnection
  const bus = new EventBus(h.repos.events, h.repos.transaction)
  let clock = Date.now()
  const usage = new UsageIntelligenceService({
    repos: h.repos,
    bus,
    runtime: technical,
    push: () => {},
    now: () => ++clock,
  })
  const routing = createProductionAdvisoryRouting({
    repos: h.repos,
    providers,
    usage,
    chatgpt: connection,
    bootId: 'test-boot',
    dataDir: 'controlled-fixture',
    maxAgents: () => 4,
  })
  const admission = new TaskAdmissionService(
    h.repos,
    undefined,
    connection,
    undefined,
    undefined,
    routing.service,
  )
  const ipc = createV72Handlers(
    h.repos,
    connection,
    undefined,
    undefined,
    admission,
    routing.service,
  )
  const profile = createHash('sha256')
    .update(JSON.stringify(['controlled-fixture@example.invalid', null, 'subscription']))
    .digest('hex')
  const approveTechnical = () =>
    new ProviderQualityRegistry(h.repos.intelligenceArtifacts).recordValidated(
      {
        provider: 'claude',
        model: 'fake-claude-strong',
        role: 'technical',
        profile,
        policyVersion: ADVISORY_POLICY,
        runtimeVersion: '0.0.0-fake',
      },
      ['controlled-fake-role-validation'],
      new Date().toISOString(),
    )
  return {
    h,
    ipc,
    usage,
    routing,
    complete,
    start,
    approveTechnical,
    setReady: (value: boolean) => {
      inferReady = value
    },
    close: async () => {
      await routing.dispose()
      usage.dispose()
      await technical.shutdown()
      h.close()
    },
  }
}

describe('production Director/compiler wiring with controlled fake adapters', () => {
  it('waits across different projects when the exclusive GPT slot is occupied, without sending a duplicate request', async () => {
    const h = await harness()
    let finish!: (value: typeof memo) => void
    try {
      const second = h.h.repos.projects.insert({
        ...h.h.project,
        id: 'capacity-second-project',
        rootPath: 'C:\\controlled\\second',
        name: 'Second',
      })
      h.complete.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const pending = h.ipc['director.invoke']({
        projectId: h.h.project.id,
        objective: 'Scope',
        level: 2,
      })
      await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1))
      const waiting = await h.ipc['director.invoke']({
        projectId: second.id,
        objective: 'Scope',
        level: 2,
      })
      expect(waiting.state).toBe('WAITING_FOR_PROVIDER')
      expect(h.complete).toHaveBeenCalledTimes(1)
      finish(memo)
      expect((await pending).state).toBe('COMPLETED')
    } finally {
      if (finish) finish(memo)
      await h.close()
    }
  })
  it('admission really gates IPC and compiler calls, with closed technical quality and bounded primary GPT', async () => {
    const h = await harness()
    try {
      const waiting = await h.ipc['director.invoke']({
        projectId: h.h.project.id,
        objective: 'Scope',
        level: 3,
      })
      expect(waiting.state).toBe('WAITING_FOR_PROVIDER')
      expect(h.complete).not.toHaveBeenCalled()
      expect(h.start).not.toHaveBeenCalled()
      const standard = await h.ipc['compilation.preview']({
        projectId: h.h.project.id,
        raw: 'Add a clear error message',
        mode: 'STANDARD',
      })
      expect(standard.status).toBe('READY')
      expect(h.complete).toHaveBeenCalledTimes(2)
      h.setReady(false)
      const busy = await h.ipc['director.invoke']({
        projectId: h.h.project.id,
        objective: 'Scope',
        level: 2,
      })
      expect(busy.state).toBe('WAITING_FOR_PROVIDER')
      expect(h.complete).toHaveBeenCalledTimes(2)
      h.setReady(true)
      h.approveTechnical()
      const technical = await h.ipc['director.invoke']({
        projectId: h.h.project.id,
        objective: 'Scope',
        level: 1,
      })
      expect(technical.state).toBe('COMPLETED')
      expect(h.start).toHaveBeenCalledTimes(1)
      expect(
        h.h.repos.intelligenceArtifacts
          .routingHistory(h.h.project.id, technical.id)
          .some((r) => r.provider === 'claude' && r.state === 'COMPLETED'),
      ).toBe(true)
    } finally {
      await h.close()
    }
  })
  it('recovers approved Claude routing only after authoritative evidence, keeping unknown/reset facts honest', async () => {
    const h = await harness()
    try {
      h.approveTechnical()
      h.usage.apply({ type: 'restore_wait', resetAt: null, limitType: 'test-window' })
      expect(
        (
          await h.ipc['director.invoke']({
            projectId: h.h.project.id,
            objective: 'Scope',
            level: 1,
          })
        ).state,
      ).toBe('WAITING_FOR_PROVIDER')
      expect(h.start).not.toHaveBeenCalled()
      // Optimistic wait cleanup is not a provider capacity observation.
      h.usage.apply({ type: 'wait_ended' })
      expect(
        (
          await h.ipc['director.invoke']({
            projectId: h.h.project.id,
            objective: 'Scope',
            level: 1,
          })
        ).state,
      ).toBe('WAITING_FOR_PROVIDER')
      h.usage.apply({ type: 'restore_wait', resetAt: null, limitType: 'test-window' })
      h.usage.apply({ type: 'probe_result', outcome: 'available', resetAt: null })
      const recovered = await h.ipc['director.invoke']({
        projectId: h.h.project.id,
        objective: 'Scope',
        level: 1,
      })
      expect(recovered.state).toBe('COMPLETED')
      expect(h.start).toHaveBeenCalledTimes(1)
      const rows = h.h.db
        .prepare("SELECT body FROM capacity_checkpoints WHERE id LIKE 'runtime-capacity:%'")
        .all() as { body: string }[]
      expect(JSON.parse(rows[0]!.body)).toMatchObject({
        state: 'AVAILABLE',
        scope: 'UNKNOWN',
        utilization: { value: null },
        resetAt: { value: null },
      })
    } finally {
      await h.close()
    }
  })
})
