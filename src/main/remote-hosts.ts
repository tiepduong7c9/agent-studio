import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { SshConnectOptions } from '../shared/types'

// Remembers connected SSH hosts so they can be re-connected automatically on the
// next launch. Persisted to a JSON file in the app's userData dir. The password
// (when supplied) is encrypted at rest with the OS keychain via Electron's
// safeStorage; hosts without a stored password reconnect via key/agent auth.

const FILE = () => path.join(app.getPath('userData'), 'remote-hosts.json')

/** "user@host" — the host key the rest of the app uses. */
function keyFor(opts: { username: string; host: string }): string {
  return `${opts.username}@${opts.host}`
}

interface StoredHost {
  host: string
  port?: number
  username: string
  privateKeyPath?: string
  /** Base64 of safeStorage-encrypted password, if a password was saved. */
  passwordEnc?: string
}

function readAll(): StoredHost[] {
  try {
    const raw = fs.readFileSync(FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as StoredHost[]) : []
  } catch {
    return []
  }
}

function writeAll(hosts: StoredHost[]): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(hosts, null, 2))
  } catch {
    // Persistence is best-effort; a failure just means hosts aren't remembered.
  }
}

/** Remember (or update) a host so it reconnects on the next launch. */
export function saveHost(opts: SshConnectOptions): void {
  const key = keyFor(opts)
  const record: StoredHost = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    privateKeyPath: opts.privateKeyPath
  }
  if (opts.password && safeStorage.isEncryptionAvailable()) {
    record.passwordEnc = safeStorage.encryptString(opts.password).toString('base64')
  }
  const hosts = readAll().filter((h) => keyFor(h) !== key)
  hosts.push(record)
  writeAll(hosts)
}

/** Forget a host (e.g. on explicit disconnect) so it isn't auto-reconnected. */
export function removeHost(hostKey: string): void {
  const hosts = readAll().filter((h) => keyFor(h) !== hostKey)
  writeAll(hosts)
}

/** The saved hosts as connect options, with passwords decrypted where possible. */
export function loadSavedHosts(): SshConnectOptions[] {
  return readAll().map((h) => {
    let password: string | undefined
    if (h.passwordEnc && safeStorage.isEncryptionAvailable()) {
      try {
        password = safeStorage.decryptString(Buffer.from(h.passwordEnc, 'base64'))
      } catch {
        // Undecryptable (e.g. keychain changed) — fall back to key/agent auth.
      }
    }
    return {
      host: h.host,
      port: h.port,
      username: h.username,
      privateKeyPath: h.privateKeyPath,
      password
    }
  })
}
