import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

// Per-user engine state. Mirrors ccremote's ~/.ccremote but rebranded; this is
// where the daemon keeps its socket, pid, and persisted sessions.
export const STATE_DIR = path.join(os.homedir(), '.agent-studio');

export const VERSION = '0.2.6';

// Platform-correct control channel: a Unix domain socket on posix, a named pipe
// on Windows. This mirrors VS Code's createStaticIPCHandle (prefer
// XDG_RUNTIME_DIR, fall back to the state dir) but under our own "agent-studio-"
// prefix,
// and — crucially — keys the socket on a hash of the FULL version. VS Code
// truncates the version to 4 chars, so semver patches (0.1.0 vs 0.1.1) collide
// on one socket, which let a stale daemon of the OLD code be reused after an
// upgrade. Hashing the full version gives every distinct VERSION its own socket
// (and thus a freshly-spawned daemon running the matching code).
function daemonSocketPath(): string {
  const scope = createHash('sha256').update(STATE_DIR).digest('hex').slice(0, 8);
  const ver = createHash('sha256').update(VERSION).digest('hex').slice(0, 4);
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-studio-${scope}-${ver}-daemon-sock`;
  const name = `agent-studio-${scope}-${ver}-daemon.sock`;
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (process.platform !== 'darwin' && xdg && !process.env['VSCODE_PORTABLE']) {
    return path.join(xdg, name);
  }
  return path.join(STATE_DIR, name);
}
export const SOCKET_PATH = daemonSocketPath();

export const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
export const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
