import * as os from 'os';
import * as path from 'path';
import { createStaticIPCHandle } from './vendor/vs/base/parts/ipc/node/ipc.net.js';

// Per-user engine state. Mirrors ccremote's ~/.ccremote but rebranded; this is
// where the daemon keeps its socket, pid, and persisted sessions.
export const STATE_DIR = path.join(os.homedir(), '.agent-studio');

export const VERSION = '0.1.0';

// Platform-correct control channel: a Unix domain socket on posix, a named pipe
// on Windows. createStaticIPCHandle derives a stable, collision-resistant path
// from (dir, type, version) so multiple engine versions don't clash.
export const SOCKET_PATH = createStaticIPCHandle(STATE_DIR, 'daemon', VERSION);

export const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
export const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
