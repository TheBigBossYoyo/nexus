import type { SecurityDecisionRecord } from '@shared/security'
import { summarizeToolInput } from './describe'

/** Where decisions go. The persisted repository implements it; tests pass an array-backed sink. */
export interface SecurityDecisionSink {
  record(entry: Omit<SecurityDecisionRecord, 'seq'>): void
}

const SECRETISH_NAME = '[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|cookie|bearer|signature|sig)[A-Za-z0-9_.-]*'
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`
const QUERY_NAMES = String.raw`(?:sig|signature|token|access_token|id_token|refresh_token|key|api_key|apikey|secret|password|passwd|pwd|code|auth|authorization|credential|session|sas)`

/**
 * Makes a one-line action summary safe to keep. Replaced: values after secret-looking names, `--password X`
 * style options, `curl -u user:pass`, `sshpass -p X`, `mysql -pX`, authorization and cookie headers, bearer
 * tokens, URL credentials and secret-named query values, well-known token prefixes and long opaque strings. The
 * log keeps what was attempted, not what it carried. Redact BEFORE truncating, never after.
 */
export function redactAction(text: string): string {
  return (
    text
      // Headers: the whole quoted header value goes.
      .replace(/(-H|--header)(\s+|=)("[^"]*(?:authorization|cookie|x-api-key|api-key|token|secret)[^"]*"|'[^']*(?:authorization|cookie|x-api-key|api-key|token|secret)[^']*')/gi, '$1$2"[redacted header]"')
      // curl -u user:pass / --user user:pass; sshpass -p X; mysql -pX / -p X after a mysql-like command.
      .replace(/(\s(?:-u|--user|--proxy-user)(?:\s+|=))("[^"]*"|'[^']*'|[^\s:]+:\S+)/g, '$1[redacted]')
      .replace(/(\bsshpass\s+(?:-\w+\s+)*-p\s*)\S+/gi, '$1[redacted]')
      .replace(/(\b(?:mysql|mysqldump|mariadb|mysqladmin)\w*(?:\s[^|;&\n]*?)?\s-p)(?!\s)\S+/gi, '$1[redacted]')
      // secret-named assignments and options: NAME=value, NAME: value, --NAME value, --NAME=value.
      .replace(new RegExp(String.raw`(\b${SECRETISH_NAME}\s*[=:]\s*)((?:bearer|basic|token)\s+)?${VALUE}`, 'gi'), '$1[redacted]')
      .replace(new RegExp(String.raw`(--?${SECRETISH_NAME}\s+)${VALUE}`, 'gi'), '$1[redacted]')
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
      // URL credentials and secret-named query parameters.
      .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[redacted]@')
      .replace(new RegExp(String.raw`([?&;]${QUERY_NAMES}=)[^&\s"']+`, 'gi'), '$1[redacted]')
      .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]')
      .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, '[redacted]')
  )
}

const RAW_LIMIT = 4000
const SUMMARY_LIMIT = 300

/** Redacted summary of a tool call, for the decision log. The raw summary is redacted first and only then shortened. */
export function actionSummary(toolName: string, input: unknown): string {
  const redacted = redactAction(summarizeToolInput(toolName, input, RAW_LIMIT))
  return redacted.length > SUMMARY_LIMIT ? `${redacted.slice(0, SUMMARY_LIMIT - 1)}…` : redacted
}
