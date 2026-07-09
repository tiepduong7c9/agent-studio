import { app } from 'electron'
import * as net from 'net'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import type { EngineModule, ISessionManagerClient } from '../shared/acp'
import { connectRemoteEngine } from './ssh-engine'

// The engine runs where the code is: a local daemon for local projects, a
// remote daemon (over SSH) for ssh projects. getEngine() resolves the engine for
// the currently-active project; the ACP IPC layer is otherwise oblivious to
// which one it's talking to. Each Engine exposes its transport stream so the IPC
// layer can detect a drop and reconnect.

export type EngineTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; host: string; client: SshClient; sftp: SFTPWrapper }

export interface Engine {
  sm: ISessionManagerClient
  /** The transport stream (local socket or SSH tunnel) — emits 'close' on drop. */
  stream: NodeJS.ReadWriteStream
  dispose(): void
}

// ── engine client module (loaded once, as an external) ────────────────────────

function engineClientPath(): string {
  const dir = process.env.STUDIO_ENGINE_DIR || path.join(app.getAppPath(), 'engine', 'dist')
  return path.join(dir, 'client.js')
}

let modulePromise: Promise<EngineModule> | null = null
export function loadEngineModule(): Promise<EngineModule> {
  if (!modulePromise) {
    modulePromise = import(pathToFileURL(engineClientPath()).href) as Promise<EngineModule>
  }
  return modulePromise
}

// ── active target + per-host connection cache ─────────────────────────────────

let active: EngineTarget = { kind: 'local' }
const cache = new Map<string, Promise<Engine>>()

const keyOf = (t: EngineTarget): string => (t.kind === 'local' ? 'local' : `ssh:${t.host}`)

/** A stable id for the active target — the IPC layer uses it to scope reconnects. */
export function activeEngineKey(): string {
  return keyOf(active)
}

/** Point subsequent getEngine() calls at a project's host (called on project open). */
export function setActiveEngineTarget(target: EngineTarget): void {
  active = target
}

/** Drop a cached SSH engine (e.g. when its project/connection closes). */
export function clearSshEngine(host: string): void {
  const key = `ssh:${host}`
  const p = cache.get(key)
  cache.delete(key)
  p?.then((e) => e.dispose()).catch(() => {})
  if (active.kind === 'ssh' && active.host === host) active = { kind: 'local' }
}

/** Invalidate the active engine's cached connection so getEngine() reconnects. */
export function invalidateActiveEngine(): void {
  const key = keyOf(active)
  const p = cache.get(key)
  cache.delete(key)
  // Dispose the old client/socket wrapper so reconnects don't accumulate them.
  p?.then((e) => e.dispose()).catch(() => {})
}

export function getEngine(): Promise<Engine> {
  const target = active
  const key = keyOf(target)
  if (!cache.has(key)) {
    const p = (target.kind === 'local' ? connectLocal() : connectSsh(target)).catch((err) => {
      cache.delete(key) // let the next call retry a fresh connection
      throw err
    })
    cache.set(key, p)
  }
  return cache.get(key)!
}

async function connectLocal(): Promise<Engine> {
  const mod = await loadEngineModule()
  await mod.ensureDaemon()
  // Own the socket ourselves (rather than mod.connect) so we can watch it for drops.
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(mod.SOCKET_PATH)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  const conn = mod.connectOverStream(socket, 'agent-studio-main')
  const sm = mod.createSessionManagerClient(conn.getChannel(mod.SESSION_MANAGER_CHANNEL))
  return { sm, stream: socket, dispose: () => { conn.dispose(); socket.destroy() } }
}

async function connectSsh(target: Extract<EngineTarget, { kind: 'ssh' }>): Promise<Engine> {
  const mod = await loadEngineModule()
  return connectRemoteEngine(mod, target.client, target.sftp, target.host)
}
