import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import * as os from 'os'
import * as pty from 'node-pty'
import type { ClientChannel } from 'ssh2'
import type { Result } from '../shared/types'
import { sshTargetFor } from './engine'

// One integrated terminal per open tab, backed by a real PTY so full-screen
// programs (vim, htop, less) and line editing work — the same xterm.js/node-pty
// pairing VS Code's terminal is built on. Local terminals get a node-pty child;
// terminals for an SSH session reuse that host's existing ssh2 connection and
// run over a remote PTY channel. The PTY lives in the main process for the life
// of its tab: switching tabs hides the view but the shell keeps running.

/** Options for opening a terminal, sent from the renderer. */
interface TerminalOpen {
  cwd: string
  /** "user@host" for an SSH session's terminal, null for a local one. */
  host: string | null
  cols: number
  rows: number
}

/** A live PTY (local child or remote ssh channel) addressed by a generated id. */
interface TerminalHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The user's login shell, falling back to a sensible per-platform default. */
function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL
  return process.platform === 'win32' ? 'powershell.exe' : 'bash'
}

export function registerTerminalIpc(getWindow: () => BrowserWindow | null): () => void {
  const handles = new Map<string, TerminalHandle>()

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  // Spawn a local PTY child rooted at the session's cwd.
  const openLocal = (id: string, o: TerminalOpen): TerminalHandle => {
    const child = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cwd: o.cwd || os.homedir(),
      cols: o.cols || 80,
      rows: o.rows || 24,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >
    })
    child.onData((data) => send('terminal:data', { id, data }))
    child.onExit(({ exitCode }) => {
      handles.delete(id)
      send('terminal:exit', { id, exitCode })
    })
    return {
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill()
    }
  }

  // Open a remote PTY over the host's existing ssh2 connection. exec'ing a login
  // shell after `cd` lands the terminal in the session's folder with no visible
  // `cd` echo (unlike shell() + a written cd command).
  const openSsh = (id: string, o: TerminalOpen): Promise<TerminalHandle> => {
    const target = sshTargetFor(o.host!)
    if (!target) throw new Error(`Not connected to ${o.host}`)
    const command = `cd ${shellQuote(o.cwd)} 2>/dev/null; exec ${'${SHELL:-bash}'} -il`
    return new Promise<TerminalHandle>((resolve, reject) => {
      target.client.exec(
        command,
        { pty: { term: 'xterm-256color', cols: o.cols || 80, rows: o.rows || 24 } },
        (err, stream: ClientChannel) => {
          if (err) return reject(err)
          stream.on('data', (d: Buffer) => send('terminal:data', { id, data: d.toString('utf8') }))
          stream.stderr.on('data', (d: Buffer) =>
            send('terminal:data', { id, data: d.toString('utf8') })
          )
          stream.on('close', (code: number | null) => {
            handles.delete(id)
            send('terminal:exit', { id, exitCode: code ?? 0 })
          })
          resolve({
            write: (data) => stream.write(data),
            resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
            kill: () => {
              try {
                stream.signal('KILL')
              } catch {
                // Some servers reject signals; closing the channel still ends it.
              }
              stream.end()
            }
          })
        }
      )
    })
  }

  ipcMain.handle('terminal:create', async (_e, o: TerminalOpen): Promise<Result<{ id: string }>> => {
    try {
      const id = randomUUID()
      handles.set(id, o.host ? await openSsh(id, o) : openLocal(id, o))
      return { ok: true, data: { id } }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.on('terminal:input', (_e, id: string, data: string) => {
    handles.get(id)?.write(data)
  })

  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    handles.get(id)?.resize(cols, rows)
  })

  ipcMain.on('terminal:kill', (_e, id: string) => {
    const h = handles.get(id)
    if (!h) return
    handles.delete(id)
    h.kill()
  })

  return () => {
    for (const h of handles.values()) h.kill()
    handles.clear()
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeAllListeners('terminal:input')
    ipcMain.removeAllListeners('terminal:resize')
    ipcMain.removeAllListeners('terminal:kill')
  }
}
