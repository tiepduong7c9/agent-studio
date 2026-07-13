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

/** A provisioned engine: its remote server dir plus the absolute path to the
 *  remote `node` used to run it (so every later invocation uses that runtime). */
export interface ProvisionResult {
  remoteDir: string
  nodePath: string
}

function localTarball(): string {
  return path.join(app.getAppPath(), 'engine', 'dist-pack', 'engine.tgz')
}

// Shell snippet that prints "<abs-node-path>\t<version>" for a usable Node on
// the remote, or nothing. A non-interactive `sh -lc` login shell (dash) sources
// ~/.profile but not ~/.bashrc, so Node installed via nvm/fnm is missing from
// PATH; probe those managers and common install dirs before giving up.
const NODE_PROBE = [
  'n=$(command -v node 2>/dev/null) || true',
  'if [ -z "$n" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; n=$(command -v node 2>/dev/null) || true; fi',
  'if [ -z "$n" ] && command -v fnm >/dev/null 2>&1; then eval "$(fnm env 2>/dev/null)" >/dev/null 2>&1; n=$(command -v node 2>/dev/null) || true; fi',
  'if [ -z "$n" ]; then for d in /usr/local/bin /opt/homebrew/bin /usr/bin "$HOME/.local/bin"; do [ -x "$d/node" ] && { n="$d/node"; break; }; done; fi',
  'if [ -z "$n" ]; then for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.fnm/node-versions/*/installation/bin; do [ -x "$d/node" ] && n="$d/node"; done; fi',
  '[ -n "$n" ] && printf "%s\\t%s\\n" "$n" "$("$n" --version 2>/dev/null)"'
].join('\n')

/** Locate a usable Node (>=18) on the remote, returning its absolute path so
 *  later `node` invocations don't depend on the login shell's PATH. */
export async function resolveRemoteNode(client: SshClient): Promise<{ path: string; version: string }> {
  const res = await sshExec(client, NODE_PROBE)
  const line = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const tab = line.indexOf('\t')
  const nodePath = tab >= 0 ? line.slice(0, tab) : ''
  const version = tab >= 0 ? line.slice(tab + 1) : ''
  const major = /^v(\d+)\./.exec(version)
  if (!nodePath || !major) {
    throw new Error('Agent Studio engine requires Node.js (>=18) on the remote host, but `node` was not found on PATH (checked nvm, fnm, and common install locations).')
  }
  if (Number(major[1]) < 18) throw new Error(`Remote Node.js is too old (${version}); need >=18.`)
  return { path: nodePath, version }
}

export async function provisionEngine(client: SshClient, sftp: SFTPWrapper, version: string): Promise<ProvisionResult> {
  const remoteDir = `${BASE}/${version}`

  // Resolve the remote Node runtime first, then use its absolute path for every
  // subsequent `node` call — a login shell (sh -lc) may not have it on PATH.
  const node = await resolveRemoteNode(client)
  const nodeCmd = shellQuote(node.path)
  const cliPath = shellQuote(`${remoteDir}/dist/cli.js`)

  // Already provisioned at the right version? (cli.js prints its version.)
  // Compare the last non-empty line, since a login shell (sh -lc) may emit
  // banner/MOTD/nvm output to stdout before the command's own output.
  const check = await sshExec(client, `${nodeCmd} ${cliPath} version 2>/dev/null || true`)
  if (lastLine(check.stdout) === version) return { remoteDir, nodePath: node.path }

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
  const verify = await sshExec(client, `${nodeCmd} ${cliPath} version`)
  if (lastLine(verify.stdout) !== version) {
    throw new Error(`Engine provisioning verification failed (got '${lastLine(verify.stdout)}').`)
  }
  return { remoteDir, nodePath: node.path }
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
