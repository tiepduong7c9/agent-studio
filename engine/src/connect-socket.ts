import type { Duplex } from 'stream'
import { Client } from './vendor/vs/base/parts/ipc/common/ipc.net.js'
import { NodeSocket } from './vendor/vs/base/parts/ipc/node/ipc.net.js'

// Build an IPC Client over any duplex stream — the generalization of connect()
// that isn't tied to a Unix socket. NodeSocket only uses Duplex methods
// (write/end/destroy + events), so an SSH-tunnelled channel stream works exactly
// like a local net.Socket. This is the seam the remote (SSH) transport plugs into.
export function connectOverStream(stream: Duplex, clientId: string): Client {
  return Client.fromSocket(new NodeSocket(stream as any, `ipc-client${clientId}`), clientId)
}
