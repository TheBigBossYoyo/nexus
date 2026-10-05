import type { AuthStatus } from '@shared/auth'
import { newId } from '@shared/ids'
import {
  DEFAULT_PROVIDER_POLICY,
  enableBlocker,
  PRIMARY_PROVIDER,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  ProviderPolicySchema,
  routeSession,
  summarizePerformance,
  type ProviderId,
  type ProviderPolicy,
  type ProviderSession,
  type ProvidersOverview,
  type ProviderStatus,
  type ProviderUsage,
} from '@shared/provider'
import { NexusError } from '@shared/result'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import type { AgentEvent, AgentRuntime, AgentSessionHandle, RuntimeCapabilities, RuntimeUsageReport, SessionSpec } from '@main/modules/agent-runtime'
import type { AgentRuntimeProvider } from './types'

const POLICY_KEY = 'provider-policy'
/** After this many failed sessions in a row an optional provider is treated as unavailable until it is checked again. */
export const FAILURES_UNTIL_UNAVAILABLE = 3

export interface ProviderSessionStore {
  insert(session: ProviderSession): ProviderSession
  update(id: string, patch: Partial<ProviderSession>): void
  providerOfSession(sessionId: string): ProviderId | null
  listRecent(limit: number): ProviderSession[]
  listByRun(runId: string): ProviderSession[]
}

export interface ProviderServiceDeps {
  providers: AgentRuntimeProvider[]
  sessions: ProviderSessionStore
  settings: { getValue<T>(key: string): T | null; setValue(key: string, value: unknown): void }
  /** The run an agent belongs to, for the session record. */
  runOfAgent: (agentId: string) => string | null
  onChange?: () => void
  logger?: (line: string) => void
  now?: () => number
}

/** A session the policy refused: it ends at once with the reason, like a runtime that could not start. */
function refusedHandle(agentId: string, reason: string): AgentSessionHandle {
  const queue = new AsyncQueue<AgentEvent>()
  queue.push({ type: 'session.ended', reason: 'crashed', error: reason })
  queue.close()
  return { agentId, sessionId: () => null, events: queue, send: () => undefined, interrupt: async () => undefined, end: () => undefined, stop: async () => undefined }
}

/**
 * The providers NEXUS knows, what the user allows, and the router every session passes through. The router is
 * itself an `AgentRuntime`, so the orchestrator, the Arena and the program engine start sessions exactly as
 * before; which provider runs one is decided here, recorded, and visible.
 */
export class ProviderService {
  private readonly byId = new Map<ProviderId, AgentRuntimeProvider>()
  private statuses = new Map<ProviderId, ProviderStatus>()
  private readonly failures = new Map<ProviderId, { count: number; last: string }>()
  private refreshing: Promise<ProviderStatus[]> | null = null
  readonly router: AgentRuntime

  constructor(private readonly deps: ProviderServiceDeps) {
    for (const p of deps.providers) this.byId.set(p.id, p)
    if (!this.byId.has(PRIMARY_PROVIDER)) throw new Error('The Claude provider is required')
    this.router = this.createRouter()
  }

  private iso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  // ───────────────────────────── discovery ─────────────────────────────

