import { z } from 'zod'

/**
 * Token intelligence (0.7.1): what a model request was made of, how the prompt cache behaved, and which
 * context decisions NEXUS took. Every figure carries a basis, because three kinds of number exist and they
 * must not be mixed:
 *  - `exact`: counted by the runtime for this very text (the runtime's context-usage breakdown in full detail);
 *  - `observed`: reported by the runtime for a request (input, cache read, cache write, output);
 *  - `estimated`: characters / 4, for text NEXUS has not sent or the runtime does not split.
 */
export type TokenBasis = 'exact' | 'observed' | 'estimated'

export const REQUEST_COMPONENTS = [
  'SYSTEM_CORE',
  'SECURITY_POLICY',
  'ROLE',
  'TOOL_DEFINITIONS',
  'PROJECT_FACTS',
  'CONTEXT_GRAPH',
  'REPOSITORY_CONTEXT',
  'TASK',
  'ACCEPTANCE_CRITERIA',
  'DEPENDENCY_HANDOFF',
  'MESSAGES',
  'HISTORY',
  'TOOL_RESULTS',
  'MEMORY',
  'REVIEW_FINDINGS',
  'DYNAMIC_RUNTIME_STATE',
  'THINKING_HISTORY',
  'OTHER',
] as const
export type RequestComponent = (typeof REQUEST_COMPONENTS)[number]

export interface ComponentTokens {
  component: RequestComponent
  tokens: number
  basis: TokenBasis
  /** What the figure covers, e.g. "8 repository facts" or "Messages (runtime category)". */
  detail: string
}

/** What one agent session's context was made of at one moment. */
export interface RequestBreakdown {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  sdkSessionId: string | null
  /** The weakest basis among the components: a breakdown with one estimate is an estimated breakdown. */
  basis: TokenBasis
  model: string | null
  totalTokens: number
  /** The window the runtime measures against, when it reported one. */
  maxTokens: number | null
  components: ComponentTokens[]
  createdAt: string
}

// ───────────────────────────── cache ─────────────────────────────

export const CACHE_MISS_CAUSES = [
  'FIRST_USE',
  'TOOLS_CHANGED',
  'SYSTEM_CHANGED',
  'MODEL_CHANGED',
  'EFFORT_CHANGED',
  'THINKING_CHANGED',
  'PROJECT_CONTEXT_CHANGED',
  'SECURITY_POLICY_CHANGED',
  'DYNAMIC_PREFIX_CONTAMINATION',
  'EXPIRED',
  'UNKNOWN',
] as const
export type CacheMissCause = (typeof CACHE_MISS_CAUSES)[number]

/**
 * What the first request of a session did with the prefix (later requests of a session read their own history):
 *  - `read`: most of the input came from cache;
 *  - `write`: the prefix was written, nothing was read;
 *  - `partial`: part read, part written (a shared head, a different tail);
 *  - `none`: the runtime reported no cache figures.
 */
export type CacheResult = 'read' | 'write' | 'partial' | 'none'

export interface CacheEvent {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  sdkSessionId: string | null
  /** 0 for the first model request of the session. */
  requestIndex: number
  /** Hash of the prefix NEXUS controls (role text, tool set, model, provider flags). Null when unknown. */
  prefixHash: string | null
  provider: string
  model: string | null
  role: string | null
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  result: CacheResult
  /** True when an earlier session used the same prefix hash recently enough that a read was expected. */
  expectedWarm: boolean
  /** Why an expected read did not happen. Null when nothing was expected or the read happened. */
  cause: CacheMissCause | null
  /** `local_inference`: derived from NEXUS's own prefix hashes. `runtime`: stated by the runtime. Never mixed. */
  causeBasis: 'local_inference' | 'runtime' | null
  /** Milliseconds since the previous use of the same prefix hash. */
  reuseDistanceMs: number | null
  createdAt: string
}

export type PromptCacheability = 'stable' | 'session' | 'volatile'

/** One immutable block of prompt text NEXUS writes. A new hash under the same key is a new version. */
export interface PromptComponent {
  /** `<key>@<version>` */
  id: string
  key: string
  version: number
  /** Where it goes: 'system' (the role text appended to the system prompt) or 'user' (the first message). */
  scope: 'system' | 'tools' | 'user'
  /** Order inside its scope; lower comes first. Stable blocks come before volatile ones. */
  priority: number
  hash: string
  chars: number
  tokenEstimate: number
  cacheability: PromptCacheability
  createdAt: string
}

