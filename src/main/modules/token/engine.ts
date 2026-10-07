import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { CacheEvent, CompactionEvent, OptimizationAction, RequestBreakdown, SessionEfficiencyRecord, TokenBasis, TokenOptimizationDecision, TokenSettings } from '@shared/token'
import { estimateTokens, techniqueEnabled } from '@shared/token'
import type { ContextPack } from '@shared/v2'
import type { Repositories } from '@main/modules/persistence/repositories'
import { buildBreakdown, type RuntimeContextUsage } from './accounting'
import { classifyCacheResult, diagnoseCache, partsFromList, partsToList } from './auditor'
import { decideSessionAction, type SessionEfficiencyDecision } from './lifecycle'
import { capabilitiesOf, planContextOptions, type ContextOptions, type ToolPlan } from './planning'
import { PromptPrefixRegistry, prefixParts, type PrefixIdentity, type PrefixParts } from './registry'

/**
 * The Token Intelligence Engine: plans what a session asks of its runtime, and records what the runtime
 * reports back. The AdaptivePolicyEngine decides strategy (who works on what); this decides nothing about
 * the work, only about how its context is carried.
 *
 *   task -> context requirements -> graph navigation and retrieval (Context Engine V3)
 *        -> prefix plan -> tool plan -> [session runs] -> accounting -> session efficiency
 *
 * Accounting can never fail an agent: every write is guarded and a failure is logged.
 */

export interface SessionContext {
  runId: string
  taskId: string | null
  agentId: string
  role: string
}

export interface SessionPlanInput extends SessionContext {
  /** The model as routed (an alias or an id); the runtime reports the resolved one when the session starts. */
  model: string | null
  effort: string | null
  cwd: string
  /** The role prompt appended to the system prompt. */
  systemText: string
  /** Built-in tool names the session may see. */
  tools: readonly string[]
  nexusToolNames: readonly string[]
  externalServers: readonly string[]
  loadProjectSettings: boolean
  structuredOutput: boolean
  settings: TokenSettings | undefined
}

export interface SessionPlan {
  options: ContextOptions
  tools: ToolPlan
  /** Estimated tokens of the text NEXUS adds to the prefix (the role prompt). The runtime's own prompt is not in it. */
  nexusPrefixTokens: number
}

interface Live {
  ctx: SessionContext
  identity: PrefixIdentity
  parts: PrefixParts | null
  provider: string
  model: string | null
  requests: number
  seenRequestIds: Set<string>
  contextTokens: number | null
  maxTokens: number | null
  toolResultTokens: number | null
  compactions: number
  pack: Pick<ContextPack, 'entries'> | null
  roleText: string
}

export interface RequestUsage {
  /** The API message id: parallel tool calls of one response share it and are counted once. */
  requestId: string
  model: string | null
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** A placeholder on a streamed response (the count known when the response began); totals come from the turn result. */
  outputTokens: number
}

export class TokenIntelligenceEngine {
  private readonly live = new Map<string, Live>()
  private readonly prefixes: PromptPrefixRegistry
  private readonly now: () => string

  constructor(private readonly deps: { repos: Repositories; now?: () => string; log?: (line: string) => void }) {
    this.now = deps.now ?? nowIso
    this.prefixes = new PromptPrefixRegistry(deps.repos, this.now)
  }

  private guard<T>(what: string, fn: () => T): T | null {
    try {
      return fn()
    } catch (e) {
      this.deps.log?.(`token intelligence: ${what} failed: ${errorMessage(e)}`)
      return null
    }
  }

  // ───────────────────────────── before the session ─────────────────────────────

