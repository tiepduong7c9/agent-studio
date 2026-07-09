import { create } from 'zustand'
import type { GitFileChange } from '../../shared/types'

// The center area is a single editor group whose "editors" are tabs: the
// new-session card, live agent chats, and file/diff viewers. This mirrors
// VS Code's editor-group model (one active editor, an ordered tab list, and a
// maximize toggle) without pulling in the workbench: the tab widget itself is
// too coupled to port, so we replicate its markup, styling, and behavior.

export type EditorTab =
  | { id: string; kind: 'new-chat'; title: string }
  | { id: string; kind: 'chat'; title: string; sid: string }
  | { id: string; kind: 'file'; title: string; path: string; name: string }
  | { id: string; kind: 'diff'; title: string; detail?: string; change: GitFileChange }

export const NEW_CHAT_ID = 'new-chat'

/** Agent tabs (the new-session card and live chats) stay left of file/diff tabs. */
export function isAgentTab(tab: EditorTab): boolean {
  return tab.kind === 'chat' || tab.kind === 'new-chat'
}

export function chatTabId(sid: string): string {
  return `chat:${sid}`
}

export function fileTabId(path: string): string {
  return `file:${path}`
}

export function diffTabId(change: GitFileChange): string {
  return `diff:${change.path}:${change.index}${change.worktree}`
}

interface TabsStore {
  tabs: EditorTab[]
  activeId: string | null
  /** Editor group maximized — the surrounding side panels are hidden. */
  maximized: boolean
  /** Open a tab (deduped by id) and make it active. */
  open: (tab: EditorTab) => void
  close: (id: string) => void
  setActive: (id: string) => void
  toggleMaximize: () => void
  setMaximized: (v: boolean) => void
  /** Drop chat tabs whose session no longer exists. */
  pruneChats: (liveSids: Set<string>) => void
}

function neighborId(tabs: EditorTab[], removedId: string): string | null {
  const idx = tabs.findIndex((t) => t.id === removedId)
  if (idx === -1) return null
  const next = tabs[idx + 1] ?? tabs[idx - 1]
  return next ? next.id : null
}

export const useTabsStore = create<TabsStore>((set) => ({
  tabs: [],
  activeId: null,
  maximized: false,
  open: (tab) =>
    set((s) => {
      if (s.tabs.some((t) => t.id === tab.id)) {
        return { tabs: s.tabs.map((t) => (t.id === tab.id ? tab : t)), activeId: tab.id }
      }
      // Agent tabs (new-session card + live chats) are pinned to the left; a new
      // one lands after the last agent tab, everything else appends to the end.
      const tabs = [...s.tabs]
      if (isAgentTab(tab)) {
        let insertAt = 0
        for (let i = 0; i < tabs.length; i++) if (isAgentTab(tabs[i])) insertAt = i + 1
        tabs.splice(insertAt, 0, tab)
      } else {
        tabs.push(tab)
      }
      return { tabs, activeId: tab.id }
    }),
  close: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? neighborId(s.tabs, id) : s.activeId
      return { tabs, activeId, maximized: tabs.length ? s.maximized : false }
    }),
  setActive: (id) => set({ activeId: id }),
  toggleMaximize: () => set((s) => ({ maximized: s.tabs.length ? !s.maximized : false })),
  setMaximized: (v) => set({ maximized: v }),
  pruneChats: (liveSids) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.kind !== 'chat' || liveSids.has(t.sid))
      if (tabs.length === s.tabs.length) return s
      const activeGone = s.activeId != null && !tabs.some((t) => t.id === s.activeId)
      return {
        tabs,
        activeId: activeGone ? (tabs[tabs.length - 1]?.id ?? null) : s.activeId,
        maximized: tabs.length ? s.maximized : false
      }
    })
}))
