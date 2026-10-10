import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeAgentRuntime, defaultFakeAuthStatus, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import type { AgentEvent, SessionSpec } from '@main/modules/agent-runtime/types'
import { FakeRuntimeProvider } from '@main/modules/providers/providers'
import { ProviderService } from '@main/modules/providers/service'
import { WorkerCapacityRouting } from '@main/modules/capacity/worker-routing'
import { CapacityAwareProviderRouter } from '@main/modules/capacity/router'
import { ProviderQualityRegistry } from '@main/modules/capacity/quality'
import { RuntimeCapacityPools } from '@main/modules/capacity/runtime-pools'
import { DISPATCH_POLICY, hostedSessionPool, sessionReservePolicy } from '@main/modules/capacity/reserves'
import { UsageIntelligenceService } from '@main/modules/usage/service'
import { EventBus } from '@main/modules/events'
import { makeAgent, makeRun } from '../persistence/fixtures'
import { graphHarness } from '../../helpers/context-graph'

async function harness(script?: FakeScript, max = 1, account: Partial<ReturnType<typeof defaultFakeAuthStatus>> = {}) {
  const h = graphHarness(), run = h.repos.runs.insert(makeRun(h.project.id, { state: 'executing' }))
  const auth = { ...defaultFakeAuthStatus(), email: 'worker-fixture@example.invalid', ...account }
  const claude = new FakeAgentRuntime({ authStatus: auth, script: script ?? (async (_spec, ctx) => { await ctx.completeTurn({ text: 'done' }) }) })
  const codex = new FakeAgentRuntime({ authStatus: auth, script: async (_spec, ctx) => { await ctx.completeTurn({ text: 'codex done' }) } })
  const start = vi.spyOn(claude, 'startSession'), codexStart = vi.spyOn(codex, 'startSession')
  const providers = new ProviderService({ providers: [new FakeRuntimeProvider('claude', claude), new FakeRuntimeProvider('codex', codex, {}, 'fake-codex')],
    sessions: h.repos.providerSessions, settings: h.repos.settings, runOfAgent: (id) => h.repos.agents.get(id)?.runId ?? null })
  await providers.refresh()
  const bus = new EventBus(h.repos.events, h.repos.transaction)
  const usage = new UsageIntelligenceService({ repos: h.repos, bus, runtime: claude, push: () => {} })
  const routing = new WorkerCapacityRouting({ repos: h.repos, providers, usage, dataDir: 'worker-fixture', bootId: 'worker-boot', maxAgents: () => max })
  const spec = (role: SessionSpec['role'] = 'worker', over: Partial<SessionSpec> = {}): SessionSpec => {
    const agent = h.repos.agents.insert(makeAgent(run.id, null, { role }))
    return { agentId: agent.id, role, model: 'fake-claude', cwd: h.project.rootPath, prompt: 'Perform the admitted task', systemPromptAppend: 'Worker policy',
      maxTurns: 1, tools: [], authorize: async () => ({ behavior: 'deny', reason: 'fixture' }), requestApproval: async () => false,
      subscriptionMode: true, loadProjectSettings: false, ...over }
  }
  const profile = createHash('sha256').update(JSON.stringify([auth.email, auth.organization, auth.mode])).digest('hex')
  const close = async () => { await claude.shutdown(); await codex.shutdown(); await routing.dispose(); usage.dispose(); h.close() }
  return { h, run, providers, usage, routing, spec, start, codexStart, profile, close }
}
async function collect(handle: ReturnType<ProviderService['router']['startSession']>) {
  const events: AgentEvent[] = []
  for await (const event of handle.events) { events.push(event); if (event.type === 'turn.completed') handle.end() }
  return events
}