  /** What the session asks of its runtime, with the reasons recorded as decisions. */
  planSession(input: SessionPlanInput): SessionPlan {
    const { options, tools } = planContextOptions({ settings: input.settings, nexusTools: input.nexusToolNames.length, externalServers: input.externalServers.length })
    const identity: PrefixIdentity = {
      provider: 'claude',
      model: input.model,
      role: input.role,
      effort: input.effort,
      systemText: input.systemText,
      tools: [...input.tools, ...input.nexusToolNames.map((n) => `mcp__nexus__${n}`), ...input.externalServers.map((s) => `mcp__${s}`)],
      flags: { stablePrefix: options.stablePrefix, nexusToolsAlwaysLoaded: options.alwaysLoadNexusTools, projectSettings: input.loadProjectSettings, structuredOutput: input.structuredOutput },
      // The working directory is NOT part of the cached prefix: on the real runtime two sessions of one role in
      // different directories read the same prefix with or without the stable-prefix option
      // (docs/acceptance/cache-acceptance-*.json). So it is not part of the identity either.
      dynamicSystem: null,
    }
    this.live.set(input.agentId, {
      ctx: { runId: input.runId, taskId: input.taskId, agentId: input.agentId, role: input.role },
      identity,
      parts: null,
      provider: 'claude',
      model: input.model,
      requests: 0,
      seenRequestIds: new Set(),
      contextTokens: null,
      maxTokens: null,
      toolResultTokens: null,
      compactions: 0,
      pack: null,
      roleText: input.systemText,
    })
    const nexusPrefixTokens = estimateTokens(input.systemText)
    if (options.stablePrefix) {
      this.decide(input, 'STABLE_PREFIX', 'Per-session text is kept out of the system prompt so that sessions with the same role and tools share a cached prefix. The working directory reaches the model in the first message instead.', { role: input.role }, null, 'estimated')
    }
    if (input.nexusToolNames.length > 0) this.decide(input, tools.action, tools.reason, { nexusTools: input.nexusToolNames.length, externalServers: input.externalServers.length }, null, 'estimated')
    return { options, tools, nexusPrefixTokens }
  }

  /** The pack the session starts with, kept so that the breakdown can name its sections. */
  attachPack(agentId: string, pack: Pick<ContextPack, 'entries'> | null): void {
    const s = this.live.get(agentId)
    if (s) s.pack = pack
  }

  // ───────────────────────────── while it runs ─────────────────────────────

  /** The runtime said which provider and model the session really runs on. */
  sessionStarted(agentId: string, started: { provider: string; model: string | null }): void {
    const s = this.live.get(agentId)
    if (!s) return
    s.provider = started.provider
    s.model = started.model ?? s.model
    const caps = capabilitiesOf(started.provider)
    // A provider that takes no Claude option did not get one: its prefix identity carries none.
    s.identity = {
      ...s.identity,
      provider: started.provider,
      flags: caps.stableSystemPrefix ? s.identity.flags : { stablePrefix: false, nexusToolsAlwaysLoaded: false, projectSettings: s.identity.flags.projectSettings, structuredOutput: s.identity.flags.structuredOutput },
      tools: caps.nexusTools ? s.identity.tools : s.identity.tools.filter((t) => !t.startsWith('mcp__nexus__')),
    }
    s.requests = 0
    s.seenRequestIds.clear()
    this.guard('prefix registration', () => {
      const parts = prefixParts(s.identity)
      s.parts = parts
      // The diagnosis of the first request compares against the role's previous, different prefix (see requestUsage).
      this.prefixes.use(s.identity, partsToList(parts), estimateTokens(s.identity.systemText))
    })
  }

