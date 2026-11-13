import { useEffect, useMemo, useRef, useState } from 'react'
import { Building2, SquareKanban } from 'lucide-react'
import type { SessionMeta } from '../../../shared/acp'
import { useSessionsStore } from '../acp/sessions-store'
import { GENERIC_CHARACTER, useCharactersStore } from '../characters-store'
import type { ActorState, Office, OfficeActor } from '../office/office-scene'
import { useViewPrefsStore } from '../view-prefs-store'
import './OfficeView.css'

// The sessions board as an office floor: each session with a character gets a
// desk (in the order of the character list), and any other session that's
// running, needs you or is scheduled takes a spare desk. Idle characters relax
// in the lounge, kitchen or exec office. Clicking someone opens their session.

const STATUS: Record<ActorState, string> = {
  working: 'working',
  waiting: 'needs you',
  done: 'done — not yet viewed',
  scheduled: 'scheduled',
  idle: 'idle'
}

function stateOf(s: SessionMeta, done: boolean): ActorState {
  if (s.claudeStatus === 'waiting' || s.status === 'exited') return 'waiting'
  if (done) return 'done'
  if (s.claudeStatus === 'working') return 'working'
  if (s.schedule) return 'scheduled'
  return 'idle'
}

const URGENCY: Record<ActorState, number> = { waiting: 0, done: 1, working: 2, scheduled: 3, idle: 4 }
const clip = (t: string, n = 26): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/** Who sits where. Characters keep their desk (their order in the character
 *  list); unassigned active sessions fill the spare desks, most urgent first. */
function seatActors(
  sessions: SessionMeta[],
  done: Record<string, number>,
  characters: ReturnType<typeof useCharactersStore.getState>['characters'],
  assignments: Record<string, string>,
  deskCount: number,
  relaxCount: number
): { actors: OfficeActor[]; overflow: number } {
  const order = new Map(characters.map((c, i) => [c.id, i]))
  const withCharacter: { s: SessionMeta; rank: number }[] = []
  const others: SessionMeta[] = []
  for (const s of sessions) {
    const cid = assignments[s.id]
    if (cid !== undefined && order.has(cid)) withCharacter.push({ s, rank: order.get(cid)! })
    else if (stateOf(s, !!done[s.id]) !== 'idle') others.push(s)
  }
  withCharacter.sort((a, b) => a.rank - b.rank || a.s.id.localeCompare(b.s.id))
  others.sort((a, b) => URGENCY[stateOf(a, !!done[a.id])] - URGENCY[stateOf(b, !!done[b.id])] || a.name.localeCompare(b.name))
  const ordered = [...withCharacter.map((x) => x.s), ...others]

  let relax = 0
  const actors = ordered.slice(0, deskCount).map((s, desk): OfficeActor => {
    const c = characters.find((x) => x.id === assignments[s.id]) ?? GENERIC_CHARACTER
    const state = stateOf(s, !!done[s.id])
    const named = c.name.trim()
    return {
      sid: s.id,
      look: c.look,
      accent: c.accent,
      name: named || clip(s.name),
      role: named ? c.role.trim() : '',
      tooltip: `${s.name} — ${STATUS[state]}\nClick to open`,
      state,
      desk,
      relax: state === 'idle' && relax < relaxCount ? relax++ : null
    }
  })
  return { actors, overflow: Math.max(0, ordered.length - deskCount) }
}

export function OfficeView({ sessions, onSelectSession }: { sessions: SessionMeta[]; onSelectSession: (sid: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const officeRef = useRef<Office | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const doneSessions = useSessionsStore((s) => s.doneSessions)
  const characters = useCharactersStore((s) => s.characters)
  const assignments = useCharactersStore((s) => s.assignments)
  const openRef = useRef(onSelectSession)
  openRef.current = onSelectSession

  useEffect(() => {
    let disposed = false
    import('../office/office-scene')
      .then((m) => m.createOffice(hostRef.current!, (sid) => openRef.current(sid)))
      .then((office) => {
        if (disposed) return office.dispose()
        officeRef.current = office
        setReady(true)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      disposed = true
      officeRef.current?.dispose()
      officeRef.current = null
    }
  }, [])

  const seating = useMemo(
    () =>
      ready && officeRef.current
        ? seatActors(sessions, doneSessions, characters, assignments, officeRef.current.deskCount, officeRef.current.relaxCount)
        : null,
    [ready, sessions, doneSessions, characters, assignments]
  )
  useEffect(() => {
    if (seating) officeRef.current?.setActors(seating.actors)
  }, [seating])

  return (
    <div className="office-view">
      <div ref={hostRef} className="office-stage" />
      {!ready && !failed && (
        <div className="office-overlay">
          <span className="acp-spinner" />
        </div>
      )}
      {failed && <div className="office-overlay office-error">Couldn&apos;t open the office: {failed}</div>}
      {seating && seating.actors.length === 0 && (
        <div className="office-hint">
          The office is empty. Sessions with a character get a desk — assign one from a session&apos;s right-click
          menu (Character). Running sessions take a spare desk while they work.
        </div>
      )}
      {seating && seating.overflow > 0 && (
        <div className="office-hint corner">
          +{seating.overflow} more session{seating.overflow === 1 ? '' : 's'} than desks — see them on the Board
        </div>
      )}
    </div>
  )
}

/** Board ⇄ Office switch for the title bar. */
export function BoardViewToggle() {
  const view = useViewPrefsStore((s) => s.boardView)
  const setView = useViewPrefsStore((s) => s.setBoardView)
  return (
    <div className="board-filters board-view-toggle" role="tablist" aria-label="Sessions view">
      <button role="tab" aria-selected={view === 'board'} className={`board-filter ${view === 'board' ? 'active' : ''}`} onClick={() => setView('board')}>
        <SquareKanban size={13} /> Board
      </button>
      <button role="tab" aria-selected={view === 'office'} className={`board-filter ${view === 'office' ? 'active' : ''}`} onClick={() => setView('office')}>
        <Building2 size={13} /> Office
      </button>
    </div>
  )
}
