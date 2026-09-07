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

/** Branches available in the branch switcher, from `git for-each-ref`. */
export interface GitBranches {
  /** Current branch, or null when in detached HEAD. */
  current: string | null
  /** Local branch names, e.g. ['main', 'feature']. */
  local: string[]
  /** Remote-tracking branch names, e.g. ['origin/main']. */
  remote: string[]
}

/** Git identity of a session's working directory: which branch it sits on, and
 *  whether the directory is a linked worktree (`git worktree add`) rather than
 *  the repository's main checkout. Probed per session cwd, so it works for
 *  folders that were never opened as a workspace. */
export interface GitWorktreeInfo {
  /** Worktree root (the cwd's repository top level). */
  root: string
  /** Repository name — the main worktree's folder name, shared by every worktree. */
  repo: string
  /** The main worktree's root path (the repo's own git dir when it's bare). */
  repoRoot: string
  /** Current branch, or null in detached HEAD (use `head` for the label then). */
  branch: string | null
  /** Short HEAD sha, the label in detached HEAD. */
  head: string
  /** True when this cwd is a linked worktree rather than the main checkout. */
  linked: boolean
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

/** A browser the host can open a link in. `id` 'default' is the system default
 *  (opened via shell.openExternal); others are detected browser binaries. */
export interface BrowserChoice {
  id: string
  name: string
}
