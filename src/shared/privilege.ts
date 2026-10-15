import { z } from 'zod'

/**
 * 0.9.1: privilege sessions. The owner authorizes ONE elevation while they are there (one UAC prompt); a temporary
 * broker holds the elevated token for the session's scope; NEXUS and every agent stay unelevated. An agent never
 * gets a shell, a handle or a token: it proposes a structured operation (a program by its path, its arguments as a
 * list, a capability), which is checked by deterministic policy, reviewed by the Technical Director (and the Director
 * Council when the operation warrants it), checked again by the same deterministic policy (a model's approval never
 * makes a forbidden operation allowed), run by the broker, verified, and recorded. Every attempt is recorded,
 * refused ones included.
 */

export const PRIVILEGE_SCOPES = ['SINGLE_OPERATION', 'MISSION', 'UNTIL_IDLE', 'OVERNIGHT'] as const
export type PrivilegeSessionScope = (typeof PRIVILEGE_SCOPES)[number]

/**
 * What a session may be used for. Narrow on purpose: there is no ADMIN_SHELL. Each one is a template in the policy
 * engine (which programs, which arguments, whether the Council is required).
 */
export const PRIVILEGED_CAPABILITIES = [
  'NEXUS_SANDBOX_REPAIR',
  'NEXUS_CANONICALIZATION_REPAIR',
  'NEXUS_SCHEDULED_TASK_REPAIR',
  'PROJECT_TOOLCHAIN_INSTALL',
  'PROJECT_TOOLCHAIN_REPAIR',
  'APP_INSTALL_TEST',
  'APP_UNINSTALL_TEST',
  'PROJECT_SERVICE_CONTROL',
  'NEXUS_FIREWALL_RECONCILIATION',
  'KNOWN_DEPENDENCY_MACHINE_INSTALL',
  'SIGNED_DRIVER_QUERY',
  /** The acceptance fixture: a registry key and a folder of NEXUS's own name, nothing else. */
  'NEXUS_ACCEPTANCE_FIXTURE',
] as const
export type PrivilegedCapability = (typeof PRIVILEGED_CAPABILITIES)[number]

/** The capabilities a session gets when the owner does not narrow them. The fixture is never among them. */
export const DEFAULT_SESSION_CAPABILITIES: readonly PrivilegedCapability[] = PRIVILEGED_CAPABILITIES.filter((c) => c !== 'NEXUS_ACCEPTANCE_FIXTURE')

/**
 * What no agent may do under any privilege session, whatever a reviewer says. A distinct workflow of the owner's
 * own, or never.
 */
export const FORBIDDEN_PRIVILEGED_ACTIONS = [
  'DISABLE_UAC',
  'DISABLE_DEFENDER',
  'DISABLE_BITDEFENDER',
  'CREATE_ADMIN_USER',
  'CHANGE_USER_PASSWORD',
  'MODIFY_UNRELATED_USER_ACCOUNTS',
  'REMOVE_WINDOWS_SECURITY_POLICY',
  'OPEN_NEXUS_CONTROL_PLANE_TO_INTERNET',
  'INSTALL_ARBITRARY_KERNEL_DRIVER',
  'CHANGE_BOOT_CONFIGURATION',
  'READ_CREDENTIAL_STORE_ARBITRARILY',
  'EXPORT_USER_SECRETS',
  'DELETE_UNRELATED_USER_FILES',
  'ALTER_NEXUS_PRIVILEGED_POLICY',
  'GRANT_THEMSELVES_NEW_PRIVILEGED_CAPABILITIES',
  /** Any interpreter of a command string (cmd /c, powershell -Command, an encoded command, mshta, ...). */
  'ARBITRARY_SHELL',
] as const
export type ForbiddenPrivilegedAction = (typeof FORBIDDEN_PRIVILEGED_ACTIONS)[number]

export const PRIVILEGED_REQUESTER_ROLES = ['WORKER', 'VERIFIER', 'PLANNER', 'DIRECTOR', 'NEXUS'] as const
export type PrivilegedRequesterRole = (typeof PRIVILEGED_REQUESTER_ROLES)[number]

