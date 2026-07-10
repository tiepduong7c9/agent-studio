import type { ProjectInfo } from '../../../shared/types'
import { ThemePicker } from './ThemePicker'

interface Props {
  activeWorkspace: ProjectInfo | null
  leftVisible: boolean
  rightVisible: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
  onOpenLocal: () => void
  onOpenSsh: () => void
}

export function TitleBar({
  activeWorkspace,
  leftVisible,
  rightVisible,
  onToggleLeft,
  onToggleRight,
  onOpenLocal,
  onOpenSsh
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
        <button
          className={`icon-button codicon codicon-layout-sidebar-right${rightVisible ? '' : '-off'}`}
          title="Toggle Right Panel"
          onClick={onToggleRight}
        />
        <button className="btn titlebar-action" onClick={onOpenSsh}>
          SSH…
        </button>
        <button className="btn btn-primary titlebar-action" onClick={onOpenLocal}>
          Open Folder
        </button>
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
