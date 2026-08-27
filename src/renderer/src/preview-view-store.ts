import { create } from 'zustand'

// Per-tab display mode for files that render two ways — markdown and HTML both
// open as a rendered preview by default and can be flipped to raw source.
// Transient view state keyed by editor tab id: not persisted, and pruned
// nowhere since the map only ever holds entries for tabs the user has
// explicitly toggled (a handful at most).
//
// A live HTML preview also publishes a reload callback here, so the reload
// button can sit in the tab strip (next to the other view controls) rather than
// stealing editor space.

interface PreviewViewState {
  /** true = source, absent/false = rendered preview (the default). */
  sourceMode: Record<string, true>
  toggle: (tabId: string) => void
  /** Reload callbacks published by the mounted HTML previews. */
  reloaders: Record<string, () => void>
  setReloader: (tabId: string, reload: (() => void) | null) => void
}

export const usePreviewViewStore = create<PreviewViewState>((set) => ({
  sourceMode: {},
  toggle: (tabId) =>
    set((s) => {
      const next = { ...s.sourceMode }
      if (next[tabId]) delete next[tabId]
      else next[tabId] = true
      return { sourceMode: next }
    }),
  reloaders: {},
  setReloader: (tabId, reload) =>
    set((s) => {
      const reloaders = { ...s.reloaders }
      if (reload) reloaders[tabId] = reload
      else delete reloaders[tabId]
      return { reloaders }
    })
}))
