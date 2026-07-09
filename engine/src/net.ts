// The engine's transport surface, re-exported from the vendored VS Code IPC
// leaf layer. `serve`/`connect` stand up a channel server/client over a Unix
// socket (or named pipe); NodeSocket wraps an arbitrary duplex stream as an
// ISocket — that's the seam the SSH tunnel will plug into later (P4).

export { serve, connect, NodeSocket, Server, Client } from './vendor/vs/base/parts/ipc/node/ipc.net.js';
export type { IServerChannel, IChannel } from './vendor/vs/base/parts/ipc/common/ipc.js';
export { IPCServer, IPCClient } from './vendor/vs/base/parts/ipc/common/ipc.js';
export type { ISocket } from './vendor/vs/base/parts/ipc/common/ipc.net.js';
export { Event } from './vendor/vs/base/common/event.js';
