export type ProjectKind = 'local' | 'ssh'

export interface ProjectInfo {
  /** Stable workspace id — `${kind}:${host ?? 'local'}:${rootPath}` */
  id: string
  kind: ProjectKind
  /** Display name (folder basename) */
  name: string
  /** Absolute path of the project root on its host */
  rootPath: string
  /** Present for ssh projects, e.g. "user@host" */
  host?: string
}

/** Stable id for an opened folder (workspace). */
export function workspaceId(info: { kind: ProjectKind; host?: string; rootPath: string }): string {
  // Normalize a trailing slash so /foo and /foo/ map to the same workspace.
  const root = info.rootPath.replace(/\/+$/, '') || '/'
  return `${info.kind}:${info.host ?? 'local'}:${root}`
}

/**
 * The engine/host key a workspace's sessions run under. Workspaces on the same
 * host share one engine; local workspaces all share the local daemon.
 */
export function engineHostKey(info: { kind: ProjectKind; host?: string }): string {
  return info.kind === 'ssh' && info.host ? `ssh:${info.host}` : 'local'
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

/** One commit in the graph/history log. */
export interface GitCommit {
  hash: string
  /** Parent commit hashes (2+ for a merge). */
  parents: string[]
  author: string
  email: string
  /** Author date, ms since epoch. */
  date: number
  subject: string
  /** Decoration refs, e.g. ['HEAD -> main', 'origin/main', 'tag: v1.0']. */
  refs: string[]
}

export interface GitLog {
  isRepo: boolean
  commits: GitCommit[]
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

/** Result of a successful SSH connect. The host's projects/sessions surface
 *  immediately; a project folder need not be chosen. */
export interface SshConnection {
  /** The connected user's home directory — where remote browsing starts. */
  home: string
  /** The host key for this connection, e.g. "user@host". */
  host: string
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

/** A live file-transfer update pushed on the fs:progress channel, driving the
 *  status-bar upload/download indicator. One 'start', throttled 'progress'
 *  updates, then one 'end'. */
export type TransferProgress =
  | { id: string; phase: 'start'; kind: 'upload' | 'download'; name: string; total: number }
  | { id: string; phase: 'progress'; transferred: number }
  | { id: string; phase: 'end' }
