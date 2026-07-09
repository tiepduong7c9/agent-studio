// User/SSH-facing CLI for the engine. This is the `bin` and the command run over
// SSH exec during remote bootstrap. Subcommands:
//   daemon        run the daemon in the foreground
//   connect-info  ensure the daemon is up, print { socket, version } as JSON
//   version       print the engine version (used for provisioning version checks)

import { SOCKET_PATH, VERSION } from './constants.js'
import { ensureDaemon } from './ensure-daemon.js'

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'daemon': {
      const { startDaemon } = await import('./daemon-core.js')
      await startDaemon()
      return
    }
    case 'connect-info': {
      // Ensure a daemon is running on this host, then tell the client where to
      // reach it. The client streamlocal-forwards to `socket` over SSH.
      await ensureDaemon()
      process.stdout.write(JSON.stringify({ socket: SOCKET_PATH, version: VERSION }) + '\n')
      process.exit(0)
      return
    }
    case 'version':
    case '--version':
      process.stdout.write(VERSION + '\n')
      process.exit(0)
      return
    default:
      process.stderr.write('usage: agent-studio-engine <daemon|connect-info|version>\n')
      process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`agent-studio-engine cli error: ${err?.stack || err}\n`)
  process.exit(1)
})
