import { create } from 'zustand'
import type { AcpSnapshot } from '../../../shared/acp'
import type { AcpCommand, AcpEvent, AcpModeState, AcpModelState } from './protocol'

// Per-session thread state. Keyed by session id (sid). Ported from ccremote's
// acp-store; the only change is setHistory taking the engine's snapshot object.

export interface AcpThreadState {
  events: AcpEvent[]
  claudeStatus?: 'working' | 'waiting' | 'idle'
  acpSessionId: string | null
  modeState?: AcpModeState | null
  availableCommands?: AcpCommand[]
  model?: string | null
  modelState?: AcpModelState | null
  pendingModelId?: string | null
  lastSeq: number
  historyLoaded?: boolean
  historyLoading?: boolean
  historyEpoch?: number
}

interface AcpStore {
  threads: Map<string, AcpThreadState>
  setHistory: (sid: string, snap: AcpSnapshot) => void
  appendEvent: (sid: string, event: AcpEvent) => void
  resolvePermissionLocal: (sid: string, requestId: string, optionId: string | null) => void
  setModeLocal: (sid: string, modeId: string) => void
  setModelLocal: (sid: string, modelId: string) => void
  clearPendingModel: (sid: string) => void
  clear: (sid: string) => void
}

export const useAcpStore = create<AcpStore>((set) => ({
  threads: new Map(),

  setHistory: (sid, snap) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    const events = [...((snap.events ?? []) as AcpEvent[])]
    const snapMax = events.reduce((m, e) => (typeof e.seq === 'number' && e.seq > m ? e.seq : m), -1)
    // Carry over any live events that arrived via appendEvent after the daemon
    // captured this snapshot but before it was applied — otherwise this
    // wholesale replace would silently drop them (the attach-gap race).
    if (prev) {
      for (const e of prev.events) {
        if (typeof e.seq === 'number' && e.seq > snapMax) events.push(e)
      }
    }
    const lastSeq = events.reduce((m, e) => (typeof e.seq === 'number' && e.seq > m ? e.seq : m), -1)
    threads.set(sid, {
      events,
      claudeStatus: snap.claudeStatus,
      acpSessionId: snap.acpSessionId,
      modeState: snap.modeState ?? null,
      availableCommands: snap.availableCommands ?? [],
      model: snap.model ?? null,
      modelState: snap.modelState ?? null,
      lastSeq,
      historyLoaded: true,
      historyLoading: !!snap.loading,
      historyEpoch: (prev?.historyEpoch ?? 0) + 1,
    })
    return { threads }
  }),

  appendEvent: (sid, event) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid) ?? { events: [], claudeStatus: undefined, acpSessionId: null, modeState: null, lastSeq: -1 } as AcpThreadState
    if (event.type === 'acp_status') { threads.set(sid, { ...prev, claudeStatus: event.claudeStatus }); return { threads } }
    if (event.type === 'acp_mode') { threads.set(sid, { ...prev, modeState: event.modeState }); return { threads } }
    if (event.type === 'acp_commands') { threads.set(sid, { ...prev, availableCommands: event.commands }); return { threads } }
    if (event.type === 'acp_model') {
      threads.set(sid, { ...prev, model: event.model, modelState: event.modelState ?? prev.modelState ?? null, pendingModelId: null })
      return { threads }
    }
    if (event.type === 'acp_reset') {
      threads.set(sid, { ...prev, events: [], lastSeq: -1, claudeStatus: undefined, acpSessionId: event.acpSessionId, model: null })
      return { threads }
    }
    // Drop duplicates fanned out to multiple attachments.
    if (typeof event.seq === 'number' && event.seq <= prev.lastSeq) return {}
    const lastSeq = typeof event.seq === 'number' ? event.seq : prev.lastSeq
    threads.set(sid, { ...prev, events: [...prev.events, event], lastSeq })
    return { threads }
  }),

  resolvePermissionLocal: (sid, requestId, optionId) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev) return {}
    const events = prev.events.map((e) =>
      e.type === 'acp_permission' && e.requestId === requestId ? { ...e, resolved: optionId ?? '__cancelled__' } : e
    )
    threads.set(sid, { ...prev, events })
    return { threads }
  }),

  setModeLocal: (sid, modeId) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev || !prev.modeState) return {}
    threads.set(sid, { ...prev, modeState: { ...prev.modeState, currentModeId: modeId } })
    return { threads }
  }),

  setModelLocal: (sid, modelId) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev) return {}
    threads.set(sid, { ...prev, pendingModelId: modelId })
    return { threads }
  }),

  clearPendingModel: (sid) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev || prev.pendingModelId == null) return {}
    threads.set(sid, { ...prev, pendingModelId: null })
    return { threads }
  }),

  clear: (sid) => set((s) => {
    const threads = new Map(s.threads)
    threads.delete(sid)
    return { threads }
  }),
}))
