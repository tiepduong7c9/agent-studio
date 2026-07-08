import { contextBridge, ipcRenderer } from 'electron'
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
  connectSsh: (opts: SshConnectOptions): Promise<Result<SshConnection>> =>
    ipcRenderer.invoke('project:connectSsh', opts),
  sshListDir: (dirPath: string): Promise<Result<RemoteDirListing>> =>
    ipcRenderer.invoke('ssh:listDir', dirPath),
  sshOpenRemote: (dirPath: string): Promise<Result<ProjectInfo>> =>
    ipcRenderer.invoke('ssh:openRemote', dirPath),
  sshCancel: (): Promise<Result<void>> => ipcRenderer.invoke('ssh:cancel'),
  closeProject: (): Promise<Result<void>> => ipcRenderer.invoke('project:close'),
  readDir: (dirPath: string): Promise<Result<FileEntry[]>> =>
    ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath: string): Promise<Result<string>> =>
    ipcRenderer.invoke('fs:readFile', filePath),
  gitStatus: (): Promise<Result<GitStatus>> => ipcRenderer.invoke('git:status'),
  gitShowHead: (relPath: string): Promise<Result<string | null>> =>
    ipcRenderer.invoke('git:showHead', relPath),
  createFile: (filePath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:createFile', filePath),
  createDir: (dirPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:createDir', dirPath),
  renamePath: (oldPath: string, newPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deletePath: (entryPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('fs:delete', entryPath),
  revealInFileManager: (entryPath: string): Promise<Result<void>> =>
    ipcRenderer.invoke('app:reveal', entryPath),
  windowControl: (action: 'minimize' | 'maximize' | 'close'): Promise<Result<boolean>> =>
    ipcRenderer.invoke('window:control', action)
}

export type StudioApi = typeof api

contextBridge.exposeInMainWorld('studio', api)
