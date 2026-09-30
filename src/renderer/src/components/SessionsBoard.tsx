import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import { AlarmClock, Ellipsis } from 'lucide-react'
import { create } from 'zustand'
import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { useCaptureStore, type Capture } from '../capture-store'
import { hostLabel, projectLabel, relTime, scheduleLabel, sessionActivity } from '../session-format'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { useTagsStore } from '../tags-store'
import { useViewPrefsStore } from '../view-prefs-store'
import { CaptureBadges, renderTitle, SessionTagIcon } from './SessionsPanel'
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

/** What a card is doing, from most to least urgent. Every session is exactly one. */
type Lane = 'needs' | 'running' | 'scheduled' | 'idle'
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

interface Props {
  sessions: SessionMeta[]
  /** Connected SSH hosts ("user@host"). */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  activeSid: string | null
  /** Open a session's chat (the board closes itself). */
  onSelectSession: (sid: string) => void
  onNewSessionFlow: () => void
  /** Start the New Session flow scoped to a host (null = local machine). */
  onNewSessionOnHost: (host: string | null) => void
  onOpenSsh: () => void
  onDisconnectRemote: (host: string) => void
  onReconnectRemote: (host: string) => void
  onClose: () => void
}

interface Card {
  s: SessionMeta
  lane: Lane
  /** Finished a turn while unwatched (the sidebar's "done"). */
  done: boolean
  doneAt?: number
  snoozed: boolean
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

function laneOf(s: SessionMeta, done: boolean): Lane {
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

function BoardCard({
  c,
  captures,
  tag,
  active,
  onOpen,
  onLater
}: {
  c: Card
  captures: Capture[]
  /** The session's tag id, if any — drawn as the sidebar's coloured icon. */
  tag?: string
  active: boolean
  onOpen: () => void
  onLater: () => void
}) {
  const { s } = c
  const status = cardStatus(c)
  const time = relTime(c.done && c.doneAt ? c.doneAt : sessionActivity(s))
  const asking = s.claudeStatus === 'waiting' && !c.snoozed
  const project = (
    <span className="board-card-project" title={s.cwd}>
      <SessionTagIcon tag={tag} />
      <span className="codicon codicon-folder" />
      <span className="board-card-project-name">{projectLabel(s.cwd)}</span>
    </span>
  )
  return (
    <div
      className={`board-card lane-${c.lane} ${asking ? 'asking' : ''} ${active ? 'active' : ''} ${s.status === 'suspended' ? 'suspended' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="board-card-title-line">
        <span className="board-card-title">{renderTitle(s.name)}</span>
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
  onReconnectRemote
}: {
  col: Column
  filter: Filter
  searching: boolean
  activeSid: string | null
  capturesFor: (sid: string) => Capture[]
  sessionTag: Record<string, string>
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
  onNewSessionFlow,
  onNewSessionOnHost,
  onOpenSsh,
  onDisconnectRemote,
  onReconnectRemote,
  onClose
}: Props) {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const capturesBySid = useCaptureStore((s) => s.capturesBySid)
  const sessionTag = useViewPrefsStore((s) => s.sessionTag)
  const tags = useTagsStore((s) => s.tags)
  const snoozed = useSnoozeStore((s) => s.snoozed)
  const keepSnoozed = useSnoozeStore((s) => s.keepOnly)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const NO_CAPTURES: Capture[] = []
  const capturesFor = (sid: string): Capture[] => capturesBySid[sid] ?? NO_CAPTURES

  // A slow tick so relative times age while the board stays open.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

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
  }, [query, onClose])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  const { columns, totals } = useMemo(() => {
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
        const card: Card = { s, lane: laneOf(s, done), done, doneAt: doneSessions[s.id], snoozed: !!snoozed[s.id] }
        counts[card.lane]++
        totals[card.lane]++
        if (matches(s) && passes(card)) cards.push(card)
      }
      // Urgent first; a snoozed prompt sinks below the ones still asking.
      // Within a lane, most recent activity first.
      cards.sort(
        (a, b) =>
          LANE_RANK[a.lane] - LANE_RANK[b.lane] ||
          Number(a.snoozed) - Number(b.snoozed) ||
          sessionActivity(b.s) - sessionActivity(a.s)
      )
      return { host, label: hostLabel(host), state, cards, counts }
    })
    return { columns, totals }
  }, [sessions, remoteHosts, engineStatus, doneSessions, snoozed, capturesBySid, sessionTag, tags, filter, q, searching])

  const summary: { lane: Lane; text: string }[] = [
    { lane: 'running', text: `${totals.running} running` },
    { lane: 'needs', text: `${totals.needs} needs you` },
    { lane: 'scheduled', text: `${totals.scheduled} scheduled` },
    { lane: 'idle', text: `${totals.idle} idle` }
  ]

  return (
    <div className="sessions-board">
      <div className="board-toolbar">
        <span className="board-title">Sessions</span>
        <span className="board-summary">
          {summary.map((p) => (
            <span key={p.lane} className={`board-summary-item lane-${p.lane}`}>
              <span className="board-summary-dot" />
              {p.text}
            </span>
          ))}
        </span>
        <span className="topbar-spacer" />
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
            </button>
          ))}
        </div>
        <div className="sessions-search board-search">
          <span className="codicon codicon-search sessions-search-icon" />
          <input
            className="sessions-search-input"
            type="text"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
        <button className="btn btn-primary board-new" onClick={onNewSessionFlow}>
          New session
        </button>
        <button className="icon-button codicon codicon-close board-close" title="Close board (Esc)" onClick={onClose} />
      </div>
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
