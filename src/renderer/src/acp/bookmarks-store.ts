import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Reading bookmarks in a session's thread: spots you scrolled back to and want
// to return to after new messages arrive. Kept on this machine, per session.
//
// A bookmark points at a thread item (by its id, which is derived from the
// item's position in the session's event log) plus how far into that item you
// had scrolled. The item's opening text is stored too, both to label the
// bookmark and to notice when the id no longer points at the same message
// (e.g. after the conversation was cleared).

export interface Bookmark {
  itemId: string
  /** Pixels from the top of the item to the top of the viewport. */
  offset: number
  /** Short label: the start of the message, or the tool's title. */
  label: string
  createdAt: number
}

interface BookmarksState {
  /** Session id → bookmarks, in thread order. */
  bySession: Record<string, Bookmark[]>
  /** Adds a bookmark, or moves the existing one for that item. `order` gives
   *  the thread position of each item id, to keep the list in reading order. */
  add: (sid: string, b: Bookmark, order: Map<string, number>) => void
  remove: (sid: string, itemId: string) => void
  /** Drops bookmarks for sessions that no longer exist. */
  prune: (liveIds: Set<string>) => void
}

const NONE: Bookmark[] = []

export const useBookmarksStore = create<BookmarksState>()(
  persist(
    (set) => ({
      bySession: {},
      add: (sid, b, order) =>
        set((s) => {
          const rest = (s.bySession[sid] ?? NONE).filter((x) => x.itemId !== b.itemId)
          const list = [...rest, b].sort((x, y) => (order.get(x.itemId) ?? 0) - (order.get(y.itemId) ?? 0))
          return { bySession: { ...s.bySession, [sid]: list } }
        }),
      remove: (sid, itemId) =>
        set((s) => {
          const list = (s.bySession[sid] ?? NONE).filter((x) => x.itemId !== itemId)
          const bySession = { ...s.bySession }
          if (list.length) bySession[sid] = list
          else delete bySession[sid]
          return { bySession }
        }),
      prune: (liveIds) =>
        set((s) => {
          const kept = Object.entries(s.bySession).filter(([sid]) => liveIds.has(sid))
          return kept.length === Object.keys(s.bySession).length ? s : { bySession: Object.fromEntries(kept) }
        })
    }),
    { name: 'agent-studio.bookmarks', version: 1 }
  )
)

export const useSessionBookmarks = (sid: string): Bookmark[] => useBookmarksStore((s) => s.bySession[sid] ?? NONE)
