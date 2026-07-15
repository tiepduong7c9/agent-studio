import { BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type { Result, SshConnectOptions } from '../shared/types'
import { engineHostKey, workspaceId } from '../shared/types'
import { clearSshEngine, LOCAL_HOST_KEY, registerEngineTarget, sshTargetFor } from './engine'
import { LocalProjectProvider } from './providers/local'
import {
  establishSshSession,
  listRemoteDirs,
  resolveRemoteDir,
  SshProjectProvider,
  type SshSession
} from './providers/ssh'
import type { ProjectProvider } from './providers/types'
import { loadSavedHosts, removeHost, saveHost } from './remote-hosts'

// Several projects can be open at once — a local folder and one or more SSH
// remotes — so providers are held in a map keyed by workspace id. File/git IPC
// calls carry the workspace id so they route to the right provider.
const providers = new Map<string, ProjectProvider>()

// The ACP engine hub, so opening/closing a project can spin up / tear down the
// engine for its host. Injected by index.ts (both live in the main process).
export interface AcpHub {
  ensureHost(hostKey: string): void
  ensureHostReady(hostKey: string): Promise<void>
  releaseHost(hostKey: string): void
}
let acpHub: AcpHub | null = null

// Connected SSH hosts, keyed by host key ("user@host"). A connection is kept
// open for the life of the host (independent of any opened folder): its remote
// ~/.claude/projects and sessions surface as soon as it connects, and the same
// ssh2 client backs the engine tunnel and every rooted provider on that host.
const sshHosts = new Map<string, SshSession>()

function endSshHosts(): void {
  for (const session of sshHosts.values()) session.client.end()
  sshHosts.clear()
}

// Outstanding OS notifications (session done / waiting), cleared together when
// the user returns to the app. See the app:notify handler for why per-click
// close() alone is unreliable on Linux.
const activeNotifications = new Set<Notification>()

/** Close every on-screen session notification. Called on notification click and
 *  on window focus. */
export function dismissAllNotifications(): void {
  for (const notification of activeNotifications) notification.close()
  activeNotifications.clear()
}

function addProvider(provider: ProjectProvider): ProjectProvider {
  const id = provider.info.id
  // Re-opening the same folder returns the existing provider.
  const existing = providers.get(id)
  if (existing) {
    provider.dispose()
    return existing
  }
  providers.set(id, provider)
  acpHub?.ensureHost(engineHostKey(provider.info))
  return provider
}

/** Close one workspace. The ssh host connection stays up (it's owned by the
 *  host, not the folder) — closing a folder just drops its provider. */
function closeProvider(wsId: string): void {
  const provider = providers.get(wsId)
  if (!provider) return
  providers.delete(wsId)
  provider.dispose()
}

/** Establish (or reuse) an SSH host connection and eagerly provision/update its
 *  engine daemon. Returns the "user@host" key. On a fresh connection whose
 *  engine fails to come up, tears the half-open connection down so a retry is
 *  clean; a reused live host is left intact. */
async function connectSshHost(opts: SshConnectOptions): Promise<string> {
  const host = `${opts.username}@${opts.host}`
  const isNew = !sshHosts.has(host)
  if (isNew) {
    const session = await establishSshSession(opts)
    sshHosts.set(host, session)
    registerEngineTarget({ kind: 'ssh', host, client: session.client, sftp: session.sftp })
  }
  try {
    await acpHub?.ensureHostReady(`ssh:${host}`)
  } catch (err) {
    if (isNew) disconnectHost(host)
    throw err
  }
  return host
}

/** Disconnect an SSH host: drop its rooted folders, its engine, and end the
 *  ssh client. */
function disconnectHost(host: string): void {
  for (const [id, p] of [...providers.entries()]) {
    if (p.info.kind === 'ssh' && p.info.host === host) {
      providers.delete(id)
      p.dispose()
    }
  }
  clearSshEngine(host)
  acpHub?.releaseHost(`ssh:${host}`)
  const session = sshHosts.get(host)
  session?.client.end()
  sshHosts.delete(host)
}

// Expand a leading ~ against the connected session's home (SFTP realpath does
// not do shell tilde expansion).
function expandRemote(session: SshSession, p: string): string {
  if (p === '~') return session.home
  if (p.startsWith('~/')) return `${session.home.replace(/\/+$/, '')}/${p.slice(2)}`
  return p
}

function requireProvider(wsId: string): ProjectProvider {
  const provider = providers.get(wsId)
  if (!provider) throw new Error('Project is not open')
  return provider
}

/** The open provider for a workspace, or undefined. Used by the media protocol. */
export function getProvider(wsId: string): ProjectProvider | undefined {
  return providers.get(wsId)
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null, hub: AcpHub): void {
  acpHub = hub

  handle('project:openLocal', async () => {
    const win = getWindow()
    if (!win) throw new Error('No window')
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project Folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return addProvider(new LocalProjectProvider(result.filePaths[0])).info
  })

  // Open a folder directly by path (no dialog) — used by STUDIO_OPEN_PATH
  // and later by things like a recent-projects list.
  handle('project:openLocalPath', async (dirPath: string) => {
    return addProvider(new LocalProjectProvider(dirPath)).info
  })

  // Ensure a provider is rooted at a session's working directory so the file/git
  // panels can follow it, even when that folder was never opened as a workspace.
  // Local folders open directly; remote folders reuse the host's engine ssh
  // connection (so it must already be connected).
  handle('project:ensureForSession', async (cwd: string, host: string | null) => {
    if (!host) return addProvider(new LocalProjectProvider(cwd)).info
    const existing = providers.get(workspaceId({ kind: 'ssh', host, rootPath: cwd }))
    if (existing) return existing.info
    const target = sshTargetFor(host)
    if (!target) throw new Error(`Not connected to ${host}`)
    return addProvider(SshProjectProvider.shared(target.client, target.sftp, cwd, host)).info
  })

  // Authenticate and wire the host's engine so its remote projects/sessions
  // surface immediately — no folder selection required (same as the local host).
  // Re-connecting to an already-connected host reuses the live session. The
  // remote daemon is provisioned/updated eagerly here (version-gated), so a
  // provisioning failure is reported at connect time rather than swallowed.
  handle('project:connectSsh', async (opts: SshConnectOptions) => {
    const host = await connectSshHost(opts)
    // Remember for auto-reconnect on the next launch (only once it works).
    saveHost(opts)
    return { home: sshHosts.get(host)!.home, host }
  })

  // Lists subdirectories on a connected host (remote folder picker).
  handle('ssh:listDir', async (host: string, dirPath: string) => {
    const session = sshHosts.get(host)
    if (!session) throw new Error(`Not connected to ${host}`)
    return listRemoteDirs(session.sftp, expandRemote(session, dirPath))
  })

  // Root a project at the chosen folder on a connected host, so it opens as a
  // workspace. The host's shared ssh connection backs the provider.
  handle('ssh:openRemote', async (host: string, dirPath: string) => {
    const session = sshHosts.get(host)
    if (!session) throw new Error(`Not connected to ${host}`)
    const root = await resolveRemoteDir(session.sftp, expandRemote(session, dirPath))
    return addProvider(SshProjectProvider.shared(session.client, session.sftp, root, host)).info
  })

  // Disconnect a host: drop its open folders, engine, and ssh connection, and
  // forget it so it isn't auto-reconnected on the next launch.
  handle('ssh:disconnect', async (host: string) => {
    disconnectHost(host)
    removeHost(host)
  })

  // Reconnect every remembered host (called on startup). Each is attempted
  // independently; one bad host (server down, auth changed) doesn't block the
  // rest. Returns every remembered host with whether it came back up, so the
  // sidebar can still surface a host that's currently unreachable (with a
  // disconnected indicator + Reconnect action) rather than hiding it.
  handle('ssh:reconnectSaved', async () => {
    return Promise.all(
      loadSavedHosts().map((opts) => {
        const host = `${opts.username}@${opts.host}`
        return connectSshHost(opts).then(
          () => ({ host, connected: true }),
          () => ({ host, connected: false })
        )
      })
    )
  })

  // Reconnect a single remembered host on demand — the "Reconnect" action on a
  // disconnected host in the sidebar. Its credentials come from the saved set.
  handle('ssh:reconnect', async (hostKey: string) => {
    const opts = loadSavedHosts().find((o) => `${o.username}@${o.host}` === hostKey)
    if (!opts) throw new Error(`No saved credentials for ${hostKey}`)
    return connectSshHost(opts)
  })

  handle('project:close', async (wsId: string) => {
    closeProvider(wsId)
  })

  handle('fs:readDir', async (wsId: string, dirPath: string) => {
    return requireProvider(wsId).readDir(dirPath)
  })

  handle('fs:readFile', async (wsId: string, filePath: string) => {
    return requireProvider(wsId).readFile(filePath)
  })

  handle('fs:listFiles', async (wsId: string) => {
    return requireProvider(wsId).listFiles()
  })

  handle('fs:readFileBase64', async (wsId: string, filePath: string) => {
    return requireProvider(wsId).readFileBase64(filePath)
  })

  handle('git:status', async (wsId: string) => {
    return requireProvider(wsId).gitStatus()
  })

  handle('git:showHead', async (wsId: string, relPath: string) => {
    return requireProvider(wsId).gitShowHead(relPath)
  })

  handle('git:log', async (wsId: string, limit?: number, allBranches?: boolean) => {
    return requireProvider(wsId).gitLog(limit, allBranches)
  })

  handle('fs:createFile', async (wsId: string, filePath: string) => {
    await requireProvider(wsId).createFile(filePath)
  })

  handle('fs:createDir', async (wsId: string, dirPath: string) => {
    await requireProvider(wsId).createDir(dirPath)
  })

  handle('fs:rename', async (wsId: string, oldPath: string, newPath: string) => {
    await requireProvider(wsId).rename(oldPath, newPath)
  })

  handle('fs:delete', async (wsId: string, entryPath: string) => {
    const provider = requireProvider(wsId)
    if (provider.info.kind === 'local') {
      try {
        await shell.trashItem(entryPath)
        return
      } catch {
        // fall through to permanent delete
      }
    }
    await provider.deleteEntry(entryPath)
  })

  handle('app:reveal', async (entryPath: string) => {
    shell.showItemInFolder(entryPath)
  })

  // Native OS notification for a background session state change (turn finished
  // / waiting for input). Clicking it brings the window forward and tells the
  // renderer which session to surface.
  //
  // Dismissal is deliberately not left to the single notification's click event:
  // on Linux/GNOME that event is flaky and close() can race the notification
  // daemon, so a click sometimes leaves the banner on screen. Instead every
  // outstanding notification is tracked and cleared together on any click and,
  // more reliably, whenever the window regains focus (dismissAllNotifications,
  // wired to the window's 'focus' event) — returning to the app is the real
  // signal that these are no longer needed.
  handle('app:notify', async (opts: { sid: string; title: string; body: string }) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: opts.title, body: opts.body })
    activeNotifications.add(notification)
    notification.on('close', () => activeNotifications.delete(notification))
    notification.on('click', () => {
      dismissAllNotifications()
      const win = getWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('app:notification-activate', opts.sid)
    })
    notification.show()
  })

  handle('window:control', async (action: 'minimize' | 'maximize' | 'close') => {
    const win = getWindow()
    if (!win) return false
    if (action === 'minimize') {
      win.minimize()
    } else if (action === 'close') {
      win.close()
    } else {
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
    return win.isMaximized()
  })

  // Local engine host is always available; ensure it's wired at startup so
  // local sessions appear even before a folder is opened.
  hub.ensureHost(LOCAL_HOST_KEY)
}

export function disposeProvider(): void {
  for (const provider of providers.values()) provider.dispose()
  providers.clear()
  endSshHosts()
}
