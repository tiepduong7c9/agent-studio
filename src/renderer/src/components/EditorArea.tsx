import { useEffect, useState, type MouseEvent } from 'react'
import type { GitFileChange, ProjectInfo } from '../../../shared/types'
import { fileTabId, useTabsStore, visibleTabs, type EditorTab } from '../tabs-store'
import { useEditorBufferStore } from '../editor-buffer-store'
import { ConfirmDialog } from './Dialogs'
import { AcpThread } from './AcpThread'
import { BrowserPane } from './BrowserPane'
import { ChatCard } from './ChatCard'
import { GitGraphView } from './GitGraphView'
import { TerminalView } from './TerminalView'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import { baseName, Breadcrumbs, DiffView, FileView, isMarkdown, relativeToRoot } from './editors'
import { useMarkdownViewStore } from '../markdown-view-store'
import { isSideBySide, useDiffViewStore } from '../diff-view-store'
import { useSessionsStore } from '../acp/sessions-store'
import { sessionInWorkspace, workspaceForSession } from '../workspace'
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

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel}`
}

/** A diff of a deleted file has no working-tree file to open. */
function isDeletedChange(change: GitFileChange): boolean {
  return change.worktree === 'D' || (change.index === 'D' && change.worktree === '.')
}

function tabIcon(tab: EditorTab): string {
  switch (tab.kind) {
    case 'chat':
      return 'codicon-robot'
    case 'diff':
      return 'codicon-git-compare'
    case 'git-graph':
      return 'codicon-git-commit'
    case 'browser':
      return 'codicon-globe'
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
  const sessions = useSessionsStore((s) => s.sessions)
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
  const openTab = useTabsStore((s) => s.open)
  const keepTab = useTabsStore((s) => s.keep)
  const toggleMarkdownSource = useMarkdownViewStore((s) => s.toggle)
  const toggleSideBySide = useDiffViewStore((s) => s.toggleSideBySide)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // Tabs with unsaved edits, so the strip can show a dirty dot and warn on close.
  const dirty = useEditorBufferStore((s) => s.dirty)
  const discardBuffer = useEditorBufferStore((s) => s.discard)
  const pruneBuffers = useEditorBufferStore((s) => s.prune)
  // A dirty file tab pending a discard-and-close confirmation.
  const [confirmClose, setConfirmClose] = useState<string | null>(null)

  // Drop edit buffers whose tab has closed (any close path), so a file reopened
  // later loads fresh from disk rather than resurrecting a stale buffer.
  useEffect(() => {
    pruneBuffers(new Set(allTabs.map((t) => t.id)))
  }, [allTabs, pruneBuffers])

  const closeTab = (id: string) => {
    if (dirty[id]) {
      setConfirmClose(id)
      return
    }
    discardBuffer(id)
    close(id)
  }

  const active = allTabs.find((t) => t.id === activeId) ?? null
  // The workspace backing a tab. Chat tabs resolve by the session's cwd (their
  // own wsId can be blank for a session outside any open folder), matching how
  // the right panel picks a workspace; other tabs carry an explicit wsId.
  const workspaceForTab = (t: EditorTab | null): ProjectInfo | null => {
    if (!t) return null
    if (t.kind === 'chat') {
      const meta = sessions.find((s) => s.id === t.sid)
      if (!meta) return null
      return (
        workspaceForSession(meta, workspaces) ??
        sessionWorkspaces.find((w) => sessionInWorkspace(meta, w)) ??
        null
      )
    }
    return [...workspaces, ...sessionWorkspaces].find((w) => w.id === t.wsId) ?? null
  }
  const markdownTab = active?.kind === 'file' && isMarkdown(active.path) ? active : null
  const markdownSource = useMarkdownViewStore((s) => (markdownTab ? !!s.sourceMode[markdownTab.id] : false))
  const diffTab = active?.kind === 'diff' ? active : null
  const diffSideBySide = useDiffViewStore((s) => (diffTab ? isSideBySide(s.sideBySide, diffTab.id) : true))
  const diffController = useDiffViewStore((s) => (diffTab ? s.controllers[diffTab.id] : undefined))
  const diffChangeCount = diffController?.changeCount ?? 0

  // Open the working-tree file behind a diff tab as its own file tab. The diff
  // tab is usually the session's transient preview slot, so promote it to a
  // permanent tab first — otherwise the file would reuse that slot in place and
  // replace the diff instead of opening alongside it.
  const openDiffFile = (tab: Extract<EditorTab, { kind: 'diff' }>) => {
    const ws = [...workspaces, ...sessionWorkspaces].find((w) => w.id === tab.wsId)
    if (!ws) return
    keepTab(tab.id)
    const path = joinPath(ws.rootPath, tab.change.path)
    openTab(
      {
        id: fileTabId(tab.ownerSid, tab.wsId, path),
        kind: 'file',
        title: baseName(path),
        path,
        name: baseName(path),
        wsId: tab.wsId,
        ownerSid: tab.ownerSid
      },
      { preview: false }
    )
  }

  const onCloseTab = (e: MouseEvent, id: string) => {
    e.stopPropagation()
    closeTab(id)
  }

  const onTabContextMenu = (e: MouseEvent, tab: EditorTab) => {
    e.preventDefault()
    const isPreview = (tab.kind === 'file' || tab.kind === 'diff') && !!tab.preview
    const items: MenuItem[] = []
    if (isPreview) {
      items.push({ label: 'Keep Open', run: () => keep(tab.id) })
      items.push({ separator: true })
    }
    items.push({ label: 'Close', run: () => closeTab(tab.id) })
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
                className={`tab ${tab.id === activeId ? 'active' : ''} ${'preview' in tab && tab.preview ? 'preview' : ''} ${dirty[tab.id] ? 'dirty' : ''}`}
                title={tab.title}
                onClick={() => setActive(tab.id)}
                onDoubleClick={toggleMaximize}
                onContextMenu={(e) => onTabContextMenu(e, tab)}
              >
                <span className={`codicon ${tabIcon(tab)} tab-icon`} />
                <span className="tab-name">{tab.title}</span>
                {dirty[tab.id] && <span className="tab-dirty codicon codicon-circle-filled" />}
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
            {markdownTab && (
              <button
                className={`icon-button codicon ${markdownSource ? 'codicon-open-preview' : 'codicon-code'}`}
                title={markdownSource ? 'Show preview' : 'Show source'}
                onClick={() => toggleMarkdownSource(markdownTab.id)}
              />
            )}
            {diffTab && (
              <>
                <button
                  className="icon-button codicon codicon-arrow-up"
                  title="Previous Change"
                  disabled={diffChangeCount === 0}
                  onClick={() => diffController?.goToDiff('previous')}
                />
                <button
                  className="icon-button codicon codicon-arrow-down"
                  title="Next Change"
                  disabled={diffChangeCount === 0}
                  onClick={() => diffController?.goToDiff('next')}
                />
                <button
                  className={`icon-button codicon codicon-editor-layout ${diffSideBySide ? 'active' : ''}`}
                  title={diffSideBySide ? 'Switch to Inline View' : 'Switch to Side by Side View'}
                  onClick={() => toggleSideBySide(diffTab.id)}
                />
                {!isDeletedChange(diffTab.change) && (
                  <button
                    className="icon-button codicon codicon-go-to-file"
                    title="Open File"
                    onClick={() => openDiffFile(diffTab)}
                  />
                )}
                <span className="tab-actions-sep" />
              </>
            )}
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
              workspace={workspaceForTab(active)}
              onCreateSession={onCreateSession}
              onPickFolder={onPickFolder}
              onCloseNewChat={() => active && close(active.id)}
            />
          </ErrorBoundary>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {confirmClose && (
        <ConfirmDialog
          message="Discard unsaved changes?"
          detail={allTabs.find((t) => t.id === confirmClose)?.title}
          confirmLabel="Discard"
          danger
          onConfirm={() => {
            discardBuffer(confirmClose)
            close(confirmClose)
            setConfirmClose(null)
          }}
          onCancel={() => setConfirmClose(null)}
        />
      )}
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
      return <AcpThread key={tab.id} sid={tab.sid} workspace={workspace} />
    case 'git-graph':
      return <GitGraphView key={tab.id} wsId={tab.wsId} />
    case 'browser':
      return <BrowserPane key={tab.id} url={tab.url} />
    case 'file':
      return (
        <div className="editor-pane">
          <Breadcrumbs relPath={relativeToRoot(workspace?.rootPath, tab.path)} />
          <div className="editor-pane-body">
            <FileView key={tab.id} wsId={tab.wsId} path={tab.path} tabId={tab.id} untitled={tab.untitled} />
          </div>
        </div>
      )
    case 'diff':
      return workspace ? (
        <div className="editor-pane">
          <Breadcrumbs relPath={tab.change.path} />
          <div className="editor-pane-body">
            <DiffView key={tab.id} project={workspace} change={tab.change} tabId={tab.id} />
          </div>
        </div>
      ) : (
        <div className="editor-watermark">
          <img src={letterpress} alt="" draggable={false} />
        </div>
      )
  }
}
