import { useEffect, useRef } from 'react'
import { Lock, Tag } from 'lucide-react'
import { TAG_COLORS, tagColorVar, tagLabel, useTagsStore, type SessionTag } from '../tags-store'
import { useViewPrefsStore } from '../view-prefs-store'

// Manage the tag palette (Customizations → Tags). The built-in six are listed
// read-only — their glyph and colour are fixed — and everything below them is
// the user's own: a name field plus a swatch strip, since a custom tag differs
// only by name and colour and needs no icon picker. Edits persist immediately
// through the tag store, and the sidebar picks them up on the next render.
//
// Deleting a tag also unsets it from every session holding it, so no session is
// left pointing at a definition that no longer exists.

// The tag's own glyph, or the generic one for a custom tag.
function TagGlyph({ t, size }: { t: SessionTag; size: number }) {
  const Icon = t.icon ?? Tag
  return <Icon size={size} strokeWidth={2.25} />
}

function BuiltinRow({ t }: { t: SessionTag }) {
  return (
    <div className="tag-row builtin">
      <span className="tag-row-preview" style={{ color: tagColorVar(t.color) }}>
        <TagGlyph t={t} size={14} />
      </span>
      <span className="tag-row-fixed-name">{t.name}</span>
      <span className="tag-row-lock" title="Built-in — fixed glyph and colour">
        <Lock size={13} />
      </span>
    </div>
  )
}

function CustomRow({ t, autoFocus }: { t: SessionTag; autoFocus: boolean }) {
  const updateTag = useTagsStore((s) => s.updateTag)
  const removeTag = useTagsStore((s) => s.removeTag)
  const inputRef = useRef<HTMLInputElement>(null)

  // A freshly added tag lands with an empty name; put the caret in it.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const remove = (): void => {
    removeTag(t.id)
    // Read the store fresh: this runs right after the removal, so a tag list
    // captured at render time would still list the tag just deleted.
    useViewPrefsStore.getState().pruneTags(new Set(useTagsStore.getState().tags.map((x) => x.id)))
  }

  return (
    <div className="tag-row">
      <span className="tag-row-preview" style={{ color: tagColorVar(t.color) }}>
        <TagGlyph t={t} size={14} />
      </span>
      <input
        ref={inputRef}
        className="dialog-input tag-row-name"
        value={t.name}
        placeholder="Name (e.g. Refactor)"
        maxLength={24}
        onChange={(e) => updateTag(t.id, { name: e.target.value })}
      />
      <span className="tag-swatches">
        {TAG_COLORS.map((c) => (
          <button
            key={c.id}
            className={`tag-swatch ${c.id === t.color ? 'selected' : ''}`}
            style={{ background: tagColorVar(c.id) }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={c.id === t.color}
            onClick={() => updateTag(t.id, { color: c.id })}
          />
        ))}
      </span>
      <button
        className="icon-button codicon codicon-trash tag-row-remove"
        title={`Delete ${tagLabel(t)} (clears it from any tagged session)`}
        onClick={remove}
      />
    </div>
  )
}

export function TagsDialog({ onClose }: { onClose: () => void }) {
  const tags = useTagsStore((s) => s.tags)
  const addTag = useTagsStore((s) => s.addTag)
  // Which row to focus: the one this dialog just created, not one that merely
  // happens to be last (so reopening the dialog doesn't steal the caret).
  const addedRef = useRef<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const custom = tags.filter((t) => !t.builtin)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tags-dialog">
        <h2 className="modal-title tags-title">
          <Tag size={15} /> Tags
        </h2>
        <div className="modal-detail">
          A tag is a marker you set on a session from its right-click menu. The row shows the icon;
          the name shows in the menu, the tooltip, and sidebar search. Tags are stored on this machine.
        </div>
        <div className="tags-list">
          <div className="tags-group-label">Built-in</div>
          {tags
            .filter((t) => t.builtin)
            .map((t) => (
              <BuiltinRow key={t.id} t={t} />
            ))}
          <div className="tags-group-label">Your tags</div>
          {custom.length === 0 ? (
            <div className="tags-empty">
              None yet — add one to mark sessions the built-ins don&apos;t cover.
            </div>
          ) : (
            custom.map((t) => <CustomRow key={t.id} t={t} autoFocus={t.id === addedRef.current} />)
          )}
        </div>
        <div className="modal-actions tags-actions">
          <button
            className="btn"
            onClick={() => {
              addedRef.current = addTag()
            }}
          >
            <span className="codicon codicon-add" /> Add tag
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
