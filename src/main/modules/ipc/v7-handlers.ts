import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { ConnectionState, RuntimeStatus } from '@shared/runtime-protocol'
import type { WorkersOverview } from '@shared/workers'
import type { ControlPlane } from '@main/modules/control-plane'

type V7Channel = Extract<IpcChannel, `control.${string}` | `runtime.${string}` | `desktop.${string}`>
export type V7Handlers = { [C in V7Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface V7Context {
  control?: ControlPlane
  decisions?: { ofItem(itemId: string, limit?: number): { at: string; itemId: string; decision: string; reason: string }[] }
  /** The runtime process itself. Absent in a process that is not one (unit tests of the handlers). */
  runtime?: {
    status(): RuntimeStatus
    workers(): WorkersOverview
    workerSelfTest(): Promise<{ ok: boolean; pid: number | null; capabilities: string[]; milliseconds: number; detail: string }>
    tray(): unknown
    /** Begins a clean stop and returns at once; false when the user declined. */
    shutdown(): Promise<boolean>
  }
}

/**
 * v0.7 channels: the global queue, limits, schedules and runtime health. Every channel names an item or a
 * schedule by id and a value from a closed set; none takes a command, a path or free text that is executed.
 */
export function createV7Handlers(ctx: V7Context): V7Handlers {
  const control = (): ControlPlane => {
    if (!ctx.control) throw new NexusError('runtime_unavailable', 'The control plane is not available in this process')
    return ctx.control
  }
  const runtime = (): NonNullable<V7Context['runtime']> => {
    if (!ctx.runtime) throw new NexusError('runtime_unavailable', 'This process is not the NEXUS runtime')
    return ctx.runtime
  }
  return {
    'control.overview': () => control().overview(),
    'control.enqueue': ({ item }) => control().enqueue(item),
    'control.setPriority': ({ itemId, priority }) => control().setPriority(itemId, priority),
    'control.move': ({ itemId, where }) => control().move(itemId, where),
    'control.pause': ({ itemId }) => control().pause(itemId),
    'control.resume': ({ itemId }) => control().resume(itemId),
    'control.cancel': ({ itemId }) => control().cancel(itemId),
    'control.setLimits': ({ limits }) => control().setLimits(limits),
    'control.createSchedule': ({ schedule }) => control().createSchedule(schedule),
    'control.setScheduleEnabled': ({ scheduleId, enabled }) => control().setScheduleEnabled(scheduleId, enabled),
    'control.removeSchedule': ({ scheduleId }) => {
      control().removeSchedule(scheduleId)
      return null
    },
    'control.decisions': ({ itemId }) => ctx.decisions?.ofItem(itemId, 30) ?? [],
    'runtime.status': () => runtime().status(),
    'runtime.workers': () => runtime().workers(),
    'runtime.workerSelfTest': () => runtime().workerSelfTest(),
    'runtime.tray': () => runtime().tray(),
    'runtime.setDispatchPaused': ({ paused }) => ({ paused: control().setDispatchPaused(paused) }),
    'runtime.stop': async () => ({ stopping: await runtime().shutdown() }),
    // Answered by the window's own main process; a request that reaches the runtime came from something else.
    'desktop.connection': (): ConnectionState => {
      throw new NexusError('invalid_state', 'This channel is answered by the NEXUS window, not by the runtime.')
    },
    'desktop.reconnect': (): ConnectionState => {
      throw new NexusError('invalid_state', 'This channel is answered by the NEXUS window, not by the runtime.')
    },
  }
}

export function unavailableV7Handlers(): V7Handlers {
  return createV7Handlers({})
}
