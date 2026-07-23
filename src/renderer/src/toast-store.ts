import { create } from 'zustand'

// Transient, non-blocking notifications shown stacked in a corner (see the
// Toasts component). Purely client-side UI state; nothing here is persisted.

export type ToastKind = 'info' | 'warn' | 'danger'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** Optional full text (e.g. long command output) shown in a details popup. */
  details?: string
}

interface ToastStore {
  toasts: Toast[]
  /**
   * Show a toast; returns its id so a caller can dismiss it early. Pass
   * `details` to keep the toast itself short while stashing long output (which
   * would otherwise overflow the screen) behind a "Details" popup.
   */
  push: (kind: ToastKind, message: string, details?: string) => number
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, message, details) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, details }] }))
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
