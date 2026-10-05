import { z } from 'zod'
import type { AgentRole } from './domain'

/**
 * NEXUS 0.6: agent runtime providers. An agent is no longer assumed to be Claude. Claude stays the required,
 * first-class provider; every other provider is optional, off until the user enables it, and never blocks
 * NEXUS when it is missing. This file is the shared model: what a provider is, what the user allows, and the
 * pure decision of which provider runs a session.
 */

export const PROVIDER_IDS = ['claude', 'codex', 'gemini'] as const
export const ProviderIdSchema = z.enum(PROVIDER_IDS)
export type ProviderId = z.infer<typeof ProviderIdSchema>

/** The provider NEXUS cannot work without, and the one every fallback goes to. */
export const PRIMARY_PROVIDER: ProviderId = 'claude'

export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export type ProviderInstallState = 'installed' | 'not_installed' | 'unknown'
export type ProviderAuthState = 'authenticated' | 'auth_required' | 'unknown'
/**
 * `unknown`: nothing was run yet (discovery sends no prompt). `healthy`: the last session or probe worked.
 * `degraded`: recent failures, still tried. `unavailable`: not installed, not signed in, or failing repeatedly.
 */
export type ProviderHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown'

export interface ProviderCapabilities {
  /** NEXUS can start sessions with this provider at all. False for a provider that is only detected. */
  sessions: boolean
  resume: boolean
  /** `native`: the runtime enforces a schema. `prompted`: NEXUS asks for JSON and parses the answer. */
  structuredOutput: 'native' | 'prompted' | 'none'
  /** Every tool call passes through the NEXUS permission policy. */
  toolAuthorization: boolean
  /** The NEXUS agent tools (messages, blockers, decisions, memory proposals) are available to the agent. */
  nexusTools: boolean
  mcp: boolean
  /** The runtime reports plan usage without a prompt. */
  usageReport: boolean
  /** What confines the agent: the NEXUS policy, the provider's own sandbox, or nothing NEXUS can state. */
  confinement: 'nexus_policy' | 'provider_sandbox' | 'none'
  /** NEXUS lets this provider change files. A read-only provider can review, research and criticise. */
  writes: boolean
}

export interface ProviderStatus {
  id: ProviderId
  displayName: string
  required: boolean
  installed: ProviderInstallState
  version: string | null
  auth: ProviderAuthState
  /** What the runtime itself said about the login (for example "Claude subscription"). Never a credential. */
  authDetail: string | null
  /** NEXUS has a runtime adapter for this provider and the installed version can be used. */
  supported: boolean
  supportDetail: string | null
  health: ProviderHealth
  healthDetail: string | null
  models: { value: string; displayName: string }[]
  capabilities: ProviderCapabilities
  checkedAt: string
}

export const NO_CAPABILITIES: ProviderCapabilities = {
  sessions: false,
  resume: false,
  structuredOutput: 'none',
  toolAuthorization: false,
  nexusTools: false,
  mcp: false,
  usageReport: false,
  confinement: 'none',
  writes: false,
}

const ModelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, 'a model name')

/**
 * What the user allows. Nothing is sent to a provider that is not enabled here, and enabling a provider does
 * not by itself route anything to it: a use (cross-model review, a second speculative candidate) must be on too.
 */
export const ProviderPolicySchema = z
  .object({
    enabled: z.object({ claude: z.literal(true), codex: z.boolean(), gemini: z.boolean() }).strict(),
    /** The model to ask each optional provider for; null leaves the choice to NEXUS's default for it. */
    models: z.object({ codex: ModelName.nullable(), gemini: ModelName.nullable() }).strict(),
    /** Reviews of Claude's work are done by another provider; the verifier stays Claude. */
    crossModelReview: z.object({ enabled: z.boolean(), reviewer: ProviderIdSchema }).strict(),
    /** In a speculative task, candidate B is written by another provider. */
    heterogeneousSpeculation: z.object({ enabled: z.boolean(), secondCandidate: ProviderIdSchema }).strict(),
    /** When the chosen provider cannot be used, Claude does the work instead and the reason is recorded. */
    fallbackToClaude: z.boolean(),
  })
  .strict()
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>

