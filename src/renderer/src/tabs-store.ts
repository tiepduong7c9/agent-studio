import { create } from 'zustand'
import type { GitFileChange } from '../../shared/types'

// The center area is a single editor group whose "editors" are tabs: the
// new-session card, live agent chats, and file/diff viewers. This mirrors
// VS Code's editor-group model (one active editor, an ordered tab list, and a
// maximize toggle) without pulling in the workbench: the tab widget itself is
// too coupled to port, so we replicate its markup, styling, and behavior.

// Every tab carries the workspace (wsId) it belongs to, so file/git operations
// route to the right provider and the right panel can follow the active tab.
// `preview` marks a transient (italic) tab that a single click reuses in place,
// VS Code style; it's promoted to a permanent tab when kept.
//
// File/diff tabs also carry `ownerSid`: the chat session that was active when
// they were opened (null when no session was active). The tab strip shows only
// the active session's file/diff tabs, so switching sessions swaps them — each
// session keeps its own set of open files.
export type EditorTab =
  | { id: string; kind: 'new-chat'; title: string; wsId: string }
  | { id: string; kind: 'chat'; title: string; sid: string; wsId: string }
  // `untitled` marks a scratch buffer with no file on disk yet (Ctrl/Cmd+N);
  // `path` is empty until its first save promotes it to a normal file tab.
  | { id: string; kind: 'file'; title: string; path: string; name: string; wsId: string; ownerSid: string | null; preview?: boolean; untitled?: boolean }
  | { id: string; kind: 'diff'; title: string; change: GitFileChange; wsId: string; ownerSid: string | null; preview?: boolean }
  | { id: string; kind: 'git-graph'; title: string; wsId: string; ownerSid: string | null }
  // An in-app browser showing `url`, opened from a session's links popover.
  | { id: string; kind: 'browser'; title: string; url: string; wsId: string; ownerSid: string | null }
  | {
      id: string
      kind: 'terminal'
      title: string
      wsId: string
      ownerSid: string | null
      cwd: string
      host: string | null
    }

/** Agent tabs (the new-session card and live chats) stay left of file/diff tabs. */
export function isAgentTab(tab: EditorTab): boolean {
  return tab.kind === 'chat' || tab.kind === 'new-chat'
}

function isFileOrDiff(tab: EditorTab): tab is Extract<EditorTab, { kind: 'file' | 'diff' }> {
  return tab.kind === 'file' || tab.kind === 'diff'
}

/**
 * Whether a tab belongs to the current session context. Chat/new-chat tabs are
 * always shown; file/diff/git-graph tabs only when owned by the active session.
 */
export function tabInSession(tab: EditorTab, activeSid: string | null): boolean {
  if (isAgentTab(tab)) return true
  return (('ownerSid' in tab ? tab.ownerSid : null) ?? null) === activeSid
}

/** The tabs shown for the active session, in strip order. */
export function visibleTabs(tabs: EditorTab[], activeSid: string | null): EditorTab[] {
  return tabs.filter((t) => tabInSession(t, activeSid))
}

/** One new-session card per workspace. */
export function newChatTabId(wsId: string): string {
  return `new-chat:${wsId}`
}

export function chatTabId(sid: string): string {
  return `chat:${sid}`
}

// File/diff tab ids are namespaced by the owning session so the same file can be
// open independently under different sessions.
export function fileTabId(ownerSid: string | null, wsId: string, path: string): string {
  return `file:${ownerSid ?? ''}:${wsId}:${path}`
}

export function diffTabId(ownerSid: string | null, wsId: string, change: GitFileChange): string {
  return `diff:${ownerSid ?? ''}:${wsId}:${change.path}:${change.index}${change.worktree}`
}

/** One git-graph tab per (session, workspace). */
export function gitGraphTabId(ownerSid: string | null, wsId: string): string {
  return `gitgraph:${ownerSid ?? ''}:${wsId}`
}

/** One in-app browser tab per (session, url). */
export function browserTabId(ownerSid: string | null, wsId: string, url: string): string {
  return `browser:${ownerSid ?? ''}:${wsId}:${url}`
}

