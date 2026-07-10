import { contextBridge, ipcRenderer } from 'electron'
import type {
  AcpConversation,
  AcpEventPayload,
  AcpSnapshot,
  ProjectConversations,
  SessionMeta
} from '../shared/acp'
import type {
  FileEntry,
  GitStatus,
  ProjectInfo,
  RemoteDirListing,
  Result,
  SshConnection,
  SshConnectOptions
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
  /** Reconnect all remembered SSH hosts; resolves with the host keys that came
   *  back up. Called once on startup. */
  reconnectSavedHosts: (): Promise<Result<string[]>> =>
    ipcRenderer.invoke('ssh:reconnectSaved'),
  // File/git calls carry the workspace id so the main process routes them to the
  // right provider (a local folder and several ssh remotes can be open at once).
  closeProject: (wsId: string): Promise<Result<void>> => ipcRenderer.invoke('project:close', wsId),
  readDir: (wsId: string, dirPath: string): Promise<Result<FileEntry[]>> =>
    ipcRenderer.invoke('fs:readDir', wsId, dirPath),
  readFile: (wsId: string, filePath: string): Promise<Result<string>> =>
    ipcRenderer.invoke('fs:readFile', wsId, filePath),
  gitStatus: (wsId: string): Promise<Result<GitStatus>> => ipcRenderer.invoke('git:status', wsId),
  gitShowHead: (wsId: string, relPath: string): Promise<Result<string | null>> =>
    ipcRenderer.invoke('git:showHead', wsId, relPath),
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
  windowControl: (action: 'minimize' | 'maximize' | 'close'): Promise<Result<boolean>> =>
    ipcRenderer.invoke('window:control', action),

  // ACP agent sessions, driven by the engine daemon. Unlike the file/git calls
  // above these reject on error (no Result envelope) to keep the ported ACP
  // store close to its original.
  acp: {
    listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('acp:list'),
    /** All projects + their conversations across every connected host. */
    listProjects: (): Promise<ProjectConversations[]> => ipcRenderer.invoke('acp:listProjects'),
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
    setMode: (sid: string, modeId: string): Promise<void> =>
      ipcRenderer.invoke('acp:setMode', { sid, modeId }),
    setModel: (sid: string, modelId: string): Promise<void> =>
      ipcRenderer.invoke('acp:setModel', { sid, modelId }),
    listConversations: (sid: string): Promise<AcpConversation[]> =>
      ipcRenderer.invoke('acp:listConversations', sid),
    newConversation: (sid: string): Promise<void> => ipcRenderer.invoke('acp:newConversation', sid),
    resumeConversation: (sid: string, sessionId: string): Promise<void> =>
      ipcRenderer.invoke('acp:resumeConversation', { sid, sessionId }),
    rename: (sid: string, name: string): Promise<SessionMeta | null> =>
      ipcRenderer.invoke('acp:rename', { sid, name }),
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
