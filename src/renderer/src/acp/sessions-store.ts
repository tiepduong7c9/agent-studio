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
  setSessions: (sessions: SessionMeta[]) => void
  setProjects: (projects: ProjectConversations[]) => void
  setHostStatus: (hostKey: string, status: EngineStatus) => void
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  projects: [],
  engineStatus: {},
  setSessions: (sessions) => set({ sessions }),
  setProjects: (projects) => set({ projects }),
  setHostStatus: (hostKey, status) =>
    set((s) => ({ engineStatus: { ...s.engineStatus, [hostKey]: status } })),
}))
