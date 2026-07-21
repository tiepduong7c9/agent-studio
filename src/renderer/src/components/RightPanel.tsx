import { useEffect, useRef, useState } from 'react'
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

// Imperative handle both trees expose so the shared header buttons
// (refresh, collapse-all) can drive whichever panel is active.
export interface PanelHandle {
  collapseAll: () => void
  refresh: () => void
}

export function RightPanel({ project, selection, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>('files')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const treeRef = useRef<PanelHandle>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Search/filter is per-panel; reset it when switching tabs so a stale query
  // doesn't silently hide the other panel's contents.
  useEffect(() => {
    setSearching(false)
    setQuery('')
  }, [tab])

  useEffect(() => {
    if (searching) searchInputRef.current?.focus()
  }, [searching])

  const toggleSearch = () => {
    setSearching((on) => {
      if (on) setQuery('')
      return !on
    })
  }

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
        <button
          className={`icon-button codicon codicon-search ${searching ? 'active' : ''}`}
          title="Search"
          onClick={toggleSearch}
        />
        {tab === 'files' && (
          <button
            className="icon-button codicon codicon-refresh"
            title="Refresh"
            onClick={() => treeRef.current?.refresh()}
          />
        )}
        <button
          className="icon-button codicon codicon-collapse-all"
          title="Collapse All"
          onClick={() => treeRef.current?.collapseAll()}
        />
      </div>
      {searching && (
        <div className="panel-search">
          <span className="codicon codicon-search panel-search-icon" />
          <input
            ref={searchInputRef}
            className="panel-search-input"
            type="text"
            placeholder={tab === 'changes' ? 'Filter changes' : 'Filter files'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSearch()
            }}
          />
          {query && (
            <button
              className="icon-button codicon codicon-close panel-search-clear"
              title="Clear"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus()
              }}
            />
          )}
        </div>
      )}
      <div className="right-panel-body">
        {!project ? (
          <div className="panel-placeholder">No project open</div>
        ) : tab === 'files' ? (
          <FileTree
            key={projectKey(project)}
            ref={treeRef}
            project={project}
            selection={selection}
            onSelect={onSelect}
            filter={query}
          />
        ) : (
          <GitPanel
            key={projectKey(project)}
            ref={treeRef}
            wsId={project.id}
            onSelect={onSelect}
            filter={query}
          />
        )}
      </div>
    </div>
  )
}

function projectKey(p: ProjectInfo): string {
  return `${p.kind}:${p.host ?? ''}:${p.rootPath}`
}
