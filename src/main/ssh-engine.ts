import type { Duplex } from 'stream'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import type { EngineModule } from '../shared/acp'
import type { Engine } from './engine'
import { provisionEngine } from './ssh-provision'
import { sshExec, shellQuote } from './ssh-exec'

// Connect to a remote engine over SSH, the VS Code Remote-SSH way:
//   1. provision the engine onto the host (SFTP the bundle, version-gated)
//   2. `cli.js connect-info` ensures the remote daemon and prints its socket
//   3. streamlocal-forward that Unix socket over SSH → a duplex stream
//   4. build the IPC client over that stream (connectOverStream)
// The daemon persists on the remote, so a dropped SSH connection reconnects to
// the same live sessions.

interface ConnectInfo { socket: string; version: string }

export async function connectRemoteEngine(
  mod: EngineModule,
  client: SshClient,
  sftp: SFTPWrapper,
  host: string
): Promise<Engine> {
  const remoteDir = await provisionEngine(client, sftp, mod.VERSION)

  const info = await connectInfo(client, remoteDir)
  const stream = await streamLocalForward(client, info.socket)

  const conn = mod.connectOverStream(stream, `agent-studio-ssh-${host}`)
  const sm = mod.createSessionManagerClient(conn.getChannel(mod.SESSION_MANAGER_CHANNEL))
  return { sm, stream, dispose: () => { conn.dispose(); stream.destroy() } }
}

async function connectInfo(client: SshClient, remoteDir: string): Promise<ConnectInfo> {
  const res = await sshExec(client, `node ${shellQuote(`${remoteDir}/dist/cli.js`)} connect-info`)
  if (res.code !== 0) throw new Error(`Remote engine connect-info failed: ${res.stderr.trim() || res.code}`)
  // Take the last JSON line (a login shell may emit banner text first).
  const line = res.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
  if (!line) throw new Error(`Remote engine returned no connect info: ${res.stdout.trim()}`)
  return JSON.parse(line) as ConnectInfo
}

// Open a direct-streamlocal channel to the remote Unix socket (OpenSSH
// streamlocal-forward extension) and return it as a duplex stream.
function streamLocalForward(client: SshClient, socketPath: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const anyClient = client as unknown as {
      openssh_forwardOutStreamLocal?: (socketPath: string, cb: (err: Error | undefined, stream: Duplex) => void) => void
    }
    if (typeof anyClient.openssh_forwardOutStreamLocal !== 'function') {
      return reject(new Error('The SSH server does not support Unix-socket forwarding (streamlocal).'))
    }
    anyClient.openssh_forwardOutStreamLocal(socketPath, (err, stream) => (err ? reject(err) : resolve(stream)))
  })
}
