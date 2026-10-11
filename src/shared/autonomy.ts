import { z } from 'zod'
import { AgentRoleSchema } from './domain'
import { TrustClassSchema } from './security'

/**
 * 0.8 autonomy: what NEXUS may do in an enrolled project without asking. The user approves a boundary once
 * (the profile of a project, or a grant for something outside it); actions inside the boundary proceed, and
 * nothing a model, a repository or a web page says can widen it. See docs/AUTONOMY_MODEL.md.
 */

/** How a capability can come to be authorized. */
export const CAPABILITY_KINDS = [
  /** Part of what a profile pre-authorizes inside an enrolled project. */
  'PROFILE',
  /** Outside every profile: needs a grant the user gave for it. */
  'BOUNDARY',
  /** No grant exists for it. Nothing an agent runs gets it, whatever the user is asked. */
  'NEVER',
] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

/**
 * Every consequential thing an actor can ask for. The order is the order shown to the user. Adding one is a
 * change of the security policy: it needs a kind, a sentence and a place in the profiles below.
 */
export const AUTONOMY_CAPABILITIES = {
  READ_PROJECT: { kind: 'PROFILE', label: 'Read the project' },
  WRITE_WORKTREE: { kind: 'PROFILE', label: 'Edit the task worktree' },
  CREATE_TEMP: { kind: 'PROFILE', label: 'Create and remove temporary files in the task roots' },
  GIT_LOCAL: { kind: 'PROFILE', label: 'Use local Git (status, diff, branch, commit, worktree)' },
  RUN_TESTS: { kind: 'PROFILE', label: 'Run tests' },
  RUN_BUILD: { kind: 'PROFILE', label: 'Run builds' },
  RUN_LINT: { kind: 'PROFILE', label: 'Run linters and type checks' },
  RUN_FORMATTER: { kind: 'PROFILE', label: 'Run formatters' },
  RUN_PROJECT_COMMAND: { kind: 'PROFILE', label: 'Run project commands and scripts inside the containment' },
  INSTALL_PROJECT_DEPENDENCIES: { kind: 'PROFILE', label: 'Install project dependencies from the approved registries' },
  START_DEV_SERVER: { kind: 'PROFILE', label: 'Start the project development server' },
  STOP_PROJECT_PROCESS: { kind: 'PROFILE', label: 'Stop processes the task started' },
  LAUNCH_PROJECT_APP: { kind: 'PROFILE', label: 'Launch the project application' },
  LOCAL_APP_AUTOMATION: { kind: 'PROFILE', label: 'Operate the launched project application' },
  BROWSER_AUTOMATION: { kind: 'PROFILE', label: 'Drive an isolated browser' },
  SCREENSHOT_APP: { kind: 'PROFILE', label: 'Take screenshots of the application under test' },
  READ_APP_CONSOLE: { kind: 'PROFILE', label: 'Read the console of the application under test' },
  READ_APP_NETWORK: { kind: 'PROFILE', label: 'Read the network activity of the application under test' },
  PUBLIC_WEB_RESEARCH: { kind: 'PROFILE', label: 'Research the public web' },
  WEB_FETCH: { kind: 'PROFILE', label: 'Fetch public web pages' },
  DOWNLOAD_RESEARCH_ARTIFACT: { kind: 'PROFILE', label: 'Download research files into quarantine' },
  PACKAGE_REGISTRY_NETWORK: { kind: 'PROFILE', label: 'Reach the approved package registries' },
  LOCALHOST_APP_NETWORK: { kind: 'PROFILE', label: 'Reach the registered local endpoints of the project' },

  READ_PROJECT_SECRETS: { kind: 'BOUNDARY', label: 'Read secret files of the project (.env, keys)' },
  READ_OUTSIDE_PROJECT: { kind: 'BOUNDARY', label: 'Read files outside the enrolled project' },
  WRITE_OUTSIDE_PROJECT: { kind: 'BOUNDARY', label: 'Write or delete files outside the task roots' },
  GIT_PUSH: { kind: 'BOUNDARY', label: 'Push to a Git remote' },
  GIT_REMOTE_CHANGE: { kind: 'BOUNDARY', label: 'Change the Git remotes or shared Git configuration' },
  GIT_SHARED_HISTORY: { kind: 'BOUNDARY', label: 'Rewrite or move branches other than the task branch' },
  PUBLISH_PACKAGE: { kind: 'BOUNDARY', label: 'Publish a package' },
  DEPLOY: { kind: 'BOUNDARY', label: 'Deploy to an environment' },
  EXTERNAL_SIDE_EFFECT: { kind: 'BOUNDARY', label: 'Change something on a third-party service' },
  SEND_MESSAGE: { kind: 'BOUNDARY', label: 'Send a message or an email' },
  USE_CREDENTIAL: { kind: 'BOUNDARY', label: 'Use a credential or an account' },
  AUTHENTICATED_BROWSING: { kind: 'BOUNDARY', label: 'Browse while signed in to an account' },
  UNRESTRICTED_NETWORK: { kind: 'BOUNDARY', label: 'Give project code unrestricted network access' },
  EXTERNAL_HOST_NETWORK: { kind: 'BOUNDARY', label: 'Let project code reach a named external host' },
  INSTALL_GLOBAL_SOFTWARE: { kind: 'BOUNDARY', label: 'Install software for the whole machine or user' },
  MODIFY_SYSTEM_CONFIG: { kind: 'BOUNDARY', label: 'Change Windows configuration (registry, services, scheduled tasks, environment)' },
  ELEVATE: { kind: 'BOUNDARY', label: 'Run something as administrator' },
  UNCONTAINED_EXECUTION: { kind: 'BOUNDARY', label: 'Run project code outside the isolated profile' },
  PAID_PROVIDER_CREDITS: { kind: 'BOUNDARY', label: 'Spend separately billed provider credits' },
  FINANCIAL_TRANSACTION: { kind: 'BOUNDARY', label: 'Make a purchase or a payment' },

  ACCESS_PROVIDER_SECRETS: { kind: 'NEVER', label: 'Read provider credentials' },
  ACCESS_NEXUS_CONTROL_PLANE: { kind: 'NEVER', label: 'Reach the NEXUS runtime, its database or its keys' },
  PERSONAL_BROWSER_PROFILE: { kind: 'NEVER', label: "Use the user's own browser profile" },
  ALTER_SECURITY_POLICY: { kind: 'NEVER', label: 'Change the NEXUS security policy, a profile or a grant' },
  DISABLE_SECURITY_SOFTWARE: { kind: 'NEVER', label: 'Disable or reconfigure security software' },
  HOST_POWER: { kind: 'NEVER', label: 'Shut down, restart or suspend the machine' },
} as const satisfies Record<string, { kind: CapabilityKind; label: string }>

