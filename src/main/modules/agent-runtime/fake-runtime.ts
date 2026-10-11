import type { AgentRole } from '@shared/domain'
import type { AuthStatus, ModelOption } from '@shared/auth'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { AsyncQueue } from './async-queue'
import type {
  AgentEvent,
  AgentRuntime,
  AgentSessionHandle,
  NexusToolHandlers,
  RuntimeCapabilities,
  SessionSpec,
  ToolDecision,
  RuntimeUsageReport,
  TurnOutcome,
  UsageInfo,
} from './types'
import { USAGE_PROBE_PROMPT } from './types'

export interface FakeSessionContext {
  readonly spec: SessionSpec
  /** Fires on interrupt() and stop(). After an interrupt the getter returns a fresh, un-aborted signal. */
  readonly signal: AbortSignal
  readonly nexusTools: NexusToolHandlers | undefined
  emitText(text: string): Promise<void>
  /**
   * Runs the same policy path as the real runtime (authorize, then requestApproval for `ask`) and emits
   * tool.started / tool.denied / tool.completed. Resolves true when the tool was allowed and ran.
   */
  useTool(toolName: string, input: Record<string, unknown>, run?: () => Promise<string>): Promise<boolean>
  completeTurn(result: { text: string; structuredOutput?: unknown; outcome?: TurnOutcome }): Promise<void>
  /** Resolves with the next send() message, or null once end() or stop() was called. */
  nextMessage(): Promise<string | null>
  /** Simulates a crash: the session ends with reason 'crashed'. Always throws. */
  fail(error: Error | string): never
  rateLimit(info?: {
    status?: 'allowed' | 'allowed_warning' | 'rejected'
    /** Epoch seconds, as the SDK reports it. */
    resetsAt?: number | null
    limitType?: string | null
    utilization?: number | null
    /** Emit only the one event. By default a rejection reproduces the real SDK: the event with the reset, then an error signal without one. */
    single?: boolean
  }): Promise<void>
  /** The runtime's simulated account availability (shared by every session of this runtime). */
  readonly usage: FakeUsageSim
  /** Waits `ms`, or until the signal aborts. */
  sleep(ms: number): Promise<void>
  /** Emits any runtime event as it is (a compaction, a context breakdown, a request's usage). */
  emitEvent(event: AgentEvent): Promise<void>
}

export type FakeScript = (spec: SessionSpec, ctx: FakeSessionContext) => Promise<void>

export interface FakeRuntimeOptions {
  script: FakeScript
  /** Artificial delay before every emitted event. Default 0. */
  delayMs?: number
  authStatus?: AuthStatus | ((options: { subscriptionMode: boolean }) => AuthStatus)
  models?: ModelOption[]
  /** Shared with scripts through `ctx.usage`; created when omitted. */
  usage?: FakeUsageSim
  /** When given, every turn reports per-request usage (and a context breakdown when the session asks for one) from this model of the cache. */
  cache?: FakeCacheSim
}

export function defaultFakeAuthStatus(): AuthStatus {
  return {
    state: 'authenticated',
    mode: 'subscription',
    subscriptionType: 'max',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
    email: null,
    organization: null,
    apiKeyEnvDetected: false,
    apiKeyEnvStripped: false,
    claudeCodeVersion: 'fake',
    warnings: [],
    error: null,
    checkedAt: nowIso(),
  }
}

/** Picks a script by session role; roles without an entry use `fallback` (default: complete with "done"). */
export function scriptsByRole(
  byRole: Partial<Record<AgentRole, FakeScript>>,
  fallback: FakeScript = completeWith({ text: 'done' }),
): FakeScript {
  return (spec, ctx) => (byRole[spec.role] ?? fallback)(spec, ctx)
}

/** The v0.2 session purposes a script cannot tell apart by role alone, read from the role policy text NEXUS appends. */
export type FakeSessionPurpose = 'critique' | 'synthesize' | 'arbitrate'

