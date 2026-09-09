import { useMemo } from 'react'
import type { SessionMeta } from '../../../shared/acp'
import { hostLoadMeta, hostLoads, hostStateLabel, type HostLoad } from '../host-load'
import { projectLabel, relTime, sessionActivity } from '../session-format'

// The sidebar's "Hosts" tab: one card per connectable host, showing whether an
// agent is already working there so the next task can go somewhere quiet.
// "Busy" here means agents, not the machine — a host is busy while any of its
// sessions is mid-turn — which is the question being answered ("where can I
// start work without queueing behind a running agent") and needs no host-side
// probing (the engine reports no CPU/load today).

// Occupied sessions listed per card before the rest collapse into a count. Two
// keeps a busy card near the height of a free one (which shows a single recent
// session); the full list is a click away in the Sessions tab.
const MAX_ACTIVE = 2

interface Props {
  sessions: SessionMeta[]
  /** Connected SSH hosts ("user@host"). */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  /** Start the New Session flow scoped to a host (null = local machine). */
  onNewSessionOnHost: (host: string | null) => void
  /** Jump to one of the sessions holding a host busy. */
  onSelectSession: (sid: string) => void
  /** Open the SSH connect dialog to add a host. */
  onOpenSsh: () => void
  onDisconnectRemote: (host: string) => void
  onReconnectRemote: (host: string) => void
}

/** One session line on a card: coloured dot, name, project, and — for a past
 *  session — how long ago it was active. */
function SessionLine({
  s,
  onSelect
}: {
  s: SessionMeta
  onSelect: () => void
}) {
  const working = s.claudeStatus === 'working'
  const waiting = s.claudeStatus === 'waiting'
  // Only the recent line is timed. On an active line the state is the point,
  // and a timestamp there would compete with it.
  const when = working || waiting ? '' : relTime(sessionActivity(s))
  const state = working ? 'working' : waiting ? 'waiting on you' : `last active ${when || 'unknown'}`
  return (
    <button
      className="host-card-session"
      title={`${s.name} — ${state}\n${s.cwd}\nClick to open it`}
      onClick={onSelect}
    >
      <span className={`host-session-dot ${working ? 'working' : waiting ? 'waiting' : 'idle'}`} />
      <span className="host-session-name">{s.name}</span>
      <span className="host-session-project">{projectLabel(s.cwd)}</span>
      {when && <span className="host-session-time">{when}</span>}
    </button>
  )
}

/** What the card says about the host's sessions. A busy host lists what's
 *  holding it; a free one has nothing current to show, so it names the session
 *  it was last used for instead — enough to recognise the box, and a way back
 *  into that work. */
function HostSessions({
  h,
  onSelectSession
}: {
  h: HostLoad
  onSelectSession: (sid: string) => void
}) {
  if (h.active.length > 0) {
    const shown = h.active.slice(0, MAX_ACTIVE)
    const hidden = h.active.length - shown.length
    return (
      <div className="host-card-sessions">
        {shown.map((s) => (
          <SessionLine key={s.id} s={s} onSelect={() => onSelectSession(s.id)} />
        ))}
        {hidden > 0 && <div className="host-card-sessions-more">+{hidden} more</div>}
      </div>
    )
  }
  if (!h.recent) return null
  return (
    <div className="host-card-sessions">
      <SessionLine s={h.recent} onSelect={() => onSelectSession(h.recent!.id)} />
    </div>
  )
}

function HostCard({
  h,
  onNewSessionOnHost,
  onSelectSession,
  onDisconnectRemote,
  onReconnectRemote
}: {
  h: HostLoad
} & Pick<Props, 'onNewSessionOnHost' | 'onSelectSession' | 'onDisconnectRemote' | 'onReconnectRemote'>) {
  const offline = h.state === 'offline'
  return (
    <div className={`host-card ${h.state}`}>
      <div className="host-card-head">
        <span
          className={`codicon ${h.host ? 'codicon-server' : 'codicon-device-desktop'} host-card-icon`}
        />
        {/* The hostname is the comparison key, so it takes the width; the full
            "user@host" stays in the tooltip. */}
        <span className="host-card-name" title={h.host ?? 'This machine'}>
          {h.label}
        </span>
        <span className="host-card-state">{hostStateLabel(h)}</span>
        <span className="host-card-dot" />
      </div>
      <div className="host-card-meta">{hostLoadMeta(h)}</div>
      {!offline && <HostSessions h={h} onSelectSession={onSelectSession} />}
      <div className="host-card-actions">
        {offline && h.host ? (
          <>
            <button className="btn btn-slim" onClick={() => onReconnectRemote(h.host!)}>
              Reconnect
            </button>
            <button className="btn btn-slim" onClick={() => onDisconnectRemote(h.host!)}>
              Forget
            </button>
          </>
        ) : (
          <>
            {/* Primary on a free host: this card is the answer to "where should
                this task go", so taking it should be the obvious next click. */}
            <button
              className={`btn btn-slim ${h.state === 'free' ? 'btn-primary' : ''}`}
              disabled={h.state === 'reconnecting'}
              onClick={() => onNewSessionOnHost(h.host)}
            >
              New session
            </button>
            {h.host && (
              <button className="btn btn-slim" onClick={() => onDisconnectRemote(h.host!)}>
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function HostsPanel({
  sessions,
  remoteHosts,
  engineStatus,
  onNewSessionOnHost,
  onSelectSession,
  onOpenSsh,
  onDisconnectRemote,
  onReconnectRemote
}: Props) {
  const loads = useMemo(
    () => hostLoads(sessions, remoteHosts, engineStatus),
    [sessions, remoteHosts, engineStatus]
  )
  return (
    <div className="hosts-panel">
      {loads.map((h) => (
        <HostCard
          key={h.host ?? 'local'}
          h={h}
          onNewSessionOnHost={onNewSessionOnHost}
          onSelectSession={onSelectSession}
          onDisconnectRemote={onDisconnectRemote}
          onReconnectRemote={onReconnectRemote}
        />
      ))}
      {/* Only the local machine so far: there's no placement decision to make
          until a second host exists, so the tab's job is to offer one. */}
      {remoteHosts.length === 0 && (
        <div className="hosts-panel-hint">
          Connect a remote host to spread work across machines.
        </div>
      )}
      <button className="btn btn-slim btn-with-icon hosts-panel-connect" onClick={onOpenSsh}>
        <span className="codicon codicon-add" />
        Connect host…
      </button>
    </div>
  )
}
