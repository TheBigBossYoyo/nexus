import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { ProviderService } from '@main/modules/providers'

type V6Channel = Extract<IpcChannel, `providers.${string}`>
export type V6Handlers = { [C in V6Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface V6Context {
  providers?: ProviderService
}

/** v0.6 channels: provider discovery, the provider policy, an explicit health probe, and who ran which session. */
export function createV6Handlers(ctx: V6Context): V6Handlers {
  const service = (): ProviderService => {
    if (!ctx.providers) throw new NexusError('runtime_unavailable', 'Providers are not available in this process')
    return ctx.providers
  }
  return {
    'providers.overview': () => service().overview(),
    'providers.refresh': async () => {
      await service().refresh()
      return service().overview()
    },
    'providers.setPolicy': ({ policy }) => service().setPolicy(policy),
    'providers.probe': async ({ provider }) => {
      const result = await service().probe(provider)
      return { ok: result.ok, detail: result.detail, status: result.status }
    },
    'providers.sessions': ({ runId }) => (ctx.providers ? ctx.providers.sessionsOfRun(runId) : []),
  }
}

export function unavailableV6Handlers(): V6Handlers {
  return createV6Handlers({})
}
