import type { FileEntry, GitStatus, ProjectInfo } from '../../shared/types'

/**
 * Abstracts a project folder so the rest of the app doesn't care whether it
 * lives on the local disk or on an SSH remote.
 */
export interface ProjectProvider {
  readonly info: ProjectInfo
  /** Lists a directory. `dirPath` is absolute on the project host. */
  readDir(dirPath: string): Promise<FileEntry[]>
  /** Reads a text file. `filePath` is absolute on the project host. */
  readFile(filePath: string): Promise<string>
  /** Git status of the project root, or isRepo:false when not a repo. */
  gitStatus(): Promise<GitStatus>
  /**
   * Content of a file at HEAD (`relPath` relative to the repo root), or
   * null when the file doesn't exist in HEAD (new/untracked files).
   */
  gitShowHead(relPath: string): Promise<string | null>
  /** Creates an empty file. Fails if it already exists. */
  createFile(filePath: string): Promise<void>
  createDir(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  /** Permanently deletes a file or directory (recursively). */
  deleteEntry(entryPath: string): Promise<void>
  dispose(): void
}