export interface PromptPrefix {
  id: string
  hash: string
  /** Component ids in order. */
  components: string[]
  provider: string
  model: string | null
  role: string
  toolSetHash: string
  tokenEstimate: number
  cacheable: boolean
  uses: number
  firstSeenAt: string
  lastSeenAt: string
  lastCacheResult: CacheResult | null
  lastCacheReadTokens: number | null
  lastCacheWriteTokens: number | null
}

// ───────────────────────────── decisions and lifecycle ─────────────────────────────

export const OPTIMIZATION_ACTIONS = [
  'STABLE_PREFIX',
  'DEFER_TOOLS',
  'LOAD_TOOLS_UPFRONT',
  'RETRIEVE_GRAPH_BRANCH',
  'EXPAND_GRAPH_NODE',
  'WIDEN_RETRIEVAL',
  'FILTER_OUTPUT',
  'CLEAR_TOOL_RESULTS',
  'COMPACT',
  'ROTATE_SESSION',
  'PROGRAMMATIC_TOOLS',
  /** A valid decision: quality demanded the full context. */
  'KEEP_FULL_CONTEXT',
] as const
export type OptimizationAction = (typeof OPTIMIZATION_ACTIONS)[number]

export interface TokenOptimizationDecision {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  action: OptimizationAction
  reason: string
  detail: Record<string, unknown> | null
  /** Tokens the decision is believed to avoid (positive) or add (negative). Null when unknown. Never summed across decisions. */
  tokenEffect: number | null
  basis: TokenBasis
  createdAt: string
}

export type ContextPressure = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL'
export type SessionAction = 'KEEP' | 'CLEAR_STALE_TOOL_RESULTS' | 'COMPACT' | 'HANDOFF_AND_ROTATE'

export interface SessionEfficiencyRecord {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  sdkSessionId: string | null
  turns: number
  contextTokens: number | null
  maxTokens: number | null
  pressure: ContextPressure
  action: SessionAction
  reason: string
  createdAt: string
}

export interface CompactionEvent {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  sdkSessionId: string | null
  trigger: 'manual' | 'auto'
  preTokens: number | null
  postTokens: number | null
  durationMs: number | null
  createdAt: string
}

/**
 * How NEXUS treats a result it put (or could put) into a prompt:
 *  - PINNED: must stay (a failure being repaired, an unresolved finding);
 *  - ACTIVE: recent and in use;
 *  - RETRIEVABLE: the raw result is stored and the model has a reference to it;
 *  - STALE: superseded by a later result of the same kind.
 * Only RETRIEVABLE and STALE results may be left out of a prompt.
 */
export type ToolResultState = 'PINNED' | 'ACTIVE' | 'RETRIEVABLE' | 'STALE'

export interface ArtifactContextRef {
  id: string
  runId: string
  taskId: string | null
  agentId: string | null
  kind: 'check_output' | 'tool_result' | 'log' | 'diff'
  /** Where the raw content is: an artifact id or `tool_event:<id>`. */
  ref: string
  title: string
  state: ToolResultState
  charsTotal: number
  charsShown: number
  createdAt: string
}

export interface TokenBenchmarkResult {
  id: string
  benchmark: string
  variant: string
  caseKey: string
  metrics: Record<string, number | string | boolean | null>
  createdAt: string
}

// ───────────────────────────── provider capabilities ─────────────────────────────

/** What a provider's runtime supports. A feature that is false is never requested from that provider. */
export interface ContextCapabilities {
  provider: string
  promptCaching: 'automatic' | 'none'
  /** The host can ask for a system prompt without per-session dynamic sections. */
  stableSystemPrefix: boolean
  perRequestUsage: boolean
  contextUsageBreakdown: boolean
  toolSearch: boolean
  alwaysLoadTools: boolean
  compactionEvents: boolean
  thinkingTokens: boolean
  nexusTools: boolean
  sessionResume: boolean
}

// ───────────────────────────── settings ─────────────────────────────

