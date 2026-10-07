import type { ContextPressure, SessionAction, ToolResultState } from '@shared/token'

/**
 * Context pressure and what to do about it. Everything here advises: the runtime owns its own compaction and
 * tool-result clearing, and NEXUS owns only the decision to end a session with a handoff.
 */

/** Share of the window in use at which each level starts. */
export const PRESSURE_THRESHOLDS = { moderate: 0.5, high: 0.7, critical: 0.85 } as const

export function pressureOf(contextTokens: number | null, maxTokens: number | null): ContextPressure {
  if (contextTokens === null || maxTokens === null || maxTokens <= 0) return 'LOW'
  const share = contextTokens / maxTokens
  if (share >= PRESSURE_THRESHOLDS.critical) return 'CRITICAL'
  if (share >= PRESSURE_THRESHOLDS.high) return 'HIGH'
  if (share >= PRESSURE_THRESHOLDS.moderate) return 'MODERATE'
  return 'LOW'
}

// ───────────────────────────── budget ─────────────────────────────

export interface BudgetInput {
  /** The model's context window, when the runtime reported it. */
  windowTokens: number | null
  /** What the runtime's own prompt and tool definitions take, when known. */
  fixedTokens: number | null
  /** Tokens already in the conversation. */
  historyTokens: number
  risk: 'low' | 'medium' | 'high' | 'critical'
  /** The user's advisory budget for the graph part of a pack. */
  graphBudget: number
}

export interface ContextBudget {
  pressure: ContextPressure
  /** Advisory tokens for graph context in the next prompt NEXUS builds. Never a cap on required context. */
  graphTokens: number
  /** Room kept for the model's output and for tool results it has not requested yet. */
  outputHeadroom: number
  toolHeadroom: number
  /** How much of the window is free after the fixed part, the history and the headroom. Null when the window is unknown. */
  freeTokens: number | null
  note: string
}

const DEFAULT_WINDOW = 200_000

/**
 * How much room there is and how the graph part of a pack should use it. Pressure narrows the graph
 * retrieval; risk widens it. Where the two disagree, risk wins: quality is never traded for room.
 */
export function allocateBudget(input: BudgetInput): ContextBudget {
  const window = input.windowTokens && input.windowTokens > 0 ? input.windowTokens : DEFAULT_WINDOW
  const fixed = input.fixedTokens ?? 0
  const used = fixed + input.historyTokens
  const pressure = pressureOf(used, window)
  const outputHeadroom = Math.min(32_000, Math.round(window * 0.1))
  const toolHeadroom = Math.min(40_000, Math.round(window * 0.15))
  const free = input.windowTokens ? Math.max(0, window - used - outputHeadroom - toolHeadroom) : null
  const riskFactor = input.risk === 'critical' ? 3 : input.risk === 'high' ? 2 : 1
  const pressureFactor = pressure === 'LOW' ? 1 : pressure === 'MODERATE' ? 0.75 : 0.5
  const graphTokens = Math.round(input.graphBudget * Math.max(riskFactor, 1) * (riskFactor > 1 ? 1 : pressureFactor))
  const note =
    riskFactor > 1
      ? `Risk is ${input.risk}: the graph budget is widened ${riskFactor}x and is not narrowed by pressure.`
      : pressure === 'LOW'
        ? 'Pressure is low: the full graph budget applies.'
        : `Pressure is ${pressure.toLowerCase()}: graph retrieval is more selective.`
  return { pressure, graphTokens, outputHeadroom, toolHeadroom, freeTokens: free, note }
}

// ───────────────────────────── session efficiency ─────────────────────────────

export interface SessionEfficiencyInput {
  turns: number
  /** The turn count at which 0.7.0 rotates. 0 disables rotation. */
  rotationTurns: number
  /** Tokens in the session's context, as the runtime reported. Null when it did not. */
  contextTokens: number | null
  maxTokens: number | null
  /** Tokens of tool results in the context, when the runtime split them out. */
  toolResultTokens: number | null
  /** True when the turn that just ended hit the per-session turn limit. */
  hitTurnLimit: boolean
  /** Compactions the runtime already did in this session. */
  compactions: number
  /** Whether a structured handoff can carry the work over (the agent works on a task). */
  canHandoff: boolean
  /** Decide by pressure. When false the 0.7.0 rule applies unchanged. */
  pressureRotation: boolean
  risk?: 'low' | 'medium' | 'high' | 'critical'
}