describe('production worker capacity admission', () => {
  it('counts real worker occupancy alongside advisory claims, waits without dispatch, then releases for coherent recovery', async () => {
    let finish!: () => void
    const h = await harness(async (_spec, ctx) => { await new Promise<void>((resolve) => { finish = resolve }); await ctx.completeTurn({ text: 'done' }) })
    try {
      const firstSpec = h.spec(), first = collect(h.providers.router.startSession(firstSpec))
      await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1))
      const secondSpec = h.spec(), events = await collect(h.providers.router.startSession(secondSpec))
      expect(events.some((e) => e.type === 'capacity.wait')).toBe(true)
      expect(h.start).toHaveBeenCalledTimes(1)
      const store = h.h.repos.intelligenceArtifacts
      expect(store.routingHistory(h.h.project.id, secondSpec.agentId)[0]).toMatchObject({ state: 'WAITING_FOR_CAPACITY', consumption: 'NOT_SENT' })
      const host = hostedSessionPool('worker-fixture'), providerPool = new RuntimeCapacityPools(store, 'worker-fixture').pool('claude', h.profile)
      const kernel = new CapacityAwareProviderRouter(store, 'worker-boot'), policy = sessionReservePolicy([providerPool, host], 1)
      const advice = kernel.decide({ projectId: h.h.project.id, operationId: 'advice', stage: 'technical', role: 'technical', pools: [providerPool, host], policy, coherentBoundary: true,
        candidates: [{ provider: 'claude', model: 'fake-claude', roles: ['technical'], poolIds: [providerPool.id, host.id], available: true, qualityApproved: true, qualityEvidence: ['fixture'], reserve: 'NONE', paid: false }] })
      const leases = kernel.claim(advice, policy)
      expect(store.readCheckpoint(`capacity-leases:${host.id}`)?.body).toMatchObject({ leases: expect.arrayContaining([expect.objectContaining({ role: 'worker', state: 'HELD' }), expect.objectContaining({ role: 'technical', state: 'HELD' })]) })
      h.h.repos.runs.update(h.run.id, { state: 'paused', pauseReason: 'capacity', resumeState: 'executing' })
      const resume = vi.fn(async () => {})
      await h.routing.recover(resume)
      expect(resume).not.toHaveBeenCalled()
      finish(); await first; kernel.release(leases)
      await Promise.all([h.routing.recover(resume), h.routing.recover(resume)])
      expect(resume).toHaveBeenCalledTimes(1)
    } finally { finish?.(); await h.close() }
  })

  it('permits only profile/model/role-approved Codex fallback and never resumes an unknown foreign session', async () => {
    const h = await harness()
    try {
      h.providers.setPolicy({ ...h.providers.policy(), enabled: { ...h.providers.policy().enabled, codex: true } })
      // Claude is limited: an open wait, as a rejected session leaves it. (A probe result alone is ignored while available.)
      h.usage.apply({ type: 'restore_wait', resetAt: null, limitType: 'five_hour' })
      expect(h.usage.canDispatch()).toBe(false)
      const denied = h.spec('researcher')
      expect((await collect(h.providers.router.startSession(denied))).some((e) => e.type === 'capacity.wait')).toBe(true)
      expect(h.codexStart).not.toHaveBeenCalled()
      new ProviderQualityRegistry(h.h.repos.intelligenceArtifacts).recordValidated({ provider: 'codex', model: 'fake-codex', role: 'worker', profile: h.profile, policyVersion: DISPATCH_POLICY, runtimeVersion: '0.0.0-fake' }, ['controlled-worker-role-comparison'], new Date().toISOString())
      const admitted = h.spec('researcher')
      const routed = await collect(h.providers.router.startSession(admitted))
      expect(routed.find((e) => e.type === 'session.started')).toMatchObject({ provider: 'codex', model: 'fake-codex' })
      expect(h.start).not.toHaveBeenCalled()
      const unknown = h.spec('researcher', { resumeSessionId: 'unowned-sdk-session' })
      expect((await collect(h.providers.router.startSession(unknown))).some((e) => e.type === 'capacity.wait')).toBe(true)
      expect(h.codexStart).toHaveBeenCalledTimes(1)
    } finally { await h.close() }
  })

  it('after a crash the slots of its sessions stay taken until their processes are proven gone, and are then free again', async () => {
    const waiters: (() => void)[] = []
    const h = await harness(async (_spec, ctx) => { await new Promise<void>((resolve) => { waiters.push(resolve) }); await ctx.completeTurn({ text: 'done' }) })
    let restarted: WorkerCapacityRouting | null = null
    const open: Promise<unknown>[] = []
    try {
      open.push(collect(h.providers.router.startSession(h.spec())))
      await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1))
      const store = h.h.repos.intelligenceArtifacts
      // The runtime dies with a worker session running. Its next start finds the leases held and quarantines them.
      store.reconcileInterrupted(() => true)
      restarted = new WorkerCapacityRouting({ repos: h.h.repos, providers: h.providers, usage: h.usage, dataDir: 'worker-fixture', bootId: 'boot-after-crash', maxAgents: () => 1 })
      const waits = async (): Promise<boolean> => (await collect(h.providers.router.startSession(h.spec()))).some((e) => e.type === 'capacity.wait')
      const reclaim = (isProcessStopped: (pid: number) => boolean, now: number): number =>
        store.reclaimHostedLeases({ currentBootId: 'boot-after-crash', isProcessStopped, childPids: () => [4242], settleMs: 30_000, now })
      const t0 = Date.now()

      // Nothing proves the old session stopped: its slot is not given away.
      expect(await waits()).toBe(true)
      expect(reclaim(() => false, t0)).toBe(0)
      // The old runtime is gone but one of its workers is not.
      expect(reclaim((pid) => pid !== 4242, t0 + 60_000)).toBe(0)
      // Everything is gone, but only just: a process that lost its parent is given time to end.
      expect(reclaim(() => true, t0 + 61_000)).toBe(0)
      expect(await waits()).toBe(true)
      expect(h.start).toHaveBeenCalledTimes(1)

      // Proven gone and settled: the provider lease and the local slot are both ended, with the evidence saved.
      expect(reclaim(() => true, t0 + 31_000 + 60_000)).toBe(2)
      const host = hostedSessionPool('worker-fixture')
      const lease = (store.readCheckpoint(`capacity-leases:${host.id}`)!.body as { leases: { id: string; state: string }[] }).leases[0]!
      expect(lease.state).toBe('INTERRUPTED')
      expect(store.readCheckpoint(`capacity-stop-confirmed:${lease.id}`)?.body).toMatchObject({ source: 'OWNER_PROCESS_EXITED', bootId: 'worker-boot', childPids: [4242] })
      expect(reclaim(() => true, t0 + 200_000)).toBe(0)

      // Work is admitted again.
      open.push(collect(h.providers.router.startSession(h.spec())))
      await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2))
      // A lease of the current start is never reclaimed this way, whatever the process check says.
      expect(reclaim(() => true, t0 + 900_000)).toBe(0)
    } finally {
      for (const done of waiters) done()
      await Promise.allSettled(open)
      await restarted?.dispose()
      await h.close()
    }
  })

  it('admits the requested primary whatever its account says about itself: no email, or an API key instead of a subscription', async () => {
    for (const account of [{ email: null }, { email: null, mode: 'api_key' as const }]) {
      const h = await harness(undefined, 1, account)
      try {
        const events = await collect(h.providers.router.startSession(h.spec()))
        expect(events.some((e) => e.type === 'capacity.wait'), JSON.stringify(account)).toBe(false)
        expect(events.find((e) => e.type === 'session.started')).toMatchObject({ provider: 'claude' })
        // A stand-in is admitted on evidence bound to an account profile: with no identity there is none, so it waits.
        h.providers.setPolicy({ ...h.providers.policy(), enabled: { ...h.providers.policy().enabled, codex: true } })
        h.usage.apply({ type: 'restore_wait', resetAt: null, limitType: 'five_hour' })
        expect((await collect(h.providers.router.startSession(h.spec('researcher')))).some((e) => e.type === 'capacity.wait')).toBe(true)
        expect(h.codexStart).not.toHaveBeenCalled()
      } finally { await h.close() }
    }
  })

  it('a dispatch that cannot start leaves no capacity behind: after many failures work is still admitted', async () => {
    const h = await harness()
    try {
      // The provider binding cannot be written, so the dispatch throws after the capacity was claimed. One worker slot exists.
      const insert = vi.spyOn(h.h.repos.providerSessions, 'insert')
      for (let i = 0; i < 4; i++) {
        insert.mockImplementationOnce(() => { throw new Error('controlled binding failure') })
        const events = await collect(h.providers.router.startSession(h.spec()))
        expect(events.some((e) => e.type === 'session.ended' && e.reason === 'crashed'), `failure ${i}`).toBe(true)
        expect(events.some((e) => e.type === 'capacity.wait'), `failure ${i} must not be a wait`).toBe(false)
      }
      expect(h.start).not.toHaveBeenCalled()
      const store = h.h.repos.intelligenceArtifacts
      const host = hostedSessionPool('worker-fixture')
      const held = (store.readCheckpoint(`capacity-leases:${host.id}`)?.body as { leases: { state: string }[] } | undefined)?.leases.filter((l) => l.state === 'HELD' || l.state === 'QUARANTINED') ?? []
      expect(held).toEqual([])
      const ok = await collect(h.providers.router.startSession(h.spec()))
      expect(ok.find((e) => e.type === 'session.started')).toMatchObject({ provider: 'claude' })
    } finally { await h.close() }
  })

  it('does not spend when durable admission cannot be written', async () => {
    const h = await harness()
    try {
      const spec = h.spec()
      vi.spyOn(h.h.repos.intelligenceArtifacts, 'saveRouting').mockImplementationOnce(() => { throw new Error('controlled persistence failure') })
      expect((await collect(h.providers.router.startSession(spec))).some((e) => e.type === 'session.ended' && e.reason === 'crashed')).toBe(true)
      expect(h.start).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
