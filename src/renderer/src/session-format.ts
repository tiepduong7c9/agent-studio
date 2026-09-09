import type { SessionMeta, SessionSchedule } from '../../shared/acp'
import { normRoot } from './workspace'

// Shared display helpers for sessions, used by the sessions list, the session
// switcher, and the remote-hosts dialog so their labels can't drift.

/** Last-activity timestamp (ms) for recency sorting. */
export const sessionActivity = (s: SessionMeta): number =>
  Date.parse(s.lastAttachedAt || s.createdAt)

/** Project display name — the folder basename of a cwd. */
export const projectLabel = (cwd: string): string => normRoot(cwd).split('/').pop() || cwd

/** Host display name — the hostname for a remote, "local" for the local machine.
 *  (A friendlier per-machine name is deferred backend work — see spec §10.3.) */
export const hostLabel = (host?: string | null): string =>
  host ? host.slice(host.lastIndexOf('@') + 1) : 'local'

/** "in 5m" / "in 3h" / "now" for a future timestamp; empty when there isn't one. */
const untilLabel = (at?: number): string => {
  if (!at) return ''
  const m = Math.round((at - Date.now()) / 60000)
  if (m <= 0) return 'now'
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`
}

/** Tooltip for the "wakes itself later" marker: what a session has armed and,
 *  where known, when it next fires. Both parts are listed when a session has a
 *  loop AND crons, since they wake it for different reasons. */
export const scheduleLabel = (schedule: SessionSchedule): string => {
  const parts: string[] = []
  if (schedule.loop) {
    const when = untilLabel(schedule.loop.at)
    parts.push(
      `Looping${when ? ` — next check ${when}` : ''}${schedule.loop.reason ? `: ${schedule.loop.reason}` : ''}`
    )
  }
  for (const cron of schedule.crons) {
    const when = cron.recurring ? cron.schedule : untilLabel(cron.at) || cron.schedule
    parts.push(`${cron.recurring ? 'Scheduled' : 'Reminder'} ${when}${cron.prompt ? `: ${cron.prompt}` : ''}`)
  }
  return parts.join('\n')
}
