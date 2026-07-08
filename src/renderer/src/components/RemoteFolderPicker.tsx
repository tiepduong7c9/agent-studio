import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo, RemoteDirListing } from '../../../shared/types'

interface Props {
  /** Directory to start browsing from (the remote home). */
  initialPath: string
  onOpen: (info: ProjectInfo) => void
  onCancel: () => void
}

// Browses the connected remote host and lets the user pick a project folder:
// click a folder to descend, ".." to go up, or type a path to jump. "Open"
// roots the project at the folder currently shown.
export function RemoteFolderPicker({ initialPath, onOpen, onCancel }: Props) {
  const [current, setCurrent] = useState(initialPath)
  const [pathInput, setPathInput] = useState(initialPath)
  const [listing, setListing] = useState<RemoteDirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const navigate = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    const result = await window.studio.sshListDir(target)
    setLoading(false)
    if (result.ok) {
      setCurrent(result.data.path)
      setPathInput(result.data.path)
      setListing(result.data)
    } else {
      setError(result.error)
    }
  }, [])

  const navigatedOnce = useRef(false)
  useEffect(() => {
    if (navigatedOnce.current) return
    navigatedOnce.current = true
    navigate(initialPath)
  }, [initialPath, navigate])

  const open = async () => {
    setOpening(true)
    setError(null)
    const result = await window.studio.sshOpenRemote(current)
    setOpening(false)
    if (result.ok) onOpen(result.data)
    else setError(result.error)
  }

  const basename = current.replace(/\/+$/, '').split('/').pop() || '/'

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-picker">
        <h2 className="modal-title">Open Remote Folder</h2>

        <div className="picker-path">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(pathInput.trim())}
            spellCheck={false}
            autoFocus
          />
          <button className="btn" onClick={() => navigate(pathInput.trim())} disabled={loading}>
            Go
          </button>
        </div>

        <div className="picker-list">
          {loading ? (
            <div className="picker-empty">Loading…</div>
          ) : (
            <>
              {listing?.parent && (
                <button className="picker-row" onClick={() => navigate(listing.parent!)}>
                  <span className="codicon codicon-arrow-up" />
                  <span className="picker-name">..</span>
                </button>
              )}
              {listing?.entries.map((entry) => (
                <button key={entry.path} className="picker-row" onClick={() => navigate(entry.path)}>
                  <span className="codicon codicon-folder" />
                  <span className="picker-name">{entry.name}</span>
                  <span className="codicon codicon-chevron-right picker-chevron" />
                </button>
              ))}
              {listing && listing.entries.length === 0 && (
                <div className="picker-empty">No subfolders here</div>
              )}
            </>
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={opening}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={open} disabled={opening || loading}>
            {opening ? 'Opening…' : `Open ${basename}`}
          </button>
        </div>
      </div>
    </div>
  )
}
