import type { ipcInputs, IpcChannel, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { z } from 'zod'

/** The channels added in 0.3. Their handlers live here so `handlers.ts` stays the 0.2.1 surface. */
export type V3Channel = Extract<
  IpcChannel,
  `usage.${string}` | `arena.${string}` | `policy.${string}` | `speculative.${string}` | `home.${string}` | `activity.${string}`
>

export type V3Handlers = {
  [C in V3Channel]: (input: z.output<(typeof ipcInputs)[C]>) => Promise<IpcOutputs[C]> | IpcOutputs[C]
}

const V3_CHANNELS: readonly V3Channel[] = [
  'usage.overview',
  'usage.totals',
  'usage.breakdown',
  'usage.limitHistory',
  'usage.run',
  'usage.efficiency',
  'usage.refresh',
  'usage.resumeNow',
  'usage.endWait',
  'arena.cases',
  'arena.importCase',
  'arena.trustCase',
  'arena.campaigns',
  'arena.createCampaign',
  'arena.campaign',
  'arena.trials',
  'arena.trial',
  'arena.start',
  'arena.pause',
  'arena.resume',
  'arena.cancel',
  'arena.results',
  'policy.overview',
  'policy.snapshot',
  'policy.compare',
  'policy.learn',
  'policy.promote',
  'policy.reject',
  'policy.rollback',
  'policy.pin',
  'policy.setConfig',
  'policy.decisions',
  'policy.preview',
  'policy.run',
  'speculative.list',
  'home.summary',
  'activity.recent',
]

/** Placeholder until the 0.3 services are wired: every channel answers with a typed error. */
export function unavailableV3Handlers(): V3Handlers {
  const unavailable = (channel: string) => (): never => {
    throw new NexusError('runtime_unavailable', `${channel} is not available in this process`)
  }
  return Object.fromEntries(V3_CHANNELS.map((c) => [c, unavailable(c)])) as unknown as V3Handlers
}
