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
