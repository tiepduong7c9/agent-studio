import { useState } from 'react'

interface Props {
  /** Called after a successful connect, with the remote home directory to
   *  begin browsing from. */
  onConnected: (home: string) => void
  onCancel: () => void
}

export function SshDialog({ onConnected, onCancel }: Props) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setConnecting(true)
    setError(null)
    const result = await window.studio.connectSsh({
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      password: password || undefined,
      privateKeyPath: privateKeyPath.trim() || undefined
    })
    setConnecting(false)
    if (result.ok) {
      onConnected(result.data.home)
    } else {
      setError(result.error)
    }
  }

  const canConnect = host.trim() && username.trim() && !connecting

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h2 className="modal-title">Connect to SSH Remote</h2>
        <div className="form-grid">
          <label>Host</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" autoFocus />
          <label>Port</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave empty to use key / agent"
          />
          <label>Private key</label>
          <input
            value={privateKeyPath}
            onChange={(e) => setPrivateKeyPath(e.target.value)}
            placeholder="~/.ssh/id_ed25519 (optional)"
          />
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={connecting}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={connect} disabled={!canConnect}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
