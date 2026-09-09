import type { SessionMeta } from '../../shared/acp'
import { hostLabel, sessionActivity } from './session-format'

// How occupied each connected host is, derived from the live session list the
// sidebar already has. "Busy" here means agents, not the machine: a host is
// busy while any of its sessions is mid-turn, free when none is. That's the
// question being answered — "where can I start a task without queueing behind
// a working agent" — and it needs no host-side probing (the engine reports no
// CPU/load today).

export type HostState = 'free' | 'busy' | 'reconnecting' | 'offline'

export interface HostLoad {
  /** "user@host", or null for the local machine. */
  host: string | null
  /** Display name — the hostname, or "local". */
  label: string
  /** Sessions mid-turn: the occupancy signal. */
  working: number
  /** Sessions blocked on you (question / permission). Not machine load, but it
   *  explains a host that looks quiet while its work isn't finished. */
  waiting: number
  /** Live (non-exited) sessions, whatever they're doing. */
  live: number
  /** The sessions accounting for `working` + `waiting`, working first then by
   *  name — what the host is actually occupied with, so a busy row can say who
   *  is holding it rather than only that someone is. */
  active: SessionMeta[]
  /** The host's most recently active live session, whatever it's doing. What a
   *  free card shows in place of `active`: with no current work to list, the
   *  useful thing is what the host was last used for — and a way back into it.
   *  Null when the host has no live sessions at all. */
  recent: SessionMeta | null
  state: HostState
}

/** Occupancy per connectable host: local first, then remotes by display name.
 *  Mirrors the New Session target list, so every row is somewhere a session can
 *  actually be started. */
export function hostLoads(
  sessions: SessionMeta[],
  remoteHosts: string[],
  engineStatus: Record<string, string>
): HostLoad[] {
  const hosts: (string | null)[] = [
    null,
    ...[...remoteHosts].sort((a, b) => hostLabel(a).localeCompare(hostLabel(b)))
  ]
  return hosts.map((host) => {
    let working = 0
    let waiting = 0
    let live = 0
    const active: SessionMeta[] = []
    let recent: SessionMeta | null = null
    for (const s of sessions) {
      if ((s.host ?? null) !== host || s.status === 'exited') continue
      live++
      if (!recent || sessionActivity(s) > sessionActivity(recent)) recent = s
      if (s.claudeStatus === 'working') working++
      else if (s.claudeStatus === 'waiting') waiting++
      else continue
      active.push(s)
    }
    active.sort(
      (a, b) =>
        (a.claudeStatus === 'working' ? 0 : 1) - (b.claudeStatus === 'working' ? 0 : 1) ||
        a.name.localeCompare(b.name)
    )
    // Transport health outranks occupancy: an unreachable host's last-known
    // session list is stale, so it's neither free nor busy — it's unusable.
    const st = host ? engineStatus[`ssh:${host}`] : undefined
    const state: HostState =
      st === 'lost'
        ? 'offline'
        : st === 'reconnecting'
          ? 'reconnecting'
          : working > 0
            ? 'busy'
            : 'free'
    return { host, label: hostLabel(host), working, waiting, live, active, recent, state }
  })
}

/** The state pill's text. Just the verdict — the counts behind it live on the
 *  meta line below, so the two don't repeat each other. */
export function hostStateLabel(h: HostLoad): string {
  return h.state === 'reconnecting' ? 'connecting' : h.state
}

/** Occupancy breakdown for the card's second line. Reads left-to-right from
 *  most to least urgent, and always ends with the session total so a "free"
 *  host that isn't empty says so. */
export function hostLoadMeta(h: HostLoad): string {
  if (h.state === 'offline') return 'disconnected — click Reconnect to use it'
  if (h.state === 'reconnecting') return 'reconnecting…'
  const parts: string[] = []
  if (h.working > 0) parts.push(`${h.working} working`)
  if (h.waiting > 0) parts.push(`${h.waiting} waiting on you`)
  parts.push(h.live === 0 ? 'no sessions' : `${h.live} session${h.live === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
