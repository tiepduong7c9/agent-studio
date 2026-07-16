import { create } from 'zustand'

// Per-tab display mode for markdown files: rendered preview (default) or raw
// source. Transient view state keyed by editor tab id — not persisted, and
// pruned nowhere since the map only ever holds entries for tabs the user has
// explicitly toggled (a handful at most).

interface MarkdownViewState {
  /** true = source, absent/false = rendered preview (the default). */
  sourceMode: Record<string, true>
  toggle: (tabId: string) => void
}

export const useMarkdownViewStore = create<MarkdownViewState>((set) => ({
  sourceMode: {},
  toggle: (tabId) =>
    set((s) => {
      const next = { ...s.sourceMode }
      if (next[tabId]) delete next[tabId]
      else next[tabId] = true
      return { sourceMode: next }
    })
}))
