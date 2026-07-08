import { useEffect, useRef, useState } from 'react'

export function PromptDialog({
  title,
  placeholder,
  initialValue = '',
  submitLabel = 'OK',
  onSubmit,
  onCancel
}: {
  title: string
  placeholder?: string
  initialValue?: string
  submitLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // pre-select the basename without extension, like VS Code's rename box
    const dot = initialValue.lastIndexOf('.')
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initialValue.length)
  }, [initialValue])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-small">
        <h2 className="modal-title">{title}</h2>
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog({
  message,
  detail,
  confirmLabel = 'OK',
  danger = false,
  onConfirm,
  onCancel
}: {
  message: string
  detail?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-small">
        <h2 className="modal-title">{message}</h2>
        {detail && <div className="modal-detail">{detail}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn btn-primary ${danger ? 'btn-danger' : ''}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-small">
        <h2 className="modal-title">
          <span className="codicon codicon-error dialog-error-icon" /> Operation failed
        </h2>
        <div className="modal-detail">{message}</div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
