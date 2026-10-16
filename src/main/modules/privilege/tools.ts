import { PrivilegedOperationProposalSchema, type PrivilegedRequesterRole } from '@shared/privilege'
import type { AgentRole } from '@shared/domain'
import { parseExtensionCall } from '../agent-runtime/extension-tools'
import type { ExtensionSession } from '../research/tools'
import { receiptForAgent, type PrivilegeService } from './service'

/**
 * 0.9.1: `privileged_request`, the only way an agent reaches administrator rights. It submits a structured proposal
 * to the privilege service and gets the receipt back. Who asks (project, run, task, agent, role) is taken from the
 * session NEXUS started, never from the proposal. Offered to the roles that implement and verify; read-only roles
 * have no use for it.
 */

const ROLES: Partial<Record<AgentRole, PrivilegedRequesterRole>> = { worker: 'WORKER', debugger: 'WORKER', verifier: 'VERIFIER' }

export function createPrivilegedTools(deps: { service: () => PrivilegeService | null }): (session: ExtensionSession) => { groups: string[]; call: (input: unknown) => Promise<string> } | null {
  return (session) => {
    const role = ROLES[session.role]
    if (role === undefined) return null
    const groups = ['privileged']
    const call = async (input: unknown): Promise<string> => {
      const parsed = parseExtensionCall(input, groups)
      if (!parsed.ok) return `Not done: ${parsed.error}`
      const service = deps.service()
      if (service === null) return 'Not done: privilege sessions are not available in this build.'
      const proposal = PrivilegedOperationProposalSchema.parse(parsed.args)
      const receipt = await service.submit(proposal, {
        projectId: session.run.projectId,
        runId: session.run.id,
        taskId: session.task?.id ?? null,
        agentId: session.agentId,
        role,
        missionTitle: session.run.prompt.split('\n')[0]?.slice(0, 120) ?? null,
        taskTitle: session.task?.title ?? null,
        provenance: `agent tool call (${session.role})`,
      })
      return receiptForAgent(receipt)
    }
    return { groups, call }
  }
}
