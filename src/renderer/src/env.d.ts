import type { NexusBridge } from '@shared/ipc'

declare global {
  interface Window {
    /** Exposed by the preload script through contextBridge; absent when the page runs in a plain browser. */
    nexus: NexusBridge
  }
}