// Terminals are multi-instance per session: each launch gets a unique id (the
// `seq`), so a session can hold several open at once.
export function terminalTabId(ownerSid: string | null, wsId: string, seq: string): string {
  return `terminal:${ownerSid ?? ''}:${wsId}:${seq}`
}

interface TabsStore {
  tabs: EditorTab[]
  activeId: string | null
  /** The chat session whose tabs are currently shown; null when none is active. */
  activeSid: string | null
  /** Editor group maximized — the surrounding side panels are hidden. */
  maximized: boolean
  /**
   * Open a tab (deduped by id) and make it active. With `{ preview: true }` a
   * file/diff tab opens as the transient preview tab (reusing the session's
   * single preview slot); otherwise it opens (or is promoted) permanent.
   * Opening a chat tab makes its session the active one.
   */
  open: (tab: EditorTab, opts?: { preview?: boolean }) => void
  close: (id: string) => void
  /** Promote a preview tab to a permanent (kept) tab. */
  keep: (id: string) => void
  /** Close the active session's other file/diff tabs (keeps the given one). */
  closeOthers: (id: string) => void
  /** Close the active session's file/diff tabs. */
  closeAll: () => void
  setActive: (id: string) => void
  toggleMaximize: () => void
  setMaximized: (v: boolean) => void
  /** Drop chat tabs (and their files) whose session no longer exists. */
  pruneChats: (liveSids: Set<string>) => void
  /** Drop every tab belonging to a workspace that was closed. */
  pruneWorkspace: (wsId: string) => void
}

/** Pick the active tab after `removedId` leaves the given session's group. */
function neighborInSession(
  tabs: EditorTab[],
  removedId: string,
  activeSid: string | null
): string | null {
  const vis = visibleTabs(tabs, activeSid)
  const idx = vis.findIndex((t) => t.id === removedId)
  if (idx === -1) return vis[vis.length - 1]?.id ?? null
  const next = vis[idx + 1] ?? vis[idx - 1]
  return next ? next.id : null
}

/** Ensure `activeId` still points at a visible tab; otherwise fall back. */
function resolveActive(
  tabs: EditorTab[],
  activeId: string | null,
  activeSid: string | null
): string | null {
  if (activeId != null && tabs.some((t) => t.id === activeId && tabInSession(t, activeSid))) {
    return activeId
  }
  const vis = visibleTabs(tabs, activeSid)
  return vis[vis.length - 1]?.id ?? null
}