const path = z.string().min(3).max(260)
const sha = z.string().regex(/^[0-9a-f]{64}$/)

/** What an agent proposes. Everything a reviewer needs (B6), and nothing that is a command string. */
export const PrivilegedOperationProposalSchema = z
  .object({
    capability: z.enum(PRIVILEGED_CAPABILITIES),
    goal: z.string().min(1).max(600),
    whyRequired: z.string().min(1).max(800),
    whyElevation: z.string().min(1).max(800),
    whyNoUnelevatedAlternative: z.string().min(1).max(800),
    executable: path,
    args: z.array(z.string().max(4096)).max(64).default([]),
    cwd: path.optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).default({}),
    /** SHA-256 of the executable, required when it is outside the protected program folders. */
    sha256: sha.optional(),
    /** Files an argument names (a script, a package) with the SHA-256 that was reviewed. */
    inputs: z.array(z.object({ arg: z.number().int().min(0).max(63), sha256: sha }).strict()).max(8).default([]),
    /** Indexes of arguments that are secret: never shown, never logged, never given to a reviewer. */
    secretArgs: z.array(z.number().int().min(0).max(63)).max(16).default([]),
    expected: z
      .object({
        files: z.array(z.string().max(300)).max(20).default([]),
        registry: z.array(z.string().max(300)).max(20).default([]),
        services: z.array(z.string().max(200)).max(20).default([]),
        network: z.string().max(400).default('none'),
      })
      .strict()
      .default({ files: [], registry: [], services: [], network: 'none' }),
    rollback: z.string().max(800).default(''),
    timeoutMs: z.number().int().min(1000).max(1_800_000).default(300_000),
    /** What this operation follows from, when it is the repair of an earlier one. */
    followsOperationId: z.string().max(80).optional(),
  })
  .strict()
export type PrivilegedOperationProposal = z.infer<typeof PrivilegedOperationProposalSchema>

/** A proposal with who made it and where, as NEXUS knows it (never as the agent says it). */
export interface PrivilegedOperationRequest extends PrivilegedOperationProposal {
  id: string
  sessionId: string | null
  requestedAt: string
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  role: PrivilegedRequesterRole
  missionTitle: string | null
  taskTitle: string | null
  /** Where the proposal came from: an agent's tool call, NEXUS itself, the acceptance fixture. */
  provenance: string
}

export const PRIVILEGED_REVIEW_VERDICTS = ['APPROVE', 'REJECT', 'SAFER_ALTERNATIVE_REQUIRED'] as const
export type PrivilegedReviewVerdict = (typeof PRIVILEGED_REVIEW_VERDICTS)[number]
export const PRIVILEGED_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type PrivilegedRisk = (typeof PRIVILEGED_RISKS)[number]

/** The concise structured result a reviewer returns. No chain of thought is kept. */
export const PrivilegedReviewResultSchema = z
  .object({
    verdict: z.enum(PRIVILEGED_REVIEW_VERDICTS),
    risk: z.enum(PRIVILEGED_RISKS),
    reason: z.string().min(1).max(600),
    restrictions: z.array(z.string().max(200)).max(10),
  })
  .strict()
export type PrivilegedReviewResult = z.infer<typeof PrivilegedReviewResultSchema>

export interface PrivilegedOperationReview extends PrivilegedReviewResult {
  reviewer: 'CLAUDE_TECHNICAL_DIRECTOR' | 'DIRECTOR_COUNCIL'
  at: string
  /** The reviewer could not give a valid result: that counts as a rejection. */
  failed: boolean
}

export type PolicyVerdict = 'ALLOWED' | 'DENIED'

export interface PrivilegedPolicyDecision {
  verdict: PolicyVerdict
  reason: string
  /** Set when the request touches the absolute deny list. */
  forbidden: ForbiddenPrivilegedAction | null
  /** Whether the full Director Council must approve as well as the Technical Director. */
  councilRequired: boolean
  councilWhy: string[]
  /**
   * 0.9.1 (review F3): whether the owner must confirm this very operation, natively, after the reviews: it runs a
   * file that is neither a Windows program nor a script NEXUS ships (an agent may have written or fetched it), and
   * no model may be the last word on that. Absent on decisions recorded before.
   */
  ownerRequired?: boolean
  ownerWhy?: string[]
}

