import type { SecurityDecisionRecord } from '@shared/security'
import { summarizeToolInput } from './describe'

/** Where decisions go. The persisted repository implements it; tests pass an array-backed sink. */
export interface SecurityDecisionSink {
  record(entry: Omit<SecurityDecisionRecord, 'seq'>): void
}

const SECRETISH_NAME = '[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|cookie|bearer)[A-Za-z0-9_.-]*'

/**
 * Makes a one-line action summary safe to keep: values after secret-looking names, bearer tokens, URL
 * credentials and long opaque strings (keys, encoded commands) are replaced. The log keeps what was attempted,
 * not what it carried.
 */
export function redactAction(text: string): string {
  return text
    .replace(new RegExp(`(\\b${SECRETISH_NAME}\\s*[=:]\\s*)((?:bearer|basic|token)\\s+)?("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1[redacted]')
    .replace(new RegExp(`(--?${SECRETISH_NAME}\\s+)("[^"]*"|'[^']*'|[^\\s-]\\S*)`, 'gi'), '$1[redacted]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[redacted]@')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, '[redacted]')
}

/** Redacted summary of a tool call, for the decision log. */
export function actionSummary(toolName: string, input: unknown): string {
  return redactAction(summarizeToolInput(toolName, input)).slice(0, 300)
}
