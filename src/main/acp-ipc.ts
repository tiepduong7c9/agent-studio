import { BrowserWindow, ipcMain } from 'electron'
import type { Disposable, ProjectConversations, SessionMeta } from '../shared/acp'
import {
  getEngine,
  invalidateEngine,
  knownHostKeys,
  LOCAL_HOST_KEY,
  type Engine
} from './engine'

// Bridges the renderer's window.studio.acp calls to the engines' sessionManager
// channels. Several hosts can be connected at once — the local daemon plus one
// or more SSH remotes — so this maintains a per-host connection, aggregates
// every host's session list into one host-tagged list for the renderer, routes
// session-scoped calls to the owning host, and transparently recovers each
// host's transport from a drop (SSH blip, daemon restart) with backoff.

export interface AcpHub {
  dispose(): void
  /** Connect + wire a host's engine so its sessions surface (called on open). */
  ensureHost(hostKey: string): void
  /** Like ensureHost, but awaitable: resolves once the engine is connected
   *  (provisioning the remote daemon), rejects if that fails. */
  ensureHostReady(hostKey: string): Promise<void>
  /** Tear down a host's forwarders (called when its last project closes). */
  releaseHost(hostKey: string): void
}

interface HostConn {
  key: string
  engine: Engine | null
  connecting: Promise<Engine> | null
  /** Per-session event forwarders, keyed by sid. */
  subs: Map<string, Disposable>
  sessionsSub: Disposable | null
  /** This host's last known session list, host-decorated. */
  sessions: SessionMeta[]
  reconnecting: boolean
}

const MAX_RECONNECT_ATTEMPTS = 10

function hostFromKey(key: string): string | null {
  return key === LOCAL_HOST_KEY ? null : key.slice('ssh:'.length)
}

