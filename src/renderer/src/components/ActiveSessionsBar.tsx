import { useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { hostLabel, projectLabel } from '../session-format'
import { useViewPrefsStore } from '../view-prefs-store'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { laneOf, useSnoozeStore } from './SessionsBoard'
import { renderTitle } from './SessionsPanel'
import { useSessionMenu } from './session-actions'
import './ActiveSessionsBar.css'

// A strip under the title bar in the session view: the *other* sessions that
// need you or are running, as small cards, so you can hop between them without
// opening the board. Needs-you first. Shows only while there is something to
// list, and the title bar's toggle hides it.

/** The other sessions to surface: waiting on you (minus ones snoozed on the
 *  board), then running. Kept in session-list order rather than by activity,
 *  so cards don't reshuffle each time you switch sessions. */
export function useActiveSessions(sessions: SessionMeta[], excludeSid: string | null) {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const snoozed = useSnoozeStore((s) => s.snoozed)
  const needs: SessionMeta[] = []
  const running: SessionMeta[] = []
  for (const s of sessions) {
    if (s.id === excludeSid) continue
    const lane = laneOf(s, !!doneSessions[s.id])
    if (lane === 'needs' && !snoozed[s.id]) needs.push(s)
    else if (lane === 'running') running.push(s)
  }
  return { needs, running }
}

// Fit maths, mirrored from ActiveSessionsBar.css.
const CHIP_MIN = 150
const CHIP_GAP = 6
const LABEL_W = 96 // a group label plus its gap, roughly
const SEP_W = 9 + CHIP_GAP
const MORE_W = 84 + CHIP_GAP
const CLOSE_W = 24 + CHIP_GAP
const PAD_X = 20

/** How many cards fit, needs-you first. */
function fit(width: number, needs: number, running: number): { needs: number; running: number } {
  const room = (labels: number, more: boolean) =>
    width - PAD_X - CLOSE_W - labels * LABEL_W - (labels > 1 ? SEP_W : 0) - (more ? MORE_W : 0)
  const groups = (needs ? 1 : 0) + (running ? 1 : 0)
  const all = needs + running
  if (all * (CHIP_MIN + CHIP_GAP) <= room(groups, false)) return { needs, running }
  // Overflowing: whatever doesn't fit goes behind "+N more". Recount the labels,
  // since the running group drops out entirely if needs-you fills the bar.
  let n = Math.max(1, Math.floor(room(groups, true) / (CHIP_MIN + CHIP_GAP)))
  if (n <= needs && running) n = Math.max(1, Math.floor(room(1, true) / (CHIP_MIN + CHIP_GAP)))
  const shownNeeds = Math.min(needs, n)
  return { needs: shownNeeds, running: Math.min(running, n - shownNeeds) }
}

type Lane = 'needs' | 'running'

function Card({
  s,
  lane,
  onOpen,
  onDelete
}: {
  s: SessionMeta
  lane: Lane
  onOpen: () => void
  onDelete: () => void
}) {
  const menu = useSessionMenu(s, onDelete)
  return (
    <div
      className={`active-bar-card ${lane}`}
      role="button"
      tabIndex={0}
      title={`${s.name}\n${hostLabel(s.host)} › ${projectLabel(s.cwd)} — ${lane === 'needs' ? 'needs you' : 'running'}`}
      onClick={menu.editing ? undefined : onOpen}
      onContextMenu={menu.open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !menu.editing) onOpen()
      }}
    >
      <span className={`active-bar-dot ${lane}`} />
      {menu.editing ? (
        <input
          className="active-bar-rename"
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
        <span className="active-bar-name">{menu.busy ? `${menu.busy}…` : renderTitle(s.name)}</span>
      )}
      <span className="active-bar-host">{hostLabel(s.host)}</span>
      {menu.node}
    </div>
  )
}

export function ActiveSessionsBar({
  sessions,
  currentSid,
  onSelectSession,
  onDeleteSession
}: {
  sessions: SessionMeta[]
  /** The session on screen — left out, the title bar already names it. */
  currentSid: string | null
  onSelectSession: (sid: string) => void
  onDeleteSession: (sid: string) => void
}) {
  const { needs, running } = useActiveSessions(sessions, currentSid)
  const setVisible = useViewPrefsStore((st) => st.setActiveBarVisible)
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const empty = !needs.length && !running.length

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [empty])

  if (empty) return null

  const shown = width ? fit(width, needs.length, running.length) : { needs: needs.length, running: running.length }
  const shownNeeds = needs.slice(0, shown.needs)
  const shownRunning = running.slice(0, shown.running)
  const rest: { s: SessionMeta; lane: Lane }[] = [
    ...needs.slice(shown.needs).map((s) => ({ s, lane: 'needs' as const })),
    ...running.slice(shown.running).map((s) => ({ s, lane: 'running' as const }))
  ]
  const restItems: MenuItem[] = rest.map(({ s, lane }) => ({
    label: `${s.name} — ${hostLabel(s.host)}`,
    icon: <span className={`active-bar-menu-dot ${lane}`} />,
    run: () => onSelectSession(s.id)
  }))

  const card = (s: SessionMeta, lane: Lane) => (
    <Card
      key={s.id}
      s={s}
      lane={lane}
      onOpen={() => onSelectSession(s.id)}
      onDelete={() => onDeleteSession(s.id)}
    />
  )

  return (
    <div className="active-bar" ref={ref}>
      {needs.length > 0 && (
        <>
          <span className="active-bar-label needs">
            Needs you<span className="active-bar-label-count">{needs.length}</span>
          </span>
          {shownNeeds.map((s) => card(s, 'needs'))}
        </>
      )}
      {shownRunning.length > 0 && (
        <>
          {needs.length > 0 && <span className="active-bar-sep" />}
          <span className="active-bar-label running">
            Running<span className="active-bar-label-count">{running.length}</span>
          </span>
          {shownRunning.map((s) => card(s, 'running'))}
        </>
      )}
      {rest.length > 0 && (
        <button
          className="active-bar-more"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMoreMenu({ x: r.left, y: r.bottom + 2 })
          }}
        >
          +{rest.length} more
        </button>
      )}
      <button className="active-bar-close" title="Hide active sessions bar" onClick={() => setVisible(false)}>
        <X size={14} strokeWidth={2} />
      </button>
      {moreMenu && (
        <ContextMenu x={moreMenu.x} y={moreMenu.y} items={restItems} onClose={() => setMoreMenu(null)} />
      )}
    </div>
  )
}
