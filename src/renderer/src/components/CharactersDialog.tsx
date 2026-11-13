import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Dices, Lock, Plus, Trash2, Users } from 'lucide-react'
import {
  CHARACTER_ACCENTS,
  CHARACTER_MODELS,
  GENERIC_CHARACTER,
  characterLabel,
  modelLabel,
  randomLook,
  useCharactersStore,
  type Character,
  type CharacterLook,
  type CharacterModel
} from '../characters-store'
import type { Preview } from '../characters/three-characters'
import { CharacterAvatar } from './CharacterAvatar'

// Manage characters (Customizations → Characters, or a session's Character
// menu). Left: the generic character and the user's own. Right: the selected
// one's live 3D preview and its fields. Edits apply immediately, like tags.

function CharacterPreview({ look }: { look: CharacterLook }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<Preview | null>(null)
  const lookRef = useRef(look)
  lookRef.current = look

  useEffect(() => {
    let disposed = false
    void import('../characters/three-characters').then((m) => {
      if (disposed || !canvasRef.current) return
      previewRef.current = m.mountPreview(canvasRef.current, lookRef.current)
    })
    return () => {
      disposed = true
      previewRef.current?.dispose()
      previewRef.current = null
    }
  }, [])
  useEffect(() => {
    previewRef.current?.setLook(look)
  }, [look.body, look.head]) // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={canvasRef} className="char-preview" title="Drag to turn" />
}

