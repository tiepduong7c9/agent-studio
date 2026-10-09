import { ChevronDown, Ellipsis, Mail, Maximize2, Minimize2, PanelTop, Plus, Pin, SquareKanban } from 'lucide-react'
import type { SessionMeta } from '../../../shared/acp'
import type { ProjectInfo } from '../../../shared/types'
import { useSessionsStore } from '../acp/sessions-store'
import { useCaptureStore, type Capture } from '../capture-store'
import { hostLabel, projectLabel, relTime, sessionActivity } from '../session-format'
import { useViewPrefsStore } from '../view-prefs-store'
import { useActiveSessions } from './ActiveSessionsBar'
import { BoardFilters, BoardSearch, laneOf } from './SessionsBoard'
import { CaptureBadges, renderTitle } from './SessionsPanel'
import { SessionLinksButton } from './SessionLinksButton'
import { TagButton, useSessionMenu } from './session-actions'
import { ThemePicker } from './ThemePicker'

// The title bar carries what the view on screen needs, so the content below
// doesn't spend a toolbar row on it:
// - the sessions board: its breadcrumb, search, filters and New;
// - a session: a pill naming it (host › project › title, status) that opens
//   the session switcher, plus its actions (links, tag, pin, maximize, menu);
// - anything else: the workspace, as before.

interface Props {
  activeWorkspace: ProjectInfo | null
  leftVisible: boolean
  /** null = no right panel (it's docked on the left); hides its toggle. */
  rightVisible: boolean | null
  onToggleLeft: () => void
  onToggleRight: () => void
  /** The board button lives in the activity bar when there is one. */
  showBoard: boolean
  boardOpen: boolean
  /** Sessions that need you — shown as a count on the Board button. */
  boardBadge: number
  onToggleBoard: () => void
  sessions: SessionMeta[]
  /** The session whose tabs are on screen, if any. */
  session: SessionMeta | null
  /** Workspace id for the session's links (its repo link). */
  sessionWsId: string | null
  onOpenSessionSwitcher: () => void
  onNewSession: () => void
  onDeleteSession: (sid: string) => void
  maximized: boolean
  onToggleMaximize: () => void
}

/** Status text for the pill: what the session is doing, most urgent first. */
function sessionStatus(s: SessionMeta, done: boolean): { cls: string; text: string } {
  if (s.status === 'exited') return { cls: 'needs', text: 'exited' }
  if (s.claudeStatus === 'waiting') return { cls: 'needs', text: 'needs you' }
  if (s.claudeStatus === 'working') return { cls: 'running', text: 'running' }
  if (done) return { cls: 'needs', text: 'done' }
  if (s.schedule) return { cls: 'scheduled', text: 'scheduled' }
  const t = relTime(sessionActivity(s))
  return { cls: 'idle', text: `${s.status === 'suspended' ? 'suspended' : 'idle'}${t ? ` · ${t}` : ''}` }
}

const NO_CAPTURES: Capture[] = []

function SessionPill({ s, onOpen, menu }: { s: SessionMeta; onOpen: () => void; menu: ReturnType<typeof useSessionMenu> }) {
  const done = useSessionsStore((st) => !!st.doneSessions[s.id])
  const captures = useCaptureStore((st) => st.capturesBySid[s.id]) ?? NO_CAPTURES
  const unread = useViewPrefsStore((st) => !!st.unreadSessions[s.id])
  const lane = laneOf(s, done)
  const status = menu.busy ? { cls: 'idle', text: `${menu.busy}…` } : sessionStatus(s, done)
  return (
    <div
      className="titlebar-pill"
      role="button"
      tabIndex={0}
      title={`${s.name}\n${s.cwd} — switch session (Ctrl+E)`}
      onClick={menu.editing ? undefined : onOpen}
      onContextMenu={menu.open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !menu.editing) onOpen()
      }}
    >
      <span className={`titlebar-pill-dot lane-${lane}`} />
      <span className="titlebar-pill-crumb">{hostLabel(s.host)}</span>
      <span className="titlebar-pill-sep">›</span>
      <span className="titlebar-pill-crumb">{projectLabel(s.cwd)}</span>
      <span className="titlebar-pill-sep">›</span>
      {menu.editing ? (
        <input
          className="titlebar-pill-rename"
          defaultValue={s.name}
          autoFocus
          spellCheck={false}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') menu.commitRename(e.currentTarget.value)
            else if (e.key === 'Escape') menu.cancelRename()
          }}
          onBlur={(e) => menu.commitRename(e.currentTarget.value)}
        />
      ) : (
        <span className="titlebar-pill-title">{renderTitle(s.name)}</span>
      )}
      {unread && (
        <span className="titlebar-pill-unread" title="Marked unread">
          <Mail size={12} strokeWidth={2.25} />
        </span>
      )}
      <CaptureBadges captures={captures} />
      <span className="titlebar-pill-spacer" />
      <span className={`titlebar-pill-status ${status.cls}`}>{status.text}</span>
      <ChevronDown size={14} className="titlebar-pill-chevron" />
    </div>
  )
}

