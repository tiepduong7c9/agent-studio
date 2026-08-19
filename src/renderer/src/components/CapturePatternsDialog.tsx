import { useEffect } from 'react'
import { Lock, Tag } from 'lucide-react'
import { useCaptureStore, type CaptureKind, type CapturePattern } from '../capture-store'
import { hasCaptureGroup, isValidRegex } from '../session-links'

// Manage the URL patterns that turn conversation links into PR / ticket badges.
// The built-in GitHub PR pattern is shown read-only; user patterns are edited
// inline (changes persist immediately via the capture store). A pattern's
// `urlRegex` must contain a capture group — `$1` in the label is replaced with
// the first group of a matching URL.

const KINDS: { value: CaptureKind; label: string }[] = [
  { value: 'pr', label: 'PR' },
  { value: 'ticket', label: 'Ticket' }
]

function PatternRow({ p }: { p: CapturePattern }) {
  const updatePattern = useCaptureStore((s) => s.updatePattern)
  const removePattern = useCaptureStore((s) => s.removePattern)
  const regexError = p.urlRegex.trim().length > 0 && !isValidRegex(p.urlRegex)
  const noGroup = !regexError && p.urlRegex.trim().length > 0 && !hasCaptureGroup(p.urlRegex)

  return (
    <div className="capture-row">
      <div className="capture-row-main">
        <div className="capture-row-fields">
          <input
            className="dialog-input capture-name"
            value={p.name}
            placeholder="Name (e.g. Jira)"
            disabled={p.builtin}
            onChange={(e) => updatePattern(p.id, { name: e.target.value })}
          />
          <select
            className="dialog-input capture-kind"
            value={p.kind}
            disabled={p.builtin}
            onChange={(e) => updatePattern(p.id, { kind: e.target.value as CaptureKind })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            className="dialog-input capture-label"
            value={p.label}
            placeholder="Label (e.g. $1)"
            disabled={p.builtin}
            onChange={(e) => updatePattern(p.id, { label: e.target.value })}
          />
        </div>
        <input
          className={`dialog-input capture-regex ${regexError ? 'invalid' : ''}`}
          value={p.urlRegex}
          placeholder="URL regex with a capture group, e.g. atlassian\.net/browse/([A-Z][A-Z0-9]+-\d+)"
          disabled={p.builtin}
          spellCheck={false}
          onChange={(e) => updatePattern(p.id, { urlRegex: e.target.value })}
        />
        {regexError && <div className="capture-hint error">Invalid regular expression.</div>}
        {noGroup && <div className="capture-hint warn">Add a ( ) capture group for the id — $1 uses group 1.</div>}
      </div>
      <div className="capture-row-action">
        {p.builtin ? (
          <span className="capture-builtin" title="Built-in — cannot be removed">
            <Lock size={14} />
          </span>
        ) : (
          <button
            className="icon-button codicon codicon-trash"
            title="Remove pattern"
            onClick={() => removePattern(p.id)}
          />
        )}
      </div>
    </div>
  )
}

export function CapturePatternsDialog({ onClose }: { onClose: () => void }) {
  const patterns = useCaptureStore((s) => s.patterns)
  const addPattern = useCaptureStore((s) => s.addPattern)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const add = (): void =>
    addPattern({ name: '', kind: 'ticket', urlRegex: '', label: '$1' })

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal capture-dialog">
        <h2 className="modal-title capture-title">
          <Tag size={15} /> Ticket Patterns
        </h2>
        <div className="modal-detail">
          Links in a session that match a pattern become badges. The first capture group is the id;
          <code> $1 </code> in the label is replaced with it.
        </div>
        <div className="capture-list">
          {patterns.map((p) => (
            <PatternRow key={p.id} p={p} />
          ))}
        </div>
        <div className="modal-actions capture-actions">
          <button className="btn" onClick={add}>
            <span className="codicon codicon-add" /> Add pattern
          </button>
          <span className="topbar-spacer" />
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
