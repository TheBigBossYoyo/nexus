import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeAgentRuntime, defaultFakeAuthStatus, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import type { AgentEvent, SessionSpec } from '@main/modules/agent-runtime/types'
import { FakeRuntimeProvider } from '@main/modules/providers/providers'
import { ProviderService } from '@main/modules/providers/service'
import { PAUSE_RETRY_MS, WorkerCapacityRouting } from '@main/modules/capacity/worker-routing'
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
      // A session whose provider is not on record cannot be resumed anywhere, now or later: it fails (the task can
      // start afresh) and is not left as a wait that nothing would ever end. No provider is started for it.
      const refused = await collect(h.providers.router.startSession(unknown))
      expect(refused.some((e) => e.type === 'capacity.wait')).toBe(false)
      expect(refused.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' })
      expect(h.codexStart).toHaveBeenCalledTimes(1)
    } finally { await h.close() }
  })

  // Finding 3.6: the request of an earlier start whose process had not exited yet at boot stayed quarantined
  // until the next restart, and with it the provider's only slot.
  it('a ChatGPT request of an earlier start is released once its process is gone, or its process id is ours', () => {
    const h = graphHarness()
    try {
      const store = h.repos.intelligenceArtifacts
      const lease = (id: string, pid: number) => ({ id, bootId: 'old-boot', state: 'QUARANTINED', owner: { kind: 'PROCESS_HTTP', pid } })
      store.checkpoint('capacity-leases:chatgpt-registration:x', null, { leases: [lease('l1', 7001), lease('l2', 7002), { ...lease('l3', 7003), bootId: 'new-boot' }] })
      const states = (): string[] => (store.readCheckpoint('capacity-leases:chatgpt-registration:x')!.body as { leases: { state: string }[] }).leases.map((l) => l.state)
      const reclaim = (stopped: number[], currentPid?: number): number =>
        store.reclaimHostedLeases({ currentBootId: 'new-boot', isProcessStopped: (pid) => stopped.includes(pid), childPids: () => [], settleMs: 30_000, ...(currentPid !== undefined ? { currentPid } : {}) })
      expect(reclaim([])).toBe(0)
      expect(reclaim([7001])).toBe(1)
      expect(states()).toEqual(['INTERRUPTED', 'QUARANTINED', 'QUARANTINED'])
      // The id of the old process was given to this one: the old process cannot be running.
      expect(reclaim([], 7002)).toBe(1)
      expect(store.readCheckpoint('capacity-stop-confirmed:l2')?.body).toMatchObject({ source: 'OWNER_PROCESS_ID_REUSED', ownerPid: 7002 })
      // A lease of the current start is never touched, whatever its process id says.
      expect(reclaim([7003], 7003)).toBe(0)
      expect(states()).toEqual(['INTERRUPTED', 'INTERRUPTED', 'QUARANTINED'])
    } finally { h.close() }
  })

  // Finding 14.7: after a hard kill a worker of the earlier start may live a moment longer, in the worktree the
  // task is about to be resumed in. No session starts while one is alive, and the wait is bounded.
  it('no session starts while a worker of the earlier start is alive, and the wait for it is bounded', async () => {
    const h = await harness()
    const routings: WorkerCapacityRouting[] = []
    try {
      let alive = true
      routings.push(new WorkerCapacityRouting({ repos: h.h.repos, providers: h.providers, usage: h.usage, dataDir: 'worker-fixture', bootId: 'next-boot', maxAgents: () => 1, earlierStart: { pids: [4242], isProcessStopped: () => !alive, graceMs: 60_000 } }))
      const session = collect(h.providers.router.startSession(h.spec()))
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(h.start).not.toHaveBeenCalled()
      alive = false
      expect((await session).some((e) => e.type === 'session.started')).toBe(true)
      expect(h.start).toHaveBeenCalledTimes(1)
      // A process id that never goes away (it was given to something else) holds a session for the grace only.
      routings.push(new WorkerCapacityRouting({ repos: h.h.repos, providers: h.providers, usage: h.usage, dataDir: 'worker-fixture', bootId: 'third-boot', maxAgents: () => 1, earlierStart: { pids: [4242], isProcessStopped: () => false, graceMs: 300 } }))
      expect((await collect(h.providers.router.startSession(h.spec()))).some((e) => e.type === 'session.started')).toBe(true)
      expect(h.start).toHaveBeenCalledTimes(2)
    } finally { for (const r of routings) await r.dispose(); await h.close() }
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

  it('a provider with no probe of its own is tried again when its pause has run out, and not before', async () => {
    const h = await harness()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      h.providers.setPolicy({ ...h.providers.policy(), enabled: { ...h.providers.policy().enabled, codex: true } })
      new ProviderQualityRegistry(h.h.repos.intelligenceArtifacts).recordValidated({ provider: 'codex', model: 'fake-codex', role: 'worker', profile: h.profile, policyVersion: DISPATCH_POLICY, runtimeVersion: '0.0.0-fake' }, ['controlled-worker-role-comparison'], new Date().toISOString())
      h.usage.apply({ type: 'restore_wait', resetAt: null, limitType: 'five_hour' })
      // One rejection marked Codex's pool paused, with no reset time. Nothing else ever writes that pool.
      const pools = new RuntimeCapacityPools(h.h.repos.intelligenceArtifacts, 'worker-fixture')
      pools.observe(pools.pool('codex', h.profile), 'QUOTA_PAUSED')
      const waits = async (): Promise<boolean> => (await collect(h.providers.router.startSession(h.spec('researcher')))).some((e) => e.type === 'capacity.wait')
      expect(await waits()).toBe(true)
      vi.setSystemTime(Date.now() + PAUSE_RETRY_MS - 60_000)
      expect(await waits()).toBe(true)
      expect(h.codexStart).not.toHaveBeenCalled()
      // It used to wait for ever. After the retry interval the pool is unknown again, labelled as NEXUS's own reckoning.
      vi.setSystemTime(Date.now() + 2 * 60_000)
      const events = await collect(h.providers.router.startSession(h.spec('researcher')))
      expect(events.find((e) => e.type === 'session.started')).toMatchObject({ provider: 'codex' })
      expect(pools.pool('codex', h.profile)).toMatchObject({ state: 'USAGE_UNKNOWN', stateEvidence: { source: 'LOCAL', confidence: 'ESTIMATED' } })
      // A pause that names its reset time holds until then, however long.
      pools.observe(pools.pool('codex', h.profile), 'QUOTA_PAUSED', { resetAt: Date.now() + 3 * 60 * 60_000 })
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      expect(await waits()).toBe(true)
      vi.setSystemTime(Date.now() + 61 * 60_000)
      expect(await waits()).toBe(false)
    } finally {
      vi.useRealTimers()
      await h.close()
    }
  })

  it('recovery resumes one waiting run per pass, a run whose resume fails does not hold the others back, and a leftover wait is not read as waiting', async () => {
    let finish!: () => void
    const h = await harness(async (_spec, ctx) => { await new Promise<void>((resolve) => { finish = resolve }); await ctx.completeTurn({ text: 'done' }) })
    try {
      // The one worker slot is taken; two other runs each have a session that waits.
      const busy = collect(h.providers.router.startSession(h.spec()))
      await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1))
      const waitingRun = async (): Promise<{ runId: string; agentId: string }> => {
        const run = h.h.repos.runs.insert(makeRun(h.h.project.id, { state: 'executing' }))
        const agent = h.h.repos.agents.insert(makeAgent(run.id, null, { role: 'worker', state: 'stopped' }))
        const events = await collect(h.providers.router.startSession({ ...h.spec(), agentId: agent.id }))
        expect(events.some((e) => e.type === 'capacity.wait')).toBe(true)
        h.h.repos.runs.update(run.id, { state: 'paused', pauseReason: 'capacity', resumeState: 'executing' })
        return { runId: run.id, agentId: agent.id }
      }
      const a = await waitingRun()
      const b = await waitingRun()
      // A wait left over in run b from an earlier pause: its task has a newer agent, which is the one that waits.
      const store = h.h.repos.intelligenceArtifacts
      const stale = h.h.repos.agents.insert({ ...makeAgent(b.runId, null, { role: 'worker', state: 'stopped' }), createdAt: '2020-01-01T00:00:00.000Z' })
      store.checkpoint(`worker-capacity-wait:${stale.id}`, null, { runId: b.runId, projectId: h.h.project.id, agentId: stale.id, routingId: 'old', role: 'worker', label: null, model: 'fake-claude', resumeSessionId: 'gone-session', state: 'WAITING_FOR_CAPACITY', createdAt: '2020-01-01T00:00:00.000Z' })

      const resumed: string[] = []
      const resume = vi.fn(async (runId: string) => {
        resumed.push(runId)
        if (runId === a.runId) throw new Error('its admission is stale')
        h.h.repos.runs.update(runId, { state: 'executing', pauseReason: null, resumeState: null })
      })
      // The slot is still taken: nobody is resumed.
      await h.routing.recover(resume)
      expect(resumed).toEqual([])
      finish(); await busy

      // First pass: one run only, and it fails. It is remembered, not retried at once.
      await h.routing.recover(resume)
      expect(resumed).toEqual([a.runId])
      // The resume did not happen, so its wait is a wait again and the run is not forgotten.
      expect((store.readCheckpoint(`worker-capacity-wait:${a.agentId}`)!.body as { state: string }).state).toBe('WAITING_FOR_CAPACITY')
      // Second pass: the failing run is in its delay; the other one is resumed. The leftover wait did not stop it,
      // although its session could never be resumed, and it is closed.
      await h.routing.recover(resume)
      expect(resumed).toEqual([a.runId, b.runId])
      expect((store.readCheckpoint(`worker-capacity-wait:${stale.id}`)!.body as { state: string }).state).toBe('ENDED')
      expect((store.readCheckpoint(`worker-capacity-wait:${b.agentId}`)!.body as { state: string }).state).toBe('RESUMED')
      // Third pass, at once: nothing. The failed run waits out its delay instead of being resumed every pass.
      await h.routing.recover(resume)
      expect(resumed).toEqual([a.runId, b.runId])
    } finally { finish?.(); await h.close() }
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
