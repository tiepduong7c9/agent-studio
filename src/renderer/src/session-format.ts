import type { SessionMeta } from '../../shared/acp'
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
