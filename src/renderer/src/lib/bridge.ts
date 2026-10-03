import type { IpcChannel, IpcInput, IpcOutputs, NexusBridge } from '@shared/ipc'
import type { PushMessage } from '@shared/events'

export class IpcError extends Error {
  readonly code: string
  readonly channel: string

  constructor(channel: string, code: string, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.channel = channel
  }
}

export const BRIDGE_UNAVAILABLE = 'bridge_unavailable'

function getBridge(): NexusBridge | null {
  const candidate = (globalThis as { nexus?: Partial<NexusBridge> }).nexus
  if (candidate && typeof candidate.invoke === 'function' && typeof candidate.onPush === 'function') {
    return candidate as NexusBridge
  }
  return null
}

export function hasBridge(): boolean {
  return getBridge() !== null
}

/** Typed IPC call. Resolves with the unwrapped value and throws IpcError on any failure. */
async function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutputs[C]> {
  const bridge = getBridge()
  if (!bridge) {
    throw new IpcError(
      channel,
      BRIDGE_UNAVAILABLE,
      'The NEXUS bridge (window.nexus) is not available. Run NEXUS through the desktop app, not a plain browser.',
    )
  }
  let result
  try {
    result = await bridge.invoke(channel, input)
  } catch (e) {
    throw new IpcError(channel, 'ipc_failure', e instanceof Error ? e.message : String(e))
  }
  if (!result.ok) throw new IpcError(channel, result.error.code, result.error.message)
  return result.value
}

function onPush(listener: (message: PushMessage) => void): () => void {
  const bridge = getBridge()
  return bridge ? bridge.onPush(listener) : () => undefined
}

export const api = { invoke, onPush }
