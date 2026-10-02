import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlarmClock, Ellipsis, Mail, Pin } from 'lucide-react'
import { create } from 'zustand'
import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { useCaptureStore, type Capture } from '../capture-store'
import { hostLabel, projectLabel, relTime, scheduleLabel, sessionActivity } from '../session-format'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { useTagsStore } from '../tags-store'
import { useViewPrefsStore } from '../view-prefs-store'
import { useGitInfoStore } from '../git-info-store'
import { CaptureBadges, renderTitle, SessionTagIcon, WorktreeChip } from './SessionsPanel'
import { useSessionMenu } from './session-actions'
import './SessionsBoard.css'

// A full-window board of every session, one column per connectable host. The
// sidebar answers "what needs me next"; the board answers "what's happening
// everywhere" — which machine is busy, which is idle, which is unreachable —
// at a size where every host fits side by side.

// Cards per column before idle ones collapse behind "Show N more idle". Active
// cards (running / needs you / scheduled) are never hidden; idle ones fill the
// rest, with a floor so a busy column still shows some of its history.
const CARD_CAP = 5
const MIN_IDLE = 3

// Pinned strip tile geometry (px) — must match .board-pin / .board-pin-more /
// .board-pins-row gap in SessionsBoard.css; used to work out how many fit.
const PIN_W = 212
const PIN_MORE_W = 98
const PIN_GAP = 8

/** What a card is doing, from most to least urgent. Every session is exactly one. */
export type Lane = 'needs' | 'running' | 'scheduled' | 'idle'
const LANE_RANK: Record<Lane, number> = { needs: 0, running: 1, scheduled: 2, idle: 3 }

type Filter = 'all' | 'active' | 'needs'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active only' },
  { key: 'needs', label: 'Needs me' }
]

// "Later" on a waiting card: take it out of "Needs me" without answering it.
// Kept for the app's lifetime (not persisted) and only while the session is
// still waiting — once it moves on, a later prompt asks afresh.
const useSnoozeStore = create<{
  snoozed: Record<string, true>
  snooze: (sid: string) => void
  keepOnly: (sids: Set<string>) => void
}>((set) => ({
  snoozed: {},
  snooze: (sid) => set((s) => ({ snoozed: { ...s.snoozed, [sid]: true } })),
  keepOnly: (sids) =>
    set((s) => {
      const ids = Object.keys(s.snoozed)
      if (ids.every((id) => sids.has(id))) return s
      return { snoozed: Object.fromEntries(ids.filter((id) => sids.has(id)).map((id) => [id, true])) }
    })
}))

// The board's filter and search live in the title bar while the board is open,
// so they're shared state rather than the board's own. Kept for the app's
// lifetime: reopening the board picks up where it was.
export const useBoardStore = create<{
  filter: Filter
  query: string
  setFilter: (f: Filter) => void
  setQuery: (q: string) => void
}>((set) => ({
  filter: 'all',
  query: '',
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query })
}))

/** The title bar's search box while the board is open. */
export function BoardSearch() {
  const query = useBoardStore((s) => s.query)
  const setQuery = useBoardStore((s) => s.setQuery)
  return (
    <div className="titlebar-search">
      <span className="codicon codicon-search" />
      <input
        className="titlebar-search-input"
        type="text"
        placeholder="Search sessions, projects, hosts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      {query && (
        <button className="icon-button codicon codicon-close" title="Clear" onClick={() => setQuery('')} />
      )}
    </div>
  )
}

