import { useEffect, useState } from 'react'
import { useToastStore, type Toast } from '../toast-store'
import './Toasts.css'

// Auto-dismiss after this long; the user can also close a toast manually.
const AUTO_DISMISS_MS = 12000

function ToastRow({ toast, onDetails }: { toast: Toast; onDetails: (t: Toast) => void }) {
  const dismiss = useToastStore((s) => s.dismiss)
  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [toast.id, dismiss])
  return (
    <div className={`toast toast-${toast.kind}`} role="alert">
      <div className="toast-body">
        <span className="toast-msg">{toast.message}</span>
        {toast.details && (
          <button className="toast-details-btn" onClick={() => onDetails(toast)}>
            Details
          </button>
        )}
      </div>
      <button
        className="toast-dismiss codicon codicon-close"
        title="Dismiss"
        onClick={() => dismiss(toast.id)}
      />
    </div>
  )
}

/** Scrollable popup showing a toast's full text (e.g. long command output). */
function DetailsDialog({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal toast-details-modal">
        <h2 className="modal-title">{toast.message}</h2>
        <pre className="toast-details-text">{toast.details}</pre>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** Stacked, non-blocking notifications anchored above the status bar. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const [details, setDetails] = useState<Toast | null>(null)
  if (!toasts.length && !details) return null
  return (
    <>
      <div className="toast-stack">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDetails={setDetails} />
        ))}
      </div>
      {details && <DetailsDialog toast={details} onClose={() => setDetails(null)} />}
    </>
  )
}
