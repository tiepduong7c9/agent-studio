import { useEffect, useRef } from 'react'
// VS Code's real list widget, reused from monaco-editor's esm distribution
import { List } from 'monaco-editor/esm/vs/base/browser/ui/list/listWidget.js'
import * as defaultStyles from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'
// Copied verbatim from vscode/src/vs/workbench/contrib/chat/browser/agentSessions/media/
import '../vscode-css/agentsessionsviewer.css'
import type { ProjectInfo } from '../../../shared/types'

const CUSTOMIZATIONS = [
  { icon: 'sparkle', label: 'Agents' },
  { icon: 'lightbulb', label: 'Skills' },
  { icon: 'book', label: 'Instructions' },
  { icon: 'plug', label: 'Hooks' },
  { icon: 'server', label: 'MCP Servers' },
  { icon: 'extensions', label: 'Plugins' }
]

interface Session {
  id: string
  title: string
  added?: number
  removed?: number
  when: string
}

interface SectionRow {
  type: 'section'
  label: string
  count: number
}

interface SessionRow {
  type: 'session'
  session: Session
}

type Row = SectionRow | SessionRow

const DEMO_SESSIONS: Session[] = [
  { id: '1', title: 'Build desktop app with VS Code-like UI', when: '55 mins ago' },
  { id: '2', title: 'Review GitHub pull request 3312', added: 367, removed: 0, when: '2 days ago' },
  { id: '3', title: 'Review pull request 3587', added: 367, removed: 0, when: '3 days ago' }
]

export function SessionsPanel({ project }: { project: ProjectInfo | null }) {
  const sessions = window.studio.demoSessions ? DEMO_SESSIONS : []

  return (
    // extra classes activate the copied agentsessionsviewer.css padding rules,
    // which are scoped to the real workbench's DOM (.agent-sessions-workbench .pane-body)
    <div className="sessions-panel agent-sessions-workbench">
      <div className="sessions-header">
        <span className="sessions-title">Sessions</span>
        <span className="topbar-spacer" />
        <button className="new-session-button">
          New <kbd>Ctrl+N</kbd>
        </button>
        <button className="icon-button codicon codicon-list-filter" title="Filter" />
        <button className="icon-button codicon codicon-search" title="Search" />
      </div>
      <div className="sessions-body pane-body">
        {project && sessions.length > 0 ? (
          <SessionsViewer project={project} sessions={sessions} />
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

/**
 * Sessions list rendered with VS Code's real List widget, using the exact DOM
 * structure the copied agentsessionsviewer.css targets (see the real renderer
 * in vscode/src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsViewer.ts).
 */
function SessionsViewer({ project, sessions }: { project: ProjectInfo; sessions: Session[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current!

    const rows: Row[] = [
      { type: 'section', label: project.name, count: sessions.length },
      ...sessions.map((s): SessionRow => ({ type: 'session', session: s }))
    ]

    const delegate = {
      getHeight: (row: Row) => (row.type === 'section' ? 26 : 52),
      getTemplateId: (row: Row) => row.type
    }

    const sectionRenderer = {
      templateId: 'section',
      renderTemplate(root: HTMLElement) {
        const section = el(root, 'div', 'agent-session-section')
        const label = el(section, 'span', 'agent-session-section-label')
        const count = el(section, 'span', 'agent-session-section-count')
        return { label, count }
      },
      renderElement(row: SectionRow, _i: number, t: any) {
        t.label.textContent = row.label
        t.count.textContent = String(row.count)
      },
      disposeTemplate() {}
    }

    const sessionRenderer = {
      templateId: 'session',
      renderTemplate(root: HTMLElement) {
        const item = el(root, 'div', 'agent-session-item')
        const iconCol = el(item, 'div', 'agent-session-icon-col')
        const icon = el(iconCol, 'div', 'agent-session-icon codicon codicon-circle-large-filled')
        const main = el(item, 'div', 'agent-session-main-col')
        const titleRow = el(main, 'div', 'agent-session-title-row')
        const title = el(titleRow, 'span', 'agent-session-title')
        const details = el(main, 'div', 'agent-session-details-row')
        const detailsIcon = el(details, 'span', 'agent-session-details-icon codicon codicon-folder visible')
        const diff = el(details, 'span', 'agent-session-diff-container')
        const added = el(diff, 'span', 'agent-session-diff-added')
        const removed = el(diff, 'span', 'agent-session-diff-removed')
        const separator = el(details, 'span', 'agent-session-separator')
        const status = el(details, 'span', 'agent-session-status')
        return { icon, title, detailsIcon, diff, added, removed, separator, status }
      },
      renderElement(row: SessionRow, _i: number, t: any) {
        const s = row.session
        t.title.textContent = s.title
        const hasDiff = typeof s.added === 'number'
        t.diff.classList.toggle('has-diff', hasDiff)
        t.added.textContent = hasDiff ? `+${s.added}` : ''
        t.removed.textContent = hasDiff ? `-${s.removed}` : ''
        t.separator.classList.toggle('has-separator', hasDiff)
        t.status.textContent = s.when
      },
      disposeTemplate() {}
    }

    const list = new List('AgentSessions', container, delegate, [sectionRenderer, sessionRenderer], {
      identityProvider: {
        getId: (row: Row) => (row.type === 'section' ? `section:${row.label}` : row.session.id)
      },
      accessibilityProvider: {
        getAriaLabel: (row: Row) => (row.type === 'section' ? row.label : row.session.title),
        getWidgetAriaLabel: () => 'Sessions'
      }
    })

    const styles = (defaultStyles as any).defaultListStyles ?? (defaultStyles as any).getListStyles?.({})
    if (styles) list.style(styles)

    list.splice(0, 0, rows)

    const resize = () => list.layout(container.clientHeight, container.clientWidth)
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    return () => {
      observer.disconnect()
      list.dispose()
      container.textContent = ''
    }
  }, [project, sessions])

  return <div ref={containerRef} className="agent-sessions-viewer" />
}

function el(parent: HTMLElement, tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  parent.appendChild(node)
  return node
}
