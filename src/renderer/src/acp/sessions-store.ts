import { create } from 'zustand'
import type { ProjectConversations, SessionMeta } from '../../../shared/acp'

// Live session list, kept in sync with the engine via window.studio.acp.onSessions.

export type EngineStatus = 'connected' | 'reconnecting' | 'lost'

interface SessionsStore {
  sessions: SessionMeta[]
  /** All discovered projects + their conversations across connected hosts.
   *  This is the on-disk history (~/.claude/projects), independent of the live
   *  sessions the daemon manages. */
  projects: ProjectConversations[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected.
   *  Several hosts can be connected at once, so status is tracked per host. */
  engineStatus: Record<string, EngineStatus>
  /** Sessions that finished a turn while the user wasn't watching them — an
   *  "unread completion" marker shown as a "done" status until the session is
   *  viewed. The value is the completion time (ms epoch), so the row can show
   *  how long ago the turn finished. Per-viewer UI state, deliberately kept out
   *  of the engine's shared claudeStatus (which can't know which session this
   *  window is looking at). */
  doneSessions: Record<string, number>
  setSessions: (sessions: SessionMeta[]) => void
  setProjects: (projects: ProjectConversations[]) => void
  setHostStatus: (hostKey: string, status: EngineStatus) => void
  markDone: (sid: string) => void
  clearDone: (sid: string) => void
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  projects: [],
  engineStatus: {},
  doneSessions: {},
  setSessions: (sessions) => set({ sessions }),
  setProjects: (projects) => set({ projects }),
  setHostStatus: (hostKey, status) =>
    set((s) => ({ engineStatus: { ...s.engineStatus, [hostKey]: status } })),
  markDone: (sid) =>
    // Keep the first completion time if already marked (a re-broadcast of the
    // same idle status shouldn't reset "finished N ago").
    set((s) => (s.doneSessions[sid] ? s : { doneSessions: { ...s.doneSessions, [sid]: Date.now() } })),
  clearDone: (sid) =>
    set((s) => {
      if (!s.doneSessions[sid]) return s
      const { [sid]: _, ...rest } = s.doneSessions
      return { doneSessions: rest }
    }),
}))
