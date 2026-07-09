// P2 smoke test: prove the sessionManager channel round-trips over a real socket
// via the vendored VS Code IPC layer. Verifies the deterministic plumbing —
// create, onDidChangeSessions, list, and the per-session onSessionEvent stream —
// without asserting anything Claude-specific (the first session event is either
// real ACP state on success or an acp_error, either of which proves the path).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { serve, connect } from './net.js';
import { SessionManager } from './acp/session-manager.js';
import { SessionManagerChannel, SESSION_MANAGER_CHANNEL, createSessionManagerClient } from './channels/session-manager.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('SMOKE FAIL:', msg); process.exit(1); }
}

async function main(): Promise<void> {
  const sock = path.join(os.tmpdir(), `agent-studio-acp-smoke-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch { /* ignore */ }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-acp-cwd-'));

  const manager = new SessionManager();
  const server = await serve(sock);
  server.registerChannel(SESSION_MANAGER_CHANNEL, new SessionManagerChannel(manager));

  const conn = await connect(sock, 'acp-smoke');
  const sm = createSessionManagerClient(conn.getChannel(SESSION_MANAGER_CHANNEL));

  // 1) onDidChangeSessions fires on create.
  const sawChange = new Promise<string[]>((resolve) => {
    const d = sm.onDidChangeSessions((sessions) => { resolve(sessions.map((s) => s.id)); d.dispose(); });
  });

  const created = await sm.create({ cwd, name: 'smoke-session' });
  assert(!!created?.id, 'create should return a session with an id');
  console.log(`  created session ${created.id} (${created.name}) in ${cwd}`);

  const changedIds = await withTimeout(sawChange, 5000, 'onDidChangeSessions never fired');
  assert(changedIds.includes(created.id), 'change event should include the new session');

  // 2) list() over IPC includes it.
  const listed = await sm.list();
  assert(listed.some((s) => s.id === created.id), 'list() should include the created session');

  // 3) snapshot() over IPC returns a structured object.
  const snap = await sm.snapshot(created.id);
  assert(snap !== null && Array.isArray(snap.events), 'snapshot() should return { events: [...] }');

  // 4) onSessionEvent streams at least one event (real ACP state or acp_error).
  const firstEvent = new Promise<any>((resolve) => {
    const d = sm.onSessionEvent(created.id)((e) => { resolve(e); d.dispose(); });
  });
  const evt = await withTimeout(firstEvent, 25000, 'no session event received within 25s');
  console.log(`  first session event over IPC: type=${evt?.type}`);
  assert(typeof evt?.type === 'string', 'session event should have a string type');

  // Cleanup.
  await sm.kill(created.id);
  conn.dispose();
  server.dispose();
  try { fs.unlinkSync(sock); } catch { /* ignore */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('SMOKE OK: sessionManager channel create/list/snapshot/onSessionEvent round-trip over VS Code IPC');
  process.exit(0);
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

main().catch((err) => { console.error('SMOKE ERROR:', err?.stack || err); process.exit(1); });
