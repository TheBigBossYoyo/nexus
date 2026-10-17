import { PrivilegedOperationProposalSchema, type PrivilegedRequesterRole } from '@shared/privilege'
import type { AgentRole } from '@shared/domain'
import { parseExtensionCall } from '../agent-runtime/extension-tools'
import type { ExtensionSession } from '../research/tools'
import { receiptForAgent, type MalformedIssue, type PrivilegeService, type PrivilegedRequester } from './service'

/**
 * 0.9.1: `privileged_request`, the only way an agent reaches administrator rights. It submits a structured proposal
 * to the privilege service and gets the receipt back. Who asks (project, run, task, agent, role) is taken from the
 * session NEXUS started, never from the proposal. Offered to the roles that implement and verify; read-only roles
 * have no use for it.
 */

const ROLES: Partial<Record<AgentRole, PrivilegedRequesterRole>> = { worker: 'WORKER', debugger: 'WORKER', verifier: 'VERIFIER' }

function requester(session: ExtensionSession, role: PrivilegedRequesterRole): PrivilegedRequester {
  return {
    projectId: session.run.projectId,
    runId: session.run.id,
    taskId: session.task?.id ?? null,
    agentId: session.agentId,
    role,
    missionTitle: session.run.prompt.split('\n')[0]?.slice(0, 120) ?? null,
    taskTitle: session.task?.title ?? null,
    provenance: `agent tool call (${session.role})`,
  }
}

export function createPrivilegedTools(deps: { service: () => PrivilegeService | null }): (session: ExtensionSession) => { groups: string[]; call: (input: unknown) => Promise<string> } | null {
  return (session) => {
    const role = ROLES[session.role]
    if (role === undefined) return null
    const groups = ['privileged']
    // 0.9.1 (second review, L9): a request that does not match the schema is refused and recorded, not only refused.
    const malformed = async (service: PrivilegeService, raw: unknown, issues: readonly MalformedIssue[]): Promise<string> => {
      try {
        return `Not done: ${receiptForAgent(await service.rejectMalformed(raw, issues, requester(session, role)))}`
      } catch {
        return 'Not done: the request did not match the schema and was refused.'
      }
    }
    const call = async (input: unknown): Promise<string> => {
      const parsed = parseExtensionCall(input, groups)
      if (!parsed.ok) {
        // Not a call of this tool at all: nothing to record.
        if (parsed.error === 'Not a tool call.' || parsed.error === 'This session has no such tool.' || (input as { name?: unknown }).name !== 'privileged_request') return `Not done: ${parsed.error}`
        const service = deps.service()
        // No service, no store: the request is refused and not recorded.
        if (service === null) return `Not done: ${parsed.error}`
        const raw = (input as { args?: unknown }).args ?? {}
        return malformed(service, raw, PrivilegedOperationProposalSchema.safeParse(raw).error?.issues ?? [])
      }
      const service = deps.service()
      if (service === null) return 'Not done: privilege sessions are not available in this build.'
      const proposal = PrivilegedOperationProposalSchema.safeParse(parsed.args)
      if (!proposal.success) return malformed(service, parsed.args, proposal.error.issues)
      return receiptForAgent(await service.submit(proposal.data, requester(session, role)))
    }
    return { groups, call }
  }
}