/**
 * `auto` follows the release's evidence-supported default (see docs/V0_7_1_RELEASE_REPORT.md): the technique
 * is on only where it is lossless or measured non-inferior. `on` and `off` are the user's explicit choice.
 */
export const TechniqueSwitchSchema = z.enum(['auto', 'on', 'off'])
export type TechniqueSwitch = z.infer<typeof TechniqueSwitchSchema>

export const TokenSettingsSchema = z.object({
  /** The only mode: lossless and measured-non-inferior optimizations. Kept as a field so a stored value is explicit. */
  mode: z.literal('QUALITY_FIRST'),
  /** Ask the runtime for a system prompt without per-session sections, so agents share a cached prefix. */
  stablePrefix: TechniqueSwitchSchema,
  /** Add the Context Graph map and related nodes to context packs and give agents the navigation tools. */
  contextGraph: TechniqueSwitchSchema,
  /** Load the NEXUS tools upfront when the tool set is small, instead of leaving them behind tool search. */
  toolLoading: TechniqueSwitchSchema,
  /** Show failures first in check output given to agents; the raw output stays stored. */
  outputFiltering: TechniqueSwitchSchema,
  /** Rotate a session on context pressure reported by the runtime instead of on turn count alone. */
  pressureRotation: TechniqueSwitchSchema,
  /** How the per-session context breakdown is taken. `full` makes token-count calls in the runtime. */
  contextUsageDetail: z.enum(['off', 'summary', 'full']),
  /** Advisory token budget of the graph part of a context pack. Retrieval may exceed it when quality demands. */
  graphContextBudget: z.number().int().min(200).max(20_000),
})
export type TokenSettings = z.infer<typeof TokenSettingsSchema>

export const DEFAULT_TOKEN_SETTINGS: TokenSettings = {
  mode: 'QUALITY_FIRST',
  stablePrefix: 'auto',
  contextGraph: 'auto',
  toolLoading: 'auto',
  outputFiltering: 'auto',
  pressureRotation: 'auto',
  contextUsageDetail: 'summary',
  graphContextBudget: 2_000,
}

export type Technique = 'stablePrefix' | 'contextGraph' | 'toolLoading' | 'outputFiltering' | 'pressureRotation'

/**
 * What `auto` means in this release. A technique is listed `true` only when it is lossless or when the
 * release's benchmarks showed it non-inferior; the evidence for each line is in the release report.
 */
export const AUTO_DEFAULTS: Record<Technique, boolean> = {
  // Measured on the real runtime (docs/acceptance/cache-acceptance-*.json): sessions of one role in different
  // working directories already share the cached prefix, so the option adds nothing; it stays off.
  stablePrefix: false,
  // The retrieval benchmark must show recall no lower than the V2 selection.
  contextGraph: false,
  // Measured on the real runtime: loading the NEXUS tools upfront did not change the size of a request.
  toolLoading: false,
  // Shows a superset of the failure lines the tail cut showed; the raw output remains stored.
  outputFiltering: true,
  pressureRotation: false,
}

export function techniqueEnabled(settings: TokenSettings | undefined, technique: Technique): boolean {
  const value = (settings ?? DEFAULT_TOKEN_SETTINGS)[technique]
  return value === 'on' || (value === 'auto' && AUTO_DEFAULTS[technique])
}

/** Characters / 4. The one estimate NEXUS uses where the runtime gives no count; always shown as estimated. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const BASIS_ORDER: Record<TokenBasis, number> = { exact: 0, observed: 1, estimated: 2 }

/** The weakest basis of a set of figures. */
export function weakestBasis(bases: readonly TokenBasis[]): TokenBasis {
  let out: TokenBasis = 'exact'
  for (const b of bases) if (BASIS_ORDER[b] > BASIS_ORDER[out]) out = b
  return out
}

/** How check output is shown to agents: `off` is the 0.7.0 tail cut, `auto` adds the failures before the tail, `on` also shortens passing runs. */
export function checkOutputMode(settings: TokenSettings | undefined): 'tail' | 'superset' | 'compact' {
  const value = (settings ?? DEFAULT_TOKEN_SETTINGS).outputFiltering
  return value === 'off' ? 'tail' : value === 'on' ? 'compact' : 'superset'
}
