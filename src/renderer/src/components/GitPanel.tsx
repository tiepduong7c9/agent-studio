import { useCallback, useEffect, useRef, useState } from 'react'
// VS Code's real tree widget, reused from monaco-editor's esm distribution
import { ObjectTree } from 'monaco-editor/esm/vs/base/browser/ui/tree/objectTree.js'
import * as defaultStyles from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'
import type { GitFileChange, GitStatus } from '../../../shared/types'
import type { SelectHandler } from '../selection'
import { useViewPrefsStore } from '../view-prefs-store'
import { fileIconStyle } from './FileIcon'

interface Props {
  wsId: string
  onSelect: SelectHandler
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

// A folder row in tree view. `path` is the folder's repo-relative path (used for
// identity); `name` is the display label, which may fold a single-child chain
// into one row ("src/renderer/components"), like the Files tree.
interface DirNode {
  type: 'dir'
  group: GroupNode
  path: string
  name: string
}

type GitNode = GroupNode | ChangeNode | DirNode

export function GitPanel({ wsId, onSelect }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<any>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const viewMode = useViewPrefsStore((s) => s.changesViewMode)
  const setViewMode = useViewPrefsStore((s) => s.setChangesViewMode)
  // The change renderer reads this to decide whether to show the dir suffix.
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await window.studio.gitStatus(wsId)
    setLoading(false)
    if (result.ok) {
      setStatus(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [wsId])

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
        // In tree view the folder is implied by nesting, so drop the suffix.
        t.description.textContent = viewModeRef.current === 'tree' ? '' : dirName(el.change.path)
        t.decoration.textContent = el.group.letter(el.change)
        t.decoration.className = `scm-decoration git-${el.group.key}`
        t.row.title = el.change.origPath
          ? `${el.change.origPath} → ${el.change.path}`
          : el.change.path
      },
      disposeTemplate() {}
    }

    const dirRenderer = {
      templateId: 'dir',
      renderTemplate(templateContainer: HTMLElement) {
        const row = document.createElement('div')
        row.className = 'entry-label'
        const name = document.createElement('span')
        name.className = 'label-name'
        row.append(name)
        templateContainer.appendChild(row)
        return { row, name }
      },
      renderElement(node: any, _i: number, t: { row: HTMLElement; name: HTMLSpanElement }) {
        const el: DirNode = node.element
        t.name.textContent = el.name
        t.row.title = el.path
      },
      disposeTemplate() {}
    }

    const tree = new ObjectTree('AgentStudioChanges', container, delegate, [groupRenderer, changeRenderer, dirRenderer], {
      expandOnlyOnTwistieClick: false,
      identityProvider: {
        getId: (el: GitNode) =>
          el.type === 'group'
            ? `group:${el.key}`
            : el.type === 'dir'
              ? `dir:${el.group.key}:${el.path}`
              : `change:${el.group.key}:${el.change.path}`
      },
      accessibilityProvider: {
        getAriaLabel: (el: GitNode) =>
          el.type === 'group' ? el.title : el.type === 'dir' ? el.path : el.change.path,
        getWidgetAriaLabel: () => 'Changes'
      }
    })

    const styles = (defaultStyles as any).defaultListStyles ?? (defaultStyles as any).getListStyles?.({})
    if (styles) tree.style(styles)

    // Single click previews the diff in the transient tab; it's kept permanent
    // via the tab's right-click menu ("Keep Open").
    const openListener = tree.onDidChangeSelection((e: any) => {
      const el: GitNode | undefined = e.elements?.[0]
      if (el?.type === 'change') {
        onSelectRef.current({ kind: 'diff', wsId, change: el.change }, { preview: true })
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
        children: viewMode === 'tree' ? buildTree(g) : buildFlat(g)
      }))
    )
  }, [status, viewMode])

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
          className={`icon-button codicon ${viewMode === 'tree' ? 'codicon-list-flat' : 'codicon-list-tree'}`}
          title={viewMode === 'tree' ? 'View as List' : 'View as Tree'}
          onClick={() => setViewMode(viewMode === 'tree' ? 'list' : 'tree')}
        />
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

// Flat list: one row per change, directory shown as a faded suffix.
function buildFlat(g: GroupNode) {
  return g.changes.map((c) => ({ element: { type: 'change', group: g, change: c } as GitNode }))
}

interface RawDir {
  dirs: Map<string, RawDir>
  changes: GitFileChange[]
}

// Nested folder tree: group the changes by their path segments, then emit dir
// and change rows. Single-child folder chains are folded into one row.
function buildTree(g: GroupNode) {
  const root: RawDir = { dirs: new Map(), changes: [] }
  for (const change of g.changes) {
    const parts = change.path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i])
      if (!next) {
        next = { dirs: new Map(), changes: [] }
        cur.dirs.set(parts[i], next)
      }
      cur = next
    }
    cur.changes.push(change)
  }
  return emitDir(root, '', g)
}

function emitDir(dir: RawDir, parentPath: string, g: GroupNode): any[] {
  const out: any[] = []
  const names = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))
  for (const first of names) {
    let node = dir.dirs.get(first)!
    let name = first
    // Fold a chain of single-child, file-less folders into one label.
    while (node.dirs.size === 1 && node.changes.length === 0) {
      const [seg, only] = [...node.dirs.entries()][0]
      name += `/${seg}`
      node = only
    }
    const path = parentPath ? `${parentPath}/${name}` : name
    out.push({
      element: { type: 'dir', group: g, path, name } as GitNode,
      collapsible: true,
      children: emitDir(node, path, g)
    })
  }
  const files = dir.changes
    .slice()
    .sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)))
  for (const change of files) {
    out.push({ element: { type: 'change', group: g, change } as GitNode })
  }
  return out
}

function fileName(p: string): string {
  return p.split('/').pop() || p
}

function dirName(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? '' : p.slice(0, idx)
}
