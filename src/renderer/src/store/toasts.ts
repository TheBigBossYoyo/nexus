import { create } from 'zustand'

export type ToastKind = 'error' | 'info' | 'success' | 'notice'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** Second line under the message (notices only). */
  detail?: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, message: string, detail?: string) => void
  dismiss: (id: number) => void
}

let nextId = 1
const MAX_TOASTS = 4

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (kind, message, detail) => {
    const id = nextId++
    const toast: Toast = detail ? { id, kind, message, detail } : { id, kind, message }
    set((s) => ({ toasts: [...s.toasts, toast].slice(-MAX_TOASTS) }))
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : kind === 'notice' ? 8000 : 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  error: (message: string) => useToastStore.getState().push('error', message),
  info: (message: string) => useToastStore.getState().push('info', message),
  success: (message: string) => useToastStore.getState().push('success', message),
  /** A titled notice with a detail line, e.g. "Claude usage limit reached". */
  notice: (title: string, detail: string) => useToastStore.getState().push('notice', title, detail),
}