export type AutonomyCapability = keyof typeof AUTONOMY_CAPABILITIES
export const AUTONOMY_CAPABILITY_NAMES = Object.keys(AUTONOMY_CAPABILITIES) as [AutonomyCapability, ...AutonomyCapability[]]
export const AutonomyCapabilitySchema = z.enum(AUTONOMY_CAPABILITY_NAMES)

export function capabilityKind(capability: AutonomyCapability): CapabilityKind {
  return AUTONOMY_CAPABILITIES[capability].kind
}

export const AUTONOMY_PROFILES = ['AUTONOMOUS_PROJECT', 'BALANCED', 'LOCKED_DOWN'] as const
export const AutonomyProfileSchema = z.enum(AUTONOMY_PROFILES)
export type AutonomyProfile = z.infer<typeof AutonomyProfileSchema>

const PROFILE_CAPABILITIES = AUTONOMY_CAPABILITY_NAMES.filter((c) => AUTONOMY_CAPABILITIES[c].kind === 'PROFILE')

/** What BALANCED leaves to a grant: code that arrives from the network, and programs that stay running. */
const BALANCED_WITHHELD: readonly AutonomyCapability[] = ['INSTALL_PROJECT_DEPENDENCIES', 'PACKAGE_REGISTRY_NETWORK', 'DOWNLOAD_RESEARCH_ARTIFACT', 'START_DEV_SERVER', 'LAUNCH_PROJECT_APP', 'LOCAL_APP_AUTOMATION', 'LOCALHOST_APP_NETWORK']

/** LOCKED_DOWN: edit, build and test in the worktree. No network of any kind, no application, no browser. */
const LOCKED_DOWN_GRANTED: readonly AutonomyCapability[] = ['READ_PROJECT', 'WRITE_WORKTREE', 'CREATE_TEMP', 'GIT_LOCAL', 'RUN_TESTS', 'RUN_BUILD', 'RUN_LINT', 'RUN_FORMATTER', 'RUN_PROJECT_COMMAND', 'STOP_PROJECT_PROCESS']