export function registerAcpIpc(getWindow: () => BrowserWindow | null): AcpHub {
  const send = (channel: string, payload: unknown) => getWindow()?.webContents.send(channel, payload)

  let disposed = false
  const hosts = new Map<string, HostConn>()
  // sid -> owning host key, rebuilt whenever any host's session list changes.
  const sidToHost = new Map<string, string>()

  const forward = (sm: Engine['sm'], sid: string): Disposable =>
    sm.onSessionEvent(sid)((event) => send('acp:event', { sid, event }))

  const decorate = (list: SessionMeta[], key: string): SessionMeta[] => {
    const host = hostFromKey(key)
    return list.map((m) => ({ ...m, host }))
  }

  const mergedList = (): SessionMeta[] => {
    const merged: SessionMeta[] = []
    for (const hc of hosts.values()) merged.push(...hc.sessions)
    return merged
  }

  const rebuildAndBroadcast = (): void => {
    sidToHost.clear()
    for (const hc of hosts.values()) for (const m of hc.sessions) sidToHost.set(m.id, hc.key)
    send('acp:sessions', mergedList())
  }

  const ensureHostConn = (key: string): HostConn => {
    let hc = hosts.get(key)
    if (!hc) {
      hc = { key, engine: null, connecting: null, subs: new Map(), sessionsSub: null, sessions: [], reconnecting: false }
      hosts.set(key, hc)
    }
    return hc
  }

  // Watch a freshly-connected engine: re-broadcast on its session changes and
  // recover on a transport drop.
  const wire = (hc: HostConn, e: Engine): void => {
    hc.sessionsSub?.dispose()
    hc.sessionsSub = e.sm.onDidChangeSessions((list) => {
      hc.sessions = decorate(list, hc.key)
      rebuildAndBroadcast()
    })
    const onDrop = () => handleDrop(hc, e)
    e.stream.once('close', onDrop)
    e.stream.once('error', onDrop)
  }

  // Connect a host's engine (idempotent), seed its session list, and re-attach
  // any forwarders (so a reconnect re-syncs attached sessions).
  const connectHost = (hc: HostConn): Promise<Engine> => {
    if (hc.engine) return Promise.resolve(hc.engine)
    if (hc.connecting) return hc.connecting
    const p = (async () => {
      const e = await getEngine(hc.key)
      wire(hc, e)
      hc.engine = e
      hc.sessions = decorate(await e.sm.list().catch(() => []), hc.key)
      for (const sid of [...hc.subs.keys()]) {
        hc.subs.get(sid)?.dispose()
        hc.subs.set(sid, forward(e.sm, sid))
        const snapshot = await e.sm.snapshot(sid).catch(() => null)
        if (snapshot) send('acp:resync', { sid, snapshot })
      }
      rebuildAndBroadcast()
      // Announce the host as connected. Previously only reconnect() emitted this,
      // so a host that connected normally on startup never reported 'connected' —
      // leaving its status undefined and the renderer unable to tell it had
      // finished loading its sessions.
      send('acp:engine-status', { hostKey: hc.key, connected: true })
      return e
    })()
    hc.connecting = p
    p.then(
      () => { hc.connecting = null },
      () => { hc.connecting = null }
    )
    return p
  }

  const ensureAll = async (): Promise<void> => {
    await Promise.all(knownHostKeys().map((k) => connectHost(ensureHostConn(k)).catch(() => {})))
  }

  // Resolve (connecting if needed) the host that owns a session.
  const hcForSid = async (sid: string): Promise<HostConn> => {
    let key = sidToHost.get(sid)
    if (!key) { await ensureAll(); key = sidToHost.get(sid) }
    if (!key) throw new Error(`Unknown session ${sid}`)
    const hc = ensureHostConn(key)
    await connectHost(hc)
    return hc
  }

  const smForSid = async (sid: string): Promise<Engine['sm']> => (await hcForSid(sid)).engine!.sm

  const handleDrop = (hc: HostConn, dropped: Engine): void => {
    if (disposed || dropped !== hc.engine) return
    if (!hosts.has(hc.key)) return // host was released
    hc.engine = null
    invalidateEngine(hc.key)
    send('acp:engine-status', { hostKey: hc.key, connected: false })
    void reconnect(hc)
  }

  const reconnect = async (hc: HostConn): Promise<void> => {
    if (hc.reconnecting || disposed) return
    hc.reconnecting = true
    const delays = [500, 1000, 2000, 4000, 8000]
    let recovered = false
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS && !disposed; attempt++) {
      const wait = delays[Math.min(attempt, delays.length - 1)] + Math.floor(Math.random() * 400)
      await new Promise((r) => setTimeout(r, wait))
      if (disposed || !hosts.has(hc.key)) { recovered = true; break } // released — abandon quietly
      try {
        await connectHost(hc) // re-forwards subs + pushes resync snapshots
        send('acp:engine-status', { hostKey: hc.key, connected: true })
        recovered = true
        break
      } catch {
        // keep retrying with backoff
      }
    }
    // Give up rather than spin forever — e.g. the SSH connection itself dropped,
    // so the reused ssh2 client can never recover.
    if (!recovered && !disposed && hosts.has(hc.key)) {
      send('acp:engine-status', { hostKey: hc.key, connected: false, permanent: true })
    }
    hc.reconnecting = false
  }

  ipcMain.handle('acp:list', async () => {
    await ensureAll()
    return mergedList()
  })

  // Discover every project + its conversations on every connected host, each
  // decorated with the host it lives on (null = local). Hosts that fail to scan
  // are skipped rather than failing the whole list.
  ipcMain.handle('acp:listProjects', async (): Promise<ProjectConversations[]> => {
    await ensureAll()
    const perHost = await Promise.all(
      [...hosts.values()].map(async (hc) => {
        if (!hc.engine) return [] as ProjectConversations[]
        const host = hostFromKey(hc.key)
        const list = await hc.engine.sm.listProjects().catch(() => [] as ProjectConversations[])
        return list.map((p) => ({ ...p, host }))
      })
    )
    return perHost.flat()
  })

  // Account + subscription usage for a host's Claude credentials (null host =
  // local). Fetched on the owning engine, so each host reports its own limits.
  // Returns nulls rather than throwing if the host isn't reachable.
  ipcMain.handle('acp:getUsage', async (_e, host?: string | null) => {
    const key = host ? `ssh:${host}` : LOCAL_HOST_KEY
    try {
      const e = await connectHost(ensureHostConn(key))
      return await e.sm.getUsage()
    } catch {
      return { account: null, usage: null }
    }
  })

  ipcMain.handle('acp:create', async (_e, arg: { cwd: string; host?: string | null; name?: string }) => {
    const key = arg.host ? `ssh:${arg.host}` : LOCAL_HOST_KEY
    const e = await connectHost(ensureHostConn(key))
    const meta = await e.sm.create({ cwd: arg.cwd, name: arg.name })
    // Route immediately so a follow-up prompt/attach finds the right host, even
    // before the engine's own session-list push arrives.
    sidToHost.set(meta.id, key)
    return { ...meta, host: arg.host ?? null }
  })

  // Attach: start forwarding this session's events, then return the snapshot.
  // Subscribe-before-snapshot so no event is lost in the gap (renderer dedupes by seq).
  ipcMain.handle('acp:attach', async (_e, sid: string) => {
    const hc = await hcForSid(sid)
    if (!hc.subs.has(sid)) hc.subs.set(sid, forward(hc.engine!.sm, sid))
    return hc.engine!.sm.snapshot(sid)
  })

  ipcMain.handle('acp:detach', async (_e, sid: string) => {
    const key = sidToHost.get(sid)
    const hc = key ? hosts.get(key) : undefined
    hc?.subs.get(sid)?.dispose()
    hc?.subs.delete(sid)
  })

  ipcMain.handle('acp:prompt', async (_e, arg: { sid: string; blocks: any[] }) => { await (await smForSid(arg.sid)).prompt(arg.sid, arg.blocks) })
  ipcMain.handle('acp:cancel', async (_e, sid: string) => { await (await smForSid(sid)).cancel(sid) })
  ipcMain.handle('acp:permissionResponse', async (_e, arg: { sid: string; requestId: string; optionId: string | null }) => {
    await (await smForSid(arg.sid)).permissionResponse(arg.sid, arg.requestId, arg.optionId)
  })
  ipcMain.handle('acp:setMode', async (_e, arg: { sid: string; modeId: string }) => { await (await smForSid(arg.sid)).setMode(arg.sid, arg.modeId) })
  ipcMain.handle('acp:setModel', async (_e, arg: { sid: string; modelId: string }) => { await (await smForSid(arg.sid)).setModel(arg.sid, arg.modelId) })
  ipcMain.handle('acp:setEffort', async (_e, arg: { sid: string; effortId: string }) => { await (await smForSid(arg.sid)).setEffort(arg.sid, arg.effortId) })
  ipcMain.handle('acp:listConversations', async (_e, sid: string) => (await smForSid(sid)).listConversations(sid))
  ipcMain.handle('acp:newConversation', async (_e, sid: string) => { await (await smForSid(sid)).newConversation(sid) })
  ipcMain.handle('acp:resumeConversation', async (_e, arg: { sid: string; sessionId: string }) => {
    await (await smForSid(arg.sid)).resumeConversation(arg.sid, arg.sessionId)
  })
  ipcMain.handle('acp:rename', async (_e, arg: { sid: string; name: string }) => (await smForSid(arg.sid)).rename(arg.sid, arg.name))
  ipcMain.handle('acp:kill', async (_e, sid: string) => {
    const hc = await hcForSid(sid)
    hc.subs.get(sid)?.dispose()
    hc.subs.delete(sid)
    return hc.engine!.sm.kill(sid)
  })

  return {
    ensureHost: (key: string) => { connectHost(ensureHostConn(key)).catch(() => {}) },
    ensureHostReady: async (key: string) => { await connectHost(ensureHostConn(key)) },
    releaseHost: (key: string) => {
      const hc = hosts.get(key)
      if (!hc) return
      hc.sessionsSub?.dispose()
      for (const d of hc.subs.values()) d.dispose()
      hc.subs.clear()
      hc.engine = null
      hosts.delete(key)
      rebuildAndBroadcast()
    },
    // Cleanup for app shutdown: stop reconnecting and drop all forwarders.
    dispose: () => {
      disposed = true
      for (const hc of hosts.values()) {
        hc.sessionsSub?.dispose()
        for (const d of hc.subs.values()) d.dispose()
        hc.subs.clear()
      }
      hosts.clear()
    }
  }
}
