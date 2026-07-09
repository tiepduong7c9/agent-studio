import type { MouseEvent } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import { useTabsStore, type EditorTab } from '../tabs-store'
import { AcpThread } from './AcpThread'
import { ChatCard } from './ChatCard'
import { DiffView, FileView } from './editors'
import letterpress from '../assets/letterpress-light.svg'

interface Props {
  project: ProjectInfo | null
  onCreateSession: (text: string) => void
  onPickFolder: () => void
}

function tabIcon(tab: EditorTab): string {
  switch (tab.kind) {
    case 'chat':
      return 'codicon-robot'
    case 'diff':
      return 'codicon-git-compare'
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
export function EditorArea({ project, onCreateSession, onPickFolder }: Props) {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const maximized = useTabsStore((s) => s.maximized)
  const setActive = useTabsStore((s) => s.setActive)
  const close = useTabsStore((s) => s.close)
  const toggleMaximize = useTabsStore((s) => s.toggleMaximize)

  const active = tabs.find((t) => t.id === activeId) ?? null

  const onCloseTab = (e: MouseEvent, id: string) => {
    e.stopPropagation()
    close(id)
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
                className={`tab ${tab.id === activeId ? 'active' : ''}`}
                title={tab.title}
                onClick={() => setActive(tab.id)}
                onDoubleClick={toggleMaximize}
              >
                <span className={`codicon ${tabIcon(tab)} tab-icon`} />
                <span className="tab-name">{tab.title}</span>
                {'detail' in tab && tab.detail && <span className="tab-detail">{tab.detail}</span>}
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
        <TabContent
          tab={active}
          project={project}
          onCreateSession={onCreateSession}
          onPickFolder={onPickFolder}
          onCloseNewChat={() => active && close(active.id)}
        />
      </div>
    </div>
  )
}

function TabContent({
  tab,
  project,
  onCreateSession,
  onPickFolder,
  onCloseNewChat
}: {
  tab: EditorTab | null
  project: ProjectInfo | null
  onCreateSession: (text: string) => void
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
          project={project}
          onClose={onCloseNewChat}
          onPickFolder={onPickFolder}
          onCreate={onCreateSession}
        />
      )
    case 'chat':
      return <AcpThread key={tab.id} sid={tab.sid} />
    case 'file':
      return <FileView key={tab.id} path={tab.path} />
    case 'diff':
      return project ? (
        <DiffView key={tab.id} project={project} change={tab.change} />
      ) : (
        <div className="editor-watermark">
          <img src={letterpress} alt="" draggable={false} />
        </div>
      )
  }
}
