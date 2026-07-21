import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Readable } from 'stream'
import { Client, type SFTPWrapper } from 'ssh2'
import type {
  FileEntry,
  GitBranches,
  GitFileChange,
  GitLog,
  GitStatus,
  ProjectInfo,
  RemoteDirListing,
  SshConnectOptions
} from '../../shared/types'
import { workspaceId } from '../../shared/types'
import { parseGitStatus } from '../git/parseStatus'
import { LOG_FORMAT, parseGitLog } from '../git/parseLog'
import { ensureText, MAX_TEXT_FILE_SIZE } from '../textFile'
import { MAX_IMAGE_FILE_SIZE } from '../../shared/imageTypes'
import { capFiles, IGNORED_DIRS } from '../fileList'
import { assertBranchName, assertRepoRelative, isMissingInHead } from './local'
import type { ProgressFn, ProjectProvider } from './types'

// Cap for `git status` output (mirrors the local provider's 16MB maxBuffer) so
// a huge status can't stream unbounded into memory over SSH.
const MAX_STATUS_OUTPUT = 16 * 1024 * 1024

/** A live SSH session, connected but not yet rooted at a project folder. */
export interface SshSession {
  client: Client
  sftp: SFTPWrapper
  /** The connected user's home directory. */
  home: string
}

// Connecting: authenticate and open SFTP. The connection is kept open for the
// life of the host — it backs the engine tunnel and any providers rooted on it
// (SshProjectProvider.shared) — no project folder need be chosen.
export async function establishSshSession(opts: SshConnectOptions): Promise<SshSession> {
  const client = new Client()
  const privateKey = await loadPrivateKey(opts.privateKeyPath)

  await new Promise<void>((resolve, reject) => {
    client
      .once('ready', () => resolve())
      .once('error', (err) => reject(err))
      .connect({
        host: opts.host,
        port: opts.port || 22,
        username: opts.username,
        password: opts.password || undefined,
        privateKey,
        agent: process.env.SSH_AUTH_SOCK,
        tryKeyboard: false,
        readyTimeout: 15000
      })
  })

  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
    const home = await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, resolved) => (err ? reject(err) : resolve(resolved)))
    })
    return { client, sftp, home }
  } catch (err) {
    client.end()
    throw err
  }
}

