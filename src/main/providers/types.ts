import type { Readable } from 'stream'
import type { FileEntry, GitFileChange, GitLog, GitStatus, ProjectInfo } from '../../shared/types'

/** Reports incremental transfer progress: `bytesDelta` bytes moved since the
 *  previous call. Used by the Files panel's upload/download progress indicator. */
export type ProgressFn = (bytesDelta: number) => void

/**
 * Abstracts a project folder so the rest of the app doesn't care whether it
 * lives on the local disk or on an SSH remote.
 */
export interface ProjectProvider {
  readonly info: ProjectInfo
  /** Lists a directory. `dirPath` is absolute on the project host. */
  readDir(dirPath: string): Promise<FileEntry[]>
  /**
   * All files under the project root as posix paths relative to it, for
   * quick-open search. Honors .gitignore in a repo; capped for huge trees.
   */
  listFiles(): Promise<string[]>
  /** Reads a text file. `filePath` is absolute on the project host. */
  readFile(filePath: string): Promise<string>
  /** Reads a file as base64 (for inline image display). `filePath` is absolute. */
  readFileBase64(filePath: string): Promise<string>
  /** Byte size of a file, for range/streaming media over studio-media://. */
  mediaFileSize(filePath: string): Promise<number>
  /**
   * A read stream for a byte range of a file (`start`/`end` inclusive), backing
   * ranged media playback. `filePath` is absolute on the project host.
   */
  createMediaStream(filePath: string, range: { start: number; end: number }): Readable
  /** Git status of the project root, or isRepo:false when not a repo. */
  gitStatus(): Promise<GitStatus>
  /**
   * Content of a file at HEAD (`relPath` relative to the repo root), or
   * null when the file doesn't exist in HEAD (new/untracked files).
   */
  gitShowHead(relPath: string): Promise<string | null>
  /** Commit history for the graph, newest first, capped at `limit`.
   *  `allBranches` (default true) logs every branch; false follows only the
   *  current branch (HEAD). Returns isRepo:false when the root isn't a git repo. */
  gitLog(limit?: number, allBranches?: boolean): Promise<GitLog>
  /**
   * Discards local changes for each of `changes`, restoring every path to its
   * HEAD state: tracked files are reverted to the last commit, and newly-added
   * or untracked files are removed from disk. Irreversible.
   */
  gitDiscard(changes: GitFileChange[]): Promise<void>
  /** Creates an empty file. Fails if it already exists. */
  createFile(filePath: string): Promise<void>
  createDir(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  /** Permanently deletes a file or directory (recursively). */
  deleteEntry(entryPath: string): Promise<void>
  /**
   * Copies a file from the local machine (running the app) into the project at
   * `destPath` (absolute on the project host), overwriting an existing file.
   * Backs the Files panel's "Upload…" action.
   */
  uploadFile(localSourcePath: string, destPath: string, onProgress?: ProgressFn): Promise<void>
  /**
   * Recursively copies a local directory into the project at `destPath`,
   * creating it. Backs uploading a dropped folder.
   */
  uploadDir(localSourceDir: string, destPath: string, onProgress?: ProgressFn): Promise<void>
  /**
   * Copies a project file (`srcPath`, absolute on the project host) to
   * `localDestPath` on the local machine. Backs "Download…" on a file.
   */
  downloadFile(srcPath: string, localDestPath: string, onProgress?: ProgressFn): Promise<void>
  /**
   * Recursively copies a project directory (`srcPath`) to `localDestDir` on the
   * local machine, creating it. Backs "Download…" on a folder.
   */
  downloadDir(srcPath: string, localDestDir: string, onProgress?: ProgressFn): Promise<void>
  dispose(): void
}
