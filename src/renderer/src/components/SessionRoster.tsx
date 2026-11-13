import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { useSessionCharacter } from '../characters-store'
import { hostLabel, projectLabel } from '../session-format'
import { useViewPrefsStore } from '../view-prefs-store'
import { laneOf, useSnoozeStore } from './SessionsBoard'
import { CharacterAvatar, type AvatarMotion } from './CharacterAvatar'
import { renderTitle } from './SessionsPanel'
import { useSessionMenu } from './session-actions'
import './SessionRoster.css'

// A roster down the right of the session view: every session that needs you
// or is running, by face, so you can see who's busy and hop between them
// without opening the board. Needs-you first. The session on screen is
// included and highlighted. The title bar's toggle hides it.

/** Sessions to surface: waiting on you (minus ones snoozed on the board), then
 *  running. Kept in session-list order rather than by activity, so rows don't
 *  reshuffle each time you switch sessions. */
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

function statusOf(s: SessionMeta, done: boolean): { cls: string; text: string; motion: AvatarMotion } {
  if (s.claudeStatus === 'waiting') return { cls: 'needs', text: 'Needs your approval', motion: 'alert' }
  if (s.status === 'exited') return { cls: 'needs', text: 'Exited', motion: 'alert' }
  if (done) return { cls: 'done', text: 'Done · not viewed', motion: 'done' }
  return { cls: 'running', text: 'Running', motion: 'busy' }
}

function Row({ s, current, onOpen, onDelete }: { s: SessionMeta; current: boolean; onOpen: () => void; onDelete: () => void }) {
  const character = useSessionCharacter(s.id)
  const done = useSessionsStore((st) => !!st.doneSessions[s.id])
  const menu = useSessionMenu(s, onDelete)
  const status = statusOf(s, done)
  const named = character.name.trim()
  return (
    <div
      className={`roster-row ${current ? 'current' : ''}`}
      role="button"
      tabIndex={0}
      title={`${named ? `${named} — ` : ''}${s.name}\n${hostLabel(s.host)} › ${projectLabel(s.cwd)}`}
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
  sessions,
  currentSid,
  onSelectSession,
  onDeleteSession
}: {
  sessions: SessionMeta[]
  currentSid: string | null
  onSelectSession: (sid: string) => void
  onDeleteSession: (sid: string) => void
}) {
  const { needs, running } = useActiveSessions(sessions, null)
  const setVisible = useViewPrefsStore((st) => st.setActiveBarVisible)
  const row = (s: SessionMeta) => (
    <Row key={s.id} s={s} current={s.id === currentSid} onOpen={() => onSelectSession(s.id)} onDelete={() => onDeleteSession(s.id)} />
  )
  return (
    <aside className="session-roster">
      <div className="roster-header">
        <span className="roster-title">Active</span>
        <button className="icon-button codicon codicon-close" title="Hide (title bar button brings it back)" onClick={() => setVisible(false)} />
      </div>
      <div className="roster-list">
        {needs.length > 0 && (
          <>
            <div className="roster-group needs">
              Needs you <span className="roster-count">{needs.length}</span>
            </div>
            {needs.map(row)}
          </>
        )}
        {running.length > 0 && (
          <>
            <div className="roster-group running">
              Running <span className="roster-count">{running.length}</span>
            </div>
            {running.map(row)}
          </>
        )}
        {!needs.length && !running.length && <div className="roster-empty">Nothing running or waiting on you.</div>}
      </div>
    </aside>
  )
}
