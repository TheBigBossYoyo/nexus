import { capabilityKind, type ActorKind, type AutonomyCapability } from '@shared/autonomy'
import type { AgentRole } from '@shared/domain'

/**
 * RoleCapabilityContract: what an actor of a given role can ever be authorized for, whatever the profile and
 * the grants say. A profile says what a project allows; the contract says what a role is for. Both must agree.
 * Planning reads the same table (see `canRoleExercise`), so a plan cannot ask a role for a step it cannot run.
 */

const READ: AutonomyCapability[] = ['READ_PROJECT']
const RESEARCH: AutonomyCapability[] = ['PUBLIC_WEB_RESEARCH', 'WEB_FETCH']
const RUN: AutonomyCapability[] = ['CREATE_TEMP', 'RUN_TESTS', 'RUN_BUILD', 'RUN_LINT', 'RUN_PROJECT_COMMAND', 'STOP_PROJECT_PROCESS', 'INSTALL_PROJECT_DEPENDENCIES', 'PACKAGE_REGISTRY_NETWORK']
const APP: AutonomyCapability[] = ['START_DEV_SERVER', 'LAUNCH_PROJECT_APP', 'LOCAL_APP_AUTOMATION', 'BROWSER_AUTOMATION', 'SCREENSHOT_APP', 'READ_APP_CONSOLE', 'READ_APP_NETWORK', 'LOCALHOST_APP_NETWORK']
const WRITE: AutonomyCapability[] = ['WRITE_WORKTREE', 'GIT_LOCAL', 'RUN_FORMATTER', 'DOWNLOAD_RESEARCH_ARTIFACT']

/** Boundary capabilities a role may ask the user for. A role that only reads never asks to push or to publish. */
const READER_BOUNDARIES: AutonomyCapability[] = ['READ_PROJECT_SECRETS', 'READ_OUTSIDE_PROJECT']
const VERIFIER_BOUNDARIES: AutonomyCapability[] = [...READER_BOUNDARIES, 'EXTERNAL_HOST_NETWORK', 'UNRESTRICTED_NETWORK', 'USE_CREDENTIAL', 'UNCONTAINED_EXECUTION']

const ROLE_CONTRACT: Record<AgentRole, ReadonlySet<AutonomyCapability>> = {
  worker: new Set([...READ, ...RESEARCH, ...RUN, ...APP, ...WRITE]),
  debugger: new Set([...READ, ...RESEARCH, ...RUN, ...APP, ...WRITE]),
  reviewer: new Set([...READ, ...RESEARCH, ...RUN, ...APP]),
  verifier: new Set([...READ, ...RESEARCH, ...RUN, ...APP]),
  planner: new Set([...READ, ...RESEARCH]),
  architect: new Set([...READ, ...RESEARCH]),
  researcher: new Set([...READ, ...RESEARCH, 'DOWNLOAD_RESEARCH_ARTIFACT', 'BROWSER_AUTOMATION']),
  security_reviewer: new Set([...READ, ...RESEARCH]),
}

const ROLE_BOUNDARIES: Record<AgentRole, ReadonlySet<AutonomyCapability> | 'ALL'> = {
  worker: 'ALL',
  debugger: 'ALL',
  reviewer: new Set(VERIFIER_BOUNDARIES),
  verifier: new Set(VERIFIER_BOUNDARIES),
  planner: new Set(READER_BOUNDARIES),
  architect: new Set(READER_BOUNDARIES),
  researcher: new Set(READER_BOUNDARIES),
  security_reviewer: new Set(READER_BOUNDARIES),
}

/** Actors that are not a task role. None of them runs project code, writes a worktree or asks for a boundary. */
const ACTOR_CONTRACT: Partial<Record<ActorKind, ReadonlySet<AutonomyCapability>>> = {
  DIRECTOR: new Set(RESEARCH),
  TASK_COMPILER: new Set(RESEARCH),
  RESEARCH_AGENT: new Set([...RESEARCH, 'DOWNLOAD_RESEARCH_ARTIFACT', 'BROWSER_AUTOMATION']),
}

export interface ContractActor {
  kind: ActorKind
  role: AgentRole | null
}

/**
 * Whether the actor could hold the capability at all. NEVER capabilities are held by nobody. NEXUS's own
 * commands in a project (the dependency setup, the check commands) run with what a worker may do.
 */
export function canRoleExercise(actor: ContractActor, capability: AutonomyCapability): boolean {
  const kind = capabilityKind(capability)
  if (kind === 'NEVER') return false
  const fixed = ACTOR_CONTRACT[actor.kind]
  if (fixed !== undefined) return fixed.has(capability)
  const role: AgentRole = actor.kind === 'NEXUS' ? 'worker' : (actor.role ?? 'planner')
  if (kind === 'PROFILE') return ROLE_CONTRACT[role].has(capability)
  const boundaries = ROLE_BOUNDARIES[role]
  return boundaries === 'ALL' || boundaries.has(capability)
}

/** Every profile capability a role can hold, for the planner's view of what a task of that role can be asked to do. */
export function roleCapabilities(role: AgentRole): ReadonlySet<AutonomyCapability> {
  return ROLE_CONTRACT[role]
}