/** Shows/hides the active sessions bar. While it's hidden, a badge counts the
 *  other sessions that need you, so there's a cue to bring it back. */
function ActiveBarToggle({ s, sessions }: { s: SessionMeta; sessions: SessionMeta[] }) {
  const visible = useViewPrefsStore((st) => st.activeBarVisible)
  const setVisible = useViewPrefsStore((st) => st.setActiveBarVisible)
  const { needs } = useActiveSessions(sessions, s.id)
  return (
    <button
      className={`titlebar-action-btn ${visible ? 'active' : ''}`}
      title={`${visible ? 'Hide' : 'Show'} running & needs-you sessions${!visible && needs.length ? ` — ${needs.length} need${needs.length === 1 ? 's' : ''} you` : ''}`}
      aria-pressed={visible}
      onClick={() => setVisible(!visible)}
    >
      <PanelTop size={16} strokeWidth={2} />
      {!visible && needs.length > 0 && <span className="titlebar-board-badge titlebar-action-badge">{needs.length}</span>}
    </button>
  )
}

function SessionActions({
  s,
  sessions,
  wsId,
  menu,
  maximized,
  onToggleMaximize
}: {
  s: SessionMeta
  sessions: SessionMeta[]
  wsId: string | null
  menu: ReturnType<typeof useSessionMenu>
  maximized: boolean
  onToggleMaximize: () => void
}) {
  const pinned = useViewPrefsStore((st) => !!st.pinnedSessions[s.id])
  const togglePin = useViewPrefsStore((st) => st.togglePin)
  return (
    <div className="titlebar-actions">
      <SessionLinksButton sid={s.id} wsId={wsId} />
      <TagButton sid={s.id} className="titlebar-action-btn" size={16} />
      <button
        className={`titlebar-action-btn ${pinned ? 'active' : ''}`}
        title={pinned ? 'Unpin' : 'Pin'}
        aria-pressed={pinned}
        onClick={() => togglePin(s.id)}
      >
        <Pin size={16} strokeWidth={2} fill={pinned ? 'currentColor' : 'none'} />
      </button>
      <ActiveBarToggle s={s} sessions={sessions} />
      <button
        className="titlebar-action-btn"
        title={maximized ? 'Restore panels' : 'Maximize editor'}
        onClick={onToggleMaximize}
      >
        {maximized ? <Minimize2 size={16} strokeWidth={2} /> : <Maximize2 size={16} strokeWidth={2} />}
      </button>
      <button className="titlebar-action-btn" title="More actions" onClick={(e) => menu.open(e, true)}>
        <Ellipsis size={16} strokeWidth={2} />
      </button>
    </div>
  )
}

/** The pill and its actions share one session menu, so "Rename" in the "…"
 *  menu edits the title in the pill. */
function SessionTitle({
  s,
  sessions,
  wsId,
  onOpenSwitcher,
  onDelete,
  maximized,
  onToggleMaximize
}: {
  s: SessionMeta
  sessions: SessionMeta[]
  wsId: string | null
  onOpenSwitcher: () => void
  onDelete: () => void
  maximized: boolean
  onToggleMaximize: () => void
}) {
  const menu = useSessionMenu(s, onDelete)
  return (
    <>
      <div className="titlebar-center">
        <SessionPill s={s} onOpen={onOpenSwitcher} menu={menu} />
      </div>
      <div className="titlebar-side right">
        <SessionActions s={s} sessions={sessions} wsId={wsId} menu={menu} maximized={maximized} onToggleMaximize={onToggleMaximize} />
        <WindowControls />
      </div>
      {menu.node}
    </>
  )
}

