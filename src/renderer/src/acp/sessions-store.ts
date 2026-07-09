import { create } from 'zustand'
import type { SessionMeta } from '../../../shared/acp'

// Live session list, kept in sync with the engine via window.studio.acp.onSessions.

export type EngineStatus = 'connected' | 'reconnecting' | 'lost'

interface SessionsStore {
  sessions: SessionMeta[]
  /** Transport health: reconnecting after a drop, or lost once given up on. */
  engineStatus: EngineStatus
  setSessions: (sessions: SessionMeta[]) => void
  setEngineStatus: (status: EngineStatus) => void
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  engineStatus: 'connected',
  setSessions: (sessions) => set({ sessions }),
  setEngineStatus: (status) => set({ engineStatus: status }),
}))