  /** Detects every provider again. One provider failing to answer never fails the others. */
  refresh(): Promise<ProviderStatus[]> {
    this.refreshing ??= (async () => {
      try {
        const found = await Promise.all(
          [...this.byId.values()].map((p) =>
            p.discover().catch(
              (e: unknown): ProviderStatus => ({
                ...(this.statuses.get(p.id) ?? { id: p.id, displayName: PROVIDER_NAMES[p.id], required: p.id === PRIMARY_PROVIDER, installed: 'unknown', version: null, auth: 'unknown', authDetail: null, supported: false, supportDetail: null, models: [], capabilities: { sessions: false, resume: false, structuredOutput: 'none', toolAuthorization: false, nexusTools: false, mcp: false, usageReport: false, confinement: 'none', writes: false } }),
                health: 'unknown',
                healthDetail: `Detection failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
                checkedAt: this.iso(),
              }),
            ),
          ),
        )
        this.statuses = new Map(found.map((s) => [s.id, s]))
        // A fresh detection is a new start for a provider that had been failing.
        this.failures.clear()
        this.deps.onChange?.()
        return this.list()
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** The statuses as last detected, with what the sessions since then showed. */
  list(): ProviderStatus[] {
    return PROVIDER_IDS.flatMap((id) => {
      const status = this.statuses.get(id)
      if (!status) return []
      const failing = this.failures.get(id)
      if (!failing || id === PRIMARY_PROVIDER) return [status]
      return [{ ...status, health: failing.count >= FAILURES_UNTIL_UNAVAILABLE ? 'unavailable' : 'degraded', healthDetail: `${failing.count} failed session${failing.count === 1 ? '' : 's'} in a row. Last: ${failing.last}` } satisfies ProviderStatus]
    })
  }

  // ───────────────────────────── policy ─────────────────────────────

  policy(): ProviderPolicy {
    const stored = ProviderPolicySchema.safeParse(this.deps.settings.getValue<unknown>(POLICY_KEY))
    return stored.success ? stored.data : DEFAULT_PROVIDER_POLICY
  }

  /** Nothing is enabled that cannot work, and no use is switched on for a provider that is off. */
  setPolicy(input: unknown): ProviderPolicy {
    const parsed = ProviderPolicySchema.safeParse(input)
    if (!parsed.success) throw new NexusError('invalid_input', `Invalid provider policy: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const next = parsed.data
    const current = this.policy()
    for (const id of PROVIDER_IDS) {
      if (id === PRIMARY_PROVIDER || !next.enabled[id] || current.enabled[id]) continue
      const status = this.statuses.get(id)
      const blocker = status ? enableBlocker(status) : `${PROVIDER_NAMES[id]} was not detected.`
      if (blocker) throw new NexusError('invalid_state', blocker)
    }
    const uses: [boolean, ProviderId, string][] = [
      [next.crossModelReview.enabled, next.crossModelReview.reviewer, 'Cross-model review'],
      [next.heterogeneousSpeculation.enabled, next.heterogeneousSpeculation.secondCandidate, 'Heterogeneous speculation'],
    ]
    for (const [on, id, what] of uses) {
      if (!on) continue
      if (id === PRIMARY_PROVIDER) throw new NexusError('invalid_input', `${what} needs a provider other than Claude.`)
      if (!next.enabled[id]) throw new NexusError('invalid_state', `${what} uses ${PROVIDER_NAMES[id]}, which is not enabled.`)
    }
    const second = next.heterogeneousSpeculation
    if (second.enabled && !this.statuses.get(second.secondCandidate)?.capabilities.writes) {
      throw new NexusError('invalid_state', `${PROVIDER_NAMES[second.secondCandidate]} is read-only in NEXUS and cannot write a speculative candidate.`)
    }
    this.deps.settings.setValue(POLICY_KEY, next)
    this.deps.onChange?.()
    return next
  }

  // ───────────────────────────── health ─────────────────────────────

  /** One minimal real session with the provider. Explicit: it uses that provider's quota. */
  async probe(id: ProviderId): Promise<{ ok: boolean; detail: string; status: ProviderStatus | null }> {
    const provider = this.byId.get(id)
    if (!provider) throw new NexusError('not_found', `Unknown provider ${id}`)
    const status = this.statuses.get(id)
    if (!status || status.installed !== 'installed' || !status.supported) return { ok: false, detail: status?.supportDetail ?? `${PROVIDER_NAMES[id]} is not installed.`, status: status ?? null }
    const result = await provider.probe().catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
    if (result.ok) this.failures.delete(id)
    else if (id !== PRIMARY_PROVIDER) this.failures.set(id, { count: FAILURES_UNTIL_UNAVAILABLE, last: result.detail.slice(0, 300) })
    const current = this.statuses.get(id)
    if (current && result.ok) this.statuses.set(id, { ...current, health: 'healthy', healthDetail: result.detail, checkedAt: this.iso() })
    this.deps.onChange?.()
    return { ...result, status: this.list().find((s) => s.id === id) ?? null }
  }

  private noteOutcome(id: ProviderId, ok: boolean, detail: string): void {
    if (id === PRIMARY_PROVIDER) return
    if (ok) {
      this.failures.delete(id)
      const current = this.statuses.get(id)
      if (current && current.health !== 'healthy') this.statuses.set(id, { ...current, health: 'healthy', healthDetail: null })
    } else {
      this.failures.set(id, { count: (this.failures.get(id)?.count ?? 0) + 1, last: detail.slice(0, 300) })
    }
    this.deps.onChange?.()
  }

  // ───────────────────────────── read model ─────────────────────────────

  async overview(): Promise<ProvidersOverview> {
    if (this.statuses.size === 0) await this.refresh()
    const recent = this.deps.sessions.listRecent(200)
    const usage: ProviderUsage[] = await Promise.all(
      PROVIDER_IDS.map(async (id): Promise<ProviderUsage> => {
        const mine = recent.filter((s) => s.provider === id)
        const report: RuntimeUsageReport | null = this.statuses.get(id)?.capabilities.usageReport ? await (this.byId.get(id)?.usageReport().catch(() => null) ?? null) : null
        return {
          provider: id,
          observed: { sessions: mine.length, inputTokens: mine.reduce((n, s) => n + s.inputTokens, 0), outputTokens: mine.reduce((n, s) => n + s.outputTokens, 0) },
          windows: report?.windows ?? [],
          windowsSource: report ? 'runtime' : 'not_exposed',
        }
      }),
    )
    return { statuses: this.list(), policy: this.policy(), performance: summarizePerformance(recent), usage, recent: recent.slice(0, 50) }
  }

  sessionsOfRun(runId: string): ProviderSession[] {
    return this.deps.sessions.listByRun(runId)
  }

  // ───────────────────────────── the router ─────────────────────────────

  private createRouter(): AgentRuntime {
    const primary = (): AgentRuntime => {
      const runtime = this.byId.get(PRIMARY_PROVIDER)?.runtime()
      if (!runtime) throw new Error('The Claude runtime is missing')
      return runtime
    }
    const start = (spec: SessionSpec): AgentSessionHandle => {
      const policy = this.policy()
      const resumeProvider = spec.resumeSessionId ? this.deps.sessions.providerOfSession(spec.resumeSessionId) : null
      const decision = routeSession({ role: spec.role, label: spec.label ?? null, resumeProvider }, policy, this.list())
      const chosen = decision.provider
      const provider = chosen ? this.byId.get(chosen) : undefined
      const runtime = provider?.runtime() ?? null
      const status = chosen ? this.statuses.get(chosen) : undefined
      const model = chosen === PRIMARY_PROVIDER ? (spec.model ?? null) : chosen ? ((chosen === 'codex' ? policy.models.codex : chosen === 'gemini' ? policy.models.gemini : null) ?? provider?.defaultModel() ?? null) : null
      const record = this.deps.sessions.insert({
        id: newId(),
        runId: this.deps.runOfAgent(spec.agentId),
        agentId: spec.agentId,
        role: spec.role,
        label: spec.label ?? null,
        requested: decision.requested,
        provider: chosen ?? decision.requested,
        model,
        runtimeVersion: status?.version ?? null,
        authMode: status?.authDetail ?? null,
        reason: decision.reason,
        fallbackReason: decision.fallbackReason,
        sessionId: spec.resumeSessionId ?? null,
        outcome: chosen && runtime ? 'running' : 'refused',
        error: chosen && runtime ? null : (decision.fallbackReason ?? 'No runtime for the chosen provider.'),
        inputTokens: 0,
        outputTokens: 0,
        createdAt: this.iso(),
        endedAt: chosen && runtime ? null : this.iso(),
      })
      if (decision.fallbackReason) this.deps.logger?.(`provider: ${spec.role} ${spec.agentId}: ${decision.fallbackReason}`)
      if (!chosen || !runtime) return refusedHandle(spec.agentId, `Provider policy: ${record.error ?? 'refused'}`)
      // A Claude model name means nothing to another provider, and the reverse.
      const { model: _claudeModel, ...rest } = spec
      const routed: SessionSpec = chosen === PRIMARY_PROVIDER ? spec : { ...rest, ...(model ? { model } : {}) }
      let inner: AgentSessionHandle
      try {
        inner = runtime.startSession(routed)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        this.deps.sessions.update(record.id, { outcome: 'failed', error: message.slice(0, 600), endedAt: this.iso() })
        this.noteOutcome(chosen, false, message)
        return refusedHandle(spec.agentId, message)
      }
      return this.observe(inner, record, chosen)
    }
    return {
      startSession: start,
      resumeSession: (spec, sdkSessionId) => start({ ...spec, resumeSessionId: sdkSessionId }),
      sendMessage: (handle, text) => handle.send(text),
      interruptSession: (handle) => handle.interrupt(),
      stopSession: (handle) => handle.stop(),
      // The account, the models offered in the composer and the plan windows are Claude's, as before 0.6.
      getCapabilities: (): Promise<RuntimeCapabilities> => primary().getCapabilities(),
      getAccountInfo: (options): Promise<AuthStatus> => primary().getAccountInfo(options),
      getUsageReport: async (options) => (await primary().getUsageReport?.(options)) ?? null,
      shutdown: async () => {
        await Promise.allSettled([...this.byId.values()].map((p) => p.runtime()?.shutdown()))
      },
    }
  }

  /** Passes a session's events through and keeps its record: session id, tokens, how it ended. */
  private observe(inner: AgentSessionHandle, record: ProviderSession, provider: ProviderId): AgentSessionHandle {
    const sessions = this.deps.sessions
    const note = (ok: boolean, detail: string): void => this.noteOutcome(provider, ok, detail)
    const iso = (): string => this.iso()
    let input = 0
    let output = 0
    let failed: string | null = null
    let succeeded = false
    async function* tap(): AsyncGenerator<AgentEvent> {
      for await (const event of inner.events) {
        if (event.type === 'session.started') {
          sessions.update(record.id, { sessionId: event.sessionId, ...(provider === PRIMARY_PROVIDER ? { model: event.model } : {}) })
        } else if (event.type === 'turn.completed') {
          for (const u of event.result.usage) {
            input += u.inputTokens
            output += u.outputTokens
          }
          sessions.update(record.id, { inputTokens: input, outputTokens: output })
          if (event.result.outcome === 'success') succeeded = true
          else if (event.result.outcome === 'error' || event.result.outcome === 'structured_output_failed') failed = event.result.errors[0] ?? event.result.outcome
        } else if (event.type === 'session.ended') {
          const crashed = event.reason === 'crashed'
          const error = crashed ? (event.error ?? 'The session crashed.') : failed
          sessions.update(record.id, { outcome: error && !succeeded ? 'failed' : crashed ? 'failed' : 'completed', error: error ? error.slice(0, 600) : null, endedAt: iso() })
          // A stopped session says nothing about the provider.
          if (event.reason !== 'stopped') note(!error || (succeeded && !crashed), error ?? '')
        }
        yield event
      }
    }
    return {
      agentId: inner.agentId,
      sessionId: () => inner.sessionId(),
      events: tap(),
      send: (text) => inner.send(text),
      interrupt: () => inner.interrupt(),
      end: () => inner.end(),
      stop: () => inner.stop(),
    }
  }
}
