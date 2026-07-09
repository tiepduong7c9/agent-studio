import { useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'

interface Props {
  project: ProjectInfo | null
  onClose: () => void
  onPickFolder: () => void
  /** Create a new agent session in the project and send the first prompt. */
  onCreate: (text: string) => void
}

/** The "new session" pane, modeled on the VS Code agent sessions window. */
export function ChatCard({ project, onClose, onPickFolder, onCreate }: Props) {
  const [draft, setDraft] = useState('')
  // The engine runs where the code is — a local daemon for local projects, or a
  // remote daemon (provisioned over SSH) for ssh projects.
  const canCreate = !!project

  const submit = () => {
    const text = draft.trim()
    if (!text || !canCreate) return
    onCreate(text)
    setDraft('')
  }

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
          <textarea
            className="chat-input-textarea"
            placeholder={canCreate ? 'Pitch your idea' : 'Open a folder to start'}
            value={draft}
            disabled={!canCreate}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
          />
          <div className="chat-input-row">
            <span className="icon-button codicon codicon-add" />
            <span className="chat-input-mode">
              <span className="codicon codicon-sparkle" /> Agent
            </span>
            <span className="chat-input-mode">Auto</span>
            <span className="topbar-spacer" />
            <button
              className="icon-button codicon codicon-send"
              title="Start session"
              disabled={!canCreate || !draft.trim()}
              onClick={submit}
            />
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