/**
 * The capabilities a profile pre-authorizes inside an enrolled project. A capability of kind PROFILE that a
 * profile withholds can still be granted by the user, once, for that project. BOUNDARY and NEVER capabilities
 * are in no profile.
 */
export function profileCapabilities(profile: AutonomyProfile): ReadonlySet<AutonomyCapability> {
  if (profile === 'AUTONOMOUS_PROJECT') return new Set(PROFILE_CAPABILITIES)
  if (profile === 'BALANCED') return new Set(PROFILE_CAPABILITIES.filter((c) => !BALANCED_WITHHELD.includes(c)))
  return new Set(LOCKED_DOWN_GRANTED)
}

/** The sentences of the one-time enrollment summary: what a profile does without asking, and what it never does without a grant. */
export function profileSummary(profile: AutonomyProfile): { allowed: string[]; withheld: string[] } {
  const granted = profileCapabilities(profile)
  const allowed = PROFILE_CAPABILITIES.filter((c) => granted.has(c)).map((c) => AUTONOMY_CAPABILITIES[c].label)
  const withheld = AUTONOMY_CAPABILITY_NAMES.filter((c) => !granted.has(c) && AUTONOMY_CAPABILITIES[c].kind !== 'NEVER').map((c) => AUTONOMY_CAPABILITIES[c].label)
  return { allowed, withheld }
}

/**
 * 0.8: what holds while nobody is there. A mission runs in the runtime, not in a window: a closed window, a
 * locked screen or a night changes nothing about what NEXUS may do in an enrolled project. The authority is
 * the stored enrollment and the stored grants, read by the runtime; no window is consulted and none can widen it.
 *
 *  - What the profile allows goes on unattended exactly as it does attended.
 *  - What needs a grant and has none becomes ONE stored boundary request. The task that met it stops; work
 *    that does not depend on it goes on; the same need met again is the same request. Nothing is retried
 *    against a refusal and nothing waits on a dialog.
 *  - When the user answers (whenever that is), the work that waited is started again by NEXUS.
 *  - Three things need the user present, because they give lasting authority or change the machine: enrolling
 *    a project, allowing something for a whole project, and the one-time setup of the sandbox account. Each is
 *    confirmed by the runtime itself, natively. Unattended, none of them happens.
 */
export interface UnattendedPolicy {
  /** Done without anyone present, under this profile. */
  proceeds: string[]
  /** Becomes one boundary request and waits. */
  waits: string[]
  /** Never done by an agent, attended or not. */
  never: string[]
  /** Needs the user at the machine. */
  needsPresence: string[]
}

export const UNATTENDED_NEEDS_PRESENCE = ['Enrolling a project, or widening its profile', 'Allowing something for a whole project', 'The one-time setup of the sandbox account (a Windows administrator prompt)'] as const

export function unattendedPolicy(profile: AutonomyProfile): UnattendedPolicy {
  const granted = profileCapabilities(profile)
  return {
    proceeds: PROFILE_CAPABILITIES.filter((c) => granted.has(c)).map((c) => AUTONOMY_CAPABILITIES[c].label),
    waits: AUTONOMY_CAPABILITY_NAMES.filter((c) => !granted.has(c) && AUTONOMY_CAPABILITIES[c].kind !== 'NEVER').map((c) => AUTONOMY_CAPABILITIES[c].label),
    never: AUTONOMY_CAPABILITY_NAMES.filter((c) => AUTONOMY_CAPABILITIES[c].kind === 'NEVER').map((c) => AUTONOMY_CAPABILITIES[c].label),
    needsPresence: [...UNATTENDED_NEEDS_PRESENCE],
  }
}

/** What a grant or a request is about. `ANY` is every resource of the capability inside the project. */
export const RESOURCE_KINDS = ['ANY', 'PATH', 'HOST', 'GIT_REMOTE', 'COMMAND', 'PACKAGE', 'ENDPOINT', 'ACCOUNT'] as const
export const ResourceKindSchema = z.enum(RESOURCE_KINDS)
export type ResourceKind = z.infer<typeof ResourceKindSchema>

export const MAX_RESOURCE_CHARS = 600

export const CapabilityResourceSchema = z
  .object({
    kind: ResourceKindSchema,
    /** Normalized by the broker before it is compared or stored: a canonical path, a lower-case host, a remote name. Empty for ANY. */
    value: z.string().max(MAX_RESOURCE_CHARS),
  })
  .strict()
export type CapabilityResource = z.infer<typeof CapabilityResourceSchema>

