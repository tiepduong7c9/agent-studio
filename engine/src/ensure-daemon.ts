// Ensures the engine daemon is running and reachable, spawning it detached if
// not. Detached (not a managed child) is deliberate: the daemon outlives the
// client so sessions survive an app restart — the client just reconnects. This
// is the local analogue of VS Code Server persisting on the remote host.

import { spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SOCKET_PATH } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}

export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<void> {
  if (await canConnect()) return;

  // daemon.js sits beside this module in dist/. ELECTRON_RUN_AS_NODE lets an
  // Electron host launch it as plain Node (harmlessly ignored by a real node).
  const daemonJs = path.join(__dirname, 'daemon.js');
  const child = spawn(opts.nodePath || process.execPath, [daemonJs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await canConnect()) return;
  }
  throw new Error('agent-studio engine daemon did not come up within 4s');
}
