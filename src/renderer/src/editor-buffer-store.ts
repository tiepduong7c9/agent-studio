import { create } from 'zustand'

// Editable file tabs keep their working content here, keyed by tab id, so edits
// survive tab switches. The editor pane unmounts when another tab is shown (only
// the active tab renders), which would otherwise discard an in-progress edit and
// its cursor position — so the Monaco model is seeded from this buffer on mount
// and written back on every change.
//
// `baseline` is the last-saved content; a buffer is dirty when its content
// diverges from the baseline. Untitled scratch buffers start with an empty
// baseline and have no file on disk until their first save.

interface Buffer {
  content: string
  baseline: string
  untitled: boolean
}

interface EditorBufferStore {
  buffers: Record<string, Buffer>
  /** Which tabs currently have unsaved changes (content !== baseline). Kept as a
   *  separate map so the tab strip re-renders only when a tab's dirty state
   *  flips, not on every keystroke. */
  dirty: Record<string, boolean>
  /** Seed a buffer if one doesn't already exist for this tab. */
  ensure: (tabId: string, content: string, untitled: boolean) => void
  setContent: (tabId: string, content: string) => void
  /** Mark the buffer saved: its baseline becomes the given (or current) content. */
  markSaved: (tabId: string, content?: string) => void
  discard: (tabId: string) => void
  /** Drop buffers for tabs that no longer exist. */
  prune: (liveTabIds: Set<string>) => void
}

export const useEditorBufferStore = create<EditorBufferStore>((set) => ({
  buffers: {},
  dirty: {},
  ensure: (tabId, content, untitled) =>
    set((s) => {
      if (s.buffers[tabId]) return s
      return { buffers: { ...s.buffers, [tabId]: { content, baseline: content, untitled } } }
    }),
  setContent: (tabId, content) =>
    set((s) => {
      const buf = s.buffers[tabId]
      if (!buf || buf.content === content) return s
      const buffers = { ...s.buffers, [tabId]: { ...buf, content } }
      const nowDirty = content !== buf.baseline
      if (nowDirty === !!s.dirty[tabId]) return { buffers }
      return { buffers, dirty: { ...s.dirty, [tabId]: nowDirty } }
    }),
  markSaved: (tabId, content) =>
    set((s) => {
      const buf = s.buffers[tabId]
      if (!buf) return s
      const saved = content ?? buf.content
      const buffers = { ...s.buffers, [tabId]: { ...buf, content: saved, baseline: saved } }
      if (!s.dirty[tabId]) return { buffers }
      const dirty = { ...s.dirty }
      delete dirty[tabId]
      return { buffers, dirty }
    }),
  discard: (tabId) =>
    set((s) => {
      if (!s.buffers[tabId] && !s.dirty[tabId]) return s
      const buffers = { ...s.buffers }
      const dirty = { ...s.dirty }
      delete buffers[tabId]
      delete dirty[tabId]
      return { buffers, dirty }
    }),
  prune: (liveTabIds) =>
    set((s) => {
      const staleBuf = Object.keys(s.buffers).filter((id) => !liveTabIds.has(id))
      const staleDirty = Object.keys(s.dirty).filter((id) => !liveTabIds.has(id))
      if (staleBuf.length === 0 && staleDirty.length === 0) return s
      const buffers = { ...s.buffers }
      const dirty = { ...s.dirty }
      for (const id of staleBuf) delete buffers[id]
      for (const id of staleDirty) delete dirty[id]
      return { buffers, dirty }
    })
}))

/** Read a buffer's current content without subscribing (for save handlers). */
export function bufferContent(tabId: string): string | undefined {
  return useEditorBufferStore.getState().buffers[tabId]?.content
}
