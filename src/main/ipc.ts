import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Result, SshConnectOptions } from '../shared/types'
import { LocalProjectProvider } from './providers/local'
import {
  establishSshSession,
  listRemoteDirs,
  resolveRemoteDir,
  SshProjectProvider,
  type SshSession
} from './providers/ssh'
import type { ProjectProvider } from './providers/types'

let currentProvider: ProjectProvider | null = null

// A connected-but-not-yet-rooted SSH session, held while the user browses the
// remote filesystem to choose a project folder.
let pendingSession: SshSession | null = null
let pendingOpts: SshConnectOptions | null = null

function disposePending(): void {
  pendingSession?.client.end()
  pendingSession = null
  pendingOpts = null
}

function setProvider(provider: ProjectProvider | null): void {
  disposePending()
  currentProvider?.dispose()
  currentProvider = provider
}

// Expand a leading ~ against the connected session's home (SFTP realpath does
// not do shell tilde expansion).
function expandRemote(session: SshSession, p: string): string {
  if (p === '~') return session.home
  if (p.startsWith('~/')) return `${session.home.replace(/\/+$/, '')}/${p.slice(2)}`
  return p
}

function requireProvider(): ProjectProvider {
  if (!currentProvider) throw new Error('No project is open')
  return currentProvider
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

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  handle('project:openLocal', async () => {
    const win = getWindow()
    if (!win) throw new Error('No window')
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project Folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    setProvider(new LocalProjectProvider(result.filePaths[0]))
    return currentProvider!.info
  })

  // Open a folder directly by path (no dialog) — used by STUDIO_OPEN_PATH
  // and later by things like a recent-projects list.
  handle('project:openLocalPath', async (dirPath: string) => {
    setProvider(new LocalProjectProvider(dirPath))
    return currentProvider!.info
  })

  // Phase 1: authenticate and hold the session open; the renderer then browses
  // the remote FS and picks a folder. Returns the home dir to start browsing.
  handle('project:connectSsh', async (opts: SshConnectOptions) => {
    disposePending()
    const session = await establishSshSession(opts)
    pendingSession = session
    pendingOpts = opts
    return { home: session.home }
  })

  // Lists subdirectories on the pending session (remote folder picker).
  handle('ssh:listDir', async (dirPath: string) => {
    if (!pendingSession) throw new Error('Not connected')
    return listRemoteDirs(pendingSession.sftp, expandRemote(pendingSession, dirPath))
  })

  // Phase 2: root a project at the chosen folder on the pending session.
  handle('ssh:openRemote', async (dirPath: string) => {
    if (!pendingSession || !pendingOpts) throw new Error('Not connected')
    const root = await resolveRemoteDir(pendingSession.sftp, expandRemote(pendingSession, dirPath))
    const provider = SshProjectProvider.fromSession(pendingSession, root, pendingOpts)
    // ownership of the session transfers to the provider; clear the pending
    // slot before setProvider so it isn't torn down.
    pendingSession = null
    pendingOpts = null
    setProvider(provider)
    return provider.info
  })

  // Cancel a pending connection (user closed the picker without choosing).
  handle('ssh:cancel', async () => {
    disposePending()
  })

  handle('project:close', async () => {
    setProvider(null)
  })

  handle('fs:readDir', async (dirPath: string) => {
    return requireProvider().readDir(dirPath)
  })

  handle('fs:readFile', async (filePath: string) => {
    return requireProvider().readFile(filePath)
  })

  handle('git:status', async () => {
    return requireProvider().gitStatus()
  })

  handle('git:showHead', async (relPath: string) => {
    return requireProvider().gitShowHead(relPath)
  })

  handle('fs:createFile', async (filePath: string) => {
    await requireProvider().createFile(filePath)
  })

  handle('fs:createDir', async (dirPath: string) => {
    await requireProvider().createDir(dirPath)
  })

  handle('fs:rename', async (oldPath: string, newPath: string) => {
    await requireProvider().rename(oldPath, newPath)
  })

  handle('fs:delete', async (entryPath: string) => {
    const provider = requireProvider()
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
}

export function disposeProvider(): void {
  setProvider(null)
  disposePending()
}
