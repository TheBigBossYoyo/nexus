import type { AgentRole } from '@shared/domain'
import type { Capability, ExecutionProfile } from '@shared/security'
import { isInspectionOnlyRole, isWritingRole } from './tools'

export interface CapabilityOptions {
  allowNetworkTools: boolean
  profile: ExecutionProfile
}

/**
 * What a role may do, as a set of capabilities. The execution policy consults it: a role without
 * INTERPRETER_EXEC cannot run an interpreter at all, a role without WRITE_WORKTREE cannot run agent-authored
 * scripts without approval, and SYSTEM_CHANGE is granted to nobody (the registry, services, scheduled tasks and
 * power are never agent powers; the few things that can still be approved are approved one call at a time).
 */
export function capabilitiesForRole(role: AgentRole, opts: CapabilityOptions): ReadonlySet<Capability> {
  const caps = new Set<Capability>(['READ_PROJECT'])
  if (isInspectionOnlyRole(role)) {
    if (opts.allowNetworkTools) caps.add('NETWORK')
    return caps
  }
  caps.add('RUN_TESTS')
  caps.add('RUN_BUILD')
  caps.add('PACKAGE_INSTALL')
  caps.add('INTERPRETER_EXEC')
  if (isWritingRole(role)) {
    caps.add('WRITE_WORKTREE')
    caps.add('GIT_LOCAL')
    // Writing roles can run network-capable tools (installs, git fetch) in STANDARD; those calls are still gated
    // by the classifier. RESTRICTED takes the network away unless the user allowed network tools.
    if (opts.profile === 'STANDARD' || opts.allowNetworkTools) caps.add('NETWORK')
  } else if (opts.allowNetworkTools) {
    caps.add('NETWORK')
  }
  return caps
}
