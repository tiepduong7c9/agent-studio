import { app } from 'electron'
import * as net from 'net'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import type { EngineModule, ISessionManagerClient } from '../shared/acp'
import { engineHostKey } from '../shared/types'
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

// ── target registry + per-host connection cache ───────────────────────────────
//
// Several projects can be open at once — a local folder plus one or more SSH
// remotes — so engines are keyed by host and cached independently. The local
// engine is always available; ssh engines are registered when a remote project
// opens (carrying the ssh2 handles needed to tunnel) and unregistered on close.

export const LOCAL_HOST_KEY = 'local'

const targets = new Map<string, EngineTarget>()
const cache = new Map<string, Promise<Engine>>()

const keyOf = (t: EngineTarget): string => engineHostKey(t)

/** Register an ssh host's engine target so getEngine(key) can connect it. */
export function registerEngineTarget(target: EngineTarget): void {
  targets.set(keyOf(target), target)
}

/** All host keys with a live/known engine — always includes the local daemon. */
export function knownHostKeys(): string[] {
  return [LOCAL_HOST_KEY, ...targets.keys()]
}

/** The ssh target for a host, or null — lets a project provider reuse the
 *  engine's ssh connection (e.g. to browse a session's remote folder). */
export function sshTargetFor(host: string): Extract<EngineTarget, { kind: 'ssh' }> | null {
  const t = targets.get(`ssh:${host}`)
  return t && t.kind === 'ssh' ? t : null
}

/** Drop a cached SSH engine and its target (e.g. when its last project closes). */
export function clearSshEngine(host: string): void {
  const key = `ssh:${host}`
  targets.delete(key)
  const p = cache.get(key)
  cache.delete(key)
  p?.then((e) => e.dispose()).catch(() => {})
}

/** Invalidate a host's cached connection so the next getEngine() reconnects. */
export function invalidateEngine(hostKey: string): void {
  const p = cache.get(hostKey)
  cache.delete(hostKey)
  // Dispose the old client/socket wrapper so reconnects don't accumulate them.
  p?.then((e) => e.dispose()).catch(() => {})
}

export function getEngine(hostKey: string): Promise<Engine> {
  if (!cache.has(hostKey)) {
    const p = connectFor(hostKey).catch((err) => {
      cache.delete(hostKey) // let the next call retry a fresh connection
      throw err
    })
    cache.set(hostKey, p)
  }
  return cache.get(hostKey)!
}

function connectFor(hostKey: string): Promise<Engine> {
  if (hostKey === LOCAL_HOST_KEY) return connectLocal()
  const target = targets.get(hostKey)
  if (!target || target.kind !== 'ssh') throw new Error(`No engine target for ${hostKey}`)
  return connectSsh(target)
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
