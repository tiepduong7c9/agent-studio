import { useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import type { Selection, SelectHandler } from '../selection'
import { FileTree } from './FileTree'
import { GitPanel } from './GitPanel'

interface Props {
  project: ProjectInfo | null
  selection: Selection | null
  onSelect: SelectHandler
}

type Tab = 'changes' | 'files'

export function RightPanel({ project, selection, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>('files')

  return (
    <div className="right-panel">
      <div className="right-panel-header">
        <button
          className={`panel-tab ${tab === 'changes' ? 'active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        <button
          className={`panel-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => setTab('files')}
        >
          Files
        </button>
        <span className="topbar-spacer" />
        <button className="icon-button codicon codicon-search" title="Search" />
        <button className="icon-button codicon codicon-collapse-all" title="Collapse All" />
      </div>
      <div className="right-panel-body">
        {!project ? (
          <div className="panel-placeholder">No project open</div>
        ) : tab === 'files' ? (
          <FileTree
            key={projectKey(project)}
            project={project}
            selection={selection}
            onSelect={onSelect}
          />
        ) : (
          <GitPanel key={projectKey(project)} wsId={project.id} onSelect={onSelect} />
        )}
      </div>
    </div>
  )
}

function projectKey(p: ProjectInfo): string {
  return `${p.kind}:${p.host ?? ''}:${p.rootPath}`
}
