import type { Client as SshClient } from 'ssh2'

export interface ExecResult { code: number; stdout: string; stderr: string }

// Run a command over an ssh2 connection, collecting stdout/stderr as strings.
// Wrapped in a login shell so the remote user's PATH (where `node`/`claude` live)
// is available in this non-interactive session.
export function sshExec(client: SshClient, command: string, maxBytes = 4 * 1024 * 1024): Promise<ExecResult> {
  const wrapped = `sh -lc ${shellQuote(command)}`
  return new Promise((resolve, reject) => {
    client.exec(wrapped, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      let size = 0
      let aborted = false
      stream
        .on('data', (d: Buffer) => {
          if (aborted) return
          size += d.length
          if (size > maxBytes) { aborted = true; stream.destroy(); reject(new Error('ssh exec output too large')); return }
          stdout += d.toString()
        })
        .once('close', (code: number) => { if (!aborted) resolve({ code: code ?? 0, stdout, stderr }) })
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    })
  })
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
