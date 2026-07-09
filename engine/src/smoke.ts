// P1 smoke test: prove the vendored VS Code IPC layer round-trips over a real
// local socket. Stands up a Server with the ping channel, connects a Client,
// calls both channel commands, asserts the responses, and exits non-zero on any
// mismatch. Self-contained — uses a throwaway socket under the OS temp dir.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { serve, connect } from './net.js';
import { PingChannel, PING_CHANNEL, pingClient } from './channels/ping.js';

async function main(): Promise<void> {
  const sock = path.join(os.tmpdir(), `agent-studio-smoke-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch { /* ignore */ }

  const server = await serve(sock);
  server.registerChannel(PING_CHANNEL, new PingChannel());

  const client = await connect(sock, 'smoke-client');
  const ping = pingClient(client.getChannel(PING_CHANNEL));

  const pong = await ping.ping();
  assert(pong === 'pong', `ping -> expected 'pong', got ${JSON.stringify(pong)}`);

  const payload = { hello: 'world', n: 42, nested: [1, 2, 3] };
  const echoed = await ping.echo(payload);
  assert(JSON.stringify(echoed) === JSON.stringify(payload), `echo mismatch: ${JSON.stringify(echoed)}`);

  client.dispose();
  server.dispose();
  try { fs.unlinkSync(sock); } catch { /* ignore */ }

  console.log('SMOKE OK: ping -> pong, echo round-trips over VS Code IPC on a local socket');
  process.exit(0);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('SMOKE FAIL:', msg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err?.stack || err);
  process.exit(1);
});