export function specPurpose(spec: Pick<SessionSpec, 'systemPromptAppend'>): FakeSessionPurpose | null {
  const text = spec.systemPromptAppend
  if (text.includes('Purpose: PLAN CRITIQUE')) return 'critique'
  if (text.includes('Purpose: PLAN SYNTHESIS')) return 'synthesize'
  if (text.includes('Purpose: FINDING ARBITRATION')) return 'arbitrate'
  return null
}

/** A script that emits the text and completes one turn. */
export function completeWith(result: { text: string; structuredOutput?: unknown; outcome?: TurnOutcome }): FakeScript {
  return async (_spec, ctx) => {
    await ctx.emitText(result.text)
    await ctx.completeTurn(result)
  }
}

class FakeCrash extends Error {}

export interface FakeUsageState {
  /** False: sessions end with a rate-limit rejection and a quota outcome. */
  available: boolean
  /** ISO reset time of the limit; null = the runtime gives none. When it passes the account becomes available. */
  resetAt: string | null
  /** False: getUsageReport answers null (probes then fall back to one minimal session). */
  reportSupported: boolean
  authFailure: boolean
  runtimeFailure: boolean
  /** Reported by the usage report while available. Null = the report carries no percentage. */
  utilizationPercent: number | null
}

/**
 * Controllable account state of the fake runtime (the brief's "FakeUsageRuntime"): available, quota
 * exhausted with an exact or unknown reset, a reset that arrives, probes that fail, auth and runtime
 * failure. Every availability check (usage report or probe session) is counted in `probes`.
 */
/**
 * A model of the runtime's prompt cache, for tests. It follows what the real runtime was observed to do
 * (docs/acceptance/cache-acceptance-*.json) and nothing else: a prefix is the model, the tool names and the
 * system text; the working directory is not part of it; a session's first request reads the prefix when an
 * identical one was used within the lifetime, and writes it otherwise; later requests read what the session
 * itself wrote. The token sizes are invented and fixed. It proves how NEXUS handles what a runtime reports,
 * never what Claude does.
 */
export class FakeCacheSim {
  /** Tokens of the simulated runtime system prompt and built-in tool definitions. */
  static readonly BASE_PREFIX = 6_000
  private readonly seen = new Map<string, number>()
  private readonly perSession = new Map<string, { requests: number; history: number }>()
  /** What every session asked for, in order: the options each runtime adapter would have applied. */
  readonly requested: { agentId: string; stablePrefix: boolean; alwaysLoadNexusTools: boolean; contextUsageDetail: string }[] = []
  now = 0
  lifetimeMs = 5 * 60_000

  key(spec: SessionSpec): string {
    return JSON.stringify([spec.model ?? 'fake-model', [...spec.tools].sort(), spec.systemPromptAppend, spec.nexusTools ? Object.keys(spec.nexusTools).sort() : [], spec.contextOptions?.stablePrefix === true])
  }

  prefixTokens(spec: SessionSpec): number {
    const nexus = spec.nexusTools ? Object.keys(spec.nexusTools).length : 0
    // Deferred tool definitions are outside the window; loaded ones are in it.
    void nexus
    return FakeCacheSim.BASE_PREFIX + Math.ceil(spec.systemPromptAppend.length / 4) + spec.tools.length * 150
  }

  /** The usage of the next request of a session. `added` is what the conversation grew by since the last request. */
  request(sessionId: string, spec: SessionSpec, added: number): { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
    const prefix = this.prefixTokens(spec)
    const state = this.perSession.get(sessionId) ?? { requests: 0, history: 0 }
    const first = state.requests === 0
    const key = this.key(spec)
    const last = this.seen.get(key)
    const warm = last !== undefined && this.now - last <= this.lifetimeMs
    // Uncached input stays what the scripted runtime always reported (1,000 per turn), so figures that predate the cache model do not move.
    const usage = first
      ? { inputTokens: 1000, cacheReadTokens: warm ? prefix : 0, cacheCreationTokens: (warm ? 0 : prefix) + added }
      : { inputTokens: 1000, cacheReadTokens: prefix + state.history, cacheCreationTokens: added }
    this.seen.set(key, this.now)
    this.perSession.set(sessionId, { requests: state.requests + 1, history: state.history + added })
    return usage
  }