export const GRANT_SCOPES = ['ONCE', 'MISSION', 'PROJECT'] as const
export const GrantScopeSchema = z.enum(GRANT_SCOPES)
export type GrantScope = z.infer<typeof GrantScopeSchema>

/** Only the user, or a policy the user stored beforehand, creates a grant. No model output is a creator. */
export const GRANT_CREATORS = ['USER', 'USER_POLICY'] as const
export type GrantCreator = (typeof GRANT_CREATORS)[number]

export interface CapabilityGrant {
  id: string
  projectId: string
  capability: AutonomyCapability
  scope: GrantScope
  /** The mission (run) a MISSION or ONCE grant belongs to; null for PROJECT. */
  runId: string | null
  /** `ANY`, or the one resource the grant covers. A PATH grant covers what lies under it; a HOST grant that host and no subdomain. */
  resource: CapabilityResource
  createdBy: GrantCreator
  createdAt: string
  /** Null: no expiry of its own. A MISSION grant also ends with its mission. */
  expiresAt: string | null
  reason: string
  /** The boundary request this grant answered, when it answered one. */
  requestId: string | null
  /** Set when a ONCE grant was used. */
  consumedAt: string | null
  revokedAt: string | null
}

export const BOUNDARY_REQUEST_STATES = ['PENDING', 'GRANTED', 'DENIED', 'EXPIRED'] as const
export type BoundaryRequestState = (typeof BOUNDARY_REQUEST_STATES)[number]

/**
 * One question for the user: an actor needs something outside what its project's profile and grants cover.
 * Identical needs are one request (`dedupeKey`), however many agents meet them and however often.
 */
export interface BoundaryRequest {
  id: string
  projectId: string
  /** The mission that first met the boundary. */
  runId: string | null
  taskId: string | null
  agentId: string | null
  capability: AutonomyCapability
  resource: CapabilityResource
  /** What was about to be done, redacted and on one line. Written by NEXUS from the tool call, not by the agent. */
  action: string
  /** Why the broker asks: the rule, in NEXUS's words. */
  reason: string
  dedupeKey: string
  state: BoundaryRequestState
  /** How many times the same need was met while this request existed. */
  occurrences: number
  createdAt: string
  lastSeenAt: string
  decidedAt: string | null
  /** The scope the user chose when granting. */
  decidedScope: GrantScope | null
  grantId: string | null
}

export const BROKER_OUTCOMES = ['AUTHORIZED', 'DENIED', 'BOUNDARY_GRANT_REQUIRED'] as const
export type BrokerOutcome = (typeof BROKER_OUTCOMES)[number]

/** Who asks. The broker never takes an actor's word for its role: the caller in NEXUS fills this in. */
export const ACTOR_KINDS = ['WORKER', 'VERIFIER', 'PLANNER', 'DIRECTOR', 'TASK_COMPILER', 'RESEARCH_AGENT', 'NEXUS'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number]

export const CapabilityRequestSchema = z
  .object({
    capability: AutonomyCapabilitySchema,
    actor: z.object({ kind: z.enum(ACTOR_KINDS), agentId: z.string().max(128).nullable(), role: AgentRoleSchema.nullable() }).strict(),
    projectId: z.string().min(1).max(128),
    runId: z.string().max(128).nullable(),
    taskId: z.string().max(128).nullable(),
    resource: CapabilityResourceSchema,
    trustClass: TrustClassSchema,
    provider: z.string().max(40).nullable(),
    executable: z.string().max(600).nullable(),
    args: z.array(z.string().max(2000)).max(64),
    cwd: z.string().max(600).nullable(),
    networkTarget: z.string().max(MAX_RESOURCE_CHARS).nullable(),
    /** One redacted line for the audit log and for a boundary request. */
    action: z.string().max(400),
    reason: z.string().max(400),
  })
  .strict()
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>

export type BrokerDecision =
  | { outcome: 'AUTHORIZED'; by: 'PROFILE' | 'GRANT'; grantId: string | null; capability: AutonomyCapability }
  | { outcome: 'DENIED'; capability: AutonomyCapability; reason: string }
  | { outcome: 'BOUNDARY_GRANT_REQUIRED'; capability: AutonomyCapability; requestId: string; deduplicated: boolean; reason: string }

