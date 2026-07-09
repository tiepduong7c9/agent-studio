// P4 smoke test: prove the transport works over an arbitrary duplex stream via
// connectOverStream — the exact seam the SSH tunnel uses. A raw net.Socket
// connected to the server's Unix socket stands in for the ssh2 tunnelled stream
// (which is likewise just a Duplex). If this drives the sessionManager channel,
// so will a real tunnel.

import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { serve } from './net.js'
import { connectOverStream } from './connect-socket.js'
import { SessionManager } from './acp/session-manager.js'
import { SessionManagerChannel, SESSION_MANAGER_CHANNEL, createSessionManagerClient } from './channels/session-manager.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('SMOKE FAIL:', msg); process.exit(1) }
}

async function main(): Promise<void> {
  const sock = path.join(os.tmpdir(), `agent-studio-tunnel-${process.pid}.sock`)
  try { fs.unlinkSync(sock) } catch { /* ignore */ }

  const manager = new SessionManager()
  const server = await serve(sock)
  server.registerChannel(SESSION_MANAGER_CHANNEL, new SessionManagerChannel(manager))

  // Stand-in for an SSH-tunnelled stream: a plain duplex socket to the server.
  const stream = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(sock, () => resolve(s))
    s.once('error', reject)
  })

  const client = connectOverStream(stream, 'tunnel-smoke')
  const sm = createSessionManagerClient(client.getChannel(SESSION_MANAGER_CHANNEL))

  const before = await sm.list()
  assert(Array.isArray(before), 'list() should return an array over the tunnelled stream')

  client.dispose()
  server.dispose()
  try { fs.unlinkSync(sock) } catch { /* ignore */ }

  console.log(`SMOKE OK: sessionManager reachable via connectOverStream (${before.length} sessions listed)`)
  process.exit(0)
}

main().catch((err) => { console.error('SMOKE ERROR:', err?.stack || err); process.exit(1) })
