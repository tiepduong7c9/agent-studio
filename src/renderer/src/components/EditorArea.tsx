import { useState, type MouseEvent } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import { useTabsStore, visibleTabs, type EditorTab } from '../tabs-store'
import { AcpThread } from './AcpThread'
import { ChatCard } from './ChatCard'
import { GitGraphView } from './GitGraphView'
import { TerminalView } from './TerminalView'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import { Breadcrumbs, DiffView, FileView, relativeToRoot } from './editors'
import letterpress from '../assets/letterpress-light.svg'

interface Props {
  workspaces: ProjectInfo[]
  // Providers rooted at a session's own cwd (folders never opened as a
  // workspace). Diff tabs can carry one of these ids, so they must be
  // resolvable here too — otherwise the diff tab renders the empty watermark.
  sessionWorkspaces: ProjectInfo[]
  onCreateSession: (ws: ProjectInfo, text: string) => void
  onPickFolder: () => void
}

function tabIcon(tab: EditorTab): string {
  switch (tab.kind) {
    case 'chat':
      return 'codicon-robot'
    case 'diff':
      return 'codicon-git-compare'
    case 'git-graph':
      return 'codicon-git-commit'
    case 'terminal':
      return 'codicon-terminal'
    case 'new-chat':
      return 'codicon-add'
    default:
      return 'codicon-file'
  }
}

/**
 * The center editor group: an ordered strip of tabs (agent chats, the
 * new-session card, and file/diff viewers) over a single active editor.
 * Double-clicking a tab toggles maximize, which hides the surrounding panels.
 */
export function EditorArea({ workspaces, sessionWorkspaces, onCreateSession, onPickFolder }: Props) {
  const allTabs = useTabsStore((s) => s.tabs)
  const activeSid = useTabsStore((s) => s.activeSid)
  // Only the active session's tabs are shown; switching sessions swaps the set.
  const tabs = visibleTabs(allTabs, activeSid)
  const activeId = useTabsStore((s) => s.activeId)
  const maximized = useTabsStore((s) => s.maximized)
  const setActive = useTabsStore((s) => s.setActive)
  const close = useTabsStore((s) => s.close)
  const keep = useTabsStore((s) => s.keep)
  const closeOthers = useTabsStore((s) => s.closeOthers)
  const closeAll = useTabsStore((s) => s.closeAll)
  const toggleMaximize = useTabsStore((s) => s.toggleMaximize)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const active = allTabs.find((t) => t.id === activeId) ?? null

  const onCloseTab = (e: MouseEvent, id: string) => {
    e.stopPropagation()
    close(id)
  }

  const onTabContextMenu = (e: MouseEvent, tab: EditorTab) => {
    e.preventDefault()
    const isPreview = (tab.kind === 'file' || tab.kind === 'diff') && !!tab.preview
    const items: MenuItem[] = []
    if (isPreview) {
      items.push({ label: 'Keep Open', run: () => keep(tab.id) })
      items.push({ separator: true })
    }
    items.push({ label: 'Close', run: () => close(tab.id) })
    items.push({ label: 'Close Others', enabled: tabs.length > 1, run: () => closeOthers(tab.id) })
    items.push({ label: 'Close All', run: () => closeAll() })
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tab-strip" role="tablist">
          <div className="tab-list">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeId}
                className={`tab ${tab.id === activeId ? 'active' : ''} ${'preview' in tab && tab.preview ? 'preview' : ''}`}
                title={tab.title}
                onClick={() => setActive(tab.id)}
                onDoubleClick={toggleMaximize}
                onContextMenu={(e) => onTabContextMenu(e, tab)}
              >
                <span className={`codicon ${tabIcon(tab)} tab-icon`} />
                <span className="tab-name">{tab.title}</span>
                <span
                  className="tab-close codicon codicon-close"
                  role="button"
                  title="Close"
                  onClick={(e) => onCloseTab(e, tab.id)}
                />
              </div>
            ))}
          </div>
          <div className="tab-actions">
            <button
              className={`icon-button codicon ${maximized ? 'codicon-screen-normal' : 'codicon-screen-full'}`}
              title={maximized ? 'Restore panel' : 'Maximize editor'}
              onClick={toggleMaximize}
            />
          </div>
        </div>
      )}
      <div className="editor-body">
        {/* Terminals persist while their tab is open: kept mounted (so the PTY
            keeps running) even when another tab is showing, and revealed when
            active. Everything else renders through TabContent for the active tab. */}
        {allTabs
          .filter((t): t is Extract<EditorTab, { kind: 'terminal' }> => t.kind === 'terminal')
          .map((t) => (
            <div
              key={t.id}
              className="editor-terminal-layer"
              style={{ display: t.id === activeId ? 'flex' : 'none' }}
            >
              <TerminalView wsId={t.wsId} cwd={t.cwd} host={t.host} active={t.id === activeId} />
            </div>
          ))}
        {active?.kind !== 'terminal' && (
          <ErrorBoundary inline resetKeys={[active?.id]}>
            <TabContent
              tab={active}
              workspace={
                active
                  ? ([...workspaces, ...sessionWorkspaces].find((w) => w.id === active.wsId) ?? null)
                  : null
              }
              onCreateSession={onCreateSession}
              onPickFolder={onPickFolder}
              onCloseNewChat={() => active && close(active.id)}
            />
          </ErrorBoundary>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function TabContent({
  tab,
  workspace,
  onCreateSession,
  onPickFolder,
  onCloseNewChat
}: {
  tab: EditorTab | null
  workspace: ProjectInfo | null
  onCreateSession: (ws: ProjectInfo, text: string) => void
  onPickFolder: () => void
  onCloseNewChat: () => void
}) {
  if (!tab) {
    // Empty group: fall back to the editor watermark.
    return (
      <div className="editor-watermark">
        <img src={letterpress} alt="" draggable={false} />
      </div>
    )
  }
  switch (tab.kind) {
    case 'new-chat':
      return (
        <ChatCard
          project={workspace}
          onClose={onCloseNewChat}
          onPickFolder={onPickFolder}
          onCreate={(text) => workspace && onCreateSession(workspace, text)}
        />
      )
    case 'chat':
      return <AcpThread key={tab.id} sid={tab.sid} />
    case 'git-graph':
      return <GitGraphView key={tab.id} wsId={tab.wsId} />
    case 'file':
      return (
        <div className="editor-pane">
          <Breadcrumbs relPath={relativeToRoot(workspace?.rootPath, tab.path)} />
          <div className="editor-pane-body">
            <FileView key={tab.id} wsId={tab.wsId} path={tab.path} />
          </div>
        </div>
      )
    case 'diff':
      return workspace ? (
        <div className="editor-pane">
          <Breadcrumbs relPath={tab.change.path} />
          <div className="editor-pane-body">
            <DiffView key={tab.id} project={workspace} change={tab.change} />
          </div>
        </div>
      ) : (
        <div className="editor-watermark">
          <img src={letterpress} alt="" draggable={false} />
        </div>
      )
  }
}
