import { SquareKanban } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import { ThemePicker } from './ThemePicker'

interface Props {
  activeWorkspace: ProjectInfo | null
  leftVisible: boolean
  /** null = no right panel (it's docked on the left); hides its toggle. */
  rightVisible: boolean | null
  onToggleLeft: () => void
  onToggleRight: () => void
  boardOpen: boolean
  /** Sessions that need you — shown as a count on the Board button. */
  boardBadge: number
  onToggleBoard: () => void
}

export function TitleBar({
  activeWorkspace,
  leftVisible,
  rightVisible,
  onToggleLeft,
  onToggleRight,
  boardOpen,
  boardBadge,
  onToggleBoard
}: Props) {
  const project = activeWorkspace
  return (
    <header className="titlebar">
      <div className="titlebar-side left">
        <button
          className={`icon-button codicon codicon-layout-sidebar-left${leftVisible ? '' : '-off'}`}
          title="Toggle Left Panel"
          onClick={onToggleLeft}
        />
        {/* Labelled, not icon-only: the board is a primary view, so it should be
            findable at a glance and reachable even with the sidebar hidden. */}
        <button
          className={`titlebar-board ${boardOpen ? 'active' : ''}`}
          title={`${boardOpen ? 'Close' : 'Open'} Sessions Board (Ctrl+Space)${boardBadge ? ` — ${boardBadge} need${boardBadge === 1 ? 's' : ''} you` : ''}`}
          aria-pressed={boardOpen}
          onClick={onToggleBoard}
        >
          <SquareKanban size={15} strokeWidth={2} />
          <span>Board</span>
          {boardBadge > 0 && <span className="titlebar-board-badge">{boardBadge}</span>}
        </button>
      </div>
      <div className="titlebar-center">
        <span className="icon-button codicon codicon-arrow-left nav-arrow" />
        <span className="icon-button codicon codicon-arrow-right nav-arrow" />
        <div className="command-center" title={project?.rootPath ?? 'Agent Studio'}>
          {project?.kind === 'ssh' && <span className="codicon codicon-remote" />}
          <span className="command-center-label">
            {project ? (project.kind === 'ssh' ? `${project.host} · ` : '') + project.name : 'Agent Studio'}
          </span>
        </div>
      </div>
      <div className="titlebar-side right">
        <ThemePicker />
        {rightVisible !== null && (
          <button
            className={`icon-button codicon codicon-layout-sidebar-right${rightVisible ? '' : '-off'}`}
            title="Toggle Right Panel"
            onClick={onToggleRight}
          />
        )}
        <div className="window-controls">
          <button
            className="window-control codicon codicon-chrome-minimize"
            onClick={() => window.studio.windowControl('minimize')}
          />
          <button
            className="window-control codicon codicon-chrome-maximize"
            onClick={() => window.studio.windowControl('maximize')}
          />
          <button
            className="window-control close codicon codicon-chrome-close"
            onClick={() => window.studio.windowControl('close')}
          />
        </div>
      </div>
    </header>
  )
}
