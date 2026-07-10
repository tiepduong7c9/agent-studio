import type { SessionMeta } from '../../shared/acp'
import type { ProjectInfo } from '../../shared/types'

// Session ↔ workspace matching, shared by the sessions list and App so the two
// can't drift. A session belongs to a workspace when they're on the same host
// and the session's cwd is at or below the workspace root.

export function sessionInWorkspace(s: SessionMeta, ws: ProjectInfo): boolean {
  const hostMatch = (ws.host ?? null) === (s.host ?? null)
  const root = ws.rootPath.replace(/\/+$/, '')
  const cwdUnder = s.cwd === ws.rootPath || s.cwd === root || s.cwd.startsWith(root + '/')
  return hostMatch && cwdUnder
}

/** The most specific open workspace a session belongs to, or null. */
export function workspaceForSession(s: SessionMeta, workspaces: ProjectInfo[]): ProjectInfo | null {
  let best: ProjectInfo | null = null
  for (const ws of workspaces) {
    if (sessionInWorkspace(s, ws) && (!best || ws.rootPath.length > best.rootPath.length)) best = ws
  }
  return best
}

/** The engine/host key a session runs under (mirrors shared engineHostKey). */
export function hostKeyForSession(s: SessionMeta): string {
  return s.host ? `ssh:${s.host}` : 'local'
}

/** Strip trailing slashes from a path (root stays "/"). */
export const normRoot = (p: string): string => p.replace(/\/+$/, '') || '/'

/** Stable identity for a project group (host + normalized root). Shared by the
 *  sessions list and the view-prefs store so hide/pin keys can't drift. */
export const groupKey = (host: string | null, cwd: string): string =>
  `${host ?? 'local'}\n${normRoot(cwd)}`
