import type { RunState, Task } from '@shared/domain'

const PASSIVE_STATES = new Set(['draft', 'blocked', 'failed', 'completed', 'cancelled'])
const REVIEW_ROLES = new Set(['reviewer', 'security_reviewer'])

/**
 * Which active phase best describes the run, from its tasks alone.
 * Repairing wins if any repair task is in flight; otherwise verifying or reviewing win when
 * they are at least as common as implementation work (ties favour the later phase).
 * Verifier/reviewer-role tasks count towards their phase while running. `testing` is never
 * derived: it is entered explicitly while the orchestrator runs check commands.
 */
export function deriveRunPhase(tasks: readonly Task[]): RunState {
  const inFlight = tasks.filter((t) => !PASSIVE_STATES.has(t.state))
  if (inFlight.some((t) => t.kind === 'repair')) return 'repairing'

  let verifying = 0
  let reviewing = 0
  let executing = 0
  for (const t of inFlight) {
    if (t.state === 'verification' || t.role === 'verifier') verifying++
    else if (t.state === 'review' || REVIEW_ROLES.has(t.role)) reviewing++
    else executing++
  }
  if (verifying > 0 && verifying >= reviewing && verifying >= executing) return 'verifying'
  if (reviewing > 0 && reviewing >= executing) return 'reviewing'
  return 'executing'
}
