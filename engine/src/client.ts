// Client entry for the engine. Bundled to dist/client.js and loaded by the
// Electron main process (dynamic import by absolute path, so it stays an
// external — VS Code-Server style). Pure IPC + the session-manager proxy; no
// ACP/native deps, so it's cheap to load anywhere a client runs.

export { connect, NodeSocket } from './net.js';
export { connectOverStream } from './connect-socket.js';
export { ensureDaemon } from './ensure-daemon.js';
export { SOCKET_PATH, VERSION } from './constants.js';
export {
  SESSION_MANAGER_CHANNEL,
  createSessionManagerClient,
} from './channels/session-manager.js';
export type { ISessionManagerClient } from './channels/session-manager.js';
export type {
  SessionMeta,
  ClaudeStatus,
  AcpEvent,
  AcpSnapshot,
  AcpConversation,
  CreateSessionOptions,
} from './acp/types.js';
