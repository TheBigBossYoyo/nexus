import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { ControlPlane } from '@main/modules/control-plane'

type V7Channel = Extract<IpcChannel, `control.${string}`>
export type V7Handlers = { [C in V7Channel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

export interface V7Context {
  control?: ControlPlane
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
  }
}

export function unavailableV7Handlers(): V7Handlers {
  return createV7Handlers({})
}
