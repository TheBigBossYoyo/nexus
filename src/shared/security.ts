import { z } from 'zod'

/**
 * 0.7 execution security. These are vocabulary types shared by the policy code in main, the persisted
 * decision log and the renderer. Static inspection of commands and scripts is a defence layer, not a sandbox:
 * nothing here confines a process once it runs (see docs/SECURITY.md, "Not a full OS sandbox").
 */

/** Who wrote or vouches for the code that is about to run. */
export const TRUST_CLASSES = [
  /** NEXUS's own commands (its git calls, its verification runner). Never reachable from an agent tool call. */
  'TRUSTED_NEXUS_INTERNAL',
  /** A command the user configured for the project (check commands, safe prefixes, package scripts they own). */
  'TRUSTED_PROJECT_COMMAND',
  /** A file or script body an agent wrote or changed (tool call, redirection, or a difference from the base commit). */
  'UNTRUSTED_AGENT_AUTHORED',
  /** Code that is in the repository's base commit and unchanged. Written by someone else; not vetted by NEXUS. */
  'UNTRUSTED_REPOSITORY_CODE',
  /** Touches the machine or NEXUS itself: power, registry, services, credentials, NEXUS data. */
  'SYSTEM_SENSITIVE',
] as const
export const TrustClassSchema = z.enum(TRUST_CLASSES)
export type TrustClass = z.infer<typeof TrustClassSchema>

export const EXECUTION_DECISIONS = ['ALLOW', 'ALLOW_WITH_AUDIT', 'REQUIRE_APPROVAL', 'DENY'] as const
export const ExecutionDecisionSchema = z.enum(EXECUTION_DECISIONS)
export type ExecutionDecision = z.infer<typeof ExecutionDecisionSchema>

/** What an agent role may do. SYSTEM_CHANGE is granted to no role: it is shown so that the absence is explicit. */
export const CAPABILITIES = [
  'READ_PROJECT',
  'WRITE_WORKTREE',
  'GIT_LOCAL',
  'RUN_TESTS',
  'RUN_BUILD',
  'NETWORK',
  'PACKAGE_INSTALL',
  'INTERPRETER_EXEC',
  'SYSTEM_CHANGE',
] as const
export const CapabilitySchema = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof CapabilitySchema>

/**
 * STANDARD: developer-oriented behaviour plus inspection and an audit trail.
 * RESTRICTED: stricter gates (no inline interpreter code, approval for agent-authored scripts and package
 * scripts, no network unless allowed, a narrower read scope). Neither is an operating-system sandbox.
 */
export const EXECUTION_PROFILES = ['STANDARD', 'RESTRICTED'] as const
export const ExecutionProfileSchema = z.enum(EXECUTION_PROFILES)
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>

/** Where the thing being run came from, as far as NEXUS could establish. */
export const PROVENANCE_KINDS = [
  'agent_authored',
  'agent_modified',
  'repository_unmodified',
  'configured_command',
  'inline_code',
  'not_applicable',
  'unknown',
] as const
export const ProvenanceKindSchema = z.enum(PROVENANCE_KINDS)
export type ProvenanceKind = z.infer<typeof ProvenanceKindSchema>

/** Bump when the rules change so that old log rows can be read against the rules that produced them. */
export const SECURITY_POLICY_VERSION = '0.7.0-exec.1'

export interface SecurityDecisionRecord {
  /** Monotonic position in the log; the paging cursor. */
  seq: number
  id: string
  timestamp: string
  runId: string | null
  taskId: string | null
  agentId: string | null
  /** Redacted one-line summary of the tool call (summarizeToolInput). Never environment values or file contents. */
  action: string
  classification: TrustClass
  provenance: ProvenanceKind
  decision: ExecutionDecision
  reason: string
  policyVersion: string
}

export const MAX_DECISION_PAGE = 200

export const SecurityDecisionsInputSchema = z
  .object({
    runId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(MAX_DECISION_PAGE).optional(),
    /** Cursor: only rows with a `seq` below this one are returned (the `nextBefore` of the previous page). */
    before: z.number().int().min(1).optional(),
  })
  .strict()
export type SecurityDecisionsInput = z.infer<typeof SecurityDecisionsInputSchema>

export interface SecurityDecisionPage {
  decisions: SecurityDecisionRecord[]
  /** Pass as `before` for the next page; null when there are no older rows. */
  nextBefore: number | null
}
