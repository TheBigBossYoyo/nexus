/** Facts are never inferred from token counts. Reserve is a separate scheduling policy. */
export type IntelligenceProvider = 'openai' | 'claude' | 'codex'
export type CapacityState =
  | 'AVAILABLE'
  | 'LIMIT_APPROACHING'
  | 'THROTTLED'
  | 'QUOTA_PAUSED'
  | 'WAITING_FOR_RESET'
  | 'AUTH_REQUIRED'
  | 'RUNTIME_UNAVAILABLE'
  | 'USAGE_UNKNOWN'
  | 'USAGE_SERVICE_UNAVAILABLE'
  | 'PROBING'
export type IntelligenceRole = 'strategic' | 'technical' | 'compiler' | 'worker' | 'reviewer'
export interface CapacityFact<T> {
  value: T | null
  source: 'PROVIDER_RUNTIME' | 'RESPONSE' | 'SERVER_ERROR' | 'LOCAL' | 'USER' | 'UNKNOWN'
  confidence: 'EXACT' | 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN'
  observedAt: number
}
export interface CapacityPool {
  id: string
  /** Account/registration binding is established by the adapter, never guessed from provider names. */
  binding: string
  consumers: IntelligenceProvider[]
  state: CapacityState
  scope: 'ACCOUNT' | 'APP' | 'UNKNOWN'
  resetAt: CapacityFact<number>
  utilization: CapacityFact<number>
  nextProbeAt: number | null
  probeAttempts: number
  stateEvidence?: CapacityFact<CapacityState>
}
export interface RoutingCandidate {
  provider: IntelligenceProvider
  model: string
  roles: IntelligenceRole[]
  poolIds: string[]
  available: boolean
  /** Evidence is scoped to role, model, profile and policy by its owning service. */
  qualityEvidence: string[]
  qualityApproved: boolean
  reserve: 'NONE' | 'STRATEGIC'
  paid: boolean
}
export interface CapacityRoutingDecision {
  action: 'ROUTE' | 'WAIT'
  provider: IntelligenceProvider | null
  model: string | null
  reasons: string[]
  qualityEvidence: string[]
}
export interface CapacityRoutingRecord extends CapacityRoutingDecision {
  id: string
  projectId: string
  operationId: string
  role: IntelligenceRole
  stage: string
  state: 'ADMITTED' | 'WAITING_FOR_CAPACITY' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED'
  poolIds: string[]
  policyVersion: string
  reservePolicy?: ProviderReservePolicy
  createdAt: string
  endedAt: string | null
  failure: 'CAPACITY' | 'PROVIDER' | 'STOP_UNCONFIRMED' | null
  consumption?: 'NOT_SENT' | 'PROVIDER_REPORTED' | 'UNKNOWN'
  usage?: ProviderUsageReceipt | null
}
/**
 * What the advisory roles (compiler, Strategic and Technical Director) used over a period, per provider, from
 * the receipts kept with each request. `reported` requests came back with the provider's own token counts and
 * are what the sums are made of; `unreported` ones were sent and say nothing of what they used. Neither is a
 * share of any allowance.
 */
export interface AdvisoryUsageSummary {
  since: string
  providers: { provider: IntelligenceProvider; requests: number; reported: number; unreported: number; notSent: number; inputTokens: number; outputTokens: number }[]
}
/** Numeric fields are reported by the adapter; absence stays null, never an estimate of allowance. */
export interface ProviderUsageReceipt {
  models: string[]
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
}
export interface ProviderReservePolicy {
  version: string
  maxConcurrent: number
  /** A local session-slot reserve, never an estimate of plan allowance. */
  advisorySlots: number
  poolLimits?: Record<string, { maxConcurrent: number; advisorySlots: number }>
}
export interface ProviderCapacityLease {
  id: string
  poolId: string
  operationId: string
  role: IntelligenceRole
  bootId: string
  state: 'HELD' | 'RELEASED' | 'QUARANTINED' | 'INTERRUPTED'
  createdAt: string
  owner?: { kind: 'PROCESS_HTTP' | 'HOSTED_SESSION'; pid: number }
}
