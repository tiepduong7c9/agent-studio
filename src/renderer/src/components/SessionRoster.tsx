import { Building2, ChevronRight } from 'lucide-react'
import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { useSessionCharacter } from '../characters-store'
import { hostLabel, projectLabel, relTime, scheduleLabel, scheduleShort, sessionActivity } from '../session-format'
import { laneOf, useSnoozeStore } from './SessionsBoard'
import { CharacterAvatar, type AvatarMotion } from './CharacterAvatar'
import { renderTitle } from './SessionsPanel'
import { useSessionMenu } from './session-actions'
import './SessionRoster.css'

// A roster down the right of the session view: every session that needs you
// or is running (or has a loop / scheduled job armed), by face, so you can see who's busy and hop between them
// without opening the board, then the most recently used of the rest. The
// session on screen is included and highlighted. The title bar's toggle
// hides it.

/** How many recently used sessions to list below the active ones. */
const RECENT_LIMIT = 12

/** Sessions to surface: waiting on you (minus ones snoozed on the board), then
 *  running. Kept in session-list order rather than by activity, so rows don't
 *  reshuffle each time you switch sessions. */
export function useActiveSessions(sessions: SessionMeta[], excludeSid: string | null) {
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const snoozed = useSnoozeStore((s) => s.snoozed)
  const needs: SessionMeta[] = []
  const running: SessionMeta[] = []
  const scheduled: SessionMeta[] = []
  for (const s of sessions) {
    if (s.id === excludeSid) continue
    const lane = laneOf(s, !!doneSessions[s.id])
    if (lane === 'needs' && !snoozed[s.id]) needs.push(s)
    else if (lane === 'running') running.push(s)
    else if (lane === 'scheduled') scheduled.push(s)
  }
  return { needs, running, scheduled }
}

function statusOf(s: SessionMeta, done: boolean, active: boolean): { cls: string; text: string; motion?: AvatarMotion } {
  // Recent (inactive) rows: when they were last used, and a still portrait.
  if (!active) {
    const when = relTime(sessionActivity(s))
    return { cls: 'idle', text: `${s.status === 'suspended' ? 'Suspended' : 'Idle'}${when ? ` · ${when}` : ''}` }
  }
  if (s.claudeStatus === 'waiting') return { cls: 'needs', text: 'Needs your approval', motion: 'alert' }
  if (s.status === 'exited') return { cls: 'needs', text: 'Exited', motion: 'alert' }
  if (done) return { cls: 'done', text: 'Done · not viewed', motion: 'done' }
  if (s.claudeStatus !== 'working' && s.schedule) return { cls: 'scheduled', text: scheduleShort(s.schedule), motion: 'idle' }
  return { cls: 'running', text: 'Running', motion: 'busy' }
}

function Row({
  s,
  current,
  active,
  onOpen,
  onDelete
}: {
  s: SessionMeta
  current: boolean
  /** Needs you, running or scheduled (animated); otherwise a recent session. */
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const character = useSessionCharacter(s.id)
  const done = useSessionsStore((st) => !!st.doneSessions[s.id])
  const menu = useSessionMenu(s, onDelete)
  const status = statusOf(s, done, active)
  const named = character.name.trim()
  return (
    <div
      className={`roster-row ${current ? 'current' : ''}`}
      role="button"
      tabIndex={0}
      title={`${named ? `${named} — ` : ''}${s.name}\n${hostLabel(s.host)} › ${projectLabel(s.cwd)}${
        s.schedule ? `\n${scheduleLabel(s.schedule)}` : ''
      }`}
      onClick={menu.editing ? undefined : onOpen}
      onContextMenu={menu.open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !menu.editing) onOpen()
      }}
    >
      <span className="roster-avatar">
        <CharacterAvatar character={character} size={36} title="" motion={status.motion} />
        <span className={`roster-dot ${status.cls}`} />
      </span>
      <span className="roster-text">
        {menu.editing ? (
          <input
            className="roster-rename"
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
          <span className="roster-name">{named || renderTitle(s.name)}</span>
        )}
        {named && <span className="roster-sub">{renderTitle(s.name)}</span>}
        <span className={`roster-status ${status.cls}`}>{menu.busy ? `${menu.busy}…` : status.text}</span>
      </span>
      {menu.node}
    </div>
  )
}

export function SessionRoster({
  width,
  sessions,
  currentSid,
  onSelectSession,
  onDeleteSession,
  onOpenOffice
}: {
  width: number
  sessions: SessionMeta[]
  currentSid: string | null
  onSelectSession: (sid: string) => void
  onDeleteSession: (sid: string) => void
  /** Open the sessions board in its office view. */
  onOpenOffice: () => void
}) {
  const { needs, running, scheduled } = useActiveSessions(sessions, null)
  const shown = new Set([...needs, ...running, ...scheduled].map((s) => s.id))
  const recent = sessions
    .filter((s) => !shown.has(s.id))
    .sort((a, b) => sessionActivity(b) - sessionActivity(a))
    .slice(0, RECENT_LIMIT)
  const row = (s: SessionMeta, active: boolean) => (
    <Row
      key={s.id}
      s={s}
      current={s.id === currentSid}
      active={active}
      onOpen={() => onSelectSession(s.id)}
      onDelete={() => onDeleteSession(s.id)}
    />
  )
  return (
    <aside className="session-roster" style={{ width }}>
      <div className="roster-header">
        <span className="roster-title">Active</span>
      </div>
      <div className="roster-list">
        <button className="roster-office" onClick={onOpenOffice}>
          <span className="roster-office-icon">
            <Building2 size={18} />
          </span>
          <span className="roster-text">
            <span className="roster-name">Open the office</span>
            <span className="roster-sub">See everyone at their desks</span>
          </span>
          <ChevronRight size={15} className="roster-office-chevron" />
        </button>
        {needs.length > 0 && (
          <>
            <div className="roster-group needs">
              Needs you <span className="roster-count">{needs.length}</span>
            </div>
            {needs.map((s) => row(s, true))}
          </>
        )}
        {running.length > 0 && (
          <>
            <div className="roster-group running">
              Running <span className="roster-count">{running.length}</span>
            </div>
            {running.map((s) => row(s, true))}
          </>
        )}
        {scheduled.length > 0 && (
          <>
            <div className="roster-group scheduled">
              Scheduled <span className="roster-count">{scheduled.length}</span>
            </div>
            {scheduled.map((s) => row(s, true))}
          </>
        )}
        {!needs.length && !running.length && !scheduled.length && <div className="roster-empty">Nothing running or waiting on you.</div>}
        {recent.length > 0 && (
          <>
            <div className="roster-group recent">Recent</div>
            {recent.map((s) => row(s, false))}
          </>
        )}
      </div>
    </aside>
  )
}