  contextTokens(sessionId: string, spec: SessionSpec): number {
    return this.prefixTokens(spec) + (this.perSession.get(sessionId)?.history ?? 0)
  }
}

export class FakeUsageSim {
  state: FakeUsageState = {
    available: true,
    resetAt: null,
    reportSupported: true,
    authFailure: false,
    runtimeFailure: false,
    utilizationPercent: null,
  }
  /** Clock used for resetAt. Tests with a manual clock replace it. */
  now: () => number = () => Date.now()
  /** The next N availability checks answer "still limited" even if the reset time has passed. */
  probeFailures = 0
  probes = 0
  /** Availability checks that answered available. */
  probeSuccesses = 0

  set(patch: Partial<FakeUsageState>): void {
    this.state = { ...this.state, ...patch }
  }

  /** Exhaust the quota. `resetAt` as ISO, epoch ms, or null/undefined for an unknown reset. */
  limit(resetAt?: string | number | null): void {
    const iso = resetAt === null || resetAt === undefined ? null : typeof resetAt === 'number' ? new Date(resetAt).toISOString() : resetAt
    this.state = { ...this.state, available: false, resetAt: iso }
  }

  restore(): void {
    this.state = { ...this.state, available: true, resetAt: null }
  }

  /** True when the account would serve a request now. A passed reset time restores it (unless probes are set to fail). */
  isAvailable(): boolean {
    const s = this.state
    if (s.authFailure || s.runtimeFailure) return false
    if (!s.available && s.resetAt && this.now() >= Date.parse(s.resetAt) && this.probeFailures === 0) this.restore()
    return this.state.available
  }

  resetAtSeconds(): number | null {
    return this.state.resetAt ? Math.floor(Date.parse(this.state.resetAt) / 1000) : null
  }

  /** One availability check (usage report or probe session). */
  checkAvailable(): boolean {
    this.probes += 1
    if (this.probeFailures > 0 && !this.state.available) {
      this.probeFailures -= 1
      return false
    }
    const ok = this.isAvailable()
    if (ok) this.probeSuccesses += 1
    return ok
  }

  report(): RuntimeUsageReport | null {
    const s = this.state
    if (!s.reportSupported || s.authFailure || s.runtimeFailure) return null
    const ok = this.checkAvailable()
    return {
      rateLimitsAvailable: true,
      subscriptionType: 'max',
      windows: [
        {
          limitType: 'five_hour',
          utilizationPercent: ok ? (this.state.utilizationPercent ?? 0) : 100,
          // A window that is still limited has a reset ahead (or none); a reset in the past would be stale.
          resetsAt: ok || !this.state.resetAt || Date.parse(this.state.resetAt) <= this.now() ? null : this.state.resetAt,
        },
      ],
    }
  }
}

/** Wraps a script with the simulated account: runtime failure, auth failure, quota rejection, probe sessions. */
function withUsage(script: FakeScript): FakeScript {
  return async (spec, ctx) => {
    const sim = ctx.usage
    if (sim.state.runtimeFailure) ctx.fail('Claude runtime unavailable (simulated)')
    const isProbe = spec.prompt === USAGE_PROBE_PROMPT
    if (sim.state.authFailure) {
      await ctx.completeTurn({ text: 'Authentication required.', outcome: 'auth' })
      return
    }
    const ok = isProbe ? sim.checkAvailable() : sim.isAvailable()
    if (!ok) {
      await ctx.rateLimit({ status: 'rejected', resetsAt: sim.resetAtSeconds(), limitType: 'five_hour' })
      await ctx.completeTurn({ text: 'Usage limit reached.', outcome: 'quota' })
      return
    }
    if (isProbe) {
      await ctx.emitText('OK')
      await ctx.completeTurn({ text: 'OK' })
      return
    }
    await script(spec, ctx)
  }
}

/** Cumulative usage of one SDK session. Like the real SDK, a resumed session continues the totals. */
interface SessionTotals {
  costUsd: number
  byModel: Map<string, UsageInfo>
}

