import type { Readable } from 'stream'
import type { FileEntry, GitLog, GitStatus, ProjectInfo } from '../../shared/types'

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
  /** Creates an empty file. Fails if it already exists. */
  createFile(filePath: string): Promise<void>
  createDir(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  /** Permanently deletes a file or directory (recursively). */
  deleteEntry(entryPath: string): Promise<void>
  dispose(): void
}