/**
 * What became of an attempt. Every attempt has one, refused ones included. EXECUTING is written before the program
 * starts and replaced by the outcome (review F6); one left behind by a stopped NEXUS is closed as ABORTED.
 */
export const PRIVILEGED_OUTCOMES = ['EXECUTED', 'FAILED', 'REJECTED_BY_POLICY', 'REJECTED_BY_DIRECTOR', 'DECLINED_BY_OWNER', 'ABORTED', 'TIMEOUT', 'EXECUTING'] as const
export type PrivilegedOutcome = (typeof PRIVILEGED_OUTCOMES)[number]

/** The record of one privileged attempt: what the morning report and the Activity screen show (B12). */
export interface PrivilegedOperationReceipt {
  id: string
  sessionId: string | null
  requestedAt: string
  finishedAt: string
  projectId: string | null
  runId: string | null
  taskId: string | null
  missionTitle: string | null
  taskTitle: string | null
  role: PrivilegedRequesterRole
  agentId: string | null
  capability: PrivilegedCapability
  goal: string
  whyRequired: string
  whyElevation: string
  whyNoUnelevatedAlternative: string
  /** The executable, arguments and environment names as they may be shown: secret arguments replaced. */
  executable: string
  args: string[]
  cwd: string | null
  envNames: string[]
  expected: PrivilegedOperationProposal['expected']
  rollback: string
  provenance: string
  followsOperationId: string | null
  precheck: PrivilegedPolicyDecision
  reviews: PrivilegedOperationReview[]
  finalPolicy: PrivilegedPolicyDecision | null
  outcome: PrivilegedOutcome
  /** Why it ended as it did, in one sentence. */
  outcomeReason: string
  exitCode: number | null
  durationMs: number | null
  /** What was verified afterwards (files, registry, services), and what was seen. */
  observed: string[]
  /** The program's output, cut and with secrets removed. */
  stdout: string
  stderr: string
  stagedSha256: string | null
}

export const PRIVILEGE_SESSION_STATES = ['PREPARING', 'ACTIVE', 'ENDED', 'DECLINED', 'FAILED'] as const
export type PrivilegeSessionState = (typeof PRIVILEGE_SESSION_STATES)[number]

export interface PrivilegeSessionStatus {
  id: string
  scope: PrivilegeSessionScope
  runId: string | null
  projectId: string | null
  state: PrivilegeSessionState
  capabilities: PrivilegedCapability[]
  createdAt: string
  activeAt: string | null
  expiresAt: string
  endedAt: string | null
  endReason: string | null
  /** The UAC prompts this session caused: 1 when it was prepared, never more. */
  uacPrompts: number
  /** Whether the broker really runs elevated (false only in tests of the protocol). */
  elevated: boolean
  counts: Record<PrivilegedOutcome, number>
}

export const PrivilegePrepareInputSchema = z
  .object({
    scope: z.enum(PRIVILEGE_SCOPES),
    runId: z.string().max(80).nullable().default(null),
    capabilities: z.array(z.enum(PRIVILEGED_CAPABILITIES)).max(PRIVILEGED_CAPABILITIES.length).optional(),
    /** How long the session may last at most. Overnight: until the run ends, never more than 14 hours. */
    hours: z.number().min(0.25).max(14).optional(),
  })
  .strict()
export type PrivilegePrepareInput = z.infer<typeof PrivilegePrepareInputSchema>

/** The text the Overnight setup and the Mission page show next to the choice (B15). */
export const PRIVILEGE_SESSION_NOTICE =
  'One Windows UAC prompt will appear now. During this session NEXUS may use the resulting temporary broker only for approved, security-reviewed privileged operations. Every privileged attempt and result will be recorded in the report. The broker shuts down by itself when the session ends.'