/** A project's standing with NEXUS: enrolled by the user with one profile, or not enrolled (the approvals of 0.7 apply). */
export interface ProjectEnrollment {
  projectId: string
  profile: AutonomyProfile
  enrolledAt: string
  /** The version of the capability table the user saw when enrolling. A later version that widens a profile asks again. */
  policyVersion: string
}

/** Bump when a capability changes kind, or a profile gains one: an enrollment made under an older version is shown its difference. */
export const AUTONOMY_POLICY_VERSION = '0.8.0-autonomy.1'

export const SECURITY_EVENT_SEVERITIES = [
  'NORMAL_AUTONOMOUS_ACTION',
  'POLICY_DENIAL',
  'INJECTION_DETECTED',
  'BOUNDARY_REQUEST',
  'ISOLATION_FAILURE',
  'ESCAPE_ATTEMPT',
  'CREDENTIAL_ACCESS_ATTEMPT',
] as const
export type SecurityEventSeverity = (typeof SECURITY_EVENT_SEVERITIES)[number]

/** Which severities are worth the user's attention. The rest is kept for inspection and tells nobody. */
export function severityNotifies(severity: SecurityEventSeverity): boolean {
  return severity === 'BOUNDARY_REQUEST' || severity === 'ISOLATION_FAILURE' || severity === 'ESCAPE_ATTEMPT' || severity === 'CREDENTIAL_ACCESS_ATTEMPT'
}

export interface AutonomyAuditEvent {
  seq: number
  id: string
  timestamp: string
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  severity: SecurityEventSeverity
  capability: AutonomyCapability | null
  outcome: BrokerOutcome | null
  /** What authorized it: the profile's name, a grant id, or null. */
  authorizedBy: string | null
  action: string
  resource: string
  reason: string
}

/** The user's answer to a boundary request. */
export const BoundaryDecisionSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    decision: z.enum(['ALLOW_ONCE', 'ALLOW_MISSION', 'ALLOW_PROJECT', 'DENY']),
  })
  .strict()
export type BoundaryDecision = z.infer<typeof BoundaryDecisionSchema>

/** The scopes a capability may be granted for. A purchase is never "always". */
export function allowedScopes(capability: AutonomyCapability): GrantScope[] {
  if (capabilityKind(capability) === 'NEVER') return []
  if (capability === 'FINANCIAL_TRANSACTION' || capability === 'ELEVATE' || capability === 'PAID_PROVIDER_CREDITS') return ['ONCE']
  if (capability === 'UNCONTAINED_EXECUTION' || capability === 'DEPLOY' || capability === 'PUBLISH_PACKAGE' || capability === 'SEND_MESSAGE') return ['ONCE', 'MISSION']
  return ['ONCE', 'MISSION', 'PROJECT']
}

/** A boundary request as the window shows it: the row, with the words and the answers that may be given. */
export interface BoundaryRequestView extends BoundaryRequest {
  capabilityLabel: string
  resourceLabel: string
  projectName: string
  missionTitle: string | null
  scopes: GrantScope[]
}

export interface AutonomyOverview {
  enrollment: ProjectEnrollment | null
  /** The sentences of the profile: of the project as it is, or of a profile being considered. */
  summary: { allowed: string[]; withheld: string[] } | null
  /** What holds for this profile while nobody is there. Null when the project is not enrolled and no profile is being considered. */
  unattended: UnattendedPolicy | null
  grants: (CapabilityGrant & { capabilityLabel: string; resourceLabel: string; active: boolean })[]
  pending: BoundaryRequestView[]
  recentDenials: AutonomyAuditEvent[]
  /** Counts per severity over the project's audit log. */
  counts: Record<string, number>
  policyVersion: string
  /** True when the enrollment was made under an older capability table than the current one. */
  policyChanged: boolean
}

export const MAX_AUTONOMY_AUDIT_PAGE = 200

export const AutonomyAuditInputSchema = z
  .object({
    projectId: z.string().min(1).max(128).optional(),
    runId: z.string().min(1).max(128).optional(),
    severities: z.array(z.enum(SECURITY_EVENT_SEVERITIES)).max(SECURITY_EVENT_SEVERITIES.length).optional(),
    limit: z.number().int().min(1).max(MAX_AUTONOMY_AUDIT_PAGE).optional(),
    before: z.number().int().min(1).optional(),
  })
  .strict()

export interface AutonomyAuditPage {
  events: AutonomyAuditEvent[]
  nextBefore: number | null
}

/** What the status bar shows about autonomy, for every project at once. */
export interface AutonomyStatus {
  pendingBoundaryRequests: number
}
