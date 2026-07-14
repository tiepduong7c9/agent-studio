import { useEffect } from 'react'
import { useToastStore, type Toast } from '../toast-store'
import './Toasts.css'

// Auto-dismiss after this long; the user can also close a toast manually.
const AUTO_DISMISS_MS = 12000

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss)
  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [toast.id, dismiss])
  return (
    <div className={`toast toast-${toast.kind}`} role="alert">
      <span className="toast-msg">{toast.message}</span>
      <button
        className="toast-dismiss codicon codicon-close"
        title="Dismiss"
        onClick={() => dismiss(toast.id)}
      />
    </div>
  )
}

/** Stacked, non-blocking notifications anchored above the status bar. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}
