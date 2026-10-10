import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentRole } from '@shared/domain'
import type { CapacityPool, CapacityRoutingRecord, IntelligenceRole, ProviderCapacityLease, ProviderUsageReceipt, RoutingCandidate } from '@shared/capacity'
import { READ_ONLY_ROLES, routeSession, unusableReason, type ProviderId } from '@shared/provider'
import type { AgentEvent, AgentSessionHandle, SessionSpec, UsageInfo } from '../agent-runtime/types'
import { AsyncQueue } from '../agent-runtime/async-queue'
import type { Repositories } from '../persistence'
import type { ProviderService, AdmittedSessionProvider } from '../providers/service'
import type { UsageIntelligenceService } from '../usage/service'
import { CapacityAwareProviderRouter, CapacityRoutingWaitError } from './router'
import { RuntimeCapacityPools } from './runtime-pools'
import { ProviderQualityRegistry } from './quality'
import { DISPATCH_POLICY, hostedSessionPool, sessionReservePolicy } from './reserves'

const Wait = z.object({
  runId: z.string(), projectId: z.string(), agentId: z.string(), routingId: z.string(),
  role: z.string(), label: z.string().nullable(), model: z.string(), resumeSessionId: z.string().nullable(),
  state: z.enum(['WAITING_FOR_CAPACITY', 'RESUMED', 'ENDED']), createdAt: z.string(),
}).strict()
type WorkerWait = z.infer<typeof Wait>
const reviewRoles = new Set<AgentRole>(['reviewer', 'security_reviewer', 'verifier'])
const roleOf = (role: AgentRole): IntelligenceRole => reviewRoles.has(role) ? 'reviewer' : 'worker'

/** The production worker front door. No wait starts a runtime or spends a model request. */
export class WorkerCapacityRouting {
  private readonly kernel: CapacityAwareProviderRouter
  private readonly pools: RuntimeCapacityPools
  private readonly quality: ProviderQualityRegistry
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Set<Promise<void>>()
  private readonly quarantined = new Map<AgentSessionHandle, ProviderCapacityLease[]>()
  /** Leases of sessions that never started and whose release could not be written; tried again on recovery. */
  private unreleased: ProviderCapacityLease[][] = []
  private disposed = false
  private recovering: Promise<void> | null = null