/** The title bar's All / Active only / Needs me switch, with live counts. */
export function BoardFilters({ sessions }: { sessions: SessionMeta[] }) {
  const filter = useBoardStore((s) => s.filter)
  const setFilter = useBoardStore((s) => s.setFilter)
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const needs = useBoardNeedsCount(sessions)
  const active = sessions.filter((s) => laneOf(s, !!doneSessions[s.id]) !== 'idle').length
  const count: Record<Filter, number | null> = { all: null, active, needs }
  return (
    <div className="board-filters" role="tablist">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          role="tab"
          aria-selected={filter === f.key}
          className={`board-filter ${filter === f.key ? 'active' : ''}`}
          onClick={() => setFilter(f.key)}
        >
          {f.label}
          {!!count[f.key] && <span className={`board-filter-count ${f.key}`}>{count[f.key]}</span>}
        </button>
      ))}
    </div>
  )
}

/** How many sessions the board's "Needs me" filter would show — for the
 *  board icon's badge. */
export function useBoardNeedsCount(sessions: SessionMeta[]): number {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const snoozed = useSnoozeStore((s) => s.snoozed)
  return sessions.filter((s) => laneOf(s, !!doneSessions[s.id]) === 'needs' && !snoozed[s.id]).length
}

interface Props {
  sessions: SessionMeta[]
  /** Connected SSH hosts ("user@host"). */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  activeSid: string | null
  /** Open a session's chat (the board closes itself). */
  onSelectSession: (sid: string) => void
  /** Start the New Session flow scoped to a host (null = local machine). */
  onNewSessionOnHost: (host: string | null) => void
  onOpenSsh: () => void
  onDisconnectRemote: (host: string) => void
  onReconnectRemote: (host: string) => void
  onDeleteSession: (sid: string) => void
  onClose: () => void
}

interface Card {
  s: SessionMeta
  lane: Lane
  /** Finished a turn while unwatched (the sidebar's "done"). */
  done: boolean
  doneAt?: number
  snoozed: boolean
  pinned: boolean
}

/** A pinned session whose host is offline: only cached metadata to show. */
interface OfflinePin {
  id: string
  name: string
  host: string
}

type HostState = 'connected' | 'reconnecting' | 'offline'

interface Column {
  host: string | null
  label: string
  state: HostState
  cards: Card[]
  /** Card counts per lane, before the filter — the column's summary line. */
  counts: Record<Lane, number>
}

export function laneOf(s: SessionMeta, done: boolean): Lane {
  if (s.status === 'exited' || s.claudeStatus === 'waiting' || done) return 'needs'
  if (s.claudeStatus === 'working') return 'running'
  if (s.schedule) return 'scheduled'
  return 'idle'
}

/** "1 running · 1 needs you · 5 idle" — the non-zero lanes, most urgent first. */
function countsLabel(c: Record<Lane, number>): string {
  const parts: string[] = []
  if (c.running) parts.push(`${c.running} running`)
  if (c.needs) parts.push(`${c.needs} needs you`)
  if (c.scheduled) parts.push(`${c.scheduled} scheduled`)
  if (c.idle) parts.push(`${c.idle} idle`)
  return parts.join(' · ') || 'no sessions'
}

/** The card's status line: what it's doing and, where it matters, since when. */
function cardStatus(c: Card): { cls: string; text: string } | null {
  const { s } = c
  if (s.status === 'exited') return { cls: 'needs', text: 'Exited — needs a restart' }
  if (s.claudeStatus === 'waiting')
    return { cls: c.snoozed ? 'snoozed' : 'needs', text: c.snoozed ? 'Waiting — snoozed' : 'Waiting for your approval' }
  if (s.claudeStatus === 'working') return { cls: 'running', text: 'Running · turn in progress' }
  if (c.done) return { cls: 'done', text: 'Done · not yet viewed' }
  if (s.schedule) return { cls: 'scheduled', text: 'Scheduled' }
  return null
}

/** The pinned tile's one-word status. */
function pinStatus(c: Card): { cls: string; text: string } {
  const { s } = c
  if (s.status === 'exited') return { cls: 'needs', text: 'Exited' }
  if (s.claudeStatus === 'waiting') return c.snoozed ? { cls: 'snoozed', text: 'Snoozed' } : { cls: 'needs', text: 'Needs you' }
  if (s.claudeStatus === 'working') return { cls: 'running', text: 'Running' }
  if (c.done) return { cls: 'done', text: 'Done' }
  if (s.schedule) return { cls: 'scheduled', text: 'Scheduled' }
  return { cls: 'idle', text: s.status === 'suspended' ? 'Suspended' : 'Idle' }
}