class FakeHandle implements AgentSessionHandle {
  readonly agentId: string
  readonly events: AsyncIterable<AgentEvent>
  private readonly eventQueue = new AsyncQueue<AgentEvent>()
  private readonly inbox = new AsyncQueue<string>()
  private controller = new AbortController()
  private finished = false
  private scriptSettled = false
  private stopRequested = false
  private readonly sdkSessionId: string
  private readonly done: Promise<void>
  private requests = 0

  constructor(
    private readonly spec: SessionSpec,
    sessionId: string,
    private readonly totals: SessionTotals,
    script: FakeScript,
    private readonly delayMs: number,
    private readonly usage: FakeUsageSim,
    private readonly onFinished: (h: FakeHandle) => void,
    private readonly cache: FakeCacheSim | null = null,
  ) {
    this.agentId = spec.agentId
    cache?.requested.push({ agentId: spec.agentId, stablePrefix: spec.contextOptions?.stablePrefix === true, alwaysLoadNexusTools: spec.contextOptions?.alwaysLoadNexusTools === true, contextUsageDetail: spec.contextOptions?.contextUsageDetail ?? 'off' })
    this.events = this.eventQueue
    this.sdkSessionId = sessionId
    this.emitNow({
      type: 'session.started',
      sessionId,
      model: spec.model ?? 'fake-model',
      tools: [...spec.tools],
      apiKeySource: 'none',
    })
    this.done = this.run(script)
  }

  get isFinished(): boolean {
    return this.finished
  }

  sessionId(): string | null {
    return this.sdkSessionId
  }

  send(text: string): void {
    this.inbox.push(text)
  }

  async interrupt(): Promise<void> {
    if (this.finished) return
    const old = this.controller
    this.controller = new AbortController()
    old.abort()
  }

  end(): void {
    this.inbox.close()
  }