/** "‹ Female A ›" — steps through the models, wrapping around. */
function ModelStepper({ label, value, onChange }: { label: string; value: CharacterModel; onChange: (m: CharacterModel) => void }) {
  const i = CHARACTER_MODELS.indexOf(value)
  const step = (d: number): void => onChange(CHARACTER_MODELS[(i + d + CHARACTER_MODELS.length) % CHARACTER_MODELS.length])
  return (
    <div className="char-field">
      <span className="char-field-label">{label}</span>
      <div className="char-stepper">
        <button className="icon-button" title={`Previous ${label.toLowerCase()}`} onClick={() => step(-1)}>
          <ChevronLeft size={15} />
        </button>
        <span className="char-stepper-value">{modelLabel(value)}</span>
        <button className="icon-button" title={`Next ${label.toLowerCase()}`} onClick={() => step(1)}>
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}

function Editor({
  c,
  assignedCount,
  onDeleted,
  onDuplicated
}: {
  c: Character
  assignedCount: number
  onDeleted: () => void
  onDuplicated: (id: string) => void
}) {
  const update = useCharactersStore((s) => s.updateCharacter)
  const add = useCharactersStore((s) => s.addCharacter)
  const remove = useCharactersStore((s) => s.removeCharacter)
  const nameRef = useRef<HTMLInputElement>(null)
  const generic = c.id === GENERIC_CHARACTER.id

  // A freshly created character lands nameless; put the caret in its name.
  useEffect(() => {
    if (!generic && !c.name) nameRef.current?.focus()
  }, [c.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const setLook = (patch: Partial<CharacterLook>): void => update(c.id, { look: { ...c.look, ...patch } })

  return (
    <>
      {generic ? (
        <div className="char-generic-note">
          <Lock size={13} /> Shown for every session that has no character assigned.
        </div>
      ) : (
        <div className="char-fields">
          <label className="char-field">
            <span className="char-field-label">Name</span>
            <input
              ref={nameRef}
              className="dialog-input"
              value={c.name}
              placeholder="e.g. Mia"
              maxLength={24}
              onChange={(e) => update(c.id, { name: e.target.value })}
            />
          </label>
          <label className="char-field">
            <span className="char-field-label">Role</span>
            <input
              className="dialog-input"
              value={c.role}
              placeholder="e.g. Release assistant"
              maxLength={32}
              onChange={(e) => update(c.id, { role: e.target.value })}
            />
          </label>
          <div className="char-field">
            <span className="char-field-label">Colour</span>
            <span className="tag-swatches">
              {CHARACTER_ACCENTS.map((a) => (
                <button
                  key={a}
                  className={`tag-swatch ${a === c.accent ? 'selected' : ''}`}
                  style={{ background: a }}
                  aria-label={a}
                  aria-pressed={a === c.accent}
                  onClick={() => update(c.id, { accent: a })}
                />
              ))}
            </span>
          </div>
          <ModelStepper label="Head" value={c.look.head} onChange={(m) => setLook({ head: m })} />
          <ModelStepper label="Body" value={c.look.body} onChange={(m) => setLook({ body: m })} />
          <div className="char-editor-actions">
            <button className="btn" onClick={() => setLook(randomLook())}>
              <Dices size={14} /> Randomize
            </button>
            <button
              className="btn"
              onClick={() => {
                // Copy everything but the id: the copy needs its own.
                const { id: _id, ...fields } = c
                onDuplicated(add({ ...fields, name: c.name ? `${c.name} 2` : '' }))
              }}
            >
              <Copy size={14} /> Duplicate
            </button>
            <span className="topbar-spacer" />
            <button
              className="btn"
              title={assignedCount ? 'Its sessions go back to the generic character' : undefined}
              onClick={() => {
                remove(c.id)
                onDeleted()
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
          <div className="char-assigned">
            {assignedCount === 0
              ? 'Not assigned yet — assign it from a session’s right-click menu (Character).'
              : `Assigned to ${assignedCount} session${assignedCount === 1 ? '' : 's'}.`}
          </div>
        </div>
      )}
    </>
  )
}

export function CharactersDialog({ initialId, onClose }: { initialId?: string; onClose: () => void }) {
  const characters = useCharactersStore((s) => s.characters)
  const assignments = useCharactersStore((s) => s.assignments)
  const addCharacter = useCharactersStore((s) => s.addCharacter)
  const [selectedId, setSelectedId] = useState<string>(initialId ?? characters[0]?.id ?? GENERIC_CHARACTER.id)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const selected = characters.find((c) => c.id === selectedId) ?? GENERIC_CHARACTER
  const count = (id: string): number => Object.values(assignments).filter((cid) => cid === id).length

  const row = (c: Character) => (
    <button
      key={c.id}
      className={`char-row ${c.id === selected.id ? 'selected' : ''}`}
      onClick={() => setSelectedId(c.id)}
    >
      <CharacterAvatar character={c} size={30} />
      <span className="char-row-text">
        <span className="char-row-name">{characterLabel(c)}</span>
        <span className="char-row-role">{c.id === GENERIC_CHARACTER.id ? 'Unassigned sessions' : c.role || '—'}</span>
      </span>
      {count(c.id) > 0 && <span className="char-row-count">{count(c.id)}</span>}
    </button>
  )

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal characters-dialog">
        <h2 className="modal-title tags-title">
          <Users size={15} /> Characters
        </h2>
        <div className="modal-detail">
          Give sessions a face. Create a character here, then assign it from a session&apos;s right-click menu
          (Character). Characters are stored on this machine.
        </div>
        <div className="char-layout">
          <div className="char-list">
            {row(GENERIC_CHARACTER)}
            <div className="tags-group-label">Your characters</div>
            {characters.length === 0 ? <div className="tags-empty">None yet.</div> : characters.map(row)}
            <button className="btn char-add" onClick={() => setSelectedId(addCharacter())}>
              <Plus size={14} /> New character
            </button>
          </div>
          {/* The preview stays mounted across selections (one WebGL context);
              the fields remount per character. */}
          <div className="char-editor">
            <CharacterPreview look={selected.look} />
            <Editor
              key={selected.id}
              c={selected}
              assignedCount={count(selected.id)}
              onDeleted={() => setSelectedId(GENERIC_CHARACTER.id)}
              onDuplicated={setSelectedId}
            />
          </div>
        </div>
        <div className="modal-actions tags-actions">
          <span className="topbar-spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