/** Right-click on an offline pinned tile: there's no live session to act on,
 *  so unpin is all it offers. */
function usePinMenu(onTogglePin: () => void, pinned: boolean) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const open = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  const node = menu && (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={[{ label: pinned ? 'Unpin' : 'Pin', run: onTogglePin }]}
      onClose={() => setMenu(null)}
    />
  )
  return { open, node }
}

function PinTile({ c, active, onOpen, onDelete }: { c: Card; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const { s } = c
  const st = pinStatus(c)
  const menu = useSessionMenu(s, onDelete)
  const asking = s.claudeStatus === 'waiting' && !c.snoozed
  return (
    <div
      className={`board-pin lane-${c.lane} ${asking ? 'asking' : ''} ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      title={s.name}
      onClick={onOpen}
      onContextMenu={menu.open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="board-pin-title">
        <span className={`board-pin-dot ${st.cls}`} />
        <span className="board-pin-name">{renderTitle(s.name)}</span>
      </div>
      <div className="board-pin-meta">
        <span className="board-pin-host">{hostLabel(s.host)}</span>
        <span className={`board-pin-status ${st.cls}`}>{st.text}</span>
        <span className="board-card-time">{relTime(c.done && c.doneAt ? c.doneAt : sessionActivity(s))}</span>
      </div>
      {menu.node}
    </div>
  )
}

function OfflinePinTile({ p, onReconnect, onUnpin }: { p: OfflinePin; onReconnect: () => void; onUnpin: () => void }) {
  const menu = usePinMenu(onUnpin, true)
  return (
    <div
      className="board-pin offline"
      role="button"
      tabIndex={0}
      title="Host disconnected — click to reconnect"
      onClick={onReconnect}
      onContextMenu={menu.open}
    >
      <div className="board-pin-title">
        <span className="board-pin-dot idle" />
        <span className="board-pin-name">{p.name}</span>
      </div>
      <div className="board-pin-meta">
        <span className="board-pin-host">{hostLabel(p.host)}</span>
        <span className="board-pin-status idle">Offline</span>
      </div>
      {menu.node}
    </div>
  )
}

/** The pinned sessions, across every host, as one row of compact tiles. What
 *  doesn't fit collapses into a "+N more" tile; "Show all pinned" wraps them. */
function PinnedStrip({
  cards,
  offline,
  total,
  activeSid,
  onSelectSession,
  onReconnectRemote,
  onTogglePin,
  onDeleteSession
}: {
  cards: Card[]
  offline: OfflinePin[]
  /** Every pinned session, before the filter and search. */
  total: number
  activeSid: string | null
  onSelectSession: (sid: string) => void
  onReconnectRemote: (host: string) => void
  onTogglePin: (sid: string) => void
  onDeleteSession: (sid: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const count = cards.length + offline.length
  const fitAll = Math.max(1, Math.floor((width + PIN_GAP) / (PIN_W + PIN_GAP)))
  const fitWithMore = Math.max(1, Math.floor((width - PIN_MORE_W) / (PIN_W + PIN_GAP)))
  const limit = expanded || count <= fitAll ? count : fitWithMore
  const shownCards = cards.slice(0, limit)
  const shownOffline = offline.slice(0, Math.max(0, limit - cards.length))
  const hidden = count - shownCards.length - shownOffline.length

  return (
    <div className="board-pins">
      <div className="board-pins-head">
        <Pin size={12} strokeWidth={2.25} />
        <span className="board-pins-label">Pinned</span>
        <span className="board-pins-count">{total}</span>
        <span className="topbar-spacer" />
        {(hidden > 0 || expanded) && (
          <button className="board-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show all pinned'}
          </button>
        )}
      </div>
      <div ref={rowRef} className={`board-pins-row ${expanded ? 'expanded' : ''}`}>
        {shownCards.map((c) => (
          <PinTile
            key={c.s.id}
            c={c}
            active={c.s.id === activeSid}
            onOpen={() => onSelectSession(c.s.id)}
            onDelete={() => onDeleteSession(c.s.id)}
          />
        ))}
        {shownOffline.map((p) => (
          <OfflinePinTile
            key={p.id}
            p={p}
            onReconnect={() => onReconnectRemote(p.host)}
            onUnpin={() => onTogglePin(p.id)}
          />
        ))}
        {hidden > 0 && (
          <button className="board-pin-more" onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        )}
        {count === 0 && <div className="board-column-empty">No pinned sessions match</div>}
      </div>
    </div>
  )
}

// Urgent first; a snoozed prompt sinks below the ones still asking. Within a
// lane, most recent activity first.
const byUrgency = (a: Card, b: Card): number =>
  LANE_RANK[a.lane] - LANE_RANK[b.lane] ||
  Number(a.snoozed) - Number(b.snoozed) ||
  sessionActivity(b.s) - sessionActivity(a.s)

function BoardCard({
  c,
  captures,
  tag,
  active,
  onOpen,
  onLater,
  onDelete
}: {
  c: Card
  captures: Capture[]
  /** The session's tag id, if any — drawn as the sidebar's coloured icon. */
  tag?: string
  active: boolean
  onOpen: () => void
  onLater: () => void
  onDelete: () => void
}) {
  const { s } = c
  const menu = useSessionMenu(s, onDelete)
  const status = menu.busy ? { cls: 'busy', text: `${menu.busy}…` } : cardStatus(c)
  const unread = useViewPrefsStore((st) => !!st.unreadSessions[s.id])
  const time = relTime(c.done && c.doneAt ? c.doneAt : sessionActivity(s))
  const asking = s.claudeStatus === 'waiting' && !c.snoozed
  const project = (
    <span className="board-card-project" title={s.cwd}>
      <SessionTagIcon tag={tag} />
      <span className="codicon codicon-folder" />
      <span className="board-card-project-name">{projectLabel(s.cwd)}</span>
      <WorktreeChip cwd={s.cwd} host={s.host} />
    </span>
  )
  return (
    <div
      className={`board-card lane-${c.lane} ${asking ? 'asking' : ''} ${active ? 'active' : ''} ${s.status === 'suspended' ? 'suspended' : ''}`}
      role="button"
      tabIndex={0}
      onClick={menu.editing ? undefined : onOpen}
      onContextMenu={menu.open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !menu.editing) onOpen()
      }}
    >
      <div className="board-card-title-line">
        {unread && (
          <span className="board-card-unread" title="Marked unread">
            <Mail size={12} strokeWidth={2.25} />
          </span>
        )}
        {c.pinned && (
          <span className="board-card-pin" title="Pinned">
            <Pin size={12} strokeWidth={2.25} />
          </span>
        )}
        {menu.editing ? (
          <input
            className="board-card-rename"
            defaultValue={s.name}
            autoFocus
            spellCheck={false}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') menu.commitRename(e.currentTarget.value)
              else if (e.key === 'Escape') {
                e.preventDefault()
                menu.cancelRename()
              }
            }}
            onBlur={(e) => menu.commitRename(e.currentTarget.value)}
          />
        ) : (
          <span className="board-card-title">{renderTitle(s.name)}</span>
        )}
        {s.schedule && (
          <span className="board-card-schedule" title={scheduleLabel(s.schedule)}>
            <AlarmClock size={13} strokeWidth={2.25} />
          </span>
        )}
        <CaptureBadges captures={captures} />
      </div>
      {status ? (
        <>
          <div className="board-card-meta">{project}</div>
          <div className="board-card-meta">
            <span className={`board-card-status ${status.cls}`}>
              <span className="board-card-status-dot" />
              {status.text}
            </span>
            <span className="board-card-time">{time}</span>
          </div>
        </>
      ) : (
        <div className="board-card-meta">
          {project}
          <span className="board-card-time">
            {s.status === 'suspended' ? 'suspended' : 'idle'}
            {time && ` · ${time}`}
          </span>
        </div>
      )}
      {asking && (
        <div className="board-card-actions">
          <button
            className="btn btn-slim btn-primary"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            Review
          </button>
          <button
            className="btn btn-slim"
            title="Snooze — drop it from Needs me until it asks again"
            onClick={(e) => {
              e.stopPropagation()
              onLater()
            }}
          >
            Later
          </button>
        </div>
      )}
      {menu.node}
    </div>
  )
}

function BoardColumn({
  col,
  filter,
  searching,
  activeSid,
  capturesFor,
  sessionTag,
  onSelectSession,
  onNewSessionOnHost,
  onDisconnectRemote,
  onReconnectRemote,
  onDeleteSession
}: {
  col: Column
  filter: Filter
  searching: boolean
  activeSid: string | null
  capturesFor: (sid: string) => Capture[]
  sessionTag: Record<string, string>
  onDeleteSession: (sid: string) => void
} & Pick<Props, 'onSelectSession' | 'onNewSessionOnHost' | 'onDisconnectRemote' | 'onReconnectRemote'>) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [showAllIdle, setShowAllIdle] = useState(false)
  const snooze = useSnoozeStore((s) => s.snooze)
  const offline = col.state === 'offline'
  const total = col.counts.needs + col.counts.running + col.counts.scheduled + col.counts.idle

  const activeCards = col.cards.filter((c) => c.lane !== 'idle')
  const idleCards = col.cards.filter((c) => c.lane === 'idle')
  const defaultIdle = Math.max(MIN_IDLE, CARD_CAP - activeCards.length)
  const idleLimit = searching || showAllIdle ? Infinity : defaultIdle
  const shownIdle = idleCards.slice(0, idleLimit)
  const hiddenIdle = idleCards.length - shownIdle.length

  const openMenu = (e: MouseEvent) => {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 2 })
  }
  const items: MenuItem[] = [
    { label: 'New session here', enabled: col.state === 'connected', run: () => onNewSessionOnHost(col.host) }
  ]
  if (col.host) {
    const host = col.host
    items.push({ separator: true })
    if (offline) {
      items.push({ label: 'Reconnect', run: () => onReconnectRemote(host) })
      items.push({ label: 'Forget host', run: () => onDisconnectRemote(host) })
    } else {
      items.push({ label: 'Disconnect', run: () => onDisconnectRemote(host) })
    }
  }

  const emptyText =
    total === 0 ? 'No sessions yet' : filter === 'needs' ? 'Nothing needs you here' : searching ? 'No matches' : 'Nothing active'

  return (
    <section className={`board-column ${col.state}`}>
      <header className="board-column-head">
        <span className={`codicon ${col.host ? 'codicon-server' : 'codicon-device-desktop'} board-column-icon`} />
        <span className="board-column-name" title={col.host ?? 'This machine'}>
          {col.label}
        </span>
        <span
          className="board-column-dot"
          title={offline ? 'Disconnected' : col.state === 'reconnecting' ? 'Reconnecting…' : 'Connected'}
        />
        <span className="board-column-count">{total}</span>
        <button className="icon-button board-column-menu" title="Host actions" onClick={openMenu}>
          <Ellipsis size={15} />
        </button>
      </header>
      <div className="board-column-summary">
        {offline ? 'offline' : col.state === 'reconnecting' ? 'reconnecting…' : countsLabel(col.counts)}
      </div>
      <div className="board-column-cards">
        {[...activeCards, ...shownIdle].map((c) => (
          <BoardCard
            key={c.s.id}
            c={c}
            captures={capturesFor(c.s.id)}
            tag={sessionTag[c.s.id]}
            active={c.s.id === activeSid}
            onOpen={() => onSelectSession(c.s.id)}
            onLater={() => snooze(c.s.id)}
            onDelete={() => onDeleteSession(c.s.id)}
          />
        ))}
        {col.cards.length === 0 && !offline && <div className="board-column-empty">{emptyText}</div>}
        {hiddenIdle > 0 && (
          <button className="board-more" onClick={() => setShowAllIdle(true)}>
            Show {hiddenIdle} more idle
          </button>
        )}
        {showAllIdle && !searching && idleCards.length > defaultIdle && (
          <button className="board-more" onClick={() => setShowAllIdle(false)}>
            Show less
          </button>
        )}
        {offline && col.host ? (
          <button className="btn board-column-reconnect" onClick={() => onReconnectRemote(col.host!)}>
            Reconnect host
          </button>
        ) : (
          <button
            className="board-column-new"
            disabled={col.state !== 'connected'}
            onClick={() => onNewSessionOnHost(col.host)}
          >
            + New session on {col.label}
          </button>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </section>
  )
}

export function SessionsBoard({
  sessions,
  remoteHosts,
  engineStatus,
  activeSid,
  onSelectSession,
  onNewSessionOnHost,
  onOpenSsh,
  onDisconnectRemote,
  onReconnectRemote,
  onDeleteSession,
  onClose
}: Props) {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const capturesBySid = useCaptureStore((s) => s.capturesBySid)
  const sessionTag = useViewPrefsStore((s) => s.sessionTag)
  const tags = useTagsStore((s) => s.tags)
  const pinnedSessions = useViewPrefsStore((s) => s.pinnedSessions)
  const pinnedMeta = useViewPrefsStore((s) => s.pinnedMeta)
  const togglePin = useViewPrefsStore((s) => s.togglePin)
  const snoozed = useSnoozeStore((s) => s.snoozed)
  const keepSnoozed = useSnoozeStore((s) => s.keepOnly)
  const filter = useBoardStore((s) => s.filter)
  const query = useBoardStore((s) => s.query)
  const setQuery = useBoardStore((s) => s.setQuery)

  const NO_CAPTURES: Capture[] = []
  const capturesFor = (sid: string): Capture[] => capturesBySid[sid] ?? NO_CAPTURES

  // A slow tick so relative times age while the board stays open.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Worktree chips are probed once per folder; re-probe on a slow interval so
  // an agent switching branch shows up (the sidebar does the same).
  const refreshGitInfo = useGitInfoStore((s) => s.refreshAll)
  useEffect(() => {
    const t = setInterval(refreshGitInfo, 60_000)
    return () => clearInterval(t)
  }, [refreshGitInfo])

  // A snooze only covers the prompt it was given for.
  useEffect(() => {
    keepSnoozed(new Set(sessions.filter((s) => s.claudeStatus === 'waiting').map((s) => s.id)))
  }, [sessions, keepSnoozed])

  // Escape clears the search first, then closes the board. Skipped while a
  // dialog or menu owns the keyboard (it handles its own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.context-menu-host, .modal-overlay')) return
      if (query) setQuery('')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, setQuery, onClose])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  const { columns, pins, offlinePins, pinTotal } = useMemo(() => {
    const matches = (s: SessionMeta): boolean =>
      !searching ||
      [s.name, s.cwd, hostLabel(s.host)].some((t) => t.toLowerCase().includes(q)) ||
      (capturesBySid[s.id] ?? []).some((c) => c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)) ||
      // Tags are icon-only on a card, so searching by name is how to pull up
      // everything wearing one.
      (tags.find((t) => t.id === sessionTag[s.id])?.name.trim().toLowerCase().includes(q) ?? false)
    const passes = (c: Card): boolean =>
      filter === 'all' || (filter === 'needs' ? c.lane === 'needs' && !c.snoozed : c.lane !== 'idle')

    const totals: Record<Lane, number> = { needs: 0, running: 0, scheduled: 0, idle: 0 }
    const pins: Card[] = []
    const hosts: (string | null)[] = [
      null,
      ...[...remoteHosts].sort((a, b) => hostLabel(a).localeCompare(hostLabel(b)))
    ]
    const columns: Column[] = hosts.map((host) => {
      const st = host ? engineStatus[`ssh:${host}`] : undefined
      const state: HostState = st === 'lost' ? 'offline' : st === 'reconnecting' ? 'reconnecting' : 'connected'
      const counts: Record<Lane, number> = { needs: 0, running: 0, scheduled: 0, idle: 0 }
      const cards: Card[] = []
      for (const s of sessions) {
        if ((s.host ?? null) !== host) continue
        const done = !!doneSessions[s.id]
        const card: Card = {
          s,
          lane: laneOf(s, done),
          done,
          doneAt: doneSessions[s.id],
          snoozed: !!snoozed[s.id],
          pinned: !!pinnedSessions[s.id]
        }
        counts[card.lane]++
        totals[card.lane]++
        if (matches(s) && passes(card)) {
          cards.push(card)
          if (card.pinned) pins.push(card)
        }
      }
      cards.sort(byUrgency)
      return { host, label: hostLabel(host), state, cards, counts }
    })
    pins.sort(byUrgency)

    // Pinned sessions on a known but disconnected host: the host pushes no
    // live list, so they're drawn from cached metadata (as in the sidebar).
    const liveIds = new Set(sessions.map((s) => s.id))
    const knownHosts = new Set(remoteHosts)
    const offlinePins: OfflinePin[] = []
    for (const [id, meta] of Object.entries(pinnedMeta)) {
      if (!pinnedSessions[id] || liveIds.has(id) || !meta.host) continue
      if (!knownHosts.has(meta.host) || engineStatus[`ssh:${meta.host}`] === 'connected') continue
      if (filter !== 'all') continue
      if (searching && ![meta.name, meta.cwd, hostLabel(meta.host)].some((t) => t.toLowerCase().includes(q))) continue
      offlinePins.push({ id, name: meta.name, host: meta.host })
    }
    const pinTotal = Object.keys(pinnedSessions).filter(
      (id) => liveIds.has(id) || (pinnedMeta[id]?.host && knownHosts.has(pinnedMeta[id].host!))
    ).length
    return { columns, pins, offlinePins, pinTotal }
  }, [
    sessions,
    remoteHosts,
    engineStatus,
    doneSessions,
    snoozed,
    capturesBySid,
    sessionTag,
    tags,
    pinnedSessions,
    pinnedMeta,
    filter,
    q,
    searching
  ])

  return (
    <div className="sessions-board">
      {pinTotal > 0 && (
        <PinnedStrip
          cards={pins}
          offline={offlinePins}
          total={pinTotal}
          activeSid={activeSid}
          onSelectSession={onSelectSession}
          onReconnectRemote={onReconnectRemote}
          onTogglePin={togglePin}
          onDeleteSession={onDeleteSession}
        />
      )}
      <div className="board-columns">
        {columns.map((col) => (
          <BoardColumn
            key={col.host ?? 'local'}
            col={col}
            filter={filter}
            searching={searching}
            activeSid={activeSid}
            capturesFor={capturesFor}
            sessionTag={sessionTag}
            onSelectSession={onSelectSession}
            onNewSessionOnHost={onNewSessionOnHost}
            onDisconnectRemote={onDisconnectRemote}
            onReconnectRemote={onReconnectRemote}
            onDeleteSession={onDeleteSession}
          />
        ))}
        <button className="board-connect" onClick={onOpenSsh}>
          <span className="codicon codicon-add" />
          Connect host…
        </button>
      </div>
    </div>
  )
}
