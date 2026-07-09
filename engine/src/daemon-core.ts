// The daemon's actual logic, factored out of the entry point so both the
// spawned `daemon.js` and the `cli.js daemon` subcommand can start it.

import * as fs from 'fs'
import { serve } from './net.js'
import { PingChannel, PING_CHANNEL } from './channels/ping.js'
import { SessionManagerChannel, SESSION_MANAGER_CHANNEL } from './channels/session-manager.js'
import { SessionManager } from './acp/session-manager.js'
import { STATE_DIR, SOCKET_PATH, PID_FILE } from './constants.js'

export async function startDaemon(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  // Remove a stale socket left by a previous run so listen() doesn't EADDRINUSE.
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* not there — fine */ }

  const manager = new SessionManager()

  const server = await serve(SOCKET_PATH)
  server.registerChannel(PING_CHANNEL, new PingChannel())
  server.registerChannel(SESSION_MANAGER_CHANNEL, new SessionManagerChannel(manager))

  fs.writeFileSync(PID_FILE, String(process.pid))
  process.stderr.write(`agent-studio-engine: listening on ${SOCKET_PATH} (pid=${process.pid})\n`)

  const shutdown = () => {
    manager.suspendAll() // adapters exit; conversations stay resumable
    server.dispose()
    try { fs.unlinkSync(SOCKET_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
