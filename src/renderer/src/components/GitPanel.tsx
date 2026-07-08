import { useCallback, useEffect, useRef, useState } from 'react'
// VS Code's real tree widget, reused from monaco-editor's esm distribution
import { ObjectTree } from 'monaco-editor/esm/vs/base/browser/ui/tree/objectTree.js'
import * as defaultStyles from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'
import type { GitFileChange, GitStatus } from '../../../shared/types'
import type { Selection } from '../selection'
import { fileIconStyle } from './FileIcon'

interface Props {
  selection: Selection | null
  onSelect: (selection: Selection) => void
}

interface GroupNode {
  type: 'group'
  key: string
  title: string
  letter: (c: GitFileChange) => string
  changes: GitFileChange[]
}

interface ChangeNode {
  type: 'change'
  group: GroupNode
  change: GitFileChange
}

type GitNode = GroupNode | ChangeNode

export function GitPanel({ onSelect }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<any>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await window.studio.gitStatus()
    setLoading(false)
    if (result.ok) {
      setStatus(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Create the ObjectTree once
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const delegate = {
      getHeight: () => 22,
      getTemplateId: (el: GitNode) => el.type
    }

    const groupRenderer = {
      templateId: 'group',
      renderTemplate(templateContainer: HTMLElement) {
        const row = document.createElement('div')
        row.className = 'scm-group-label'
        const title = document.createElement('span')
        title.className = 'scm-group-title'
        const badge = document.createElement('span')
        badge.className = 'badge'
        row.append(title, badge)
        templateContainer.appendChild(row)
        return { title, badge }
      },
      renderElement(node: any, _i: number, t: { title: HTMLSpanElement; badge: HTMLSpanElement }) {
        const el: GroupNode = node.element
        t.title.textContent = el.title
        t.badge.textContent = String(el.changes.length)
      },
      disposeTemplate() {}
    }

    const changeRenderer = {
      templateId: 'change',
      renderTemplate(templateContainer: HTMLElement) {
        const row = document.createElement('div')
        row.className = 'entry-label'
        const icon = document.createElement('span')
        icon.className = 'seti-icon'
        const name = document.createElement('span')
        name.className = 'label-name'
        const description = document.createElement('span')
        description.className = 'label-description'
        const decoration = document.createElement('span')
        decoration.className = 'scm-decoration'
        row.append(icon, name, description, decoration)
        templateContainer.appendChild(row)
        return { row, icon, name, description, decoration }
      },
      renderElement(node: any, _i: number, t: any) {
        const el: ChangeNode = node.element
        const file = fileName(el.change.path)
        const { glyph, color } = fileIconStyle(file)
        t.icon.style.color = color
        t.icon.textContent = glyph
        t.name.textContent = file
        t.description.textContent = dirName(el.change.path)
        t.decoration.textContent = el.group.letter(el.change)
        t.decoration.className = `scm-decoration git-${el.group.key}`
        t.row.title = el.change.origPath
          ? `${el.change.origPath} → ${el.change.path}`
          : el.change.path
      },
      disposeTemplate() {}
    }

    const tree = new ObjectTree('AgentStudioChanges', container, delegate, [groupRenderer, changeRenderer], {
      expandOnlyOnTwistieClick: false,
      identityProvider: {
        getId: (el: GitNode) =>
          el.type === 'group' ? `group:${el.key}` : `change:${el.group.key}:${el.change.path}`
      },
      accessibilityProvider: {
        getAriaLabel: (el: GitNode) => (el.type === 'group' ? el.title : el.change.path),
        getWidgetAriaLabel: () => 'Changes'
      }
    })

    const styles = (defaultStyles as any).defaultListStyles ?? (defaultStyles as any).getListStyles?.({})
    if (styles) tree.style(styles)

    const openListener = tree.onDidChangeSelection((e: any) => {
      const el: GitNode | undefined = e.elements?.[0]
      if (el?.type === 'change') {
        onSelectRef.current({ kind: 'diff', change: el.change })
      }
    })

    const resize = () => tree.layout(container.clientHeight, container.clientWidth)
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    treeRef.current = tree
    return () => {
      observer.disconnect()
      openListener.dispose()
      tree.dispose()
      treeRef.current = null
      container.textContent = ''
    }
  }, [status?.isRepo])

  // Feed status into the tree
  useEffect(() => {
    const tree = treeRef.current
    if (!tree || !status?.isRepo) return
    const groups = buildGroups(status)
    tree.setChildren(
      null,
      groups.map((g) => ({
        element: g,
        collapsible: true,
        children: g.changes.map((c) => ({ element: { type: 'change', group: g, change: c } }))
      }))
    )
  }, [status])

  if (error) return <div className="tree-error">{error}</div>
  if (!status) return <div className="tree-message">Loading…</div>

  return (
    <div className="git-panel">
      <div className="git-branch-row">
        <span className="codicon codicon-git-branch" />
        <span className="git-branch" title={status.upstream ? `upstream: ${status.upstream}` : ''}>
          {status.branch ?? 'unknown'}
        </span>
        {status.ahead > 0 && <span className="git-ab">{status.ahead}↑</span>}
        {status.behind > 0 && <span className="git-ab">{status.behind}↓</span>}
        <span className="topbar-spacer" />
        <button
          className="icon-button codicon codicon-refresh"
          title="Refresh"
          onClick={refresh}
          disabled={loading}
        />
      </div>
      {!status.isRepo ? (
        <div className="tree-message">Not a git repository</div>
      ) : status.changes.length === 0 ? (
        <div className="tree-message">No changes</div>
      ) : null}
      <div ref={containerRef} className="widget-tree" />
    </div>
  )
}

function buildGroups(status: GitStatus): GroupNode[] {
  const staged = status.changes.filter((c) => !c.conflicted && !c.untracked && c.index !== '.')
  const unstaged = status.changes.filter(
    (c) => !c.conflicted && !c.untracked && c.worktree !== '.'
  )
  const untracked = status.changes.filter((c) => c.untracked)
  const conflicted = status.changes.filter((c) => c.conflicted)

  const groups: GroupNode[] = []
  if (conflicted.length)
    groups.push({ type: 'group', key: 'conflict', title: 'Merge Conflicts', letter: () => '!', changes: conflicted })
  if (staged.length)
    groups.push({ type: 'group', key: 'staged', title: 'Staged Changes', letter: (c) => c.index, changes: staged })
  if (unstaged.length)
    groups.push({ type: 'group', key: 'unstaged', title: 'Changes', letter: (c) => c.worktree, changes: unstaged })
  if (untracked.length)
    groups.push({ type: 'group', key: 'untracked', title: 'Untracked', letter: () => 'U', changes: untracked })
  return groups
}

function fileName(p: string): string {
  return p.split('/').pop() || p
}

function dirName(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? '' : p.slice(0, idx)
}
