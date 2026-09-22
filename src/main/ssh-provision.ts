import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import { sshExec, shellQuote } from './ssh-exec'

// Bootstrap the engine onto a remote host, VS Code Server-style: check whether
// the matching version is already installed under ~/.agent-studio-server/<ver>/,
// and if not, SFTP-upload the packed tarball and extract it. Returns the remote
// server directory (relative to the remote home).
//
// The tarball is deliberately arch-free (see scripts/pack.mjs): the one piece of
// the engine that isn't portable JavaScript is the Claude native binary, which
// npm ships as a platform-gated optional dep. It's fetched on the remote, for
// the remote's platform — so an arm64 client can drive x64 hosts and vice versa.

const BASE = '.agent-studio-server'

/** A provisioned engine: its remote server dir plus the absolute path to the
 *  remote `node` used to run it (so every later invocation uses that runtime). */
export interface ProvisionResult {
  remoteDir: string
  nodePath: string
}

function localTarball(): string {
  // Mirrors engineClientPath(): packaged, the engine is extraResources beside
  // the asar; in dev it's in the repo tree.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'engine')
    : path.join(app.getAppPath(), 'engine')
  return path.join(base, 'dist-pack', 'engine.tgz')
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
  if (lastLine(check.stdout) !== version) {
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
  }

  // Runs even on the already-provisioned path: an install laid down by an older
  // client shipped that client's native binary, which is the wrong arch whenever
  // the two machines differ. Cheap when it's already right (one `sh -lc`).
  await ensureRemoteNative(client, remoteDir, node.path)

  return { remoteDir, nodePath: node.path }
}

// Make sure the remote engine has the Claude native binary for ITS OWN platform.
//
// @anthropic-ai/claude-agent-sdk locates the CLI by resolving
// `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]/claude` next to itself; with
// no match it fails every session/new and session/load with "Claude native binary
// not found for <plat>", which surfaces in the UI as an ACP error on open/resume.
//
// The binary is ~300 MB, so rather than upload it (and we couldn't anyway — a
// client only ever has its own arch installed) we `npm pack` it on the remote
// into a shared, version-keyed cache under ~/.agent-studio-server/natives/ and
// symlink it into the engine's node_modules. The cache is shared across engine
// versions, so an engine upgrade re-links instead of re-downloading.
function nativeScript(remoteDir: string, nodePath: string): string {
  return [
    'set -e',
    `node=${shellQuote(nodePath)}`,
    // npm's shebang is `#!/usr/bin/env node`, so npm needs node on PATH even
    // though we call everything else by absolute path.
    'PATH="$(dirname "$node"):$PATH"; export PATH',
    `nm="$HOME"/${shellQuote(remoteDir)}/node_modules`,
    'sdk="$nm/@anthropic-ai/claude-agent-sdk"',
    // No SDK in the tree means the adapter doesn't need a native binary.
    '[ -d "$sdk" ] || { echo "SKIP no-sdk"; exit 0; }',
    'ver=$("$node" -p "require(process.argv[1]).version" "$sdk/package.json")',
    'case "$(uname -s)" in Linux) o=linux;; Darwin) o=darwin;; *) echo "unsupported remote OS: $(uname -s)" >&2; exit 1;; esac',
    'case "$(uname -m)" in x86_64|amd64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported remote CPU: $(uname -m)" >&2; exit 1;; esac',
    // Same candidate order the SDK probes in, so we install what it will pick.
    'if [ "$o" = linux ]; then',
    '  if (ldd --version 2>&1 | grep -qi musl) || ls /lib/ld-musl-* >/dev/null 2>&1; then',
    '    cands="claude-agent-sdk-linux-$a-musl claude-agent-sdk-linux-$a"',
    '  else',
    '    cands="claude-agent-sdk-linux-$a claude-agent-sdk-linux-$a-musl"',
    '  fi',
    'else',
    '  cands="claude-agent-sdk-$o-$a"',
    'fi',
    'for c in $cands; do [ -x "$nm/@anthropic-ai/$c/claude" ] && { echo "OK $c"; exit 0; }; done',
    'pkg=${cands%% *}',
    'cache="$HOME/.agent-studio-server/natives/$pkg-$ver"',
    'if [ ! -x "$cache/claude" ]; then',
    '  command -v npm >/dev/null 2>&1 || { echo "npm is required on the remote host to install the Claude native binary (@anthropic-ai/$pkg@$ver)" >&2; exit 1; }',
    '  tmp="$cache.tmp.$$"',
    '  rm -rf "$tmp"; mkdir -p "$tmp/x"',
    // `npm pack <spec>` just downloads the tarball into the cwd — it never touches
    // the engine's own package.json or lockfile.
    '  ( cd "$tmp" && npm pack "@anthropic-ai/$pkg@$ver" --silent >/dev/null )',
    '  tar xzf "$tmp"/*.tgz -C "$tmp/x"',
    '  rm -rf "$cache"; mkdir -p "$(dirname "$cache")"',
    '  mv "$tmp/x/package" "$cache"',
    '  rm -rf "$tmp"',
    '  chmod +x "$cache/claude"',
    'fi',
    'mkdir -p "$nm/@anthropic-ai"',
    'rm -rf "$nm/@anthropic-ai/$pkg"',
    'ln -s "$cache" "$nm/@anthropic-ai/$pkg"',
    'echo "INSTALLED $pkg"'
  ].join('\n')
}

async function ensureRemoteNative(client: SshClient, remoteDir: string, nodePath: string): Promise<void> {
  const res = await sshExec(client, nativeScript(remoteDir, nodePath))
  if (res.code !== 0) {
    throw new Error(`Could not install the Claude native binary on the remote host: ${res.stderr.trim() || `exit ${res.code}`}`)
  }
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
