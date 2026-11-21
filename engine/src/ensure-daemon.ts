// Ensures the engine daemon is running and reachable, spawning it detached if
// not. Detached (not a managed child) is deliberate: the daemon outlives the
// client so sessions survive an app restart — the client just reconnects. This
// is the local analogue of VS Code Server persisting on the remote host.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SOCKET_PATH, LOG_DIR, DAEMON_LOG } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

// The daemon's stdout/stderr go to an append-only log file rather than being
// discarded, so a crash leaves evidence — notably V8's own "FATAL ERROR: ...
// heap limit" line, which it prints just before aborting and which no JS-level
// handler can capture. The file is rotated (one previous generation kept) at
// spawn time. Returns null if the log can't be opened; the daemon still starts.
function openDaemonLog(): number | null {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(DAEMON_LOG).size > LOG_ROTATE_BYTES) fs.renameSync(DAEMON_LOG, `${DAEMON_LOG}.1`);
    } catch { /* no log yet */ }
    return fs.openSync(DAEMON_LOG, 'a');
  } catch {
    return null;
  }
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

export interface EnsureDaemonOptions {
  /** Node binary to launch the daemon with. Defaults to process.execPath. */
  nodePath?: string;
  /** Give the daemon's sessions the agent-studio MCP tools. Only the desktop
   *  app's own local engine sets this; remote hosts (started via cli.js) don't. */
  studioMcp?: boolean;
}

export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<void> {
  if (await canConnect()) return;

  // daemon.js sits beside this module in dist/. ELECTRON_RUN_AS_NODE lets an
  // Electron host launch it as plain Node (harmlessly ignored by a real node).
  const daemonJs = path.join(__dirname, 'daemon.js');
  const logFd = openDaemonLog();
  const out = logFd ?? 'ignore';
  const child = spawn(opts.nodePath || process.execPath, [daemonJs], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(opts.studioMcp ? { AGENT_STUDIO_MCP: '1' } : {}) },
  });
  child.unref();
  if (logFd !== null) fs.closeSync(logFd); // the child holds its own copy

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await canConnect()) return;
  }
  throw new Error('agent-studio engine daemon did not come up within 4s');
}
