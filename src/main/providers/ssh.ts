import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, type SFTPWrapper } from 'ssh2'
import type {
  FileEntry,
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
import { assertRepoRelative, isMissingInHead } from './local'
import type { ProjectProvider } from './types'

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