  /** One model request finished. The first request of a session shows whether its prefix was read from cache. */
  requestUsage(agentId: string, sdkSessionId: string | null, usage: RequestUsage): CacheEvent | null {
    const s = this.live.get(agentId)
    if (!s || s.seenRequestIds.has(usage.requestId)) return null
    s.seenRequestIds.add(usage.requestId)
    const index = s.requests++
    return this.guard('cache event', () => {
      const at = this.now()
      const result = classifyCacheResult({ inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheCreationTokens })
      const event: CacheEvent = {
        id: newId(),
        runId: s.ctx.runId,
        taskId: s.ctx.taskId,
        agentId: s.ctx.agentId,
        sdkSessionId,
        requestIndex: index,
        prefixHash: s.parts?.hash ?? null,
        provider: s.provider,
        model: usage.model ?? s.model,
        role: s.ctx.role,
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheCreationTokens,
        outputTokens: usage.outputTokens,
        result,
        expectedWarm: false,
        cause: null,
        causeBasis: null,
        reuseDistanceMs: null,
        createdAt: at,
      }
      if (index === 0 && s.parts) {
        const same = this.deps.repos.cacheEvents.lastUseOfPrefix(s.parts.hash, at, s.ctx.agentId)
        const previous = this.deps.repos.promptPrefixes.previousForRole(s.ctx.role, s.provider, s.parts.hash)
        const d = diagnoseCache({
          result,
          current: s.parts,
          sameHash: same ? { at: same.createdAt, result: same.result } : null,
          previousForRole: previous ? partsFromList(previous.hash, previous.components) : null,
          at,
        })
        Object.assign(event, { expectedWarm: d.expectedWarm, cause: d.cause, causeBasis: d.causeBasis, reuseDistanceMs: d.reuseDistanceMs })
        this.prefixes.observe(s.parts.hash, result, usage.cacheReadTokens, usage.cacheCreationTokens)
      }
      return this.deps.repos.cacheEvents.insert(event)
    })
  }

  /** The runtime's breakdown of the session's context. */
  contextUsage(agentId: string, sdkSessionId: string | null, usage: RuntimeContextUsage): RequestBreakdown | null {
    const s = this.live.get(agentId)
    if (!s) return null
    s.contextTokens = usage.totalTokens
    s.maxTokens = usage.maxTokens
    s.toolResultTokens = usage.messageBreakdown?.toolResultTokens ?? null
    return this.guard('context breakdown', () => {
      const b = buildBreakdown({ usage, pack: s.pack, roleText: s.roleText })
      return this.deps.repos.requestBreakdowns.insert({
        id: newId(),
        runId: s.ctx.runId,
        taskId: s.ctx.taskId,
        agentId: s.ctx.agentId,
        sdkSessionId,
        basis: b.basis,
        model: b.model ?? s.model,
        totalTokens: b.totalTokens,
        maxTokens: b.maxTokens,
        components: b.components,
        createdAt: this.now(),
      })
    })
  }

  /** A breakdown from NEXUS's own text only, for a session whose runtime reports none. Always `estimated`. */
  estimateBreakdown(agentId: string, promptText: string): RequestBreakdown | null {
    const s = this.live.get(agentId)
    if (!s) return null
    return this.guard('estimated breakdown', () => {
      const b = buildBreakdown({ usage: null, pack: s.pack, roleText: s.roleText, promptText })
      return this.deps.repos.requestBreakdowns.insert({ id: newId(), runId: s.ctx.runId, taskId: s.ctx.taskId, agentId: s.ctx.agentId, sdkSessionId: null, basis: 'estimated', model: s.model, totalTokens: b.totalTokens, maxTokens: null, components: b.components, createdAt: this.now() })
    })
  }

  compaction(agentId: string, sdkSessionId: string | null, e: { trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null; durationMs: number | null }): CompactionEvent | null {
    const s = this.live.get(agentId)
    if (!s) return null
    s.compactions++
    if (e.postTokens !== null) s.contextTokens = e.postTokens
    return this.guard('compaction event', () => {
      const event = this.deps.repos.compactionEvents.insert({ id: newId(), runId: s.ctx.runId, taskId: s.ctx.taskId, agentId: s.ctx.agentId, sdkSessionId, trigger: e.trigger, preTokens: e.preTokens, postTokens: e.postTokens, durationMs: e.durationMs, createdAt: this.now() })
      this.decide(s.ctx, 'COMPACT', `The runtime compacted the conversation${e.preTokens !== null && e.postTokens !== null ? ` from ${e.preTokens} to ${e.postTokens} tokens` : ''}. The task, its criteria, decisions, commits and findings are stored by NEXUS and do not depend on the summary.`, { trigger: e.trigger }, e.preTokens !== null && e.postTokens !== null ? e.preTokens - e.postTokens : null, 'observed')
      return event
    })
  }