export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = {
  enabled: { claude: true, codex: false, gemini: false },
  models: { codex: null, gemini: null },
  crossModelReview: { enabled: false, reviewer: 'codex' },
  heterogeneousSpeculation: { enabled: false, secondCandidate: 'codex' },
  fallbackToClaude: true,
}

/** Roles whose session reads and judges and must not change files. */
export const READ_ONLY_ROLES: readonly AgentRole[] = ['reviewer', 'security_reviewer', 'verifier', 'researcher', 'planner', 'architect']
const REVIEW_ROLES: readonly AgentRole[] = ['reviewer', 'security_reviewer']
const CANDIDATE_B = /\bcandidate B\b/

export interface RouteRequest {
  role: AgentRole
  /** The agent's label ("Worker/api · candidate B"); a speculative candidate is recognised by it. */
  label?: string | null
  /** A resumed session stays with the provider that owns it. */
  resumeProvider?: ProviderId | null
}

export interface RouteDecision {
  /** The provider that runs the session; null when the policy refuses and no fallback is allowed. */
  provider: ProviderId | null
  /** The provider the policy asked for. */
  requested: ProviderId
  /** Why that provider was asked for. */
  reason: string
  /** Set when `provider` differs from `requested`, or when the session is refused. */
  fallbackReason: string | null
}

/** Why a provider cannot run this session now, or null when it can. */
export function unusableReason(id: ProviderId, policy: ProviderPolicy, status: ProviderStatus | undefined, role: AgentRole): string | null {
  const name = PROVIDER_NAMES[id]
  if (!policy.enabled[id]) return `${name} is not enabled in the provider policy`
  if (!status) return `${name} was not detected`
  if (status.installed !== 'installed') return `${name} is not installed`
  if (!status.supported || !status.capabilities.sessions) return status.supportDetail ?? `NEXUS cannot run sessions with ${name}`
  if (status.auth !== 'authenticated') return `${name} needs authentication`
  if (status.health === 'unavailable') return `${name} is unavailable${status.healthDetail ? `: ${status.healthDetail}` : ''}`
  if (!READ_ONLY_ROLES.includes(role) && !status.capabilities.writes) return `${name} is read-only in NEXUS and a ${role} changes files`
  return null
}

/**
 * Which provider runs a session. Pure: the same request, policy and statuses give the same answer. Claude is
 * asked for unless a use the user switched on names another provider; Claude is never "unusable" here (its own
 * failures are handled by the runtime and the usage system, as before 0.6).
 */
export function routeSession(request: RouteRequest, policy: ProviderPolicy, statuses: readonly ProviderStatus[]): RouteDecision {
  const status = (id: ProviderId): ProviderStatus | undefined => statuses.find((s) => s.id === id)
  if (request.resumeProvider) {
    return { provider: request.resumeProvider, requested: request.resumeProvider, reason: 'The session is resumed with the provider that owns it.', fallbackReason: null }
  }
  let requested: ProviderId = PRIMARY_PROVIDER
  let reason = 'Claude is the default provider.'
  if (policy.crossModelReview.enabled && REVIEW_ROLES.includes(request.role) && policy.crossModelReview.reviewer !== PRIMARY_PROVIDER) {
    requested = policy.crossModelReview.reviewer
    reason = `Cross-model review: a ${request.role.replace('_', ' ')} from ${PROVIDER_NAMES[requested]}.`
  } else if (policy.heterogeneousSpeculation.enabled && request.label && CANDIDATE_B.test(request.label) && policy.heterogeneousSpeculation.secondCandidate !== PRIMARY_PROVIDER) {
    requested = policy.heterogeneousSpeculation.secondCandidate
    reason = `Heterogeneous speculation: candidate B from ${PROVIDER_NAMES[requested]}.`
  }
  if (requested === PRIMARY_PROVIDER) return { provider: PRIMARY_PROVIDER, requested, reason, fallbackReason: null }
  const problem = unusableReason(requested, policy, status(requested), request.role)
  if (problem === null) return { provider: requested, requested, reason, fallbackReason: null }
  if (policy.fallbackToClaude) return { provider: PRIMARY_PROVIDER, requested, reason, fallbackReason: `${problem}; Claude does this instead.` }
  return { provider: null, requested, reason, fallbackReason: `${problem}; the policy allows no fallback.` }
}

