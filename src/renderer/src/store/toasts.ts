import { create } from 'zustand'

export type ToastKind = 'error' | 'info' | 'success'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, message: string) => void
  dismiss: (id: number) => void
}

let nextId = 1
const MAX_TOASTS = 4

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }].slice(-MAX_TOASTS) }))
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  error: (message: string) => useToastStore.getState().push('error', message),
  info: (message: string) => useToastStore.getState().push('info', message),
  success: (message: string) => useToastStore.getState().push('success', message),
}
