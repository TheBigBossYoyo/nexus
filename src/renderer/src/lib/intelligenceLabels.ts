import type { CompilationMode } from '@shared/intelligence'

/** The compilation depths as a user reads them. The name used in the documentation stays visible in brackets. */
export const COMPILATION_MODE_LABEL: Record<CompilationMode, string> = {
  AUTO: 'Automatic: NEXUS picks the depth (AUTO)',
  EXACT: 'Exact wording, nothing added, no provider (EXACT)',
  LIGHT: 'Light: local checks only, no provider (LIGHT)',
  STANDARD: 'Standard: developed with ChatGPT (STANDARD)',
  TECHNICAL: 'Technical: ChatGPT, then a challenge by Claude (TECHNICAL)',
  COUNCIL: 'Council: ChatGPT, Claude, then a synthesis (COUNCIL)',
}

const STATE_LABEL: Record<string, string> = {
  PENDING: 'In progress',
  INVOKING: 'In progress',
  REQUESTED: 'Saved, not sent',
  WAITING_FOR_PROVIDER: 'Waiting for a provider',
  WAITING_FOR_CAPACITY: 'Waiting for a provider',
  USER_DECISION_REQUIRED: 'Needs your decision',
  READY: 'Ready',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  DISMISSED: 'Dismissed',
  ADMITTED: 'Admitted',
  INTERRUPTED: 'Interrupted',
}

/** A stored state as a user reads it. A state with no wording of its own is shown in lower case, never as a code. */
export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? sentence(state)
}

/** `SOME_CODE` as "Some code": for values that have no wording of their own. */
export function sentence(code: string): string {
  const words = code.replaceAll('_', ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Where a line of a specification came from, as a user reads it. */
export const PROVENANCE_LABEL: Record<string, string> = {
  USER_EXPLICIT: 'you wrote this',
  USER_CONFIRMED: 'you confirmed this',
  CONTEXT_DERIVED: 'added from project knowledge',
  DIRECTOR_RECOMMENDED: 'recommended by the strategic model',
  TECHNICAL_REQUIREMENT: 'recommended by the technical model',
  ASSUMPTION: 'an assumption, not confirmed',
}

/** What kind of addition a recommendation is. */
export const KIND_LABEL: Record<string, string> = {
  REQUIREMENT: 'Requirement',
  ACCEPTANCE: 'Acceptance criterion',
  CONSTRAINT: 'Constraint',
  NON_GOAL: 'Not in scope',
  RISK: 'Risk',
  ASSUMPTION: 'Assumption',
  UNKNOWN: 'Open question',
  VERIFICATION: 'How to verify',
}

export const provenanceLabel = (code: string): string => PROVENANCE_LABEL[code] ?? sentence(code)
export const kindLabel = (code: string): string => KIND_LABEL[code] ?? sentence(code)
