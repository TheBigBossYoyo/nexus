import { create } from 'zustand'

/** Transient streaming text per agent. Never persisted; cleared when the completed block arrives. */
const MAX_CHARS = 40_000

interface LiveState {
  text: Record<string, string>
  append: (agentId: string, delta: string) => void
  clear: (agentId: string) => void
}

export const useLiveStore = create<LiveState>()((set) => ({
  text: {},
  append: (agentId, delta) =>
    set((s) => {
      const next = (s.text[agentId] ?? '') + delta
      return { text: { ...s.text, [agentId]: next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next } }
    }),
  clear: (agentId) =>
    set((s) => {
      if (!(agentId in s.text)) return s
      const rest = { ...s.text }
      delete rest[agentId]
      return { text: rest }
    }),
}))

export function useLiveText(agentId: string | null): string {
  return useLiveStore((s) => (agentId ? (s.text[agentId] ?? '') : ''))
}