export const useTabsStore = create<TabsStore>((set) => ({
  tabs: [],
  activeId: null,
  activeSid: null,
  maximized: false,
  open: (tab, opts) =>
    set((s) => {
      const previewable = isFileOrDiff(tab)
      // Opening a chat switches the active session; anything else keeps it.
      const activeSid = tab.kind === 'chat' ? tab.sid : s.activeSid
      const existingIdx = s.tabs.findIndex((t) => t.id === tab.id)
      if (existingIdx !== -1) {
        const existing = s.tabs[existingIdx]
        // A single click (preview) leaves an already-permanent tab permanent; an
        // explicit keep (no preview flag) promotes a preview tab.
        const stayPreview =
          previewable && opts?.preview === true && isFileOrDiff(existing) && existing.preview === true
        const merged = previewable ? ({ ...tab, preview: stayPreview } as EditorTab) : tab
        return { tabs: s.tabs.map((t, i) => (i === existingIdx ? merged : t)), activeId: tab.id, activeSid }
      }
      // Live chats share a single tab slot: opening one replaces the existing
      // chat tab in place (keeping its position) rather than accumulating one tab
      // per session.
      if (tab.kind === 'chat') {
        const idx = s.tabs.findIndex((t) => t.kind === 'chat')
        if (idx !== -1) {
          return { tabs: s.tabs.map((t, i) => (i === idx ? tab : t)), activeId: tab.id, activeSid }
        }
      }
      const newTab = previewable ? ({ ...tab, preview: opts?.preview === true } as EditorTab) : tab
      // Each session has its own preview slot: a fresh file open reuses that
      // session's italic preview tab in place instead of accumulating tabs,
      // until it's kept.
      if (previewable) {
        const ownerSid = (newTab as Extract<EditorTab, { kind: 'file' | 'diff' }>).ownerSid ?? null
        const previewIdx = s.tabs.findIndex(
          (t) => isFileOrDiff(t) && t.preview === true && (t.ownerSid ?? null) === ownerSid
        )
        if (previewIdx !== -1) {
          return { tabs: s.tabs.map((t, i) => (i === previewIdx ? newTab : t)), activeId: newTab.id, activeSid }
        }
      }
      // Agent tabs (new-session card + live chats) are pinned to the left; a new
      // one lands after the last agent tab, everything else appends to the end.
      const tabs = [...s.tabs]
      if (isAgentTab(newTab)) {
        let insertAt = 0
        for (let i = 0; i < tabs.length; i++) if (isAgentTab(tabs[i])) insertAt = i + 1
        tabs.splice(insertAt, 0, newTab)
      } else {
        tabs.push(newTab)
      }
      return { tabs, activeId: newTab.id, activeSid }
    }),
  close: (id) =>
    set((s) => {
      const removed = s.tabs.find((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      // Closing the active session's chat tab clears the session context.
      let activeSid = s.activeSid
      if (removed?.kind === 'chat' && removed.sid === s.activeSid) {
        activeSid = tabs.find((t) => t.kind === 'chat')?.sid ?? null
      }
      const activeId =
        s.activeId === id
          ? resolveActive(tabs, neighborInSession(s.tabs, id, s.activeSid), activeSid)
          : resolveActive(tabs, s.activeId, activeSid)
      return { tabs, activeId, activeSid, maximized: tabs.length ? s.maximized : false }
    }),
  keep: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && isFileOrDiff(t) && t.preview ? { ...t, preview: false } : t
      )
    })),
  closeOthers: (id) =>
    set((s) => {
      const tabs = s.tabs.filter(
        (t) => t.id === id || !(isFileOrDiff(t) && tabInSession(t, s.activeSid))
      )
      return { tabs, activeId: resolveActive(tabs, id, s.activeSid), maximized: tabs.length ? s.maximized : false }
    }),
  closeAll: () =>
    set((s) => {
      const tabs = s.tabs.filter((t) => !(isFileOrDiff(t) && tabInSession(t, s.activeSid)))
      return {
        tabs,
        activeId: resolveActive(tabs, s.activeId, s.activeSid),
        maximized: tabs.length ? s.maximized : false
      }
    }),
  setActive: (id) => set({ activeId: id }),
  toggleMaximize: () => set((s) => ({ maximized: s.tabs.length ? !s.maximized : false })),
  setMaximized: (v) => set({ maximized: v }),
  pruneChats: (liveSids) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => {
        if (t.kind === 'chat') return liveSids.has(t.sid)
        // Drop files/diffs/graphs whose owning session is gone; keep session-less ones.
        if ('ownerSid' in t && t.ownerSid) return liveSids.has(t.ownerSid)
        return true
      })
      const activeSidStale = s.activeSid != null && !liveSids.has(s.activeSid)
      if (tabs.length === s.tabs.length && !activeSidStale) return s
      const activeSid = activeSidStale ? (tabs.find((t) => t.kind === 'chat')?.sid ?? null) : s.activeSid
      return {
        tabs,
        activeId: resolveActive(tabs, s.activeId, activeSid),
        activeSid,
        maximized: tabs.length ? s.maximized : false
      }
    }),
  pruneWorkspace: (wsId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.wsId !== wsId)
      if (tabs.length === s.tabs.length) return s
      const activeSid =
        s.activeSid != null && !tabs.some((t) => t.kind === 'chat' && t.sid === s.activeSid)
          ? (tabs.find((t) => t.kind === 'chat')?.sid ?? null)
          : s.activeSid
      return {
        tabs,
        activeId: resolveActive(tabs, s.activeId, activeSid),
        activeSid,
        maximized: tabs.length ? s.maximized : false
      }
    })
}))
