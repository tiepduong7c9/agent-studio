import { execFile } from 'child_process'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import * as path from 'path'
import type { Readable } from 'stream'
import { promisify } from 'util'
import type {
  FileEntry,
  GitBranches,
  GitFileChange,
  GitLog,
  GitStatus,
  ProjectInfo
} from '../../shared/types'
import { workspaceId } from '../../shared/types'
import { parseGitStatus } from '../git/parseStatus'
import { LOG_FORMAT, parseGitLog } from '../git/parseLog'
import { ensureText, MAX_TEXT_FILE_SIZE } from '../textFile'
import { MAX_IMAGE_FILE_SIZE } from '../../shared/imageTypes'
import { capFiles, walkFiles } from '../fileList'
import type { ProgressFn, ProjectProvider } from './types'

const execFileAsync = promisify(execFile)

export class LocalProjectProvider implements ProjectProvider {
  readonly info: ProjectInfo

  constructor(rootPath: string) {
    const root = path.resolve(rootPath)
    this.info = {
      id: workspaceId({ kind: 'local', rootPath: root }),
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

  async listFiles(): Promise<string[]> {
    // `ls-files --cached --others --exclude-standard` = tracked + untracked but
    // not ignored — the same set VS Code's quick-open shows in a repo. -z keeps
    // paths raw (no quoting) so odd filenames survive.
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.info.rootPath, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
      )
      return capFiles(stdout.split('\0'))
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? ''
      // Not a repo, git missing, or output too big → walk the tree instead.
      if (
        stderr.includes('not a git repository') ||
        err?.code === 'ENOENT' ||
        err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ) {
        return capFiles(await walkFiles(this.info.rootPath))
      }
      throw new Error(stderr.trim() || err?.message || String(err))
    }
  }

  async readFile(filePath: string): Promise<string> {
    const file = this.confine(filePath)
    const stat = await fs.stat(file)
    if (stat.size > MAX_TEXT_FILE_SIZE) {
      return ensureText(Buffer.alloc(0), stat.size)
    }
    return ensureText(await fs.readFile(file))
  }

