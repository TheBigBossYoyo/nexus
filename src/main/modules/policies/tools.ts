import type { AgentRole } from '@shared/domain'
import { WRITING_ROLES } from '@shared/domain'

export const SHELL_TOOLS = ['Bash', 'PowerShell'] as const
export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch'] as const

export function isWritingRole(role: AgentRole): boolean {
  return WRITING_ROLES.includes(role)
}

/** Roles that must only inspect and verify; shell access is restricted by command classification. */
export function isInspectionOnlyRole(role: AgentRole): boolean {
  return role === 'planner' || role === 'architect' || role === 'researcher' || role === 'security_reviewer'
}

/** Built-in tools a role may see. Agent/Task are never included. */
export function toolsForRole(role: AgentRole, opts: { allowNetworkTools: boolean }): string[] {
  const tools: string[] = ['Read', 'Glob', 'Grep']
  const writing = isWritingRole(role)
  if (writing) tools.push(...WRITE_TOOLS)
  tools.push(...SHELL_TOOLS)
  if (writing) tools.push('TodoWrite')
  if (!writing && opts.allowNetworkTools) tools.push(...NETWORK_TOOLS)
  return tools
}
