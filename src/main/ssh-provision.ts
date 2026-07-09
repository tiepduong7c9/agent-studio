import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import { sshExec, shellQuote } from './ssh-exec'

// Bootstrap the engine onto a remote host, VS Code Server-style: check whether
// the matching version is already installed under ~/.agent-studio-server/<ver>/,
// and if not, SFTP-upload the packed tarball and extract it. Returns the remote
// server directory (relative to the remote home).

const BASE = '.agent-studio-server'

function localTarball(): string {
  return path.join(app.getAppPath(), 'engine', 'dist-pack', 'engine.tgz')
}

export async function provisionEngine(client: SshClient, sftp: SFTPWrapper, version: string): Promise<string> {
  const remoteDir = `${BASE}/${version}`

  // Already provisioned at the right version? (cli.js prints its version.)
  // Compare the last non-empty line, since a login shell (sh -lc) may emit
  // banner/MOTD/nvm output to stdout before the command's own output.
  const check = await sshExec(client, `node ${shellQuote(`${remoteDir}/dist/cli.js`)} version 2>/dev/null || true`)
  if (lastLine(check.stdout) === version) return remoteDir

  // Need a Node runtime on the remote (>=18). We don't ship one yet.
  const node = await sshExec(client, 'command -v node && node --version || true')
  if (!/v(\d+)\./.test(node.stdout)) {
    throw new Error('Agent Studio engine requires Node.js (>=18) on the remote host, but `node` was not found on PATH.')
  }
  const major = Number(/v(\d+)\./.exec(node.stdout)?.[1] ?? '0')
  if (major < 18) throw new Error(`Remote Node.js is too old (${node.stdout.trim()}); need >=18.`)

  const tgz = localTarball()
  if (!fs.existsSync(tgz)) {
    throw new Error(`Engine tarball not found at ${tgz}. Build it with: (cd engine && npm run pack)`)
  }

  // Upload into a temp path, then extract into the versioned dir.
  await sshExec(client, `mkdir -p ${shellQuote(remoteDir)}`)
  const remoteTgz = `${remoteDir}/engine.tgz`
  await sftpPut(sftp, tgz, remoteTgz)
  const extract = await sshExec(client, `cd ${shellQuote(remoteDir)} && tar xzf engine.tgz && rm -f engine.tgz`)
  if (extract.code !== 0) throw new Error(`Failed to unpack engine on remote: ${extract.stderr.trim()}`)

  // Verify the install responds.
  const verify = await sshExec(client, `node ${shellQuote(`${remoteDir}/dist/cli.js`)} version`)
  if (lastLine(verify.stdout) !== version) {
    throw new Error(`Engine provisioning verification failed (got '${lastLine(verify.stdout)}').`)
  }
  return remoteDir
}

// The last non-empty, trimmed line of command output — skips login-shell banner
// text a non-interactive `sh -lc` may print before the command's own output.
function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

function sftpPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()))
  })
}
