import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PushMessage } from '@shared/events'
import type { NexusBridge } from '@shared/ipc'
import { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL } from '@shared/ipc-channels'

// The only surface the renderer gets: one validated request channel and one push subscription.
// No Node, filesystem, process, or generic ipcRenderer access is exposed.
const bridge: NexusBridge = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, channel, input),
  onPush: (listener) => {
    const handler = (_event: IpcRendererEvent, message: PushMessage): void => listener(message)
    ipcRenderer.on(IPC_PUSH_CHANNEL, handler)
    return () => ipcRenderer.removeListener(IPC_PUSH_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld('nexus', bridge)
