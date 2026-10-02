import { type MouseEvent, type ReactNode, useState } from 'react'
import { Tag } from 'lucide-react'
import type { SessionMeta } from '../../../shared/acp'
import { tagColorVar, tagLabel, useTagsStore, type SessionTag } from '../tags-store'
import { useViewPrefsStore } from '../view-prefs-store'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConfirmDialog } from './Dialogs'
import { TagsDialog } from './TagsDialog'

// Session actions shared by the board's cards and the title bar — the same
// menu the old sessions sidebar row had.

/** The Tag submenu. One tag at a time, so it reads as a radio group: picking
 *  another replaces the current one, and picking the current one clears it. */
export function tagMenuItems(
  tags: SessionTag[],
  tag: string | undefined,
  onSetTag: (tagId: string | null) => void,
  onManageTags: () => void
): MenuItem[] {
  return [
    ...tags.map((t) => {
      const Icon = t.icon ?? Tag
      return {
        label: tagLabel(t),
        checked: tag === t.id,
        icon: <Icon size={13} strokeWidth={2.25} style={{ color: tagColorVar(t.color) }} />,
        run: () => onSetTag(tag === t.id ? null : t.id)
      }
    }),
    { separator: true as const },
    { label: 'No tag', checked: !tag, run: () => onSetTag(null) },
    { label: 'Manage tags…', run: onManageTags }
  ]
}

const menuAt = (e: MouseEvent, below: boolean): { x: number; y: number } => {
  e.preventDefault()
  e.stopPropagation()
  if (!below) return { x: e.clientX, y: e.clientY }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 2 }
}

/** A session's right-click menu: pin, read/unread, tag, rename, regenerate
 *  title, restart, delete. Rename is inline, so the caller renders the editor
 *  while `editing` is set and reports back through `commitRename`. */
export function useSessionMenu(s: SessionMeta, onDelete: () => void) {
  const pinned = useViewPrefsStore((st) => !!st.pinnedSessions[s.id])
  const unread = useViewPrefsStore((st) => !!st.unreadSessions[s.id])
  const tag = useViewPrefsStore((st) => st.sessionTag[s.id])
  const togglePin = useViewPrefsStore((st) => st.togglePin)
  const toggleUnread = useViewPrefsStore((st) => st.toggleUnread)
  const setSessionTag = useViewPrefsStore((st) => st.setSessionTag)
  const tags = useTagsStore((st) => st.tags)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'restarting' | 'generating title' | null>(null)

  const run = async (label: 'restarting' | 'generating title', fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const commitRename = (value: string) => {
    const name = value.trim()
    setEditing(false)
    if (name && name !== s.name) void window.studio.acp.rename(s.id, name)
  }

  const items: MenuItem[] = [
    { label: pinned ? 'Unpin' : 'Pin', run: () => togglePin(s.id) },
    { label: unread ? 'Mark as read' : 'Mark as unread', run: () => toggleUnread(s.id) },
    { label: 'Tag', submenu: tagMenuItems(tags, tag, (t) => setSessionTag(s.id, t), () => setTagsOpen(true)) },
    { separator: true },
    { label: 'Rename', run: () => setEditing(true) },
    {
      label: 'Regenerate title',
      enabled: !busy,
      run: () => void run('generating title', () => window.studio.acp.regenerateTitle(s.id))
    },
    // Re-spawns the adapter so it re-reads host-side config (e.g. new MCP
    // servers); the conversation reloads, but an in-flight turn is dropped.
    { label: 'Restart session', enabled: !busy, run: () => void run('restarting', () => window.studio.acp.restart(s.id)) },
    { separator: true },
    { label: 'Delete Session', run: () => setConfirming(true) }
  ]

  const node: ReactNode = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {confirming && (
        <ConfirmDialog
          message="Delete this session?"
          detail={`This permanently ends the agent for “${s.name}”.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setConfirming(false)
            onDelete()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      {tagsOpen && <TagsDialog onClose={() => setTagsOpen(false)} />}
    </>
  )

  return {
    /** Open the menu at the cursor, or `below` the clicked element (a "…" button). */
    open: (e: MouseEvent, below = false) => setMenu(menuAt(e, below)),
    editing,
    cancelRename: () => setEditing(false),
    commitRename,
    busy,
    node
  }
}

/** A button that drops down the Tag menu for one session. */
export function TagButton({ sid, className, size = 14 }: { sid: string; className?: string; size?: number }) {
  const tag = useViewPrefsStore((st) => st.sessionTag[sid])
  const setSessionTag = useViewPrefsStore((st) => st.setSessionTag)
  const tags = useTagsStore((st) => st.tags)
  const resolved = tags.find((t) => t.id === tag)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [tagsOpen, setTagsOpen] = useState(false)
  const Icon = resolved?.icon ?? Tag
  return (
    <>
      <button
        className={className}
        title={resolved ? `Tag: ${tagLabel(resolved)}` : 'Tag this session'}
        onClick={(e) => setMenu(menuAt(e, true))}
      >
        <Icon size={size} strokeWidth={2} style={resolved ? { color: tagColorVar(resolved.color) } : undefined} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={tagMenuItems(tags, tag, (t) => setSessionTag(sid, t), () => setTagsOpen(true))}
          onClose={() => setMenu(null)}
        />
      )}
      {tagsOpen && <TagsDialog onClose={() => setTagsOpen(false)} />}
    </>
  )
}
