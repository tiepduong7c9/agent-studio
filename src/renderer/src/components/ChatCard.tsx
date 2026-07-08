import type { ProjectInfo } from '../../../shared/types'

interface Props {
  project: ProjectInfo | null
  onClose: () => void
  onPickFolder: () => void
}

/** The "new session" pane, modeled on the VS Code agent sessions window. */
export function ChatCard({ project, onClose, onPickFolder }: Props) {
  return (
    <div className="chat-pane">
      <div className="chat-pane-toolbar">
        <button className="icon-button codicon codicon-close" title="Close" onClick={onClose} />
      </div>
      <div className="chat-pane-content">
        <h2 className="chat-heading">
          New session in
          <span className="chat-chip">
            <span className="codicon codicon-folder" />
            {project?.name ?? 'no folder'}
            <span className="codicon codicon-chevron-down chat-chip-chevron" />
          </span>
          with
          <span className="chat-chip">
            <span className="codicon codicon-robot" />
            Agent
            <span className="codicon codicon-chevron-down chat-chip-chevron" />
          </span>
        </h2>
        <div className="chat-input-card">
          <div className="chat-input-placeholder">Pitch your idea</div>
          <div className="chat-input-row">
            <span className="icon-button codicon codicon-add" />
            <span className="chat-input-mode">
              <span className="codicon codicon-sparkle" /> Agent
            </span>
            <span className="chat-input-mode">Auto</span>
            <span className="topbar-spacer" />
            <span className="icon-button codicon codicon-send" />
          </div>
        </div>
        <div className="chat-meta-row">
          <span className="chat-meta-item">
            <span className="codicon codicon-circle-slash" /> Default Approvals
          </span>
          <span className="topbar-spacer" />
          <button className="chat-meta-button" onClick={onPickFolder}>
            <span className="codicon codicon-folder" /> Folder
          </button>
          <span className="chat-meta-item">
            <span className="codicon codicon-git-branch" /> Branch
          </span>
        </div>
      </div>
    </div>
  )
}
