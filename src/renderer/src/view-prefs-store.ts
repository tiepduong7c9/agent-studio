import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Per-machine view preferences for the sessions sidebar: which sessions are
// pinned, which sessions/projects are hidden, and the focus/show-hidden toggles.
// This is purely a client-side view concern — the engine owns the sessions
// themselves and on-disk projects have no server home — so it lives in
// localStorage alongside the theme, keyed by stable ids.
//
// Sessions are keyed by SessionMeta.id; projects by groupKey(host, cwd) from
// workspace.ts (the same key the sidebar groups on).

interface ViewPrefsState {
  /** Pinned session ids (surface in Focus mode, sort first in All mode). */
  pinnedSessions: Record<string, true>
  /** Hidden session ids (dropped from the list unless showHidden). */
  hiddenSessions: Record<string, true>
  /** Hidden project group keys (whole group dropped unless showHidden). */
  hiddenProjects: Record<string, true>
  /** Focus mode: show only pinned sessions, flat and cross-project. */
  focusMode: boolean
  /** Reveal hidden sessions/projects (temporary escape hatch). */
  showHidden: boolean
  /** Changes panel layout: flat list of files or a nested folder tree. */
  changesViewMode: 'list' | 'tree'

  togglePin: (sid: string) => void
  hideSession: (sid: string) => void
  unhideSession: (sid: string) => void
  hideProject: (key: string) => void
  unhideProject: (key: string) => void
  setFocusMode: (on: boolean) => void
  setShowHidden: (on: boolean) => void
  setChangesViewMode: (mode: 'list' | 'tree') => void
  /** Drop pin/hide keys for sessions that no longer exist, so stale keys can't
   *  accumulate (mirrors how dead sessions' chat tabs are pruned). */
  pruneSessions: (liveIds: Set<string>) => void
}

const without = (rec: Record<string, true>, key: string): Record<string, true> => {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

export const useViewPrefsStore = create<ViewPrefsState>()(
  persist(
    (set) => ({
      pinnedSessions: {},
      hiddenSessions: {},
      hiddenProjects: {},
      focusMode: false,
      showHidden: false,
      changesViewMode: 'list',

      togglePin: (sid) =>
        set((s) =>
          sid in s.pinnedSessions
            ? { pinnedSessions: without(s.pinnedSessions, sid) }
            : { pinnedSessions: { ...s.pinnedSessions, [sid]: true } }
        ),
      // Hiding a session also drops any pin (a hidden session shouldn't sit in
      // the Focus view), and unhiding is the only way back short of showHidden.
      hideSession: (sid) =>
        set((s) => ({
          hiddenSessions: { ...s.hiddenSessions, [sid]: true },
          pinnedSessions: without(s.pinnedSessions, sid)
        })),
      unhideSession: (sid) => set((s) => ({ hiddenSessions: without(s.hiddenSessions, sid) })),
      hideProject: (key) => set((s) => ({ hiddenProjects: { ...s.hiddenProjects, [key]: true } })),
      unhideProject: (key) => set((s) => ({ hiddenProjects: without(s.hiddenProjects, key) })),
      setFocusMode: (on) => set({ focusMode: on }),
      setShowHidden: (on) => set({ showHidden: on }),
      setChangesViewMode: (mode) => set({ changesViewMode: mode }),

      pruneSessions: (liveIds) =>
        set((s) => {
          const keep = (rec: Record<string, true>): Record<string, true> => {
            const next: Record<string, true> = {}
            let changed = false
            for (const id of Object.keys(rec)) {
              if (liveIds.has(id)) next[id] = true
              else changed = true
            }
            return changed ? next : rec
          }
          const pinnedSessions = keep(s.pinnedSessions)
          const hiddenSessions = keep(s.hiddenSessions)
          if (pinnedSessions === s.pinnedSessions && hiddenSessions === s.hiddenSessions) return {}
          return { pinnedSessions, hiddenSessions }
        })
    }),
    { name: 'agent-studio.view-prefs' }
  )
)
