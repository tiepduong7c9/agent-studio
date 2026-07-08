export type ProjectKind = 'local' | 'ssh'

export interface ProjectInfo {
  kind: ProjectKind
  /** Display name (folder basename) */
  name: string
  /** Absolute path of the project root on its host */
  rootPath: string
  /** Present for ssh projects, e.g. "user@host" */
  host?: string
}

export type FileKind = 'file' | 'dir'

export interface FileEntry {
  name: string
  /** Absolute path on the project host */
  path: string
  /** Kind of the entry — for symlinks, the kind of the resolved target */
  kind: FileKind
  /** True when the entry is a symbolic link */
  symlink?: boolean
}

export interface GitFileChange {
  /** Path relative to the repo root */
  path: string
  /** Original path for renames */
  origPath?: string
  /** Staged (index) status letter, '.' if none */
  index: string
  /** Working-tree status letter, '.' if none */
  worktree: string
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  changes: GitFileChange[]
}

export interface SshConnectOptions {
  host: string
  port?: number
  username: string
  /** Password auth; agent and default keys are tried automatically */
  password?: string
  /** Path to a local private key file */
  privateKeyPath?: string
}

/** Result of a successful SSH connect, before a project folder is chosen. */
export interface SshConnection {
  /** The connected user's home directory — where remote browsing starts. */
  home: string
}

export interface RemoteDirEntry {
  name: string
  /** Absolute path on the remote host */
  path: string
}

/** A directory listing for the remote folder picker (subdirectories only). */
export interface RemoteDirListing {
  /** Resolved absolute path being listed */
  path: string
  /** Parent directory, or null at the filesystem root */
  parent: string | null
  entries: RemoteDirEntry[]
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }
