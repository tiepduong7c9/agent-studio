import { create } from 'zustand'
import type { AcpSnapshot } from '../../../shared/acp'
import type { AcpCommand, AcpEvent, AcpEffortState, AcpModeState, AcpModelState, AcpUsage } from './protocol'

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
  effortState?: AcpEffortState | null
  pendingEffortId?: string | null
  usage?: AcpUsage | null
  lastSeq: number
  historyLoaded?: boolean
  historyLoading?: boolean
  historyEpoch?: number
}

interface AcpStore {
  threads: Map<string, AcpThreadState>
  setHistory: (sid: string, snap: AcpSnapshot) => void
  appendEvent: (sid: string, event: AcpEvent) => void
  /** Apply a burst of events in a single update — used to fold a streamed
   *  history replay into one render instead of one per event. */
  appendEvents: (sid: string, events: AcpEvent[]) => void
  resolvePermissionLocal: (sid: string, requestId: string, optionId: string | null) => void
  setModeLocal: (sid: string, modeId: string) => void
  setModelLocal: (sid: string, modelId: string) => void
  clearPendingModel: (sid: string) => void
  setEffortLocal: (sid: string, effortId: string) => void
  clearPendingEffort: (sid: string) => void
  clear: (sid: string) => void
}

const EMPTY_THREAD: AcpThreadState = {
  events: [], claudeStatus: undefined, acpSessionId: null, modeState: null, lastSeq: -1
}

// Apply one event to a thread's state, returning the next state — or the SAME
// reference when the event is a control no-op / duplicate, so callers can skip
// the render. Pure and side-effect-free so a streamed history replay can be
// folded over in a single store update (see appendEvents).
function reduceEvent(prev: AcpThreadState, event: AcpEvent): AcpThreadState {
  switch (event.type) {
    case 'acp_status': return { ...prev, claudeStatus: event.claudeStatus }
    case 'acp_mode': return { ...prev, modeState: event.modeState }
    case 'acp_commands': return { ...prev, availableCommands: event.commands }
    case 'acp_model':
      return { ...prev, model: event.model, modelState: event.modelState ?? prev.modelState ?? null, pendingModelId: null }
    case 'acp_effort':
      return { ...prev, effortState: event.effortState, pendingEffortId: null }
    case 'acp_usage': return { ...prev, usage: event.usage }
    case 'acp_reset':
      return { ...prev, events: [], lastSeq: -1, claudeStatus: undefined, acpSessionId: event.acpSessionId, model: null, usage: null }
  }
  // Drop duplicates fanned out to multiple attachments.
  if (typeof event.seq === 'number' && event.seq <= prev.lastSeq) return prev
  const lastSeq = typeof event.seq === 'number' ? event.seq : prev.lastSeq
  // Stamp arrival time on live events so the UI can measure spans (e.g. thinking
  // duration) from real event timing. Events pre-stamped on arrival (batched) or
  // from snapshot history keep their existing rxAt.
  const stamped = event.rxAt != null ? event : { ...event, rxAt: Date.now() }
  return { ...prev, events: [...prev.events, stamped], lastSeq }
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
      effortState: snap.effortState ?? null,
      usage: snap.usage ?? null,
      lastSeq,
      historyLoaded: true,
      historyLoading: !!snap.loading,
      historyEpoch: (prev?.historyEpoch ?? 0) + 1,
    })
    return { threads }
  }),

  appendEvent: (sid, event) => set((s) => {
    const prev = s.threads.get(sid) ?? EMPTY_THREAD
    const next = reduceEvent(prev, event)
    if (next === prev) return {} // duplicate / no-op — skip the re-render
    const threads = new Map(s.threads)
    threads.set(sid, next)
    return { threads }
  }),

  appendEvents: (sid, events) => set((s) => {
    const prev = s.threads.get(sid) ?? EMPTY_THREAD
    let next = prev
    for (const event of events) next = reduceEvent(next, event)
    if (next === prev) return {}
    const threads = new Map(s.threads)
    threads.set(sid, next)
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

  setEffortLocal: (sid, effortId) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev) return {}
    threads.set(sid, { ...prev, pendingEffortId: effortId })
    return { threads }
  }),

  clearPendingEffort: (sid) => set((s) => {
    const threads = new Map(s.threads)
    const prev = threads.get(sid)
    if (!prev || prev.pendingEffortId == null) return {}
    threads.set(sid, { ...prev, pendingEffortId: null })
    return { threads }
  }),

  clear: (sid) => set((s) => {
    const threads = new Map(s.threads)
    threads.delete(sid)
    return { threads }
  }),
}))
