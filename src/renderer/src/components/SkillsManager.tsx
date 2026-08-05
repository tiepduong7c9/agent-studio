import { useEffect, useMemo, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { Pencil } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SkillRef } from '../../../shared/acp'
import { useSkillsStore } from '../skills-store'
import { useToastStore } from '../toast-store'
import { ConfirmDialog, PromptDialog } from './Dialogs'

// Skills live on remote hosts / the library, not an open workspace, so links
// can't be followed and relative media can't be resolved. Keep the preview inert:
// links don't navigate; images fall back to their alt text.
const MARKDOWN_COMPONENTS = {
  a: ({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a {...props} href={href} title={href} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
  img: ({ alt }: ComponentPropsWithoutRef<'img'>) => <em>{alt || 'image'}</em>
}

// The Skills Manager: a full-screen overlay opened from the Customizations →
// Skills row. Phase 1 is read-only. The left rail is a single flat list of
// skills deduplicated by name (the same skill often exists on several
// hosts/projects); selecting one shows its SKILL.md and lists every place it was
// found so a specific copy can be viewed. Disconnected hosts are surfaced at the
// bottom with a Reconnect action (create/clone/edit/inject land later).

interface Props {
  /** Connected + saved SSH hosts ("user@host"). */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  /** Reconnect a disconnected host from its saved credentials. */
  onReconnectRemote: (host: string) => void
  onClose: () => void
}

/** One deduped list entry: a skill name and every source it was found in. */
interface SkillEntry {
  name: string
  sources: SkillRef[]
  /** The representative source shown by default (library > local > remote). */
  rep: SkillRef
  invalid: boolean
}

// The name/description already appear in the header, so drop the leading
// `--- ... ---` frontmatter from the SKILL.md preview and show just the body.
function stripFrontmatter(text: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length).replace(/^\s+/, '') : text
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Rank sources so the representative prefers the library, then the local
// machine, then remotes; personal before project within a host.
function sourceRank(s: SkillRef): number {
  if (s.scope === 'library') return 0
  const hostBase = s.host == null ? 1 : 3
  return hostBase + (s.scope === 'host' ? 0 : 1)
}

export function SkillsManager({ remoteHosts, engineStatus, onReconnectRemote, onClose }: Props) {
  const { listing, loading, scanning, error, selectedId, files, filesLoading, refresh, scan, select } =
    useSkillsStore()
  const [activeFile, setActiveFile] = useState<string>('SKILL.md')
  // Markdown content defaults to the rendered preview; toggles to raw source.
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  // Expand the dialog to near-fullscreen (header button or double-click).
  const [maximized, setMaximized] = useState(false)
  // Inline editor (library skills only): raw text of the active file.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // Which name/confirm dialog is open, if any.
  const [dialog, setDialog] = useState<'new' | 'duplicate' | 'delete' | null>(null)
  const pushToast = useToastStore((s) => s.push)

  // Show the library immediately, then scan hosts (collecting any new skills) on
  // open and whenever a host's connection state flips — so a freshly-connected
  // host's skills are pulled in automatically.
  const statusKey = remoteHosts.map((h) => `${h}:${engineStatus[`ssh:${h}`] ?? ''}`).join('|')
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    void scan()
  }, [scan, statusKey])

  // Escape cancels an in-progress edit, otherwise closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editing) setEditing(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  // Flat, name-deduplicated list across every source.
  const entries = useMemo<SkillEntry[]>(() => {
    const byName = new Map<string, SkillRef[]>()
    for (const s of listing.skills) {
      const arr = byName.get(s.name) ?? []
      arr.push(s)
      byName.set(s.name, arr)
    }
    return [...byName.entries()]
      .map(([name, sources]) => {
        sources.sort((a, b) => sourceRank(a) - sourceRank(b))
        return { name, sources, rep: sources[0], invalid: sources.every((s) => s.invalid) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [listing.skills])

  const selected = useMemo(
    () => listing.skills.find((s) => s.id === selectedId) ?? null,
    [listing.skills, selectedId]
  )
  // The deduped entry the current selection belongs to (for its source list).
  const selectedEntry = useMemo(
    () => entries.find((e) => e.sources.some((s) => s.id === selectedId)) ?? null,
    [entries, selectedId]
  )

  // Hosts we know about but couldn't scan — offer a Reconnect. Mirrors the
  // sidebar's 'lost' semantics, unioned with hosts the scan reported unreachable.
  const disconnected = useMemo(() => {
    const set = new Set<string>()
    for (const h of remoteHosts) if (engineStatus[`ssh:${h}`] === 'lost') set.add(h)
    for (const key of listing.unreachable) if (key.startsWith('ssh:')) set.add(key.slice('ssh:'.length))
    return [...set].sort()
  }, [remoteHosts, engineStatus, listing.unreachable])

  // Reset the in-skill file selection to SKILL.md whenever the selection changes.
  useEffect(() => {
    setActiveFile('SKILL.md')
  }, [selectedId])

  // Leaving a file/skill discards any in-progress edit.
  useEffect(() => {
    setEditing(false)
  }, [selectedId, activeFile])

  const activeContent = files?.files.find((f) => f.rel === activeFile) ?? null
  const isMarkdown = /\.md$/i.test(activeFile)
  // SKILL.md's name/description already show in the header, so drop its frontmatter.
  const displayText =
    activeFile === 'SKILL.md'
      ? stripFrontmatter(activeContent?.text ?? '')
      : activeContent?.text ?? ''

  // Everything shown is a managed library skill, so it's always editable
  // (except binary resources).
  const canEdit = !!activeContent && !activeContent.binary

  const startEdit = () => {
    if (!activeContent || activeContent.binary) return
    setDraft(activeContent.text ?? '')
    setViewMode('raw')
    setEditing(true)
  }

  // Run a mutation with busy-guarding + error toast; refresh and optionally
  // select the resulting skill so the UI lands on it.
  const run = async (label: string, fn: () => Promise<SkillRef | void>, land?: boolean) => {
    setBusy(true)
    try {
      const ref = await fn()
      await refresh()
      if (land && ref) await select(ref)
      return ref
    } catch (err: any) {
      pushToast('danger', err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const doCreate = (name: string) =>
    run('create', async () => {
      const ref = await window.studio.skills.create({ name })
      pushToast('info', `Created "${ref.name}"`)
      return ref
    }, true)

  const doDuplicate = (name: string) => {
    if (!selected) return
    const src = selected
    return run('duplicate', async () => {
      const ref = await window.studio.skills.import({
        host: src.host ?? null,
        scope: src.scope,
        dir: src.dir,
        name
      })
      pushToast('info', `Duplicated as "${ref.name}"`)
      return ref
    }, true)
  }

  const doDelete = async (skill: SkillRef) => {
    await run('delete', async () => {
      await window.studio.skills.remove({ dir: skill.dir })
      pushToast('info', `Deleted "${skill.name}"`)
    })
    await select(null)
  }

  const doSave = async () => {
    if (!selected) return
    const src = selected
    await run('save', async () => {
      await window.studio.skills.writeFile({ dir: src.dir, rel: activeFile, content: draft })
      pushToast('info', 'Saved')
    })
    setEditing(false)
    await select(src) // reload the skill's files from disk
  }

  return (
    <div
      className={`modal-overlay ${maximized ? 'skills-overlay-max' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`skills-manager ${maximized ? 'maximized' : ''}`}>
        <div className="skills-header" onDoubleClick={() => setMaximized((v) => !v)}>
          <h2 className="modal-title skills-title">
            <span className="codicon codicon-lightbulb" /> Skills
          </h2>
          <div className="skills-header-actions">
            <button
              className="btn btn-icon"
              onClick={() => setDialog('new')}
              title="New skill in the library"
              disabled={busy}
            >
              <span className="codicon codicon-add" />
            </button>
            <button
              className="btn btn-icon"
              onClick={() => void scan()}
              title="Scan connected hosts and collect skills into the library"
              disabled={scanning}
            >
              <span className={`codicon codicon-refresh ${scanning ? 'spin' : ''}`} />
            </button>
            <button
              className="btn btn-icon"
              onClick={() => setMaximized((v) => !v)}
              title={maximized ? 'Restore' : 'Expand'}
            >
              <span className={`codicon codicon-${maximized ? 'screen-normal' : 'screen-full'}`} />
            </button>
            <button className="btn btn-icon" onClick={onClose} title="Close">
              <span className="codicon codicon-close" />
            </button>
          </div>
        </div>

        {error && <div className="skills-error">{error}</div>}

        <div className="skills-body">
          <div className="skills-rail">
            {entries.length === 0 ? (
              <div className="skills-empty">
                {scanning || loading ? 'Scanning…' : 'Library empty — Scan to collect skills'}
              </div>
            ) : (
              entries.map((e) => {
                const isSelected = selectedEntry?.name === e.name
                return (
                  <div key={e.name}>
                    <button
                      className={`skills-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => void select(e.rep)}
                      title={e.rep.description || e.name}
                    >
                      <span className="codicon codicon-lightbulb skills-row-icon" />
                      <span className="skills-row-name">{e.name}</span>
                      {e.invalid && (
                        <span
                          className="codicon codicon-error skills-row-warn"
                          title="Missing frontmatter"
                        />
                      )}
                    </button>
                    {/* The selected skill's files (SKILL.md + resources) nest here. */}
                    {isSelected && (files?.files.length ?? 0) > 1 && (
                      <div className="skills-file-list">
                        {files!.files.map((f) => {
                          const slash = f.rel.lastIndexOf('/')
                          const dir = slash < 0 ? '' : f.rel.slice(0, slash + 1)
                          const base = slash < 0 ? f.rel : f.rel.slice(slash + 1)
                          return (
                            <button
                              key={f.rel}
                              className={`skills-file ${activeFile === f.rel ? 'selected' : ''}`}
                              onClick={() => setActiveFile(f.rel)}
                              title={f.rel}
                            >
                              <span className="codicon codicon-file skills-file-icon" />
                              <span className="skills-file-name">
                                {dir && <span className="skills-file-dir">{dir}</span>}
                                {base}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            {disconnected.length > 0 && (
              <div className="skills-disconnected">
                <div className="skills-group-label">Disconnected</div>
                {disconnected.map((h) => (
                  <div key={h} className="skills-offline-row" title={`${h} — reconnect`}>
                    <span className="codicon codicon-vm-outline" />
                    <span className="skills-row-name">{h}</span>
                    <button className="skills-reconnect" onClick={() => onReconnectRemote(h)}>
                      <span className="codicon codicon-debug-disconnect" /> Reconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="skills-detail">
            {!selected ? (
              <div className="skills-placeholder">
                {loading ? 'Scanning skills…' : 'Select a skill to view it'}
              </div>
            ) : (
              <>
                <div className="skills-detail-head">
                  <div className="skills-detail-subhead">
                    <div className="skills-detail-file">
                      <span className="codicon codicon-lightbulb" />
                      <span className="skills-detail-name">{selected.name}</span>
                      {activeFile !== 'SKILL.md' && (
                        <span className="skills-detail-sub">/ {activeFile}</span>
                      )}
                    </div>
                    <div className="skills-detail-center">
                      {!editing && isMarkdown && activeContent && !activeContent.binary && (
                        <div className="skills-seg">
                          <button
                            className={viewMode === 'preview' ? 'selected' : ''}
                            onClick={() => setViewMode('preview')}
                          >
                            Preview
                          </button>
                          <button
                            className={viewMode === 'raw' ? 'selected' : ''}
                            onClick={() => setViewMode('raw')}
                          >
                            Raw
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="skills-detail-actions">
                      {editing ? (
                        <>
                          <button className="skills-act" onClick={() => setEditing(false)}>
                            Cancel
                          </button>
                          <button
                            className="skills-act primary"
                            onClick={() => void doSave()}
                            disabled={busy}
                          >
                            Save
                          </button>
                        </>
                      ) : (
                        <>
                          {canEdit && (
                            <button className="btn btn-icon" title="Edit this file" onClick={startEdit}>
                              <Pencil size={15} />
                            </button>
                          )}
                          <button
                            className="btn btn-icon"
                            title="Duplicate"
                            onClick={() => setDialog('duplicate')}
                            disabled={busy}
                          >
                            <span className="codicon codicon-copy" />
                          </button>
                          <button
                            className="btn btn-icon"
                            title="Delete from library"
                            onClick={() => setDialog('delete')}
                            disabled={busy}
                          >
                            <span className="codicon codicon-trash" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className="skills-viewer"
                  title={!editing && canEdit ? 'Double-click to edit' : undefined}
                  onDoubleClick={() => !editing && startEdit()}
                >
                  {editing ? (
                    <textarea
                      className="skills-editor"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Ctrl/Cmd+S saves.
                        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                          e.preventDefault()
                          void doSave()
                        }
                      }}
                      spellCheck={false}
                      autoFocus
                    />
                  ) : filesLoading ? (
                    <div className="skills-placeholder">Loading…</div>
                  ) : !activeContent ? (
                    <div className="skills-placeholder">File not found</div>
                  ) : activeContent.binary ? (
                    <div className="skills-placeholder">
                      Binary file ({formatSize(activeContent.size)}) — preview not available
                    </div>
                  ) : isMarkdown && viewMode === 'preview' ? (
                    // Preview drops SKILL.md's frontmatter (the name is in the
                    // toolbar) and renders the body as markdown.
                    <div className="markdown-preview skills-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {displayText}
                      </ReactMarkdown>
                      {activeContent.truncated && (
                        <p>
                          <em>… (truncated)</em>
                        </p>
                      )}
                    </div>
                  ) : (
                    // Raw shows the file verbatim, including the frontmatter block.
                    <pre className="skills-code">
                      {activeContent.text ?? ''}
                      {activeContent.truncated && '\n\n… (truncated)'}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {dialog === 'new' && (
          <PromptDialog
            title="New skill"
            placeholder="skill-name"
            submitLabel="Create"
            onSubmit={(v) => {
              setDialog(null)
              void doCreate(v)
            }}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog === 'duplicate' && selected && (
          <PromptDialog
            title="Duplicate skill"
            initialValue={`${selected.name}-copy`}
            submitLabel="Duplicate"
            onSubmit={(v) => {
              setDialog(null)
              void doDuplicate(v)
            }}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog === 'delete' && selected && (
          <ConfirmDialog
            message={`Delete "${selected.name}"?`}
            detail="This permanently removes it from the app library."
            confirmLabel="Delete"
            danger
            onConfirm={() => {
              const s = selected
              setDialog(null)
              void doDelete(s)
            }}
            onCancel={() => setDialog(null)}
          />
        )}
      </div>
    </div>
  )
}
