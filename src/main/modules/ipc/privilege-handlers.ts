import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { PrivilegeService } from '../privilege/service'
import { buildPrivilegedActivityReport } from '../privilege/report'

/**
 * 0.9.1: privilege sessions from the window. Only the window reaches these channels: no agent session, no message
 * of the Director Line and no call can prepare a session (a remote command never creates administrator authority).
 * Preparing one needs no NEXUS dialog of its own: the UAC prompt it raises is Windows' own consent, on the secure
 * desktop, which nothing in NEXUS can answer.
 */

export interface PrivilegeHandlerContext {
  service: () => PrivilegeService | null
  unavailableReason: string | null
  /** The project a run belongs to, or null. */
  projectOfRun: (runId: string) => string | null
}

type PrivilegeHandlers = { [C in Extract<IpcChannel, `privilege.${string}`>]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export function createPrivilegeHandlers(ctx: PrivilegeHandlerContext): PrivilegeHandlers {
  return {
    'privilege.status': () => {
      const service = ctx.service()
      return { available: service !== null, unavailableReason: service === null ? ctx.unavailableReason ?? 'Privilege sessions are not available.' : null, active: service?.status() ?? null, recent: service?.history(10) ?? [] }
    },
    'privilege.prepare': async (input) => {
      const service = ctx.service()
      if (service === null) throw new NexusError('invalid_state', ctx.unavailableReason ?? 'Privilege sessions are not available.')
      const runId = input.runId ?? null
      const projectId = runId !== null ? ctx.projectOfRun(runId) : null
      if (runId !== null && projectId === null) throw new NexusError('not_found', 'No such run.')
      const result = await service.prepare({ scope: input.scope, runId, projectId, ...(input.capabilities ? { capabilities: input.capabilities } : {}), ...(input.hours !== undefined ? { hours: input.hours } : {}) })
      return { ok: result.ok, reason: result.ok ? null : result.reason, status: result.status }
    },
    'privilege.revoke': async () => {
      const service = ctx.service()
      if (service === null || service.status() === null) return { ok: false }
      await service.end('revoked by the owner')
      return { ok: true }
    },
    'privilege.activity': ({ runId, sessionId }) => {
      const service = ctx.service()
      if (service === null) return { receipts: [], report: '' }
      const receipts = service.receipts({ ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}), limit: 500 })
      const sessions = service.history(50).filter((s) => (runId === undefined || s.runId === runId) && (sessionId === undefined || s.id === sessionId))
      return { receipts, report: buildPrivilegedActivityReport(receipts, sessions) }
    },
  }
}