  constructor(private readonly o: {
    repos: Repositories; providers: ProviderService; usage: UsageIntelligenceService;
    bootId: string; dataDir: string; maxAgents: () => number;
  }) {
    const store = o.repos.intelligenceArtifacts
    this.kernel = new CapacityAwareProviderRouter(store, o.bootId)
    this.pools = new RuntimeCapacityPools(store, o.dataDir)
    this.quality = new ProviderQualityRegistry(store)
    o.providers.setSessionAdmission((spec, dispatch) => this.start(spec, dispatch))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed(): void { for (const listener of this.listeners) listener() }

  private async snapshot(spec: Pick<SessionSpec, 'role' | 'label' | 'model' | 'resumeSessionId'>) {
    const policy = this.o.providers.policy()
    const owner = spec.resumeSessionId ? this.o.providers.sessionProvider(spec.resumeSessionId) : null
    const request = routeSession({ role: spec.role, label: spec.label ?? null, resumeProvider: owner }, policy, this.o.providers.list())
    const role = roleOf(spec.role)
    const candidates: RoutingCandidate[] = [], pools: CapacityPool[] = []
    const hostPool = hostedSessionPool(this.o.dataDir)
    pools.push(hostPool)
    // A provider session whose owner is missing is never resumed in a different runtime.
    const ids: ('claude' | 'codex')[] = spec.resumeSessionId
      ? owner === 'claude' || owner === 'codex' ? [owner] : []
      : request.requested === 'codex' ? ['codex', ...(policy.fallbackToClaude ? ['claude' as const] : [])]
        : request.requested === 'claude' ? ['claude', 'codex'] : []
    for (const provider of ids) {
      const runtime = this.o.providers.pinnedRuntime(provider)
      const status = this.o.providers.list().find((s) => s.id === provider)
      if (!runtime || !status) continue
      const model = provider === 'claude' ? spec.model ?? this.o.repos.settings.get().models.tiers.strongest
        : policy.models.codex ?? this.o.providers.defaultModel('codex')
      if (!model) continue
      // The provider the policy asks for in this role: Claude by default, another one where the user chose it
      // (cross-model review). It is the user's decision, not a substitution, and needs no evidence.
      const primary = provider === request.requested
      const account = await runtime.getAccountInfo({ subscriptionMode: this.o.repos.settings.get().claude.subscriptionMode }).catch(() => null)
      if (!account || account.state !== 'authenticated') continue
      // A provider that stands in for the requested one is admitted on quality evidence, and that evidence is
      // bound to an account profile: with no identity, or outside a subscription, there is nothing to bind it
      // to. The requested primary needs none: an account that reports no email, or an API key, still works.
      if (!primary && (account.mode !== 'subscription' || !account.email)) continue
      const profile = createHash('sha256').update(JSON.stringify([account.email, account.organization, account.mode])).digest('hex')
      let pool = this.pools.pool(provider, profile)
      if (provider === 'claude') {
        const observed = this.o.usage.capacityObservation()
        if (observed && observed.observedAt >= (pool.stateEvidence?.observedAt ?? 0))
          pool = this.pools.observe(pool, observed.state, observed)
        if (!this.o.usage.canDispatch()) {
          const machine = this.o.usage.machineState()
          if (pool.state !== machine.status) pool = this.pools.observe(pool, machine.status, { resetAt: machine.resetAt, utilization: machine.utilizationPercent })
        }
      }
      pools.push(pool)
      const evidence = primary ? [`PRIMARY_ROLE_POLICY:${DISPATCH_POLICY}:${profile}:${model}:${role}`]
        : this.quality.evidence({ provider, model, role, profile, policyVersion: DISPATCH_POLICY, runtimeVersion: status.version ?? 'unknown' })
      candidates.push({
        provider, model, roles: [role], poolIds: [pool.id, hostPool.id],
        available: !this.disposed && spec.model !== ''
          && unusableReason(provider, policy, status, spec.role) === null
          // Something must confine the agent: the NEXUS policy on every tool call, or the provider's own sandbox
          // (Codex, read-only roles). A provider with neither is never admitted.
          && (status.capabilities.toolAuthorization || status.capabilities.confinement === 'provider_sandbox')
          && (READ_ONLY_ROLES.includes(spec.role) || status.capabilities.writes)
          && (provider !== 'claude' || this.o.usage.canDispatch()),
        qualityApproved: evidence.length > 0, qualityEvidence: evidence, reserve: 'NONE', paid: false,
      })
    }
    return { candidates, pools, role, requested: request.requested, owner }
  }

  private saveWait(spec: SessionSpec, record: CapacityRoutingRecord): void {
    const runId = this.o.repos.agents.get(spec.agentId)?.runId
    if (!runId) return
    const key = `worker-capacity-wait:${spec.agentId}`
    const store = this.o.repos.intelligenceArtifacts, saved = store.readCheckpoint(key)
    const wait: WorkerWait = {
      runId, projectId: record.projectId, agentId: spec.agentId, routingId: record.id,
      role: spec.role, label: spec.label ?? null, model: spec.model ?? record.model ?? '',
      resumeSessionId: spec.resumeSessionId ?? null, state: 'WAITING_FOR_CAPACITY', createdAt: new Date().toISOString(),
    }
    if (!store.checkpoint(key, saved?.revision ?? null, Wait.parse(wait))) throw new Error('Worker capacity wait changed concurrently')
  }

  private start(spec: SessionSpec, dispatch: (selection: AdmittedSessionProvider) => AgentSessionHandle): AgentSessionHandle {
    const queue = new AsyncQueue<AgentEvent>()
    let inner: AgentSessionHandle | null = null, stopped = false, inputEnded = false, sent = false
    const messages: string[] = []
    let record: CapacityRoutingRecord | null = null, leases: ProviderCapacityLease[] = []
    let usage: UsageInfo[] = [], terminal = false, failed = false
    let terminalEvent: Extract<AgentEvent, { type: 'session.ended' }> | null = null
    const wait = (decision: CapacityRoutingRecord): void => {
      this.saveWait(spec, decision)
      queue.push({ type: 'capacity.wait', routingId: decision.id, provider: decision.provider, reasons: decision.reasons })
    }
    const work = (async () => {
      try {
        const agent = this.o.repos.agents.get(spec.agentId)
        const run = agent ? this.o.repos.runs.get(agent.runId) : null
        if (!run) throw new Error('Worker capacity admission requires an owning run')
        const snapshot = await this.snapshot(spec)
        if (stopped || this.disposed) return
        const reserve = sessionReservePolicy(snapshot.pools, this.o.maxAgents())
        record = this.kernel.decide({
          projectId: run.projectId, operationId: spec.agentId, stage: `WORKER:${spec.role}:${randomUUID()}`, ...snapshot,
          policy: reserve, coherentBoundary: !spec.resumeSessionId,
          ...(spec.resumeSessionId && snapshot.owner ? { activeSession: { provider: snapshot.owner as 'claude' | 'codex', model: spec.model ?? '' } } : {}),
        })
        if (record.action === 'WAIT') { wait(record); return }
        leases = this.kernel.claim(record, reserve)
        if (stopped || this.disposed) return
        this.kernel.dispatched(record)
        sent = true
        inner = dispatch({ provider: record.provider as ProviderId, requested: snapshot.requested, model: record.model!,
          reason: record.reasons.join('; '), fallbackReason: record.provider === snapshot.requested ? null : 'Quality-approved provider transition at a fresh session boundary.' })
        if (inputEnded) inner.end()
        for (const message of messages) inner.send(message)
        for await (const event of inner.events) {
          if (event.type === 'turn.completed') {
            usage = event.result.usage
            if (event.result.outcome !== 'success') failed = true
            if (event.result.outcome === 'quota' || event.result.outcome === 'auth') {
              const providerPool = snapshot.pools.find((p) => p.id === record!.poolIds[0])!
              this.pools.observe(providerPool, event.result.outcome === 'auth' ? 'AUTH_REQUIRED' : 'QUOTA_PAUSED')
              const paused: CapacityRoutingRecord = { ...record, action: 'WAIT', state: 'WAITING_FOR_CAPACITY', failure: 'CAPACITY', reasons: [...record.reasons, event.result.outcome === 'auth' ? 'PROVIDER_AUTH_REQUIRED' : 'PROVIDER_QUOTA_REJECTED'] }
              // The provider refused a request that was sent. The routing record says so, and the session's own
              // result carries the outcome: the run pauses for quota or authentication as it always has (the
              // banner, the reset time, the automatic resume, an overnight run's shutdown all hang on that
              // pause). A capacity wait is only for work that was never dispatched.
              this.o.repos.intelligenceArtifacts.saveRouting(paused)
              record = paused
            }
          } else if (event.type === 'rate_limit' && event.status === 'rejected') {
            const providerPool = snapshot.pools.find((p) => p.id === record!.poolIds[0])!
            this.pools.observe(providerPool, 'QUOTA_PAUSED', { resetAt: event.resetsAt === null ? null : event.resetsAt * 1000 })
          } else if (event.type === 'session.ended') {
            terminal = true
            failed ||= event.reason === 'crashed'
            terminalEvent = event
          }
          if (event.type !== 'session.ended') queue.push(event)
        }
      } catch (error) {
        if (error instanceof CapacityRoutingWaitError) { record = error.decision; wait(error.decision) }
        else {
          failed = true
          terminalEvent = { type: 'session.ended', reason: 'crashed', error: 'Provider capacity dispatch could not complete safely.' }
        }
      } finally {
        // With no handle nothing was started (the admission stopped before the dispatch, or the dispatch itself
        // threw: a missing command line tool): there is no session whose stop is still to be confirmed.
        let confirmed = inner === null
        if (inner) {
          try { await inner.stop(); confirmed = inner.stopConfirmed?.() ?? terminal } catch { confirmed = false }
        }
        if (leases.length) {
          // A failure to write the release must not take the session's end with it: the consumer still gets its
          // terminal event and the outcome is still recorded. The leases stay as they are and are looked at again.
          try {
            this.kernel.release(leases, !confirmed)
            if (!confirmed && inner) this.quarantined.set(inner, leases)
          } catch {
            if (inner) this.quarantined.set(inner, leases)
            else this.unreleased.push(leases)
          }
        }
        if (record && record.action === 'ROUTE') {
          const sum = (key: keyof UsageInfo) => usage.reduce((n, u) => n + (typeof u[key] === 'number' ? u[key] as number : 0), 0)
          const receipt: ProviderUsageReceipt | null = usage.length ? {
            models: [...new Set(usage.map((u) => u.model))], inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
            totalTokens: null, cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheCreationTokens'),
            reasoningTokens: usage.every((u) => u.thinkingTokens !== undefined) ? sum('thinkingTokens') : null,
          } : null
          this.kernel.outcome(record, terminal && !failed ? 'COMPLETED' : 'FAILED', confirmed ? (terminal && !failed ? null : 'PROVIDER') : 'STOP_UNCONFIRMED', receipt)
        }
        queue.push(terminalEvent ?? { type: 'session.ended', reason: 'stopped', error: null })
        queue.close(); this.changed()
      }
    })()
    this.pending.add(work)
    void work.catch(() => queue.close()).finally(() => this.pending.delete(work))
    return {
      agentId: spec.agentId, sessionId: () => inner?.sessionId() ?? null, events: queue,
      send: (text) => inner ? inner.send(text) : void messages.push(text),
      end: () => { inputEnded = true; inner?.end() }, interrupt: async () => { await inner?.interrupt() },
      stop: async () => { stopped = true; await inner?.stop(); await work },
      stopConfirmed: () => !sent || (inner?.stopConfirmed?.() ?? terminal),
    }
  }

  /** Reconcile stop evidence and wait at coherent run boundaries. Never replays Director/compiler calls. */
  async recover(resume: (runId: string) => Promise<unknown>): Promise<void> {
    if (this.recovering) return this.recovering
    this.recovering = this.recoverWaits(resume).finally(() => { this.recovering = null })
    return this.recovering
  }
  private async recoverWaits(resume: (runId: string) => Promise<unknown>): Promise<void> {
    for (const [handle, leases] of this.quarantined) {
      if (!handle.stopConfirmed?.()) continue
      // Held (the release was never written) or quarantined: either way the stop is now confirmed.
      try { this.kernel.settle(leases); this.quarantined.delete(handle); this.changed() } catch { /* looked at again on the next pass */ }
    }
    this.unreleased = this.unreleased.filter((leases) => {
      try { this.kernel.settle(leases); this.changed(); return false } catch { return true }
    })
    const store = this.o.repos.intelligenceArtifacts
    for (const run of this.o.repos.runs.listActive()) {
      if (this.disposed || run.state !== 'paused' || run.pauseReason !== 'capacity') continue
      const waiting = this.o.repos.agents.listByRun(run.id).flatMap((agent) => {
        const saved = store.readCheckpoint(`worker-capacity-wait:${agent.id}`)
        if (!saved) return []
        const wait = Wait.parse(saved.body)
        return wait.state === 'WAITING_FOR_CAPACITY' ? [{ wait, revision: saved.revision }] : []
      })
      if (!waiting.length) continue
      let ready = true
      for (const { wait } of waiting) {
        const snapshot = await this.snapshot({ role: wait.role as AgentRole, label: wait.label ?? undefined, model: wait.model, resumeSessionId: wait.resumeSessionId ?? undefined })
        const decision = this.kernel.assess({ ...snapshot, policy: sessionReservePolicy(snapshot.pools, this.o.maxAgents()), coherentBoundary: !wait.resumeSessionId, allowPaid: false,
          ...(wait.resumeSessionId && snapshot.owner ? { activeSession: { provider: snapshot.owner as 'claude' | 'codex', model: wait.model } } : {}) })
        if (decision.action !== 'ROUTE') { ready = false; break }
      }
      if (!ready || this.o.repos.agents.listByRun(run.id).some((a) => a.state === 'starting' || a.state === 'working')) continue
      await resume(run.id)
      for (const { wait, revision } of waiting)
        if (!store.checkpoint(`worker-capacity-wait:${wait.agentId}`, revision, { ...wait, state: 'RESUMED' })) throw new Error('Capacity wait changed during resume')
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.pending, ...(this.recovering ? [this.recovering] : [])])
    this.listeners.clear()
  }
  closeAdmission(): void { this.disposed = true }
}
