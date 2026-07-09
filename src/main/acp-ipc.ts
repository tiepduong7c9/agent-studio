import { BrowserWindow, ipcMain } from 'electron'
import type { Disposable } from '../shared/acp'
import { activeEngineKey, getEngine, invalidateActiveEngine, type Engine } from './engine'

// Bridges the renderer's window.studio.acp calls to the engine's sessionManager
// channel, forwards the engine's push events to the renderer, and transparently
// recovers from a dropped transport (SSH blip, daemon restart): it reconnects
// with backoff and re-syncs every attached session, since the daemon keeps them
// alive across the drop.

export function registerAcpIpc(getWindow: () => BrowserWindow | null): () => void {
  const send = (channel: string, payload: unknown) => getWindow()?.webContents.send(channel, payload)

  let disposed = false
  let currentEngine: Engine | null = null
  let wiredKey: string | null = null
  let reconnecting = false

  // Per-session event forwarders, keyed by sid.
  const subs = new Map<string, Disposable>()

  const forward = (sm: Engine['sm'], sid: string): Disposable =>
    sm.onSessionEvent(sid)((event) => send('acp:event', { sid, event }))

  // Wire a freshly-connected engine: broadcast its session list and watch the
  // transport for a drop.
  const wire = (e: Engine): void => {
    e.sm.onDidChangeSessions((list) => send('acp:sessions', list))
    wiredKey = activeEngineKey()
    const onDrop = () => handleDrop(e)
    e.stream.once('close', onDrop)
    e.stream.once('error', onDrop)
  }

  // Get the active engine, wiring it the first time we see a given instance.
  const engine = async (): Promise<Engine> => {
    const e = await getEngine()
    if (e !== currentEngine) { currentEngine = e; wire(e) }
    return e
  }

  const handleDrop = (dropped: Engine): void => {
    if (disposed || dropped !== currentEngine) return
    // Only recover the still-active target; a project switch closes the old one.
    if (wiredKey !== activeEngineKey()) return
    currentEngine = null
    invalidateActiveEngine()
    send('acp:engine-status', { connected: false })
    void reconnect()
  }

  const MAX_RECONNECT_ATTEMPTS = 10
  const reconnect = async (): Promise<void> => {
    if (reconnecting || disposed) return
    reconnecting = true
    const delays = [500, 1000, 2000, 4000, 8000]
    let recovered = false
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS && !disposed; attempt++) {
      const wait = delays[Math.min(attempt, delays.length - 1)] + Math.floor(Math.random() * 400)
      await new Promise((r) => setTimeout(r, wait))
      if (disposed || wiredKey !== activeEngineKey()) { recovered = true; break } // target changed — abandon quietly
      try {
        const e = await engine() // reconnects (cache was invalidated) and re-wires
        send('acp:engine-status', { connected: true })
        // Re-establish every attached session on the new connection and push a
        // fresh snapshot so the renderer catches up on anything missed.
        for (const sid of [...subs.keys()]) {
          subs.get(sid)?.dispose()
          subs.set(sid, forward(e.sm, sid))
          const snapshot = await e.sm.snapshot(sid).catch(() => null)
          if (snapshot) send('acp:resync', { sid, snapshot })
        }
        recovered = true
        break
      } catch {
        // keep retrying with backoff
      }
    }
    // Give up rather than spin forever — e.g. the SSH connection itself dropped,
    // so the reused ssh2 client can never recover. Surface a terminal state
    // instead of a perpetual "reconnecting…".
    if (!recovered && !disposed && wiredKey === activeEngineKey()) {
      send('acp:engine-status', { connected: false, permanent: true })
    }
    reconnecting = false
  }

  ipcMain.handle('acp:list', async () => (await engine()).sm.list())
  ipcMain.handle('acp:create', async (_e, arg: { cwd: string; name?: string }) => (await engine()).sm.create(arg))

  // Attach: start forwarding this session's events, then return the snapshot.
  // Subscribe-before-snapshot so no event is lost in the gap (renderer dedupes by seq).
  ipcMain.handle('acp:attach', async (_e, sid: string) => {
    const e = await engine()
    if (!subs.has(sid)) subs.set(sid, forward(e.sm, sid))
    return e.sm.snapshot(sid)
  })

  ipcMain.handle('acp:detach', async (_e, sid: string) => {
    subs.get(sid)?.dispose()
    subs.delete(sid)
  })

  ipcMain.handle('acp:prompt', async (_e, arg: { sid: string; blocks: any[] }) => { await (await engine()).sm.prompt(arg.sid, arg.blocks) })
  ipcMain.handle('acp:cancel', async (_e, sid: string) => { await (await engine()).sm.cancel(sid) })
  ipcMain.handle('acp:permissionResponse', async (_e, arg: { sid: string; requestId: string; optionId: string | null }) => {
    await (await engine()).sm.permissionResponse(arg.sid, arg.requestId, arg.optionId)
  })
  ipcMain.handle('acp:setMode', async (_e, arg: { sid: string; modeId: string }) => { await (await engine()).sm.setMode(arg.sid, arg.modeId) })
  ipcMain.handle('acp:setModel', async (_e, arg: { sid: string; modelId: string }) => { await (await engine()).sm.setModel(arg.sid, arg.modelId) })
  ipcMain.handle('acp:listConversations', async (_e, sid: string) => (await engine()).sm.listConversations(sid))
  ipcMain.handle('acp:newConversation', async (_e, sid: string) => { await (await engine()).sm.newConversation(sid) })
  ipcMain.handle('acp:resumeConversation', async (_e, arg: { sid: string; sessionId: string }) => {
    await (await engine()).sm.resumeConversation(arg.sid, arg.sessionId)
  })
  ipcMain.handle('acp:rename', async (_e, arg: { sid: string; name: string }) => (await engine()).sm.rename(arg.sid, arg.name))
  ipcMain.handle('acp:kill', async (_e, sid: string) => {
    subs.get(sid)?.dispose()
    subs.delete(sid)
    return (await engine()).sm.kill(sid)
  })

  // Cleanup for app shutdown: stop reconnecting and drop all forwarders.
  return () => {
    disposed = true
    for (const d of subs.values()) d.dispose()
    subs.clear()
  }
}
