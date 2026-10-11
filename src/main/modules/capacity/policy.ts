import type {
  CapacityPool,
  CapacityRoutingDecision,
  CapacityState,
  IntelligenceProvider,
  IntelligenceRole,
  RoutingCandidate,
} from '@shared/capacity'

/**
 * A refusal of the request itself: the provider understood it and will refuse it again unchanged (a model this
 * plan does not offer, a malformed or oversize request, a forbidden one). It says nothing about the allowance,
 * so it is neither a state of the capacity pool nor a reason to wait and probe. A code that names a limit wins
 * over the status it came with.
 */
export function isRequestRefusal(status: number, code: string | null): boolean {
  if (code !== null && (LIMIT_CODES.has(code) || code.startsWith('subscription_sharing_'))) return false
  return REFUSAL_STATUS.has(status) || (code !== null && REFUSAL_CODES.has(code))
}
const LIMIT_CODES: ReadonlySet<string> = new Set(['insufficient_quota', 'rate_limit_exceeded'])
const REFUSAL_STATUS: ReadonlySet<number> = new Set([400, 403, 404, 413, 422])
const REFUSAL_CODES: ReadonlySet<string> = new Set(['model_not_found', 'unsupported_model', 'invalid_request_error', 'context_length_exceeded', 'invalid_prompt'])

export function classifyOpenAIError(status: number, code: string | null): CapacityState {
  // The account's allowance is used up, whichever status or stream event carried the word.
  if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'insufficient_quota') return 'QUOTA_PAUSED'
  if (code === 'subscription_sharing_usage_unavailable') return 'USAGE_SERVICE_UNAVAILABLE'
  if (code === 'subscription_sharing_invalid_user' || status === 401) return 'AUTH_REQUIRED'
  // A rate limit reported inside the event stream has no status of its own.
  if (status === 429 || code === 'rate_limit_exceeded') return 'THROTTLED'
  return 'RUNTIME_UNAVAILABLE'
}

const ADMISSIBLE = new Set<CapacityState>(['AVAILABLE', 'LIMIT_APPROACHING', 'USAGE_UNKNOWN'])

/** Pure admission decision. Unknown allowance is not an invented zero or 100 percent. */
export function routeCapacity(input: {
  role: IntelligenceRole
  candidates: readonly RoutingCandidate[]
  pools: readonly CapacityPool[]
  activeSession?: { provider: IntelligenceProvider; model: string }
  coherentBoundary: boolean
  allowPaid?: boolean
  /** An explicit advisory retry may probe a due pool; its adapter still owns the durable probe lease. */
  probePoolIds?: readonly string[]
}): CapacityRoutingDecision {
  const reasons: string[] = []
  const eligible = input.candidates.filter((c) => {
    const reject = (reason: string) => {
      reasons.push(`${c.provider}:${c.model}: ${reason}`)
      return false
    }
    if (!c.roles.includes(input.role)) return reject('ROLE_UNSUPPORTED')
    if (!c.qualityApproved || c.qualityEvidence.length === 0)
      return reject('QUALITY_EVIDENCE_REQUIRED')
    if (!c.available) return reject('PROVIDER_UNAVAILABLE')
    if (c.paid && !input.allowPaid) return reject('PAID_CONTINUATION_DISABLED')
    if (c.poolIds.length === 0) return reject('CAPACITY_BINDING_REQUIRED')
    if (
      c.poolIds.some((id) => {
        const p = input.pools.find((p) => p.id === id)
        const explicitProbe =
          p &&
          c.provider === 'openai' &&
          ['strategic', 'compiler', 'technical'].includes(input.role) &&
          p.state !== 'AUTH_REQUIRED' &&
          input.probePoolIds?.includes(id)
        return (
          !p || !p.consumers.includes(c.provider) || (!ADMISSIBLE.has(p.state) && !explicitProbe)
        )
      })
    )
      return reject('CAPACITY_NOT_ADMISSIBLE')
    if (c.reserve === 'STRATEGIC' && (input.role === 'worker' || input.role === 'reviewer'))
      return reject('STRATEGIC_RESERVE')
    return true
  })
  const sticky = eligible.find(
    (c) => c.provider === input.activeSession?.provider && c.model === input.activeSession.model,
  )
  const selected =
    sticky ?? (input.activeSession && !input.coherentBoundary ? undefined : eligible[0])
  if (!selected)
    return {
      action: 'WAIT',
      provider: null,
      model: null,
      reasons: [
        ...reasons,
        input.activeSession && !input.coherentBoundary
          ? 'CHECKPOINT_AT_COHERENT_BOUNDARY'
          : 'NO_QUALITY_SAFE_PROVIDER',
      ],
      qualityEvidence: [],
    }
  return {
    action: 'ROUTE',
    provider: selected.provider,
    model: selected.model,
    reasons: [
      ...reasons,
      sticky ? 'PRESERVE_VALUABLE_SESSION' : 'QUALITY_APPROVED_PROVIDER',
      ...(selected.poolIds.some((id) => input.probePoolIds?.includes(id))
        ? ['EXPLICIT_PROBE_DUE']
        : []),
    ],
    qualityEvidence: [...selected.qualityEvidence],
  }
}

/** A reset makes a probe due, never proves availability. Persist the returned state before probing. */
export function planCapacityProbe(pool: CapacityPool, now: number): CapacityPool {
  if (!Number.isFinite(now)) throw new Error('Invalid clock')
  const reset = pool.resetAt.confidence === 'EXACT' ? pool.resetAt.value : null
  const delay = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(pool.probeAttempts, 7))
  return {
    ...pool,
    nextProbeAt: reset !== null && reset > now ? reset + 30_000 : now + delay,
    probeAttempts: pool.probeAttempts + 1,
  }
}
