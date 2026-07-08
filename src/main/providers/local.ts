import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import type { FileEntry, GitStatus, ProjectInfo } from '../../shared/types'
import { parseGitStatus } from '../git/parseStatus'
import { ensureText, MAX_TEXT_FILE_SIZE } from '../textFile'
import type { ProjectProvider } from './types'

const execFileAsync = promisify(execFile)

export class LocalProjectProvider implements ProjectProvider {
  readonly info: ProjectInfo

  constructor(rootPath: string) {
    const root = path.resolve(rootPath)
    this.info = {
      kind: 'local',
      name: path.basename(root),
      rootPath: root
    }
  }

  // Confine a renderer-supplied path to the project root. The renderer is only
  // semi-trusted (it renders content from arbitrary/remote projects), so a
  // compromise must not be able to read/rename/delete anywhere on the host.
  private confine(p: string): string {
    const resolved = path.resolve(p)
    const root = this.info.rootPath
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('Path is outside the project folder')
    }
    return resolved
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const dir = this.confine(dirPath)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return Promise.all(
      entries.map(async (e) => {
        const entryPath = path.join(dir, e.name)
        let kind: 'file' | 'dir' = e.isDirectory() ? 'dir' : 'file'
        let symlink = false
        if (e.isSymbolicLink()) {
          symlink = true
          try {
            kind = (await fs.stat(entryPath)).isDirectory() ? 'dir' : 'file'
          } catch {
            kind = 'file' // broken link
          }
        }
        return { name: e.name, path: entryPath, kind, symlink }
      })
    )
  }

  async readFile(filePath: string): Promise<string> {
    const file = this.confine(filePath)
    const stat = await fs.stat(file)
    if (stat.size > MAX_TEXT_FILE_SIZE) {
      return ensureText(Buffer.alloc(0), stat.size)
    }
    return ensureText(await fs.readFile(file))
  }

  async gitShowHead(relPath: string): Promise<string | null> {
    assertRepoRelative(relPath)
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.info.rootPath, 'show', `HEAD:${relPath}`],
        { maxBuffer: MAX_TEXT_FILE_SIZE + 1024, encoding: 'buffer' }
      )
      return ensureText(stdout)
    } catch (err: any) {
      // A blob larger than the buffer cap: surface the same friendly message
      // readFile gives for oversized files instead of execFile's raw error.
      if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return ensureText(Buffer.alloc(0), MAX_TEXT_FILE_SIZE + 1)
      }
      const stderr = err?.stderr?.toString?.() ?? ''
      if (isMissingInHead(stderr)) return null
      throw new Error(stderr.trim() || err?.message || String(err))
    }
  }

  async gitStatus(): Promise<GitStatus> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.info.rootPath, 'status', '--porcelain=v2', '--branch', '-z'],
        { maxBuffer: 16 * 1024 * 1024 }
      )
      return parseGitStatus(stdout)
    } catch (err: any) {
      if (typeof err?.stderr === 'string' && err.stderr.includes('not a git repository')) {
        return { isRepo: false, ahead: 0, behind: 0, changes: [] }
      }
      throw err
    }
  }

  async createFile(filePath: string): Promise<void> {
    await fs.writeFile(this.confine(filePath), '', { flag: 'wx' })
  }

  async createDir(dirPath: string): Promise<void> {
    await fs.mkdir(this.confine(dirPath))
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.confine(oldPath), this.confine(newPath))
  }

  async deleteEntry(entryPath: string): Promise<void> {
    await fs.rm(this.confine(entryPath), { recursive: true, force: true })
  }

  dispose(): void {}
}

// A HEAD path must stay inside the repo: no absolute paths, no `..` escape.
export function assertRepoRelative(relPath: string): void {
  if (relPath.startsWith('/') || relPath.split(/[/\\]/).includes('..')) {
    throw new Error('Path is outside the repository')
  }
}

export function isMissingInHead(stderr: string): boolean {
  return (
    stderr.includes("does not exist in 'HEAD'") ||
    stderr.includes("exists on disk, but not in 'HEAD'") ||
    stderr.includes('invalid object name') // repo with no commits yet
  )
}