/** The window buttons, set off from whatever precedes them by a divider. */
function WindowControls() {
  return (
    <>
      <span className="titlebar-sep" />
      <div className="window-controls">
        <button
          className="window-control codicon codicon-chrome-minimize"
          onClick={() => window.studio.windowControl('minimize')}
        />
        <button
          className="window-control codicon codicon-chrome-maximize"
          onClick={() => window.studio.windowControl('maximize')}
        />
        <button
          className="window-control close codicon codicon-chrome-close"
          onClick={() => window.studio.windowControl('close')}
        />
      </div>
    </>
  )
}

export function TitleBar({
  activeWorkspace,
  leftVisible,
  rightVisible,
  onToggleLeft,
  onToggleRight,
  showBoard,
  boardOpen,
  boardBadge,
  onToggleBoard,
  sessions,
  session,
  sessionWsId,
  onOpenSessionSwitcher,
  onNewSession,
  onDeleteSession,
  maximized,
  onToggleMaximize
}: Props) {
  const project = activeWorkspace
  const onBoard = boardOpen && !showBoard
  return (
    <header className="titlebar">
      <div className="titlebar-side left">
        <button
          className={`icon-button codicon codicon-layout-sidebar-left${leftVisible ? '' : '-off'}`}
          title="Toggle Left Panel"
          onClick={onToggleLeft}
        />
        {/* Labelled, not icon-only: the board is a primary view, so it should be
            findable at a glance and reachable even with the sidebar hidden. */}
        {showBoard && (
          <button
            className={`titlebar-board ${boardOpen ? 'active' : ''}`}
            title={`${boardOpen ? 'Close' : 'Open'} Sessions Board (Ctrl+Space)${boardBadge ? ` — ${boardBadge} need${boardBadge === 1 ? 's' : ''} you` : ''}`}
            aria-pressed={boardOpen}
            onClick={onToggleBoard}
          >
            <SquareKanban size={15} strokeWidth={2} />
            <span>Board</span>
            {boardBadge > 0 && <span className="titlebar-board-badge">{boardBadge}</span>}
          </button>
        )}
        {onBoard && (
          <span className="titlebar-crumbs">
            <span>Agent Studio</span>
            <span className="titlebar-pill-sep">›</span>
            <span className="titlebar-crumbs-current">Sessions</span>
          </span>
        )}
      </div>
      {onBoard ? (
        <>
          <div className="titlebar-center">
            <BoardSearch />
          </div>
          <div className="titlebar-side right">
            <BoardFilters sessions={sessions} />
            <button className="btn btn-primary titlebar-new" onClick={onNewSession}>
              <Plus size={14} strokeWidth={2.5} />
              New
            </button>
            <WindowControls />
          </div>
        </>
      ) : session ? (
        <SessionTitle
          key={session.id}
          s={session}
          sessions={sessions}
          wsId={sessionWsId}
          onOpenSwitcher={onOpenSessionSwitcher}
          onDelete={() => onDeleteSession(session.id)}
          maximized={maximized}
          onToggleMaximize={onToggleMaximize}
        />
      ) : (
        <>
          <div className="titlebar-center">
            <div className="command-center" title={project?.rootPath ?? 'Agent Studio'}>
              {project?.kind === 'ssh' && <span className="codicon codicon-remote" />}
              <span className="command-center-label">
                {project ? (project.kind === 'ssh' ? `${project.host} · ` : '') + project.name : 'Agent Studio'}
              </span>
            </div>
          </div>
          <div className="titlebar-side right">
            {showBoard && <ThemePicker />}
            {rightVisible !== null && (
              <button
                className={`icon-button codicon codicon-layout-sidebar-right${rightVisible ? '' : '-off'}`}
                title="Toggle Right Panel"
                onClick={onToggleRight}
              />
            )}
            <WindowControls />
          </div>
        </>
      )}
    </header>
  )
}
