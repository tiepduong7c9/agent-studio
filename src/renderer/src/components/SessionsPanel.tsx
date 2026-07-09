import type { SessionMeta } from '../../../shared/acp'
import type { ProjectInfo } from '../../../shared/types'

const CUSTOMIZATIONS = [
  { icon: 'sparkle', label: 'Agents' },
  { icon: 'lightbulb', label: 'Skills' },
  { icon: 'book', label: 'Instructions' },
  { icon: 'plug', label: 'Hooks' },
  { icon: 'server', label: 'MCP Servers' },
  { icon: 'extensions', label: 'Plugins' }
]

interface Props {
  project: ProjectInfo | null
  sessions: SessionMeta[]
  activeSid: string | null
  onSelect: (sid: string) => void
  onNew: () => void
}

function relTime(iso: string | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusClass(status?: string): string {
  if (status === 'working') return 'acp-status-working'
  if (status === 'waiting') return 'acp-status-waiting'
  return 'acp-status-idle'
}

export function SessionsPanel({ project, sessions, activeSid, onSelect, onNew }: Props) {
  return (
    <div className="sessions-panel agent-sessions-workbench">
      <div className="sessions-header">
        <span className="sessions-title">Sessions</span>
        <span className="topbar-spacer" />
        <button className="new-session-button" onClick={onNew}>
          New <kbd>Ctrl+N</kbd>
        </button>
        <button className="icon-button codicon codicon-list-filter" title="Filter" />
        <button className="icon-button codicon codicon-search" title="Search" />
      </div>
      <div className="sessions-body pane-body">
        {sessions.length > 0 ? (
          <>
            {project && <div className="sessions-group-label">{project.name}</div>}
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`acp-session-row ${s.id === activeSid ? 'active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className={`acp-status-dot ${statusClass(s.claudeStatus)}`} />
                <span className="acp-session-main">
                  <span className="acp-session-name">{s.name}</span>
                  <span className="acp-session-sub">
                    {s.claudeStatus ?? s.status} · {relTime(s.lastAttachedAt || s.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </>
        ) : project ? (
          <>
            <div className="sessions-group-label">{project.name}</div>
            <div className="sessions-empty">No sessions yet</div>
          </>
        ) : (
          <div className="sessions-empty">Open a project to start a session</div>
        )}
      </div>
      <div className="customizations">
        <div className="customizations-label">Customizations</div>
        {CUSTOMIZATIONS.map((c) => (
          <div key={c.label} className="customization-row">
            <span className={`codicon codicon-${c.icon}`} />
            <span className="customization-name">{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
