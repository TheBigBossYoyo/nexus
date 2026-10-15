import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import { DEFAULT_SESSION_CAPABILITIES } from '@shared/privilege'
import type { PrivilegeService } from '../privilege/service'
import { buildPrivilegedActivityReport } from '../privilege/report'

/**
 * 0.9.1: privilege sessions from the window. No agent tool, no message of the Director Line and no call can prepare a
 * session without the owner (a remote command never creates administrator authority). Review F5: any client holding
 * the runtime's token reaches these channels, and a UAC prompt at a moment someone else chose is easy to accept: a
 * session is prepared only after NEXUS's own confirmation (natively, as Overnight's authorization), then the UAC
 * prompt. An Overnight run that prepares its session was confirmed by its own authorization.
 */

export interface PrivilegeHandlerContext {
  service: () => PrivilegeService | null
  unavailableReason: string | null
  /** The project a run belongs to, or null. */
  projectOfRun: (runId: string) => string | null
  /** The owner's confirmation, natively; no answer is a no. Absent: no session is prepared. */
  confirm?: (message: string, detail: string) => Promise<boolean>
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
      const capabilities = input.capabilities ?? DEFAULT_SESSION_CAPABILITIES
      const asked = service.status() === null && ctx.confirm !== undefined
        ? await ctx.confirm(
            'Prepare an administrator session for NEXUS?',
            [`Scope: ${input.scope.toLowerCase().replace(/_/g, ' ')}${runId ? ` (mission ${runId})` : ''}${input.hours !== undefined ? `, at most ${input.hours} h` : ''}.`, `What it may be used for: ${capabilities.join(', ')}.`, 'Windows will then ask for administrator rights once (UAC). Every operation is still checked by the policy and reviewed; one that runs a file NEXUS does not ship asks you again. If you did not ask for this, choose Cancel.'].join('\n\n'),
          ).catch(() => false)
        : service.status() !== null
      if (!asked) return { ok: false, reason: ctx.confirm === undefined ? 'NEXUS cannot ask for your confirmation here, so no administrator session is prepared.' : 'Not confirmed: no administrator session was prepared.', status: service.status() }
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
