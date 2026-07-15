// Native OS notifications for background session state changes. Fired from the
// session-list watcher in App.tsx when a session that isn't being watched
// finishes a turn or starts waiting for input. Fire-and-forget: failures (e.g.
// notifications disabled at the OS level) are swallowed.

export type SessionNotifyKind = 'done' | 'waiting'

export function notifySession(sid: string, name: string, kind: SessionNotifyKind): void {
  const body = kind === 'done' ? 'Finished responding.' : 'Waiting for your input.'
  window.studio.notify({ sid, title: name || 'Claude Code', body }).catch(() => {})
}
