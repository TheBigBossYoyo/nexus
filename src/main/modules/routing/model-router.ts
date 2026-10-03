import {
  WRITING_ROLES,
  type AgentPurpose,
  type AgentRole,
  type Complexity,
  type ModelTier,
  type Preset,
  type Risk,
  type Severity,
  type TaskKind,
} from '@shared/domain'
import type { PerformanceStat, RoutingPolicy } from '@shared/v2'

export interface RouteInput {
  role: AgentRole
  purpose: AgentPurpose
  /** The run's role → tier policy (already preset-adjusted by settings). */
  rolePolicy: Record<AgentRole, ModelTier>
  preset: Preset
  complexity?: Complexity
  risk?: Risk
  /** 1-based attempt about to start. */
  attempt?: number
  repairCycle?: number
  triggeringSeverity?: Severity | null
  /** Explicit escalation already stored on the task. */
  tierOverride?: ModelTier | null
  stats?: readonly PerformanceStat[]
  /** Settings lookup; null or empty means no model is configured for the tier. */
  modelForTier: (tier: ModelTier) => string | null
  category?: TaskKind
}

export interface RouteResult {
  requestedPolicy: RoutingPolicy
  resolvedPolicy: RoutingPolicy
  resolvedTier: ModelTier | null
  resolvedModel: string | null
  reasons: string[]
}

/** Promotion order, weakest first. */
const TIER_ORDER: readonly ModelTier[] = ['fast', 'balanced', 'strongest']
/** Planning and verification gates are never held back by the ECO preset. */
const GATE_ROLES: readonly AgentRole[] = ['planner', 'verifier']

const rank = (t: ModelTier): number => TIER_ORDER.indexOf(t)
const policyOf = (t: ModelTier): RoutingPolicy => t.toUpperCase() as RoutingPolicy
const oneStepUp = (t: ModelTier): ModelTier => TIER_ORDER[Math.min(rank(t) + 1, TIER_ORDER.length - 1)] ?? t

/**
 * Decide the capability tier for a session. Rules run in a fixed order, each appending a reason:
 * role policy, high risk / large complexity, repeated attempt, repair after a serious finding,
 * explicit override, measured performance, then resolution to a concrete model. Pure and total.
 */
export function routeModel(input: RouteInput): RouteResult {
  const { role } = input
  const requested: ModelTier = input.rolePolicy[role] ?? 'balanced'
  let tier = requested
  const reasons = [`Role policy for ${role} asks for ${policyOf(requested)}.`]

  // ECO never promotes a non-gate role above BALANCED (or above what the policy already chose),
  // except through an explicit override or a HIGH/CRITICAL finding.
  const ecoCap: ModelTier | null =
    input.preset === 'eco' && !GATE_ROLES.includes(role)
      ? rank(requested) > rank('balanced')
        ? requested
        : 'balanced'
      : null

  const raise = (target: ModelTier, why: string, exempt = false): void => {
    let goal = target
    let capped = false
    if (ecoCap !== null && !exempt && rank(goal) > rank(ecoCap)) {
      goal = ecoCap
      capped = true
    }
    if (rank(goal) <= rank(tier)) {
      reasons.push(
        capped
          ? `${why}; held at ${policyOf(tier)} by the ECO preset.`
          : `${why}; already ${policyOf(tier)}, no change.`,
      )
      return
    }
    reasons.push(
      `${why}: ${policyOf(tier)} -> ${policyOf(goal)}${capped ? ' (capped by the ECO preset)' : ''}.`,
    )
    tier = goal
  }

  if (WRITING_ROLES.includes(role) && (input.risk === 'high' || input.complexity === 'large')) {
    const why = input.risk === 'high' ? 'High-risk task with a writing role' : 'Large task with a writing role'
    raise('strongest', why)
  }

  if ((input.attempt ?? 1) >= 2) {
    raise(oneStepUp(tier), `Attempt ${input.attempt} after an earlier failure`)
  }

  const severity = input.triggeringSeverity
  if ((input.repairCycle ?? 0) >= 1 && (severity === 'high' || severity === 'critical')) {
    raise('strongest', `Repair cycle ${input.repairCycle} after a ${severity.toUpperCase()} finding`, true)
  }

  if (input.tierOverride) {
    raise(input.tierOverride, `Task escalated to ${policyOf(input.tierOverride)}`, true)
  }

  if (input.category !== undefined && input.stats) {
    const current = input.modelForTier(tier)
    const stat = current
      ? input.stats.find((s) => s.role === role && s.model === current && s.category === input.category)
      : undefined
    if (stat && stat.sufficient && stat.firstPassRate < 0.5) {
      const passed = Math.round(stat.firstPassRate * stat.samples)
      const pct = Math.round(stat.firstPassRate * 100)
      raise(
        oneStepUp(tier),
        `Measured performance of ${current} for ${role}/${input.category}: first-pass ${passed}/${stat.samples} = ${pct}% (below 50%)`,
      )
    }
  }

  const model = input.modelForTier(tier)
  if (model === null || model.trim() === '') {
    reasons.push(`No model is configured for ${policyOf(tier)}; using the runtime default (INHERIT).`)
    return {
      requestedPolicy: policyOf(requested),
      resolvedPolicy: 'INHERIT',
      resolvedTier: null,
      resolvedModel: null,
      reasons,
    }
  }
  reasons.push(`${policyOf(tier)} resolves to ${model}.`)
  return {
    requestedPolicy: policyOf(requested),
    resolvedPolicy: policyOf(tier),
    resolvedTier: tier,
    resolvedModel: model,
    reasons,
  }
}
