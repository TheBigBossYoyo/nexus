import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { Repositories } from '@main/modules/persistence'

type SecurityChannel = Extract<IpcChannel, `security.${string}`>
export type SecurityHandlers = { [C in SecurityChannel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

/**
 * v0.7 security channels. Read-only: the renderer can look at why a call was blocked, never change a
 * decision. The input is an optional run id, a limit of at most 200 and a cursor; nothing in it is executed.
 */
export function createSecurityHandlers(repos: Pick<Repositories, 'securityDecisions'>): SecurityHandlers {
  return {
    'security.decisions': ({ runId, limit, before }) => repos.securityDecisions.list({ runId, limit, before }),
  }
}