export interface SessionEfficiencyDecision {
  pressure: ContextPressure
  action: SessionAction
  reason: string
}

/**
 * What to do with a session at the end of a turn.
 *
 * With `pressureRotation` off this is exactly 0.7.0: rotate when the turn limit was hit. With it on, a
 * session that hit the turn limit while its context is still small is KEPT (a rotation would throw away a
 * warm cache and pay for a handoff to drop little), and a session under critical pressure is rotated even
 * before the turn limit, provided a handoff can carry the work.
 *
 * COMPACT and CLEAR_STALE_TOOL_RESULTS are reported, not executed: the runtime does both by itself.
 */
export function decideSessionAction(input: SessionEfficiencyInput): SessionEfficiencyDecision {
  const pressure = pressureOf(input.contextTokens, input.maxTokens)
  const rotationOn = input.rotationTurns > 0 && input.canHandoff
  if (!input.pressureRotation) {
    if (input.hitTurnLimit && rotationOn) return { pressure, action: 'HANDOFF_AND_ROTATE', reason: `The session reached its limit of ${input.rotationTurns} turns.` }
    return { pressure, action: 'KEEP', reason: 'The session is within its turn limit.' }
  }

  if (input.contextTokens === null || input.maxTokens === null) {
    // No figure from the runtime: fall back to the turn rule rather than guess.
    if (input.hitTurnLimit && rotationOn) return { pressure, action: 'HANDOFF_AND_ROTATE', reason: `The runtime reported no context size; the session reached its limit of ${input.rotationTurns} turns.` }
    return { pressure, action: 'KEEP', reason: 'The runtime reported no context size and the session is within its turn limit.' }
  }

  const share = input.contextTokens / input.maxTokens
  const pct = `${Math.round(share * 100)}%`
  if (pressure === 'CRITICAL') {
    if (rotationOn) return { pressure, action: 'HANDOFF_AND_ROTATE', reason: `The context is ${pct} full: a fresh session with a handoff is safer than working at the edge of the window.` }
    return { pressure, action: 'COMPACT', reason: `The context is ${pct} full and the work cannot be handed off; the runtime compacts by itself.` }
  }
  if (input.hitTurnLimit && rotationOn) {
    if (pressure === 'LOW') return { pressure, action: 'KEEP', reason: `The session reached ${input.rotationTurns} turns but its context is only ${pct} full: rotating would discard a warm cache to drop little.` }
    return { pressure, action: 'HANDOFF_AND_ROTATE', reason: `The session reached ${input.rotationTurns} turns and its context is ${pct} full.` }
  }
  if (pressure === 'HIGH') {
    const toolShare = input.toolResultTokens !== null ? input.toolResultTokens / input.contextTokens : 0
    if (toolShare >= 0.5) return { pressure, action: 'CLEAR_STALE_TOOL_RESULTS', reason: `The context is ${pct} full and ${Math.round(toolShare * 100)}% of it is tool results; every result is stored outside the context, so the runtime may clear the old ones.` }
    return { pressure, action: 'KEEP', reason: `The context is ${pct} full; no action until it is critical.` }
  }
  return { pressure, action: 'KEEP', reason: `The context is ${pct} full.` }
}

// ───────────────────────────── tool-result states ─────────────────────────────

export interface ResultStateInput {
  /** The result reports a failure that is still being repaired, or a finding that still stands. */
  unresolved: boolean
  /** A later result of the same kind (the same check, the same command) exists. */
  superseded: boolean
  /** The raw result is stored where it can be read again. */
  stored: boolean
  /** How many results of this kind came after it. */
  age: number
}

/**
 * Which of the four states a result is in. Only RETRIEVABLE and STALE results may be left out of a prompt,
 * and a result that is not stored is never either: what cannot be read again is not removed.
 */
export function resultState(input: ResultStateInput): ToolResultState {
  if (input.unresolved) return 'PINNED'
  if (!input.stored) return 'ACTIVE'
  if (input.superseded) return 'STALE'
  return input.age >= 1 ? 'RETRIEVABLE' : 'ACTIVE'
}

export function mayLeaveOut(state: ToolResultState): boolean {
  return state === 'RETRIEVABLE' || state === 'STALE'
}
