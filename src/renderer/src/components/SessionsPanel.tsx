import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import type { AcpConversation, ProjectConversations, SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { useViewPrefsStore } from '../view-prefs-store'
import { hostLabel, projectLabel, sessionActivity as activity } from '../session-format'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { AboutDialog, ConfirmDialog } from './Dialogs'
import { RemoteHostsDialog } from './RemoteHostsDialog'
import { SkillsManager } from './SkillsManager'

const CUSTOMIZATIONS = [
  { icon: 'sparkle', label: 'Agents' },
  { icon: 'lightbulb', label: 'Skills' },
  { icon: 'book', label: 'Instructions' },
  { icon: 'plug', label: 'Hooks' },
  { icon: 'server', label: 'MCP Servers' },
  { icon: 'extensions', label: 'Plugins' }
]

interface Props {
  sessions: SessionMeta[]
  projects: ProjectConversations[]
  /** Connected SSH hosts ("user@host"), managed from the header hosts menu. */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  activeSid: string | null
  onSelectSession: (sid: string) => void
  onOpenConversation: (project: ProjectConversations, conv: AcpConversation) => void
  /** Start the New Session flow (opens the command palette at its project picker). */
  onNewSessionFlow: () => void
  /** Permanently end (kill) a live session on the engine. */
  onDeleteSession: (sid: string) => void
  onOpenLocal: () => void
  onOpenSsh: () => void
  /** Disconnect a connected SSH host (or forget a lost one). */
  onDisconnectRemote: (host: string) => void
  /** Reconnect a disconnected (saved) SSH host from its stored credentials. */
  onReconnectRemote: (host: string) => void
}

// Compact relative time — Working counts up (elapsed), the rest count time since
// last active. Rendered tersely to fit the right edge of the metadata line.
function relTime(ms: number): string {
  if (!ms || Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

// Render a session title with inline PR/issue numbers (#1234) in the mono face,
// so they read as identifiers rather than prose.
function renderTitle(name: string) {
  return name.split(/(#\d+)/g).map((part, i) =>
    /^#\d+$/.test(part) ? (
      <span key={i} className="acp-session-pr">
        {part}
      </span>
    ) : (
      part
    )
  )
}

// Max rows shown per section before a "Show N more" toggle.
const ROW_LIMIT = 4

// Attention-state sections, in fixed display order. "Pinned" and "Needs you"
// carry the accent header colour.
type SectionKey = 'pinned' | 'needs' | 'working' | 'later' | 'idle' | 'parked'
const SECTIONS: { key: SectionKey; title: string; accent: boolean }[] = [
  { key: 'pinned', title: 'Pinned', accent: true },
  { key: 'needs', title: 'Needs you', accent: true },
  { key: 'working', title: 'Working', accent: false },
  { key: 'later', title: 'Later', accent: false },
  { key: 'idle', title: 'Idle', accent: false },
  { key: 'parked', title: 'Parked', accent: false }
]

// A row in a section: a live session, a resumable past conversation, or a pinned
// session whose host is offline (reconnect-on-click).
type Row =
  | { kind: 'live'; s: SessionMeta }
  | { kind: 'conv'; project: ProjectConversations; conv: AcpConversation }
  | { kind: 'offline'; id: string; name: string; host: string }

interface LiveRowProps {
  s: SessionMeta
  active: boolean
  pinned: boolean
  hidden: boolean
  /** Finished a turn while unwatched — shown as a "done" status until viewed. */
  done: boolean
  /** When that turn finished (ms epoch); shown as the row time on a done row. */
  doneAt?: number
  /** User-flagged unread (follow up later) — a persistent manual marker. */
  unread: boolean
  onSelect: () => void
  onToggleUnread: () => void
  onDelete: () => void
}

function LiveRow({ s, active, pinned, hidden, done, doneAt, unread, onSelect, onToggleUnread, onDelete }: LiveRowProps) {
  // "done" only stands in when Claude is otherwise idle — a live working/waiting
  // status always wins (a new turn clears the marker anyway).
  const displayStatus = done && (!s.claudeStatus || s.claudeStatus === 'idle') ? 'done' : s.claudeStatus
  // On a done row the time is when the turn finished; otherwise it's last activity.
  const subTime = displayStatus === 'done' && doneAt ? relTime(doneAt) : relTime(activity(s))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const openMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const commitRename = (value: string) => {
    const name = value.trim()
    setEditing(false)
    if (name && name !== s.name) void window.studio.acp.rename(s.id, name)
  }

  const regenerateTitle = async () => {
    setBusy(true)
    try {
      await window.studio.acp.regenerateTitle(s.id)
    } finally {
      setBusy(false)
    }
  }

  // Re-spawn the session's adapter so it re-reads host-side config (e.g. newly
  // added MCP servers); the conversation is reloaded, but any in-flight turn is
  // dropped.
  const restart = async () => {
    setRestarting(true)
    try {
      await window.studio.acp.restart(s.id)
    } finally {
      setRestarting(false)
    }
  }

  const items: MenuItem[] = [
    { label: unread ? 'Mark as read' : 'Mark as unread', run: onToggleUnread },
    { separator: true },
    { label: 'Rename', run: () => setEditing(true) },
    { label: 'Regenerate title', enabled: !busy && !restarting, run: () => void regenerateTitle() },
    { label: 'Restart session', enabled: !busy && !restarting, run: () => void restart() },
    { separator: true },
    { label: 'Delete Session', run: () => setConfirming(true) }
  ]

  const showUnreadDot = unread || displayStatus === 'done'

  return (
    <div className={`acp-session-row-wrap ${hidden ? 'hidden' : ''}`}>
      {editing ? (
        <div className="acp-session-row editing">
          <input
            className="acp-session-name-edit"
            defaultValue={s.name}
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value)
              else if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={(e) => commitRename(e.currentTarget.value)}
          />
        </div>
      ) : (
        <button
          className={`acp-session-row ${active ? 'active' : ''} ${displayStatus === 'done' ? 'done' : ''} ${displayStatus === 'waiting' ? 'waiting' : ''} ${unread ? 'unread' : ''}`}
          onClick={onSelect}
          onContextMenu={openMenu}
        >
          <span className="acp-session-main">
            <span className="acp-session-title-line">
              <span className="acp-session-name">{renderTitle(s.name)}</span>
              {/* One indicator, right-aligned: a live green pulse while working,
                  else the blue unread-activity dot. Mutually exclusive. */}
              {displayStatus === 'working' ? (
                <span className="acp-session-working-dot" title="Working" />
              ) : (
                showUnreadDot && <span className="acp-session-unread-dot" title="Unread activity" />
              )}
            </span>
            <span className="acp-session-meta-line">
              {restarting || busy ? (
                <span className="acp-session-meta-label">
                  {restarting ? 'restarting…' : 'generating title…'}
                </span>
              ) : (
                <>
                  <span className="acp-session-project">
                    <span className="codicon codicon-folder acp-session-meta-icon" />
                    {projectLabel(s.cwd)}
                  </span>
                  <span className="acp-session-host">
                    <span
                      className={`codicon ${s.host ? 'codicon-server' : 'codicon-device-desktop'} acp-session-meta-icon`}
                    />
                    <span className="acp-session-host-name">{hostLabel(s.host)}</span>
                  </span>
                  <span className="acp-session-time">{subTime}</span>
                </>
              )}
            </span>
          </span>
        </button>
      )}
      {pinned && <span className="acp-session-pin codicon codicon-pinned" title="Pinned" />}
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
    </div>
  )
}

// A resumable past conversation on disk (no live session). Lives in "Parked".
function ConvRow({ project, conv, onOpen }: { project: ProjectConversations; conv: AcpConversation; onOpen: () => void }) {
  return (
    <button className="acp-session-row acp-session-history" onClick={onOpen} title="Resume this conversation">
      <span className="acp-session-main">
        <span className="acp-session-title-line">
          <span className="acp-session-name">{renderTitle(conv.title || 'Untitled conversation')}</span>
        </span>
        <span className="acp-session-meta-line">
          <span className="acp-session-project">
            <span className="codicon codicon-folder acp-session-meta-icon" />
            {project.name}
          </span>
          <span className="acp-session-host">
            <span
              className={`codicon ${project.host ? 'codicon-server' : 'codicon-device-desktop'} acp-session-meta-icon`}
            />
            <span className="acp-session-host-name">{hostLabel(project.host)}</span>
          </span>
          <span className="acp-session-time">{relTime(conv.mtime)}</span>
        </span>
      </span>
    </button>
  )
}

// A pinned session whose host is offline: no live data to attach to, so it's
// rendered from cached metadata as a dimmed row that reconnects the host on click
// (its session resurfaces once the host is back up).
function OfflineRow({ name, host, onReconnect }: { name: string; host: string; onReconnect: () => void }) {
  return (
    <div className="acp-session-row-wrap offline">
      <button
        className="acp-session-row offline"
        onClick={onReconnect}
        title="Host disconnected — click to reconnect"
      >
        <span className="acp-session-main">
          <span className="acp-session-title-line">
            <span className="acp-session-name">{name}</span>
          </span>
          <span className="acp-session-meta-line">
            <span className="acp-session-host">
              <span className="codicon codicon-server acp-session-meta-icon" />
              <span className="acp-session-host-name">{hostLabel(host)}</span>
            </span>
            <span className="acp-session-time">reconnect</span>
          </span>
        </span>
      </button>
      <span className="acp-session-pin codicon codicon-pinned" title="Pinned" />
    </div>
  )
}

export function SessionsPanel({
  sessions,
  projects,
  remoteHosts,
  engineStatus,
  activeSid,
  onSelectSession,
  onOpenConversation,
  onNewSessionFlow,
  onDeleteSession,
  onOpenLocal,
  onOpenSsh,
  onDisconnectRemote,
  onReconnectRemote
}: Props) {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const pinnedSessions = useViewPrefsStore((s) => s.pinnedSessions)
  const pinnedMeta = useViewPrefsStore((s) => s.pinnedMeta)
  const hiddenSessions = useViewPrefsStore((s) => s.hiddenSessions)
  const showHidden = useViewPrefsStore((s) => s.showHidden)
  const unreadSessions = useViewPrefsStore((s) => s.unreadSessions)
  const toggleUnread = useViewPrefsStore((s) => s.toggleUnread)
  const setShowHidden = useViewPrefsStore((s) => s.setShowHidden)

  // A slow tick so live timestamps (Working counts up, others age) refresh even
  // without a session update.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Pinned sessions whose remote host isn't currently connected, drawn from
  // cached metadata — the host pushes no live list, so without this they'd
  // vanish. Only known, disconnected hosts qualify.
  const offlinePinned = useMemo(() => {
    const liveIds = new Set(sessions.map((s) => s.id))
    const knownHosts = new Set(remoteHosts)
    const out: { id: string; name: string; host: string }[] = []
    for (const [id, meta] of Object.entries(pinnedMeta)) {
      if (!pinnedSessions[id] || liveIds.has(id) || !meta.host) continue
      if (!knownHosts.has(meta.host) || engineStatus[`ssh:${meta.host}`] === 'connected') continue
      out.push({ id, name: meta.name, host: meta.host })
    }
    return out
  }, [sessions, pinnedMeta, pinnedSessions, engineStatus, remoteHosts])

  // Classify every visible live session into an attention-state bucket, plus the
  // resumable on-disk conversations that have no live session (folded into
  // Parked). Sorting: same-project rows sit adjacent, then most-recent first;
  // Needs-you additionally floats blocked (waiting) items above crashed & done.
  const buckets = useMemo(() => {
    const cmp = (a: SessionMeta, b: SessionMeta): number => {
      const pa = projectLabel(a.cwd)
      const pb = projectLabel(b.cwd)
      if (pa !== pb) return pa.localeCompare(pb)
      return activity(b) - activity(a)
    }
    const pinned: SessionMeta[] = []
    const needs: SessionMeta[] = []
    const working: SessionMeta[] = []
    const later: SessionMeta[] = []
    const idle: SessionMeta[] = []
    const parked: SessionMeta[] = []
    for (const s of sessions) {
      if (!showHidden && hiddenSessions[s.id]) continue
      if (pinnedSessions[s.id]) {
        pinned.push(s)
        continue
      }
      if (s.status === 'exited') needs.push(s)
      else if (s.status === 'suspended') parked.push(s)
      else if (s.claudeStatus === 'working') working.push(s)
      else if (s.claudeStatus === 'waiting') needs.push(s)
      else if (doneSessions[s.id]) needs.push(s)
      // Manually flagged "follow up later" — an otherwise-idle session you
      // bookmarked. Live/urgent states above keep their more-specific section.
      else if (unreadSessions[s.id]) later.push(s)
      else idle.push(s)
    }
    const needsRank = (s: SessionMeta): number =>
      s.claudeStatus === 'waiting' ? 0 : s.status === 'exited' ? 1 : 2
    needs.sort((a, b) => needsRank(a) - needsRank(b) || cmp(a, b))
    working.sort(cmp)
    later.sort(cmp)
    idle.sort(cmp)
    parked.sort(cmp)
    pinned.sort((a, b) => activity(b) - activity(a))

    // Resumable conversations: on-disk history not backed by a live session.
    const liveAcp = new Set(sessions.map((s) => s.acpSessionId).filter(Boolean) as string[])
    const convs: { project: ProjectConversations; conv: AcpConversation }[] = []
    for (const p of projects) {
      for (const c of p.conversations) {
        if (!liveAcp.has(c.sessionId)) convs.push({ project: p, conv: c })
      }
    }
    convs.sort((a, b) => b.conv.mtime - a.conv.mtime)

    return { pinned, needs, working, later, idle, parked, convs }
  }, [sessions, projects, pinnedSessions, hiddenSessions, showHidden, doneSessions, unreadSessions])

  // Search: free-text across the whole list, matching title / project / host.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])
  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matchesSession = (s: SessionMeta): boolean =>
    !searching ||
    [s.name, projectLabel(s.cwd), hostLabel(s.host)].some((t) => t.toLowerCase().includes(q))
  const matchesText = (...parts: (string | null | undefined)[]): boolean =>
    !searching || parts.some((t) => !!t && t.toLowerCase().includes(q))
  const toggleSearch = (): void => {
    if (searchOpen) {
      setQuery('')
      setSearchOpen(false)
    } else {
      setSearchOpen(true)
    }
  }

  // Section collapse — Parked starts collapsed (header only). Searching forces
  // every section open so matches stay visible.
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set<SectionKey>(['parked']))
  const toggleCollapse = (key: SectionKey): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Per-section "show more" (local to the section). Searching shows all.
  const [expanded, setExpanded] = useState<Set<SectionKey>>(new Set())
  const toggleExpand = (key: SectionKey): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const liveRowProps = (s: SessionMeta): LiveRowProps => ({
    s,
    active: s.id === activeSid,
    pinned: !!pinnedSessions[s.id],
    hidden: !!hiddenSessions[s.id],
    done: !!doneSessions[s.id],
    doneAt: doneSessions[s.id],
    unread: !!unreadSessions[s.id],
    onSelect: () => onSelectSession(s.id),
    onToggleUnread: () => toggleUnread(s.id),
    onDelete: () => onDeleteSession(s.id)
  })

  // Build the display rows for each section, applying the search filter.
  const rowsByKey = useMemo(() => {
    const live = (list: SessionMeta[]): Row[] =>
      list.filter(matchesSession).map((s) => ({ kind: 'live', s }))
    const pinnedRows: Row[] = [
      ...live(buckets.pinned),
      ...offlinePinned
        .filter((o) => matchesText(o.name, hostLabel(o.host)))
        .map((o) => ({ kind: 'offline', id: o.id, name: o.name, host: o.host }) as Row)
    ]
    const parkedRows: Row[] = [
      ...live(buckets.parked),
      ...buckets.convs
        .filter(({ project, conv }) => matchesText(conv.title, project.name, hostLabel(project.host)))
        .map(({ project, conv }) => ({ kind: 'conv', project, conv }) as Row)
    ]
    return {
      pinned: pinnedRows,
      needs: live(buckets.needs),
      working: live(buckets.working),
      later: live(buckets.later),
      idle: live(buckets.idle),
      parked: parkedRows
    } as Record<SectionKey, Row[]>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, offlinePinned, q, searching, activeSid, pinnedSessions, unreadSessions, hiddenSessions, doneSessions])

  const totalRows = SECTIONS.reduce((n, s) => n + rowsByKey[s.key].length, 0)
  const hiddenCount = sessions.filter((s) => hiddenSessions[s.id]).length
  const nothing = sessions.length === 0 && projects.length === 0 && remoteHosts.length === 0

  // Header "manage remote hosts" popup — the single place to connect a new SSH
  // host and to manage each known one (open a folder, disconnect, reconnect,
  // forget). Replaces the old separate hosts + connect buttons.
  const [hostsOpen, setHostsOpen] = useState(false)

  const [customizationsCollapsed, setCustomizationsCollapsed] = useState(true)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
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

  const renderRow = (r: Row) => {
    if (r.kind === 'live') return <LiveRow key={r.s.id} {...liveRowProps(r.s)} />
    if (r.kind === 'conv')
      return (
        <ConvRow
          key={r.conv.sessionId}
          project={r.project}
          conv={r.conv}
          onOpen={() => onOpenConversation(r.project, r.conv)}
        />
      )
    return <OfflineRow key={r.id} name={r.name} host={r.host} onReconnect={() => onReconnectRemote(r.host)} />
  }

  const renderSection = ({ key, title, accent }: { key: SectionKey; title: string; accent: boolean }) => {
    const rows = rowsByKey[key]
    if (rows.length === 0) return null
    const isCollapsed = !searching && collapsed.has(key)
    const showAll = searching || expanded.has(key)
    const shown = showAll ? rows : rows.slice(0, ROW_LIMIT)
    return (
      <div className="sess-section" key={key}>
        <div
          className={`sess-section-header ${accent ? 'accent' : ''}`}
          onClick={() => toggleCollapse(key)}
          role="button"
          aria-expanded={!isCollapsed}
        >
          <span className="sess-section-title">{title}</span>
          <span className="sess-section-count">{rows.length}</span>
        </div>
        {!isCollapsed && (
          <div className="sess-section-rows">
            {shown.map(renderRow)}
            {!searching && rows.length > ROW_LIMIT && (
              <button className="sess-more" onClick={() => toggleExpand(key)}>
                {expanded.has(key) ? 'Show less' : `Show ${rows.length - ROW_LIMIT} more`}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sessions-panel agent-sessions-workbench">
      <div className="sessions-header">
        <span className="sessions-title">Sessions</span>
        <span className="topbar-spacer" />
        {hiddenCount > 0 && (
          <button
            className={`sessions-show-hidden ${showHidden ? 'active' : ''}`}
            onClick={() => setShowHidden(!showHidden)}
            title={showHidden ? 'Stop showing hidden items' : `Show ${hiddenCount} hidden item(s)`}
          >
            <span className={`codicon ${showHidden ? 'codicon-eye' : 'codicon-eye-closed'}`} />
            {hiddenCount}
          </button>
        )}
        {!nothing && (
          <button
            className={`icon-button codicon codicon-search ${searchOpen ? 'active' : ''}`}
            title={searchOpen ? 'Hide Search' : 'Search'}
            onClick={toggleSearch}
          />
        )}
        <button className="icon-button codicon codicon-add" title="New Session" onClick={onNewSessionFlow} />
        <button
          className={`icon-button codicon codicon-server ${hostsOpen ? 'active' : ''}`}
          title="Manage remote hosts"
          onClick={() => setHostsOpen(true)}
        />
      </div>
      {searchOpen && !nothing && (
        <div className="sessions-search-wrap">
          <div className="sessions-search">
            <span className="codicon codicon-search sessions-search-icon" />
            <input
              ref={inputRef}
              className="sessions-search-input"
              type="text"
              placeholder="Search sessions, projects, hosts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Escape') {
                  if (query) setQuery('')
                  else toggleSearch()
                }
              }}
              spellCheck={false}
            />
            {query && (
              <button
                className="icon-button codicon codicon-close sessions-search-clear"
                title="Clear"
                onClick={() => setQuery('')}
              />
            )}
          </div>
        </div>
      )}
      <div className="sessions-body pane-body">
        {nothing ? (
          <div className="sessions-empty-cta">
            <div className="sessions-empty">No sessions found</div>
            <button className="btn btn-primary" onClick={onOpenLocal}>Open Folder</button>
            <button className="btn" onClick={onOpenSsh}>Connect SSH…</button>
          </div>
        ) : searching && totalRows === 0 ? (
          <div className="sessions-empty">No matching sessions</div>
        ) : (
          SECTIONS.map(renderSection)
        )}
      </div>
      <div className="customizations">
        <div
          className="customizations-label"
          onClick={() => setCustomizationsCollapsed((v) => !v)}
          role="button"
          aria-expanded={!customizationsCollapsed}
        >
          <span
            className={`codicon ${customizationsCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} customizations-twistie`}
          />
          <span>Customizations</span>
        </div>
        {!customizationsCollapsed && (
          <>
            {CUSTOMIZATIONS.map((c) => {
              const onClick = c.label === 'Skills' ? () => setSkillsOpen(true) : undefined
              return (
                <div
                  key={c.label}
                  className="customization-row"
                  role={onClick ? 'button' : undefined}
                  onClick={onClick}
                >
                  <span className={`codicon codicon-${c.icon}`} />
                  <span className="customization-name">{c.label}</span>
                </div>
              )
            })}
            <div className="customization-row" role="button" onClick={() => setAboutOpen(true)}>
              <Info size={16} className="customization-icon" />
              <span className="customization-name">About</span>
            </div>
          </>
        )}
      </div>
      {hostsOpen && (
        <RemoteHostsDialog
          hosts={remoteHosts}
          engineStatus={engineStatus}
          onConnectNew={onOpenSsh}
          onDisconnect={onDisconnectRemote}
          onReconnect={onReconnectRemote}
          onClose={() => setHostsOpen(false)}
        />
      )}
      {aboutOpen && <AboutDialog version={version} onClose={() => setAboutOpen(false)} />}
      {skillsOpen && (
        <SkillsManager
          remoteHosts={remoteHosts}
          engineStatus={engineStatus}
          onReconnectRemote={onReconnectRemote}
          onClose={() => setSkillsOpen(false)}
        />
      )}
    </div>
  )
}
