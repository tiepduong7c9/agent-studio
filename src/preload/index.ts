import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AcpConversation,
  AcpEventPayload,
  AcpSnapshot,
  AcpUsageDetail,
  ProjectConversations,
  SessionMeta
} from '../shared/acp'
import type {
  BrowserChoice,
  FileEntry,
  GitBranches,
  GitFileChange,
  GitLog,
  GitStatus,
  ProjectInfo,
  RemoteDirListing,
  Result,
  SshConnection,
  SshConnectOptions,
  TransferProgress
} from '../shared/types'

const api = {
  /** Folder to open automatically on launch (STUDIO_OPEN_PATH) */
  initialProjectPath: process.env.STUDIO_OPEN_PATH || null,
  /** Dev aid: render sample sessions (STUDIO_DEMO_SESSIONS=1) */
  demoSessions: process.env.STUDIO_DEMO_SESSIONS === '1',
  openLocalProject: (): Promise<Result<ProjectInfo | null>> =>
    ipcRenderer.invoke('project:openLocal'),
  openLocalPath: (dirPath: string): Promise<Result<ProjectInfo>> =>
    ipcRenderer.invoke('project:openLocalPath', dirPath),
  /** Root a provider at a session's cwd (without opening it as a workspace) so
   *  the file/git panels can follow the selected session's directory. */
  ensureProjectForSession: (cwd: string, host: string | null): Promise<Result<ProjectInfo>> =>
    ipcRenderer.invoke('project:ensureForSession', cwd, host),
  connectSsh: (opts: SshConnectOptions): Promise<Result<SshConnection>> =>
    ipcRenderer.invoke('project:connectSsh', opts),
  sshListDir: (host: string, dirPath: string): Promise<Result<RemoteDirListing>> =>
    ipcRenderer.invoke('ssh:listDir', host, dirPath),
  sshOpenRemote: (host: string, dirPath: string): Promise<Result<ProjectInfo>> =>
    ipcRenderer.invoke('ssh:openRemote', host, dirPath),
  sshDisconnect: (host: string): Promise<Result<void>> =>
    ipcRenderer.invoke('ssh:disconnect', host),
  /** Reconnect all remembered SSH hosts; resolves with every remembered host and
   *  whether it came back up (unreachable ones are still reported so the sidebar
   *  can surface them as disconnected). Called once on startup. */
  reconnectSavedHosts: (): Promise<Result<{ host: string; connected: boolean }[]>> =>
    ipcRenderer.invoke('ssh:reconnectSaved'),
  /** Reconnect a single remembered host (the sidebar's Reconnect action on a
   *  disconnected host); resolves with the host key on success. */
  reconnectSsh: (host: string): Promise<Result<string>> =>
    ipcRenderer.invoke('ssh:reconnect', host),
  // File/git calls carry the workspace id so the main process routes them to the
  // right provider (a local folder and several ssh remotes can be open at once).
  closeProject: (wsId: string): Promise<Result<void>> => ipcRenderer.invoke('project:close', wsId),
  readDir: (wsId: string, dirPath: string): Promise<Result<FileEntry[]>> =>
    ipcRenderer.invoke('fs:readDir', wsId, dirPath),
  listFiles: (wsId: string): Promise<Result<string[]>> =>
    ipcRenderer.invoke('fs:listFiles', wsId),
  readFile: (wsId: string, filePath: string): Promise<Result<string>> =>
    ipcRenderer.invoke('fs:readFile', wsId, filePath),
  /** Overwrite (or create) a text file with `content`. Backs saving an edited file. */
  writeFile: (wsId: string, filePath: string, content: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:writeFile', wsId, filePath, content),
  readFileBase64: (wsId: string, filePath: string): Promise<Result<string>> =>
    ipcRenderer.invoke('fs:readFileBase64', wsId, filePath),
  gitStatus: (wsId: string): Promise<Result<GitStatus>> => ipcRenderer.invoke('git:status', wsId),
  gitShowHead: (wsId: string, relPath: string): Promise<Result<string | null>> =>
    ipcRenderer.invoke('git:showHead', wsId, relPath),
  gitLog: (wsId: string, limit?: number, allBranches?: boolean): Promise<Result<GitLog>> =>
    ipcRenderer.invoke('git:log', wsId, limit, allBranches),
  /** Discard local changes for the given files, reverting each to its HEAD state
   *  (untracked/new files are deleted). Irreversible. */
  gitDiscard: (wsId: string, changes: GitFileChange[]): Promise<Result<void>> =>
    ipcRenderer.invoke('git:discard', wsId, changes),
  /** Local and remote-tracking branches, for the branch switcher. */
  gitBranches: (wsId: string): Promise<Result<GitBranches>> =>
    ipcRenderer.invoke('git:branches', wsId),
  /** Switch to `branch`; `discardLocal` forces past uncommitted tracked changes. */
  gitCheckout: (wsId: string, branch: string, discardLocal: boolean): Promise<Result<void>> =>
    ipcRenderer.invoke('git:checkout', wsId, branch, discardLocal),
  /** Pull the current branch (fast-forward), or hard-reset to upstream when
   *  `discardLocal` is set. Resolves with a short summary of what happened. */
  gitPull: (wsId: string, discardLocal: boolean): Promise<Result<string>> =>
    ipcRenderer.invoke('git:pull', wsId, discardLocal),
  createFile: (wsId: string, filePath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:createFile', wsId, filePath),
  createDir: (wsId: string, dirPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:createDir', wsId, dirPath),
  renamePath: (wsId: string, oldPath: string, newPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:rename', wsId, oldPath, newPath),
  deletePath: (wsId: string, entryPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:delete', wsId, entryPath),
  revealInFileManager: (entryPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('app:reveal', entryPath),
  /** Upload files/folders into `destDir` on the project host. With `sourcePaths`
   *  (from a drag-drop) it uploads those directly; otherwise a native picker
   *  collects them. Resolves with how many top-level items were uploaded. */
  uploadFiles: (
    wsId: string,
    destDir: string,
    sourcePaths?: string[]
  ): Promise<Result<{ uploaded: number }>> =>
    ipcRenderer.invoke('fs:upload', wsId, destDir, sourcePaths),
  /** Download a project file/folder to a local path chosen via a native dialog.
   *  Resolves with the saved path, or saved:false on cancel. */
  downloadPath: (
    wsId: string,
    srcPath: string,
    kind: 'file' | 'dir'
  ): Promise<Result<{ saved: boolean; path?: string }>> =>
    ipcRenderer.invoke('fs:download', wsId, srcPath, kind),
  /** Resolve the absolute filesystem path of a dropped File (Electron's
   *  File.path replacement), for uploading OS drag-drops. '' if not path-backed. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Subscribe to upload/download progress. Returns an unsubscribe fn. */
  onTransferProgress: (cb: (p: TransferProgress) => void): (() => void) => {
    const h = (_e: unknown, p: TransferProgress) => cb(p)
    ipcRenderer.on('fs:progress', h)
    return () => ipcRenderer.removeListener('fs:progress', h)
  },
  /** Fire a native OS notification for a background session state change. */
  notify: (opts: { sid: string; title: string; body: string }): Promise<Result<void>> =>
    ipcRenderer.invoke('app:notify', opts),
  /** A notification was clicked; carries the session id to surface. Returns an
   *  unsubscribe fn. */
  onNotificationActivate: (cb: (sid: string) => void): (() => void) => {
    const h = (_e: unknown, sid: string) => cb(sid)
    ipcRenderer.on('app:notification-activate', h)
    return () => ipcRenderer.removeListener('app:notification-activate', h)
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close'): Promise<Result<boolean>> =>
    ipcRenderer.invoke('window:control', action),

  // Session links: enumerate the browsers installed on the host, and open a URL
  // in a chosen one (or the system default). Opening in-app is handled entirely
  // in the renderer via a <webview> tab; these only cover the external browsers.
  links: {
    listBrowsers: (): Promise<Result<BrowserChoice[]>> => ipcRenderer.invoke('links:listBrowsers'),
    openIn: (url: string, browserId: string): Promise<Result<void>> =>
      ipcRenderer.invoke('links:openIn', url, browserId)
  },

  // Integrated terminal: a PTY per tab, living in the main process. create()
  // spawns it (local child or ssh channel); input/resize/kill drive it; output
  // and exit are pushed back on the terminal:data / terminal:exit channels.
  terminal: {
    create: (opts: {
      cwd: string
      host: string | null
      cols: number
      rows: number
    }): Promise<Result<{ id: string }>> => ipcRenderer.invoke('terminal:create', opts),
    input: (id: string, data: string): void => ipcRenderer.send('terminal:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('terminal:kill', id),
    /** Pop the native right-click menu; resolves with the action the user picked. */
    contextMenu: (opts: {
      hasSelection: boolean
    }): Promise<'copy' | 'paste' | 'selectAll' | null> =>
      ipcRenderer.invoke('terminal:contextMenu', opts),
    /** Subscribe to a terminal's output; returns an unsubscribe fn. */
    onData: (cb: (payload: { id: string; data: string }) => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; data: string }) => cb(payload)
      ipcRenderer.on('terminal:data', h)
      return () => ipcRenderer.removeListener('terminal:data', h)
    },
    /** Subscribe to terminal exits; returns an unsubscribe fn. */
    onExit: (cb: (payload: { id: string; exitCode: number }) => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; exitCode: number }) => cb(payload)
      ipcRenderer.on('terminal:exit', h)
      return () => ipcRenderer.removeListener('terminal:exit', h)
    }
  },

  // ACP agent sessions, driven by the engine daemon. Unlike the file/git calls
  // above these reject on error (no Result envelope) to keep the ported ACP
  // store close to its original.
  acp: {
    listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('acp:list'),
    /** All projects + their conversations across every connected host. */
    listProjects: (): Promise<ProjectConversations[]> => ipcRenderer.invoke('acp:listProjects'),
    /** Account + subscription usage for a host (null/undefined = local engine). */
    getUsage: (host?: string | null): Promise<AcpUsageDetail> =>
      ipcRenderer.invoke('acp:getUsage', host ?? null),
    createSession: (cwd: string, host?: string | null, name?: string): Promise<SessionMeta> =>
      ipcRenderer.invoke('acp:create', { cwd, host, name }),
    /** Start receiving this session's events and get its replay snapshot. */
    attach: (sid: string): Promise<AcpSnapshot | null> => ipcRenderer.invoke('acp:attach', sid),
    detach: (sid: string): Promise<void> => ipcRenderer.invoke('acp:detach', sid),
    prompt: (sid: string, blocks: any[]): Promise<void> =>
      ipcRenderer.invoke('acp:prompt', { sid, blocks }),
    cancel: (sid: string): Promise<void> => ipcRenderer.invoke('acp:cancel', sid),
    permissionResponse: (sid: string, requestId: string, optionId: string | null): Promise<void> =>
      ipcRenderer.invoke('acp:permissionResponse', { sid, requestId, optionId }),
    elicitationResponse: (sid: string, requestId: string, response: unknown): Promise<void> =>
      ipcRenderer.invoke('acp:elicitationResponse', { sid, requestId, response }),
    setMode: (sid: string, modeId: string): Promise<void> =>
      ipcRenderer.invoke('acp:setMode', { sid, modeId }),
    setModel: (sid: string, modelId: string): Promise<void> =>
      ipcRenderer.invoke('acp:setModel', { sid, modelId }),
    setEffort: (sid: string, effortId: string): Promise<void> =>
      ipcRenderer.invoke('acp:setEffort', { sid, effortId }),
    listConversations: (sid: string): Promise<AcpConversation[]> =>
      ipcRenderer.invoke('acp:listConversations', sid),
    newConversation: (sid: string): Promise<void> => ipcRenderer.invoke('acp:newConversation', sid),
    resumeConversation: (sid: string, sessionId: string): Promise<void> =>
      ipcRenderer.invoke('acp:resumeConversation', { sid, sessionId }),
    rename: (sid: string, name: string): Promise<SessionMeta | null> =>
      ipcRenderer.invoke('acp:rename', { sid, name }),
    /** Ask Claude to recap the conversation into a fresh title (out-of-band). */
    regenerateTitle: (sid: string): Promise<SessionMeta | null> =>
      ipcRenderer.invoke('acp:regenerateTitle', sid),
    kill: (sid: string): Promise<boolean> => ipcRenderer.invoke('acp:kill', sid),
    /** Subscribe to per-session thread events; returns an unsubscribe fn. */
    onEvent: (cb: (payload: AcpEventPayload) => void): (() => void) => {
      const h = (_e: unknown, payload: AcpEventPayload) => cb(payload)
      ipcRenderer.on('acp:event', h)
      return () => ipcRenderer.removeListener('acp:event', h)
    },
    /** Subscribe to session-list changes; returns an unsubscribe fn. */
    onSessions: (cb: (sessions: SessionMeta[]) => void): (() => void) => {
      const h = (_e: unknown, list: SessionMeta[]) => cb(list)
      ipcRenderer.on('acp:sessions', h)
      return () => ipcRenderer.removeListener('acp:sessions', h)
    },
    /** Fresh snapshot pushed after a reconnect, to re-sync an attached session. */
    onResync: (cb: (payload: { sid: string; snapshot: AcpSnapshot }) => void): (() => void) => {
      const h = (_e: unknown, payload: { sid: string; snapshot: AcpSnapshot }) => cb(payload)
      ipcRenderer.on('acp:resync', h)
      return () => ipcRenderer.removeListener('acp:resync', h)
    },
    /** Engine connection status. connected=false while recovering; permanent=true
     *  once reconnection has been given up (e.g. the SSH connection itself died). */
    onEngineStatus: (cb: (status: { hostKey: string; connected: boolean; permanent?: boolean }) => void): (() => void) => {
      const h = (_e: unknown, status: { hostKey: string; connected: boolean; permanent?: boolean }) => cb(status)
      ipcRenderer.on('acp:engine-status', h)
      return () => ipcRenderer.removeListener('acp:engine-status', h)
    }
  }
}

export type StudioApi = typeof api

contextBridge.exposeInMainWorld('studio', api)
