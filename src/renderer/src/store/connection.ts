import { create } from 'zustand'
import type { ConnectionState } from '@shared/runtime-protocol'
import { needsResync } from '../lib/connectionModel'

interface ConnectionStore {
  state: ConnectionState | null
  /** True once READY has been seen: from then on a lost connection makes the data stale. */
  everReady: boolean
  /** Counts re-syncs; a change tells the live region to announce "reconnected". */
  resyncs: number
  /** Applies a new state and returns true when every cached query must be refreshed. */
  apply: (next: ConnectionState) => boolean
}

export const useConnectionStore = create<ConnectionStore>()((set, get) => ({
  state: null,
  everReady: false,
  resyncs: 0,
  apply: (next) => {
    const { state, everReady, resyncs } = get()
    const resync = needsResync(state, next)
    set({ state: next, everReady: everReady || next.phase === 'READY', resyncs: resync ? resyncs + 1 : resyncs })
    return resync
  },
}))