  // ───────────────────────────── after a turn ─────────────────────────────

  /** What to do with the session now that a turn has ended. Recorded; the caller acts on HANDOFF_AND_ROTATE only. */
  turnEnded(agentId: string, sdkSessionId: string | null, input: { turns: number; rotationTurns: number; hitTurnLimit: boolean; canHandoff: boolean; settings: TokenSettings | undefined; risk?: 'low' | 'medium' | 'high' | 'critical'; outputTokens?: number | null; thinkingTokens?: number | null }): SessionEfficiencyDecision {
    const s = this.live.get(agentId)
    const decision = decideSessionAction({
      turns: input.turns,
      rotationTurns: input.rotationTurns,
      contextTokens: s?.contextTokens ?? null,
      maxTokens: s?.maxTokens ?? null,
      toolResultTokens: s?.toolResultTokens ?? null,
      hitTurnLimit: input.hitTurnLimit,
      compactions: s?.compactions ?? 0,
      canHandoff: input.canHandoff,
      pressureRotation: techniqueEnabled(input.settings, 'pressureRotation'),
      ...(input.risk ? { risk: input.risk } : {}),
    })
    if (s) {
      this.guard('session efficiency', () => {
        const record: SessionEfficiencyRecord = { id: newId(), runId: s.ctx.runId, taskId: s.ctx.taskId, agentId: s.ctx.agentId, sdkSessionId, turns: input.turns, contextTokens: s.contextTokens, maxTokens: s.maxTokens, outputTokens: input.outputTokens ?? null, thinkingTokens: input.thinkingTokens ?? null, pressure: decision.pressure, action: decision.action, reason: decision.reason, createdAt: this.now() }
        this.deps.repos.sessionEfficiency.insert(record)
        if (decision.action === 'HANDOFF_AND_ROTATE') this.decide(s.ctx, 'ROTATE_SESSION', decision.reason, { turns: input.turns, pressure: decision.pressure }, null, 'observed')
        else if (decision.action === 'CLEAR_STALE_TOOL_RESULTS') this.decide(s.ctx, 'CLEAR_TOOL_RESULTS', decision.reason, { pressure: decision.pressure }, null, 'observed')
        else if (input.hitTurnLimit) this.decide(s.ctx, 'KEEP_FULL_CONTEXT', decision.reason, { turns: input.turns, pressure: decision.pressure }, null, 'observed')
      })
    }
    return decision
  }

  /** The agent is done: its live state is dropped. */
  sessionClosed(agentId: string): void {
    this.live.delete(agentId)
  }

  /** The context size the runtime last reported for an agent, for the caller's own decisions. */
  lastContext(agentId: string): { contextTokens: number | null; maxTokens: number | null } {
    const s = this.live.get(agentId)
    return { contextTokens: s?.contextTokens ?? null, maxTokens: s?.maxTokens ?? null }
  }

  /** Record one context decision. `tokenEffect` is per decision and is never summed: decisions overlap. */
  decide(ctx: { runId: string; taskId: string | null; agentId: string | null }, action: OptimizationAction, reason: string, detail: Record<string, unknown> | null, tokenEffect: number | null, basis: TokenBasis): TokenOptimizationDecision | null {
    return this.guard('optimization decision', () =>
      this.deps.repos.optimizationDecisions.insert({ id: newId(), runId: ctx.runId, taskId: ctx.taskId, agentId: ctx.agentId, action, reason, detail, tokenEffect, basis, createdAt: this.now() }),
    )
  }
}
