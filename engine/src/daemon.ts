// Daemon entry point — the file ensure-daemon spawns as `node daemon.js`.
import { startDaemon } from './daemon-core.js'

startDaemon().catch((err) => {
  process.stderr.write(`agent-studio-engine failed to start: ${err?.stack || err}\n`)
  process.exit(1)
})