  async stop(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true
      this.inbox.close()
      this.controller.abort()
    }
    // A script that ignores its signal must not be able to hang shutdown.
    await Promise.race([this.done, new Promise<void>((r) => setTimeout(r, 2000).unref())])
    this.finish('stopped', null)
  }

  stopConfirmed(): boolean { return this.finished && this.scriptSettled }

  private async run(script: FakeScript): Promise<void> {
    try {
      await script(this.spec, this.context())
      this.finish(this.stopRequested ? 'stopped' : 'completed', null)
    } catch (e) {
      this.finish(this.stopRequested ? 'stopped' : 'crashed', e instanceof FakeCrash ? e.message : errorMessage(e))
    } finally {
      this.scriptSettled = true
    }
  }

  private finish(reason: 'completed' | 'stopped' | 'crashed', error: string | null): void {
    if (this.finished) return
    this.eventQueue.push({ type: 'session.ended', reason, error })
    this.finished = true
    this.inbox.close()
    this.eventQueue.close()
    this.onFinished(this)
  }

  private emitNow(event: AgentEvent): void {
    if (!this.finished) this.eventQueue.push(event)
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (this.delayMs > 0) await this.sleep(this.delayMs)
    this.emitNow(event)
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.controller.signal
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private async decide(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ToolDecision> {
    if (toolName.startsWith('mcp__nexus__')) return { behavior: 'allow' }
    try {
      return await this.spec.authorize({ agentId: this.spec.agentId, toolName, input, toolUseId })
    } catch (e) {
      return { behavior: 'deny', reason: `Policy check failed: ${errorMessage(e)}` }
    }
  }

  private context(): FakeSessionContext {
    const currentSignal = () => this.controller.signal
    return {
      spec: this.spec,
      get signal() {
        return currentSignal()
      },
      nexusTools: this.spec.nexusTools,
      sleep: (ms) => this.sleep(ms),
      emitEvent: (event) => this.emit(event),
      emitText: (text) => this.emit({ type: 'text', text }),
      nextMessage: async () => {
        const it = this.inbox[Symbol.asyncIterator]()
        const r = await it.next()
        return r.done ? null : r.value
      },
      fail: (error) => {
        throw new FakeCrash(typeof error === 'string' ? error : error.message)
      },
      usage: this.usage,
      rateLimit: async (info = {}) => {
        await this.emit({
          type: 'rate_limit',
          status: info.status ?? 'rejected',
          resetsAt: info.resetsAt ?? null,
          limitType: info.limitType ?? null,
          ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
        })
        if ((info.status ?? 'rejected') === 'rejected' && info.single !== true) {
          await this.emit({ type: 'rate_limit', status: 'rejected', resetsAt: null, limitType: null })
        }
      },
      useTool: async (toolName, input, run) => {
        const toolUseId = newId()
        await this.emit({ type: 'tool.started', toolUseId, toolName, input })
        const decision = await this.decide(toolName, input, toolUseId)
        let denial: string | null = null
        if (decision.behavior === 'deny') denial = decision.reason
        else if (decision.behavior === 'ask') {
          let approved: boolean
          try {
            approved = await this.spec.requestApproval(
              { agentId: this.spec.agentId, toolName, input, toolUseId },
              decision.reason,
              decision.risk,
            )
          } catch {
            approved = false
          }
          if (!approved) denial = 'Denied by the user'
        }
        if (denial !== null) {
          await this.emit({ type: 'tool.denied', toolUseId, toolName, reason: denial })
          await this.emit({ type: 'tool.completed', toolUseId, isError: true, outputPreview: denial })
          return false
        }
        try {
          const output = run ? await run() : 'ok'
          await this.emit({ type: 'tool.completed', toolUseId, isError: false, outputPreview: output.slice(0, 500) })
        } catch (e) {
          await this.emit({ type: 'tool.completed', toolUseId, isError: true, outputPreview: errorMessage(e).slice(0, 500) })
        }
        return true
      },
      completeTurn: (r) => {
        const model = this.spec.model ?? 'fake-model'
        const prev = this.totals.byModel.get(model)
        const outputTokens = Math.max(1, Math.ceil(r.text.length / 4))
        const turnCost = 0.001
        this.totals.costUsd += turnCost
        const usage: UsageInfo = {
          model,
          inputTokens: (prev?.inputTokens ?? 0) + 1000,
          outputTokens: (prev?.outputTokens ?? 0) + outputTokens,
          cacheReadTokens: prev?.cacheReadTokens ?? 0,
          cacheCreationTokens: prev?.cacheCreationTokens ?? 0,
          costUsd: (prev?.costUsd ?? 0) + turnCost,
          contextWindow: 200_000,
        }
        const outcome = r.outcome ?? 'success'
        if (this.cache) {
          // One request per turn: the first one carries the first message, later ones what the turn added.
          const added = Math.ceil((this.requests === 0 ? this.spec.prompt.length : 0) / 4) + outputTokens
          const u = this.cache.request(this.sdkSessionId, this.spec, added)
          this.requests++
          usage.inputTokens = (prev?.inputTokens ?? 0) + u.inputTokens
          usage.cacheReadTokens = (prev?.cacheReadTokens ?? 0) + u.cacheReadTokens
          usage.cacheCreationTokens = (prev?.cacheCreationTokens ?? 0) + u.cacheCreationTokens
          this.emitNow({ type: 'request.usage', requestId: `${this.sdkSessionId}-req-${this.requests}-${this.totals.byModel.size}-${usage.outputTokens}`, model, inputTokens: u.inputTokens, cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens, outputTokens })
          const detail = this.spec.contextOptions?.contextUsageDetail ?? 'off'
          if (detail !== 'off') {
            const prefix = this.cache.prefixTokens(this.spec)
            const total = this.cache.contextTokens(this.sdkSessionId, this.spec)
            const user = Math.ceil(this.spec.prompt.length / 4)
            this.emitNow({
              type: 'context.usage',
              usage: {
                detail,
                model,
                totalTokens: total,
                maxTokens: 200_000,
                categories: [{ name: 'System prompt', tokens: prefix - this.spec.tools.length * 150, kind: 'used' }, { name: 'System tools', tokens: this.spec.tools.length * 150, kind: 'used' }, { name: 'Messages', tokens: total - prefix, kind: 'used' }, { name: 'Free space', tokens: 200_000 - total, kind: 'free' }],
                systemPromptSections: [{ name: 'runtime', tokens: prefix - this.spec.tools.length * 150 }],
                systemTools: this.spec.tools.map((name) => ({ name, tokens: 150 })),
                mcpTools: [],
                memoryFiles: [],
                messageBreakdown: { toolCallTokens: 0, toolResultTokens: 0, attachmentTokens: 0, assistantMessageTokens: Math.max(0, total - prefix - Math.min(user, total - prefix)), userMessageTokens: Math.min(user, total - prefix), toolCallsByType: [] },
              },
            })
          }
        }
        this.totals.byModel.set(model, usage)
        return this.emit({
          type: 'turn.completed',
          result: {
            outcome,
            text: outcome === 'success' ? r.text : '',
            structuredOutput: r.structuredOutput ?? null,
            // Per result, as the SDK reports it; usage and cost below are cumulative for the session.
            numTurns: 1,
            durationMs: this.delayMs,
            usage: [...this.totals.byModel.values()],
            totalCostUsd: this.totals.costUsd,
            errors: outcome === 'success' ? [] : [r.text],
          },
        })
      },
    }
  }
}

/** Scriptable AgentRuntime with no Claude usage, for unit, integration and E2E tests. */
export class FakeAgentRuntime implements AgentRuntime {
  /** Every spec passed to startSession/resumeSession, in order. */
  readonly sessions: SessionSpec[] = []
  readonly handles: AgentSessionHandle[] = []
  script: FakeScript
  delayMs: number
  authStatus: NonNullable<FakeRuntimeOptions['authStatus']>
  models: ModelOption[]
  readonly usage: FakeUsageSim
  readonly cache: FakeCacheSim | null
  private readonly live = new Set<FakeHandle>()
  private readonly totals = new Map<string, SessionTotals>()
  private counter = 0

  constructor(options: FakeRuntimeOptions) {
    this.script = options.script
    this.delayMs = options.delayMs ?? 0
    this.usage = options.usage ?? new FakeUsageSim()
    this.cache = options.cache ?? null
    this.authStatus = options.authStatus ?? defaultFakeAuthStatus()
    this.models = options.models ?? [
      { value: 'fake-model', displayName: 'Fake Model', description: 'Scripted test model', supportsEffort: true },
    ]
  }

  startSession(spec: SessionSpec): AgentSessionHandle {
    this.sessions.push(spec)
    this.counter += 1
    const id = spec.resumeSessionId ?? `fake-session-${this.counter}`
    let totals = this.totals.get(id)
    if (!totals) {
      totals = { costUsd: 0, byModel: new Map() }
      this.totals.set(id, totals)
    }
    const handle = new FakeHandle(spec, id, totals, withUsage(this.script), this.delayMs, this.usage, (h) => this.live.delete(h), this.cache)
    if (!handle.isFinished) this.live.add(handle)
    this.handles.push(handle)
    return handle
  }

  resumeSession(spec: SessionSpec, sdkSessionId: string): AgentSessionHandle {
    return this.startSession({ ...spec, resumeSessionId: sdkSessionId })
  }

  sendMessage(handle: AgentSessionHandle, text: string): void {
    handle.send(text)
  }

  interruptSession(handle: AgentSessionHandle): Promise<void> {
    return handle.interrupt()
  }

  stopSession(handle: AgentSessionHandle): Promise<void> {
    return handle.stop()
  }

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve({
      models: this.models,
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsEffort: true,
      sdkVersion: 'fake',
    })
  }

  getAccountInfo(options: { subscriptionMode: boolean }): Promise<AuthStatus> {
    const s = typeof this.authStatus === 'function' ? this.authStatus(options) : this.authStatus
    return Promise.resolve({ ...s, checkedAt: nowIso() })
  }

  getUsageReport(): Promise<RuntimeUsageReport | null> {
    return Promise.resolve(this.usage.report())
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live].map((h) => h.stop()))
  }
}