/** What stops the user from switching a provider on, or null. Shown next to the switch. */
export function enableBlocker(status: ProviderStatus): string | null {
  if (status.required) return null
  if (status.installed !== 'installed') return `${status.displayName} is not installed on this computer.`
  if (!status.supported || !status.capabilities.sessions) return status.supportDetail ?? `NEXUS cannot run sessions with ${status.displayName} yet.`
  if (status.auth === 'auth_required') return `${status.displayName} is installed but not signed in. Sign in with its own command line tool; NEXUS never handles its credentials.`
  return null
}

/** One session and the provider that ran it. */
export interface ProviderSession {
  id: string
  runId: string | null
  agentId: string
  role: AgentRole
  label: string | null
  requested: ProviderId
  provider: ProviderId
  model: string | null
  runtimeVersion: string | null
  authMode: string | null
  reason: string
  fallbackReason: string | null
  /** The provider's own session id, once known. */
  sessionId: string | null
  /** `refused`: the policy allowed neither the provider nor a fallback. */
  outcome: 'running' | 'completed' | 'failed' | 'refused'
  error: string | null
  inputTokens: number
  outputTokens: number
  createdAt: string
  endedAt: string | null
}

/** Facts about one provider's recent sessions. Counts only; no score and no ranking. */
export interface ProviderPerformance {
  provider: ProviderId
  sessions: number
  completed: number
  failed: number
  fallbacksFrom: number
  inputTokens: number
  outputTokens: number
  lastUsedAt: string | null
}

export function summarizePerformance(sessions: readonly ProviderSession[]): ProviderPerformance[] {
  return PROVIDER_IDS.map((provider) => {
    const mine = sessions.filter((s) => s.provider === provider)
    return {
      provider,
      sessions: mine.length,
      completed: mine.filter((s) => s.outcome === 'completed').length,
      failed: mine.filter((s) => s.outcome === 'failed').length,
      fallbacksFrom: sessions.filter((s) => s.requested === provider && s.provider !== provider).length,
      inputTokens: mine.reduce((n, s) => n + s.inputTokens, 0),
      outputTokens: mine.reduce((n, s) => n + s.outputTokens, 0),
      lastUsedAt: mine.reduce<string | null>((latest, s) => (latest === null || s.createdAt > latest ? s.createdAt : latest), null),
    }
  })
}

/**
 * Provider usage as each provider states it. Quota systems differ and are not converted into one scale: a
 * provider that reports no plan window has none shown.
 */
export interface ProviderUsage {
  provider: ProviderId
  /** Tokens NEXUS observed in this provider's sessions. */
  observed: { sessions: number; inputTokens: number; outputTokens: number }
  /** Plan windows exactly as the runtime reported them; empty when it reports none. */
  windows: { limitType: string; utilizationPercent: number | null; resetsAt: string | null }[]
  windowsSource: 'runtime' | 'not_exposed'
}

export interface ProvidersOverview {
  statuses: ProviderStatus[]
  policy: ProviderPolicy
  performance: ProviderPerformance[]
  usage: ProviderUsage[]
  recent: ProviderSession[]
}

/** A stable description of who did what, for evidence that compares strategies: `reviewer=codex:gpt-5.5`. */
export function providerSignature(sessions: readonly Pick<ProviderSession, 'role' | 'provider' | 'model'>[]): string {
  const parts = new Set(sessions.filter((s) => s.provider !== PRIMARY_PROVIDER).map((s) => `${s.role}=${s.provider}:${s.model ?? 'default'}`))
  return [...parts].sort().join(',')
}
