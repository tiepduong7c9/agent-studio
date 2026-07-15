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

/** Last-known metadata for a pinned session, cached so the row can still render
 *  (dimmed, reconnectable) while its host is offline and pushing no live list. */
export interface PinnedMeta {
  name: string
  cwd: string
  host: string | null
}

interface ViewPrefsState {
  /** Pinned session ids (surface in Focus mode, sort first in All mode). */
  pinnedSessions: Record<string, true>
  /** Cached metadata for pinned sessions, keyed by session id. Kept fresh from
   *  the live list so a pinned remote session stays visible after a restart or
   *  connection loss, until its host reconnects (or the session is deleted). */
  pinnedMeta: Record<string, PinnedMeta>
  /** Hidden session ids (dropped from the list unless showHidden). */
  hiddenSessions: Record<string, true>
  /** Hidden project group keys (whole group dropped unless showHidden). */
  hiddenProjects: Record<string, true>
  /** Sessions the user flagged as unread to follow up on later. Persisted like
   *  the pins (survives restart and host disconnect) and only ever cleared by
   *  the user — unlike the transient `doneSessions` marker, viewing the session
   *  does not clear it. */
  unreadSessions: Record<string, true>
  /** Focus mode: show only pinned sessions, flat and cross-project. */
  focusMode: boolean
  /** Reveal hidden sessions/projects (temporary escape hatch). */
  showHidden: boolean
  /** Changes panel layout: flat list of files or a nested folder tree. */
  changesViewMode: 'list' | 'tree'

  togglePin: (sid: string) => void
  /** Flag/unflag a session as unread (follow-up-later). */
  toggleUnread: (sid: string) => void
  /** Refresh cached metadata for currently-pinned live sessions. */
  rememberPinned: (metas: Array<{ id: string } & PinnedMeta>) => void
  hideSession: (sid: string) => void
  unhideSession: (sid: string) => void
  hideProject: (key: string) => void
  unhideProject: (key: string) => void
  setFocusMode: (on: boolean) => void
  setShowHidden: (on: boolean) => void
  setChangesViewMode: (mode: 'list' | 'tree') => void
  /** Drop pin/hide keys and cached pin metadata for sessions that no longer
   *  exist, so stale keys can't accumulate (mirrors how dead sessions' chat tabs
   *  are pruned). Only safe to call once every host is connected — see the
   *  caller's gate — else an offline host's absent sessions look deleted. */
  pruneSessions: (liveIds: Set<string>) => void
}

const without = (rec: Record<string, true>, key: string): Record<string, true> => {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

const dropMeta = (rec: Record<string, PinnedMeta>, key: string): Record<string, PinnedMeta> => {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

export const useViewPrefsStore = create<ViewPrefsState>()(
  persist(
    (set) => ({
      pinnedSessions: {},
      pinnedMeta: {},
      hiddenSessions: {},
      hiddenProjects: {},
      unreadSessions: {},
      focusMode: false,
      showHidden: false,
      changesViewMode: 'list',

      // Unpinning also drops the cached metadata (nothing to render offline).
      togglePin: (sid) =>
        set((s) =>
          sid in s.pinnedSessions
            ? { pinnedSessions: without(s.pinnedSessions, sid), pinnedMeta: dropMeta(s.pinnedMeta, sid) }
            : { pinnedSessions: { ...s.pinnedSessions, [sid]: true } }
        ),
      toggleUnread: (sid) =>
        set((s) =>
          sid in s.unreadSessions
            ? { unreadSessions: without(s.unreadSessions, sid) }
            : { unreadSessions: { ...s.unreadSessions, [sid]: true } }
        ),
      rememberPinned: (metas) =>
        set((s) => {
          let changed = false
          const next = { ...s.pinnedMeta }
          for (const { id, name, cwd, host } of metas) {
            const prev = next[id]
            if (prev && prev.name === name && prev.cwd === cwd && prev.host === host) continue
            next[id] = { name, cwd, host }
            changed = true
          }
          return changed ? { pinnedMeta: next } : {}
        }),
      // Hiding a session also drops any pin (a hidden session shouldn't sit in
      // the Focus view), and unhiding is the only way back short of showHidden.
      hideSession: (sid) =>
        set((s) => ({
          hiddenSessions: { ...s.hiddenSessions, [sid]: true },
          pinnedSessions: without(s.pinnedSessions, sid),
          pinnedMeta: dropMeta(s.pinnedMeta, sid)
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
          const unreadSessions = keep(s.unreadSessions)
          // Prune cached metadata alongside pins. This only runs once every
          // remembered host is connected (see the caller's gate), so a live id
          // missing here is a genuinely-gone session, not one hidden behind an
          // offline host — its cached row should go too.
          let metaChanged = false
          const pinnedMeta: Record<string, PinnedMeta> = {}
          for (const id of Object.keys(s.pinnedMeta)) {
            if (liveIds.has(id)) pinnedMeta[id] = s.pinnedMeta[id]
            else metaChanged = true
          }
          if (
            pinnedSessions === s.pinnedSessions &&
            hiddenSessions === s.hiddenSessions &&
            unreadSessions === s.unreadSessions &&
            !metaChanged
          )
            return {}
          return {
            pinnedSessions,
            hiddenSessions,
            unreadSessions,
            pinnedMeta: metaChanged ? pinnedMeta : s.pinnedMeta
          }
        })
    }),
    { name: 'agent-studio.view-prefs' }
  )
)