// Lists the subdirectories of `dirPath` for the remote folder picker. Symlinks
// are resolved so link-to-directory entries are browsable.
export async function listRemoteDirs(
  sftp: SFTPWrapper,
  dirPath: string
): Promise<RemoteDirListing> {
  const resolved = await new Promise<string>((resolve, reject) => {
    sftp.realpath(dirPath, (err, p) => (err ? reject(err) : resolve(p)))
  })
  type SftpEntry = { filename: string; attrs: import('ssh2').Stats }
  const list = await new Promise<SftpEntry[]>((resolve, reject) => {
    sftp.readdir(resolved, (err, l) => (err ? reject(err) : resolve(l)))
  })
  const dirs = await Promise.all(
    list.map(async (item) => {
      const full = joinPosix(resolved, item.filename)
      let isDir = item.attrs.isDirectory()
      if (item.attrs.isSymbolicLink()) {
        try {
          const st = await new Promise<import('ssh2').Stats>((res, rej) => {
            sftp.stat(full, (e, s) => (e ? rej(e) : res(s)))
          })
          isDir = st.isDirectory()
        } catch {
          isDir = false
        }
      }
      return { name: item.filename, path: full, isDir }
    })
  )
  return {
    path: resolved,
    parent: resolved === '/' ? null : path.posix.dirname(resolved),
    entries: dirs
      .filter((e) => e.isDir)
      .map(({ name, path }) => ({ name, path }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

// Validates that `dirPath` resolves to a directory and returns its clean
// absolute path, for use as a project root.
export async function resolveRemoteDir(sftp: SFTPWrapper, dirPath: string): Promise<string> {
  const resolved = await new Promise<string>((resolve, reject) => {
    sftp.realpath(dirPath, (err, p) => (err ? reject(err) : resolve(p)))
  })
  const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
    sftp.stat(resolved, (err, s) => (err ? reject(err) : resolve(s)))
  })
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`)
  return resolved.replace(/\/+$/, '') || '/'
}

export class SshProjectProvider implements ProjectProvider {
  readonly info: ProjectInfo

  private constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    rootPath: string,
    host: string
  ) {
    this.info = {
      id: workspaceId({ kind: 'ssh', host, rootPath }),
      kind: 'ssh',
      name: rootPath.replace(/\/+$/, '').split('/').pop() || rootPath,
      rootPath,
      host
    }
  }

  // Root a read/write provider on a host's shared ssh connection (owned by the
  // host, not the provider). Used both for an opened remote workspace and to
  // follow a remote session's folder. dispose() leaves the connection running.
  static shared(client: Client, sftp: SFTPWrapper, rootPath: string, host: string): SshProjectProvider {
    return new SshProjectProvider(client, sftp, rootPath.replace(/\/+$/, '') || '/', host)
  }

  // Confine a renderer-supplied POSIX path to the project root, so a renderer
  // compromise can't read/rename/delete outside the opened remote folder.
  private confine(p: string): string {
    const resolved = path.posix.normalize(p)
    const root = this.info.rootPath
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      throw new Error('Path is outside the project folder')
    }
    return resolved
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const dir = this.confine(dirPath)
    type SftpEntry = { filename: string; attrs: import('ssh2').Stats }
    const list = await new Promise<SftpEntry[]>((resolve, reject) => {
      this.sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    })
    return Promise.all(
      list.map(async (item) => {
        const entryPath = joinPosix(dir, item.filename)
        let kind: 'file' | 'dir' = item.attrs.isDirectory() ? 'dir' : 'file'
        let symlink = false
        if (item.attrs.isSymbolicLink()) {
          symlink = true
          try {
            // sftp.stat follows symlinks
            const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
              this.sftp.stat(entryPath, (err, s) => (err ? reject(err) : resolve(s)))
            })
            kind = stat.isDirectory() ? 'dir' : 'file'
          } catch {
            kind = 'file' // broken link
          }
        }
        return { name: item.filename, path: entryPath, kind, symlink }
      })
    )
  }

  async listFiles(): Promise<string[]> {
    const root = shellQuote(this.info.rootPath)
    const cap = 64 * 1024 * 1024
    // Prefer git (honors .gitignore); -z keeps paths raw. 16MB is too small for
    // a big tree, so raise the exec cap.
    const git = await this.exec(
      `git -C ${root} ls-files --cached --others --exclude-standard -z`,
      cap
    )
    if (git.code === 0) return capFiles(git.stdout.toString('utf8').split('\0'))

    // Not a repo (or git unavailable): fall back to find, pruning heavy dirs.
    const prune = [...IGNORED_DIRS].map((d) => `-name ${shellQuote(d)}`).join(' -o ')
    const find = await this.exec(
      `find ${root} \\( ${prune} \\) -prune -o -type f -print0`,
      cap
    )
    if (find.code !== 0) {
      throw new Error(find.stderr.trim() || git.stderr.trim() || `find exited with code ${find.code}`)
    }
    const base = this.info.rootPath.replace(/\/+$/, '')
    const files = find.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((p) => (p.startsWith(base + '/') ? p.slice(base.length + 1) : p))
    return capFiles(files)
  }

  async readFile(filePath: string): Promise<string> {
    const file = this.confine(filePath)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      this.sftp.stat(file, (err, stats) => (err ? reject(err) : resolve(stats)))
    })
    if (stat.size > MAX_TEXT_FILE_SIZE) {
      return ensureText(Buffer.alloc(0), stat.size)
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.readFile(file, (err, data) => (err ? reject(err) : resolve(data)))
    })
    return ensureText(buf)
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const file = this.confine(filePath)
    await new Promise<void>((resolve, reject) => {
      this.sftp.writeFile(file, content, { encoding: 'utf8' }, (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  async readFileBase64(filePath: string): Promise<string> {
    const file = this.confine(filePath)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      this.sftp.stat(file, (err, stats) => (err ? reject(err) : resolve(stats)))
    })
    if (stat.size > MAX_IMAGE_FILE_SIZE) {
      throw new Error(`File is too large to display (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.readFile(file, (err, data) => (err ? reject(err) : resolve(data)))
    })
    return buf.toString('base64')
  }

  async mediaFileSize(filePath: string): Promise<number> {
    const file = this.confine(filePath)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      this.sftp.stat(file, (err, stats) => (err ? reject(err) : resolve(stats)))
    })
    return stat.size
  }

  createMediaStream(filePath: string, range: { start: number; end: number }): Readable {
    // SFTP read streams are created synchronously; the confine() re-check guards
    // this separate entry point (see the local provider for the same note).
    return this.sftp.createReadStream(this.confine(filePath), {
      start: range.start,
      end: range.end
    })
  }

  async gitShowHead(relPath: string): Promise<string | null> {
    assertRepoRelative(relPath)
    const cmd = `git -C ${shellQuote(this.info.rootPath)} show HEAD:${shellQuote(relPath)}`
    let result: { code: number; stdout: Buffer; stderr: string }
    try {
      result = await this.exec(cmd, MAX_TEXT_FILE_SIZE + 1024)
    } catch (err: unknown) {
      // exceeded the size cap → same friendly message readFile gives oversized files
      if ((err as { code?: string })?.code === 'EXEC_OUTPUT_TOO_LARGE') {
        return ensureText(Buffer.alloc(0), MAX_TEXT_FILE_SIZE + 1)
      }
      throw err
    }
    if (result.code !== 0) {
      if (isMissingInHead(result.stderr)) return null
      throw new Error(result.stderr.trim() || `git exited with code ${result.code}`)
    }
    // decode the raw bytes once, mirroring the local `encoding: 'buffer'` path
    return ensureText(result.stdout)
  }

  async gitStatus(): Promise<GitStatus> {
    // --untracked-files=all lists each untracked file individually instead of
    // collapsing a wholly-untracked directory into one `dir/` entry — folder
    // entries aren't diffable and mismatch VS Code's SCM behavior.
    const cmd = `git -C ${shellQuote(this.info.rootPath)} status --porcelain=v2 --branch -z --untracked-files=all`
    const { code, stdout, stderr } = await this.exec(cmd)
    if (code !== 0) {
      if (stderr.includes('not a git repository')) {
        return { isRepo: false, ahead: 0, behind: 0, changes: [] }
      }
      throw new Error(stderr.trim() || `git exited with code ${code}`)
    }
    return parseGitStatus(stdout.toString('utf8'))
  }

  async gitLog(limit = 300, allBranches = true): Promise<GitLog> {
    // --all: every branch so the graph shows real branch/merge structure;
    // omit it to follow only the current branch (HEAD). --topo-order keeps
    // parents below children so lane layout is stable.
    const all = allBranches ? '--all ' : ''
    const cmd = `git -C ${shellQuote(this.info.rootPath)} log ${all}--topo-order --max-count=${limit} --format=${shellQuote(LOG_FORMAT)}`
    const { code, stdout, stderr } = await this.exec(cmd)
    if (code !== 0) {
      if (stderr.includes('not a git repository')) return { isRepo: false, commits: [] }
      // Freshly-initialized repo with no commits yet.
      if (stderr.includes('does not have any commits')) return { isRepo: true, commits: [] }
      throw new Error(stderr.trim() || `git exited with code ${code}`)
    }
    return parseGitLog(stdout.toString('utf8'))
  }

  async gitDiscard(changes: GitFileChange[]): Promise<void> {
    const root = shellQuote(this.info.rootPath)
    for (const change of changes) {
      // A rename touches two paths: the new name and the original one to restore.
      const paths = change.origPath ? [change.origPath, change.path] : [change.path]
      for (const p of paths) assertRepoRelative(p)
      for (const p of paths) {
        // Overwrites both the index and the working tree with the HEAD version.
        const co = await this.exec(`git -C ${root} checkout HEAD -- ${shellQuote(p)}`)
        if (co.code !== 0) {
          // Not in HEAD (a newly-added or untracked file, or a rename's new
          // path): unstage it if staged, then delete it so the path matches HEAD.
          await this.exec(`git -C ${root} reset -q -- ${shellQuote(p)}`)
          const abs = this.confine(joinPosix(this.info.rootPath, p))
          await this.exec(`rm -rf -- ${shellQuote(abs)}`)
        }
      }
    }
  }

  async gitBranches(): Promise<GitBranches> {
    const root = shellQuote(this.info.rootPath)
    // symbolic-ref exits non-zero in detached HEAD; treat that as "no branch".
    const head = await this.exec(`git -C ${root} symbolic-ref --short -q HEAD`)
    const current = head.code === 0 ? head.stdout.toString('utf8').trim() || null : null
    const local = await this.gitRefList('refs/heads')
    // Drop the symbolic `origin/HEAD -> origin/main` alias; it's not switchable.
    const remote = (await this.gitRefList('refs/remotes')).filter((r) => !r.endsWith('/HEAD'))
    return { current, local, remote }
  }

  private async gitRefList(ref: string): Promise<string[]> {
    const root = shellQuote(this.info.rootPath)
    const { code, stdout, stderr } = await this.exec(
      `git -C ${root} for-each-ref --format=${shellQuote('%(refname:short)')} ${ref}`
    )
    if (code !== 0) throw new Error(stderr.trim() || `git exited with code ${code}`)
    return stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  }

  async gitCheckout(branch: string, discardLocal: boolean): Promise<void> {
    assertBranchName(branch)
    const root = shellQuote(this.info.rootPath)
    const force = discardLocal ? '--force ' : ''
    const { code, stderr } = await this.exec(`git -C ${root} checkout ${force}${shellQuote(branch)}`)
    if (code !== 0) throw new Error(stderr.trim() || `git exited with code ${code}`)
  }

  async gitPull(discardLocal: boolean): Promise<string> {
    const root = shellQuote(this.info.rootPath)
    if (discardLocal) {
      // Ignore local changes: sync refs, then force the tree to the upstream.
      const fetch = await this.exec(`git -C ${root} fetch --prune`)
      if (fetch.code !== 0) {
        throw new Error(fetch.stderr.trim() || `git exited with code ${fetch.code}`)
      }
      const reset = await this.exec(`git -C ${root} reset --hard @{u}`)
      if (reset.code !== 0) throw new Error(reset.stderr.trim() || `git exited with code ${reset.code}`)
      return reset.stdout.toString('utf8').trim() || 'Reset to upstream.'
    }
    // Fast-forward only: fails clearly if the branch has diverged.
    const { code, stdout, stderr } = await this.exec(`git -C ${root} pull --ff-only`)
    if (code !== 0) throw new Error(stderr.trim() || `git exited with code ${code}`)
    return `${stdout.toString('utf8')}${stderr}`.trim() || 'Already up to date.'
  }

  async createFile(filePath: string): Promise<void> {
    const file = this.confine(filePath)
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.open(file, 'wx', (err, h) => (err ? reject(err) : resolve(h)))
    })
    await new Promise<void>((resolve, reject) => {
      this.sftp.close(handle, (err) => (err ? reject(err) : resolve()))
    })
  }

  async createDir(dirPath: string): Promise<void> {
    const dir = this.confine(dirPath)
    await new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = this.confine(oldPath)
    const to = this.confine(newPath)
    await new Promise<void>((resolve, reject) => {
      this.sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  async deleteEntry(entryPath: string): Promise<void> {
    const { code, stderr } = await this.exec(`rm -rf -- ${shellQuote(this.confine(entryPath))}`)
    if (code !== 0) throw new Error(stderr.trim() || `rm exited with code ${code}`)
  }

  async uploadFile(localSourcePath: string, destPath: string, onProgress?: ProgressFn): Promise<void> {
    const dest = this.confine(destPath)
    await new Promise<void>((resolve, reject) => {
      this.sftp.fastPut(localSourcePath, dest, stepOption(onProgress), (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  async uploadDir(localSourceDir: string, destPath: string, onProgress?: ProgressFn): Promise<void> {
    const dest = this.confine(destPath)
    // Create the target dir only if absent — mkdir on an existing folder errors,
    // and we want to merge into it.
    const exists = await new Promise<boolean>((resolve) => {
      this.sftp.stat(dest, (err) => resolve(!err))
    })
    if (!exists) {
      await new Promise<void>((resolve, reject) => {
        this.sftp.mkdir(dest, (err) => (err ? reject(err) : resolve()))
      })
    }
    const entries = await fs.readdir(localSourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const src = path.join(localSourceDir, entry.name)
      const to = joinPosix(dest, entry.name)
      if (entry.isDirectory()) {
        await this.uploadDir(src, to, onProgress)
      } else if (entry.isFile()) {
        await this.uploadFile(src, to, onProgress)
      }
    }
  }

  async downloadFile(srcPath: string, localDestPath: string, onProgress?: ProgressFn): Promise<void> {
    const src = this.confine(srcPath)
    await new Promise<void>((resolve, reject) => {
      this.sftp.fastGet(src, localDestPath, stepOption(onProgress), (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  async downloadDir(srcPath: string, localDestDir: string, onProgress?: ProgressFn): Promise<void> {
    const dir = this.confine(srcPath)
    await fs.mkdir(localDestDir, { recursive: true })
    type SftpEntry = { filename: string; attrs: import('ssh2').Stats }
    const list = await new Promise<SftpEntry[]>((resolve, reject) => {
      this.sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l)))
    })
    for (const item of list) {
      const from = joinPosix(dir, item.filename)
      const to = path.join(localDestDir, item.filename)
      let isDir = item.attrs.isDirectory()
      if (item.attrs.isSymbolicLink()) {
        try {
          const st = await new Promise<import('ssh2').Stats>((res, rej) => {
            this.sftp.stat(from, (e, s) => (e ? rej(e) : res(s)))
          })
          isDir = st.isDirectory()
        } catch {
          continue // skip broken links rather than failing the whole download
        }
      }
      if (isDir) {
        await this.downloadDir(from, to, onProgress)
      } else {
        await this.downloadFile(from, to, onProgress)
      }
    }
  }

  // Collects stdout as raw bytes (concatenated once) rather than decoding each
  // chunk to a string: chunk boundaries can split multi-byte UTF-8 sequences,
  // and callers like gitShowHead need the original bytes to decode correctly.
  // Aborts if output exceeds `maxBytes` so a huge command can't exhaust memory.
  private exec(
    command: string,
    maxBytes = MAX_STATUS_OUTPUT
  ): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        const chunks: Buffer[] = []
        let size = 0
        let stderr = ''
        let aborted = false
        stream
          .on('data', (d: Buffer) => {
            if (aborted) return
            size += d.length
            if (size > maxBytes) {
              aborted = true
              stream.destroy()
              const e = new Error('git produced more output than the display limit')
              ;(e as { code?: string }).code = 'EXEC_OUTPUT_TOO_LARGE'
              reject(e)
              return
            }
            chunks.push(d)
          })
          .once('close', (code: number) => {
            if (!aborted) resolve({ code: code ?? 0, stdout: Buffer.concat(chunks), stderr })
          })
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      })
    })
  }

  dispose(): void {
    // The ssh connection is owned by the host layer, not this provider.
  }
}

async function loadPrivateKey(keyPath?: string): Promise<Buffer | undefined> {
  const candidates = keyPath
    ? [expandHome(keyPath)]
    : [
        path.join(os.homedir(), '.ssh', 'id_ed25519'),
        path.join(os.homedir(), '.ssh', 'id_rsa')
      ]
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate)
    } catch {
      if (keyPath) throw new Error(`Cannot read private key: ${candidate}`)
    }
  }
  return undefined
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p
}

function joinPosix(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Builds a fastPut/fastGet options object whose `step` callback (which reports
// cumulative bytes for the file) is converted to per-call deltas for onProgress.
function stepOption(onProgress?: ProgressFn): { step?: (total: number, chunk: number, size: number) => void } {
  if (!onProgress) return {}
  let last = 0
  return {
    step: (total) => {
      if (total > last) {
        onProgress(total - last)
        last = total
      }
    }
  }
}
