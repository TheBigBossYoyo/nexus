import type { ExecutionDecision, ProvenanceKind, TrustClass } from '@shared/security'
import type { Tone } from '../../lib/status'

/** Wording for the "Why was this blocked?" panel. Plain sentences; nothing here promises more than the policy does. */

export const DECISION_LABEL: Record<ExecutionDecision, string> = {
  ALLOW: 'Allowed',
  ALLOW_WITH_AUDIT: 'Allowed and logged',
  REQUIRE_APPROVAL: 'Asked for approval',
  DENY: 'Refused',
}

export const DECISION_TONE: Record<ExecutionDecision, Tone> = {
  ALLOW: 'success',
  ALLOW_WITH_AUDIT: 'neutral',
  REQUIRE_APPROVAL: 'warning',
  DENY: 'danger',
}

export const TRUST_LABEL: Record<TrustClass, string> = {
  TRUSTED_NEXUS_INTERNAL: 'NEXUS internal',
  TRUSTED_PROJECT_COMMAND: 'Configured project command',
  UNTRUSTED_AGENT_AUTHORED: 'Written by an agent',
  UNTRUSTED_REPOSITORY_CODE: 'Repository code',
  SYSTEM_SENSITIVE: 'Touches the system',
}

export const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  agent_authored: 'Created by an agent',
  agent_modified: 'Changed by an agent',
  repository_unmodified: 'Unchanged from the base commit',
  configured_command: 'Configured command',
  inline_code: 'Inline code',
  not_applicable: 'Not a file',
  unknown: 'Unknown origin',
}

export const PROFILE_EXPLANATION =
  'STANDARD keeps developer flows working: project tests and builds run, and anything an agent wrote or changed that is then run is inspected and logged. RESTRICTED is stricter: inline interpreter code is refused, scripts an agent wrote and package scripts an agent changed need your approval, network use is refused unless web tools are allowed, and installs always ask. Neither is a sandbox. NEXUS reads commands and scripts before they run; it cannot confine a program once it runs. Compiled programs, code that builds its commands at run time and test files that a test runner executes can still do things NEXUS never saw.'
