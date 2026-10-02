import { type MouseEvent, useEffect, useState } from 'react'
import { Files, GitBranch, Lightbulb, Settings, SquareKanban } from 'lucide-react'
import type { PanelTab } from './RightPanel'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { AboutDialog } from './Dialogs'
import { CapturePatternsDialog } from './CapturePatternsDialog'
import { RemoteHostsDialog } from './RemoteHostsDialog'
import { SkillsManager } from './SkillsManager'
import { TagsDialog } from './TagsDialog'
import { ThemePicker } from './ThemePicker'

// VS Code's activity bar: a thin icon strip on the far left that picks what
// the side panel shows. Clicking the active view's icon hides the panel, as in
// VS Code. The gear at the bottom holds what the old sessions sidebar's
// "Customizations" list did.

const VIEWS: { tab: PanelTab; label: string; Icon: typeof Files }[] = [
  { tab: 'files', label: 'Explorer', Icon: Files },
  { tab: 'changes', label: 'Source Control', Icon: GitBranch },
  { tab: 'skills', label: 'Skills', Icon: Lightbulb }
]

type Dialog = 'skills' | 'tags' | 'patterns' | 'hosts' | 'about'

interface Props {
  boardOpen: boolean
  /** Sessions that need you — a badge on the board icon. */
  boardBadge: number
  onToggleBoard: () => void
  tab: PanelTab
  panelVisible: boolean
  onSelect: (tab: PanelTab) => void
  remoteHosts: string[]
  engineStatus: Record<string, string>
  onOpenSsh: () => void
  onDisconnectRemote: (host: string) => void
  onReconnectRemote: (host: string) => void
}

export function ActivityBar({
  boardOpen,
  boardBadge,
  onToggleBoard,
  tab,
  panelVisible,
  onSelect,
  remoteHosts,
  engineStatus,
  onOpenSsh,
  onDisconnectRemote,
  onReconnectRemote
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.studio
      .getVersion()
      .then((res) => {
        if (!cancelled && res.ok) setVersion(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const openMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // Opens beside the gear, bottom-aligned with it; ContextMenu keeps it on screen.
    setMenu({ x: r.right + 4, y: r.bottom })
  }
  const items: MenuItem[] = [
    { label: 'Skills', run: () => setDialog('skills') },
    { label: 'Tags', run: () => setDialog('tags') },
    { label: 'Ticket Patterns', run: () => setDialog('patterns') },
    { label: 'Remote Hosts', run: () => setDialog('hosts') },
    { separator: true },
    { label: 'About', run: () => setDialog('about') }
  ]
  const close = () => setDialog(null)

  return (
    <nav className="activity-bar">
      {/* The board first: it's the app's main view of every session. */}
      <button
        className={`activity-bar-item ${boardOpen ? 'active' : ''}`}
        title={`${boardOpen ? 'Close' : 'Open'} Sessions Board (Ctrl+Space)${boardBadge ? ` — ${boardBadge} need${boardBadge === 1 ? 's' : ''} you` : ''}`}
        aria-pressed={boardOpen}
        onClick={onToggleBoard}
      >
        <SquareKanban size={22} strokeWidth={1.6} />
        {boardBadge > 0 && <span className="activity-bar-badge">{boardBadge}</span>}
      </button>
      <span className="activity-bar-sep" />
      {VIEWS.map(({ tab: t, label, Icon }) => (
        <button
          key={t}
          className={`activity-bar-item ${!boardOpen && panelVisible && tab === t ? 'active' : ''}`}
          title={label}
          aria-pressed={panelVisible && tab === t}
          onClick={() => onSelect(t)}
        >
          <Icon size={22} strokeWidth={1.6} />
        </button>
      ))}
      <span className="activity-bar-spacer" />
      <ThemePicker variant="activity" />
      <button className={`activity-bar-item ${menu ? 'open' : ''}`} title="Manage" onClick={openMenu}>
        <Settings size={22} strokeWidth={1.6} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog === 'skills' && (
        <SkillsManager
          remoteHosts={remoteHosts}
          engineStatus={engineStatus}
          onReconnectRemote={onReconnectRemote}
          onClose={close}
        />
      )}
      {dialog === 'tags' && <TagsDialog onClose={close} />}
      {dialog === 'patterns' && <CapturePatternsDialog onClose={close} />}
      {dialog === 'hosts' && (
        <RemoteHostsDialog
          hosts={remoteHosts}
          engineStatus={engineStatus}
          onConnectNew={onOpenSsh}
          onDisconnect={onDisconnectRemote}
          onReconnect={onReconnectRemote}
          onClose={close}
        />
      )}
      {dialog === 'about' && <AboutDialog version={version} onClose={close} />}
    </nav>
  )
}