  async readFileBase64(filePath: string): Promise<string> {
    const file = this.confine(filePath)
    const stat = await fs.stat(file)
    if (stat.size > MAX_IMAGE_FILE_SIZE) {
      throw new Error(`File is too large to display (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    }
    return (await fs.readFile(file)).toString('base64')
  }

  async mediaFileSize(filePath: string): Promise<number> {
    return (await fs.stat(this.confine(filePath))).size
  }

  createMediaStream(filePath: string, range: { start: number; end: number }): Readable {
    // confine() already validated the path when the size was fetched, but the
    // stream is a separate entry point, so re-check here too.
    return createReadStream(this.confine(filePath), { start: range.start, end: range.end })
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
        // --untracked-files=all lists each untracked file individually instead
        // of collapsing a wholly-untracked directory into one `dir/` entry —
        // folder entries aren't diffable and mismatch VS Code's SCM behavior.
        ['-C', this.info.rootPath, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
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

  async gitLog(limit = 300, allBranches = true): Promise<GitLog> {
    try {
      // --all: every branch so the graph shows real branch/merge structure;
      // omit it to follow only the current branch (HEAD). --topo-order keeps
      // parents below children so lane layout is stable.
      const args = ['-C', this.info.rootPath, 'log', '--topo-order', `--max-count=${limit}`, `--format=${LOG_FORMAT}`]
      if (allBranches) args.splice(3, 0, '--all')
      const { stdout } = await execFileAsync('git', args, { maxBuffer: 16 * 1024 * 1024 })
      return parseGitLog(stdout)
    } catch (err: any) {
      if (typeof err?.stderr === 'string') {
        if (err.stderr.includes('not a git repository')) return { isRepo: false, commits: [] }
        // Freshly-initialized repo with no commits yet.
        if (err.stderr.includes('does not have any commits')) return { isRepo: true, commits: [] }
      }
      throw err
    }
  }

  async gitDiscard(changes: GitFileChange[]): Promise<void> {
    for (const change of changes) {
      // A rename touches two paths: the new name and the original one to restore.
      const paths = change.origPath ? [change.origPath, change.path] : [change.path]
      for (const p of paths) assertRepoRelative(p)
      for (const p of paths) {
        try {
          // Overwrites both the index and the working tree with the HEAD version.
          await execFileAsync('git', ['-C', this.info.rootPath, 'checkout', 'HEAD', '--', p])
        } catch {
          // Not in HEAD (a newly-added or untracked file, or a rename's new
          // path): unstage it if staged, then delete it so the path matches HEAD.
          await execFileAsync('git', ['-C', this.info.rootPath, 'reset', '-q', '--', p]).catch(
            () => {}
          )
          await fs.rm(this.confine(path.join(this.info.rootPath, p)), {
            recursive: true,
            force: true
          })
        }
      }
    }
  }

  async gitBranches(): Promise<GitBranches> {
    const root = this.info.rootPath
    // symbolic-ref fails (exit 1) in detached HEAD; treat that as "no branch".
    const current = await execFileAsync('git', ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'])
      .then((r) => r.stdout.trim() || null)
      .catch(() => null)
    const local = await this.gitRefList('refs/heads')
    // Drop the symbolic `origin/HEAD -> origin/main` alias; it's not switchable.
    const remote = (await this.gitRefList('refs/remotes')).filter((r) => !r.endsWith('/HEAD'))
    return { current, local, remote }
  }

  private async gitRefList(ref: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', this.info.rootPath, 'for-each-ref', '--format=%(refname:short)', ref],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  }

  async gitCheckout(branch: string, discardLocal: boolean): Promise<void> {
    assertBranchName(branch)
    const args = ['-C', this.info.rootPath, 'checkout']
    if (discardLocal) args.push('--force')
    args.push(branch)
    try {
      await execFileAsync('git', args)
    } catch (err: any) {
      throw new Error(gitError(err))
    }
  }

  async gitPull(discardLocal: boolean): Promise<string> {
    const root = this.info.rootPath
    try {
      if (discardLocal) {
        // Ignore local changes: sync refs, then force the tree to the upstream.
        await execFileAsync('git', ['-C', root, 'fetch', '--prune'])
        const { stdout } = await execFileAsync('git', ['-C', root, 'reset', '--hard', '@{u}'])
        return stdout.trim() || 'Reset to upstream.'
      }
      // Fast-forward only: fails clearly if the branch has diverged, rather than
      // creating a surprise merge commit.
      const { stdout, stderr } = await execFileAsync('git', ['-C', root, 'pull', '--ff-only'])
      return `${stdout}${stderr}`.trim() || 'Already up to date.'
    } catch (err: any) {
      throw new Error(gitError(err))
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

  async uploadFile(localSourcePath: string, destPath: string, onProgress?: ProgressFn): Promise<void> {
    await copyLocal(localSourcePath, this.confine(destPath), onProgress)
  }

  async uploadDir(localSourceDir: string, destPath: string, onProgress?: ProgressFn): Promise<void> {
    await copyLocalDir(localSourceDir, this.confine(destPath), onProgress)
  }

  async downloadFile(srcPath: string, localDestPath: string, onProgress?: ProgressFn): Promise<void> {
    await copyLocal(this.confine(srcPath), localDestPath, onProgress)
  }

  async downloadDir(srcPath: string, localDestDir: string, onProgress?: ProgressFn): Promise<void> {
    await copyLocalDir(this.confine(srcPath), localDestDir, onProgress)
  }

  dispose(): void {}
}

// Stream-copy a single file, reporting bytes read as they flow so a large copy
// shows live progress (fs.copyFile is atomic but opaque).
function copyLocal(from: string, to: string, onProgress?: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = createReadStream(from)
    const write = createWriteStream(to)
    read.on('data', (chunk) => onProgress?.(chunk.length))
    read.on('error', reject)
    write.on('error', reject)
    write.on('finish', () => resolve())
    read.pipe(write)
  })
}

// Recursively copy a directory, streaming each file through copyLocal so
// progress accrues across the whole tree.
async function copyLocalDir(from: string, to: string, onProgress?: ProgressFn): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      await copyLocalDir(src, dest, onProgress)
    } else if (entry.isFile()) {
      await copyLocal(src, dest, onProgress)
    }
  }
}

// A HEAD path must stay inside the repo: no absolute paths, no `..` escape.
export function assertRepoRelative(relPath: string): void {
  if (relPath.startsWith('/') || relPath.split(/[/\\]/).includes('..')) {
    throw new Error('Path is outside the repository')
  }
}

// A branch/ref name from the renderer must not start with '-' (which git would
// read as an option) or contain whitespace/control chars. Args are passed as an
// array (no shell), so this only guards against option injection and typos.
export function assertBranchName(name: string): void {
  if (!name || name.startsWith('-') || /[\s\x00-\x1f~^:?*[\\]/.test(name)) {
    throw new Error(`Invalid branch name: ${name}`)
  }
}

// A friendly one-line message from a failed execFile git call.
export function gitError(err: any): string {
  const stderr = err?.stderr?.toString?.() ?? ''
  return stderr.trim() || err?.message || String(err)
}

export function isMissingInHead(stderr: string): boolean {
  return (
    stderr.includes("does not exist in 'HEAD'") ||
    stderr.includes("exists on disk, but not in 'HEAD'") ||
    stderr.includes('invalid object name') // repo with no commits yet
  )
}
