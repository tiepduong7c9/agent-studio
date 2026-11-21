// The daemon's actual logic, factored out of the entry point so both the
// spawned `daemon.js` and the `cli.js daemon` subcommand can start it.

import * as fs from 'fs'
import * as v8 from 'v8'
import { serve } from './net.js'
import { PingChannel, PING_CHANNEL } from './channels/ping.js'
import { SessionManagerChannel, SESSION_MANAGER_CHANNEL } from './channels/session-manager.js'
import { SessionManager } from './acp/session-manager.js'
import { fetchModelCatalog } from './acp/model-catalog.cjs'
import { STATE_DIR, SOCKET_PATH, PID_FILE, VERSION, DAEMON_LOG } from './constants.js'

// How often the daemon logs its memory use. The daemon is long-lived (days),
// so a slow leak only shows up as a trend across these lines.
const MEMORY_LOG_INTERVAL_MS = 5 * 60_000

// ensure-daemon rotates the log at spawn, but the daemon lives for days and
// forwards every adapter's stderr, so also cap it while running. The fd was
// opened O_APPEND, so copy-then-truncate is safe: writes resume at offset 0.
const LOG_MAX_BYTES = 20 * 1024 * 1024

function capLog(): void {
  try {
    if (fs.statSync(DAEMON_LOG).size <= LOG_MAX_BYTES) return
    fs.copyFileSync(DAEMON_LOG, `${DAEMON_LOG}.1`)
    fs.truncateSync(DAEMON_LOG, 0)
  } catch { /* no log file (foreground run) — nothing to cap */ }
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
}

function logMemory(manager: SessionManager): void {
  capLog()
  const m = process.memoryUsage()
  const s = manager.memoryStats()
  const top = s.top
    .filter((r) => r.events > 0)
    .map((r) => `${r.id}(${r.status},${r.events}ev,${mb(r.bytes)})`)
    .join(' ')
  log(
    `memory rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} ` +
    `external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)} | ` +
    `sessions=${s.total} running=${s.running} historyEvents=${s.events} historyBytes=${mb(s.bytes)}` +
    (top ? ` | top: ${top}` : ''),
  )
}

export async function startDaemon(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  // Remove a stale socket left by a previous run so listen() doesn't EADDRINUSE.
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* not there — fine */ }

  log(
    `agent-studio-engine ${VERSION} starting (pid=${process.pid}, node=${process.version}, ` +
    `heapLimit=${mb(v8.getHeapStatistics().heap_size_limit)})`,
  )
  // Log before dying so the reason lands in the file with a timestamp; then
  // exit like Node would by default (the app respawns the daemon on next use).
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err?.stack || err}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason: any) => {
    log(`unhandledRejection: ${reason?.stack || reason}`)
    process.exit(1) // Node's default for an unhandled rejection
  })

  const manager = new SessionManager()

  // Warm the model catalog cache at startup (fire-and-forget) so the first
  // session's adapter spawn hits a warm cache instead of blocking on the
  // /v1/models fetch. Best-effort — failures are swallowed and retried lazily.
  void fetchModelCatalog(process.env).catch(() => {})

  const server = await serve(SOCKET_PATH)
  server.registerChannel(PING_CHANNEL, new PingChannel())
  server.registerChannel(SESSION_MANAGER_CHANNEL, new SessionManagerChannel(manager))

  fs.writeFileSync(PID_FILE, String(process.pid))
  log(`listening on ${SOCKET_PATH}`)

  logMemory(manager)
  setInterval(() => logMemory(manager), MEMORY_LOG_INTERVAL_MS).unref()

  const shutdown = (signal: string) => {
    log(`${signal} received, shutting down`)
    manager.suspendAll() // adapters exit; conversations stay resumable
    server.dispose()
    try { fs.unlinkSync(SOCKET_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
