import { hostLabel } from '../session-format'

// A popup for managing remote SSH hosts: connect a new one, and connect /
// disconnect / reconnect / forget the known ones. Opened from the sidebar's
// "Manage remote hosts" (server) button.

interface Props {
  /** Known remote hosts ("user@host"). */
  hosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  /** Open the SSH connect dialog to add a new host. */
  onConnectNew: () => void
  /** Disconnect a connected host / forget a lost one. */
  onDisconnect: (host: string) => void
  /** Reconnect a saved but disconnected host. */
  onReconnect: (host: string) => void
  onClose: () => void
}

export function RemoteHostsDialog({
  hosts,
  engineStatus,
  onConnectNew,
  onDisconnect,
  onReconnect,
  onClose
}: Props) {
  const statusOf = (host: string): 'connected' | 'reconnecting' | 'lost' => {
    const st = engineStatus[`ssh:${host}`]
    if (!st || st === 'connected') return 'connected'
    return st === 'lost' ? 'lost' : 'reconnecting'
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-picker remote-hosts-dialog">
        <h2 className="modal-title">Remote hosts</h2>

        <div className="remote-hosts-list">
          {hosts.length === 0 ? (
            <div className="picker-empty">No remote hosts yet. Connect one to get started.</div>
          ) : (
            hosts.map((host) => {
              const status = statusOf(host)
              const lost = status === 'lost'
              return (
                <div key={host} className="remote-host-row">
                  <span className="codicon codicon-server remote-host-icon" />
                  <span className="remote-host-name" title={host}>
                    {hostLabel(host)}
                  </span>
                  <span className={`remote-host-status ${status}`}>{status}</span>
                  {lost ? (
                    <>
                      <button className="btn btn-slim" onClick={() => onReconnect(host)}>
                        Reconnect
                      </button>
                      <button className="btn btn-slim" onClick={() => onDisconnect(host)}>
                        Forget
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-slim" onClick={() => onDisconnect(host)}>
                      Disconnect
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary btn-with-icon"
            onClick={() => {
              onConnectNew()
              onClose()
            }}
          >
            <span className="codicon codicon-add" />
            Connect host…
          </button>
        </div>
      </div>
    </div>
  )
}
