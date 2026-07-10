import { useCallback, useEffect, useRef, useState } from 'react'
// VS Code's real tree widget, reused from monaco-editor's esm distribution.
// The compressible variant folds single-child folder chains into one row
// ("@esbuild / linux-x64"), like the agent window's Files view.
import { CompressibleAsyncDataTree } from 'monaco-editor/esm/vs/base/browser/ui/tree/asyncDataTree.js'
import * as defaultStyles from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'
import type { FileEntry, ProjectInfo, Result } from '../../../shared/types'
import type { Selection, SelectHandler } from '../selection'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConfirmDialog, ErrorDialog, PromptDialog } from './Dialogs'
import { fileIconStyle } from './FileIcon'

interface Props {
  project: ProjectInfo
  selection: Selection | null
  onSelect: SelectHandler
}

type RootInput = { root: true }
type TreeNode = ProjectInfo | FileEntry

const isProject = (n: TreeNode): n is ProjectInfo => 'rootPath' in n

type Dialog =
  | { kind: 'prompt'; title: string; initialValue?: string; submitLabel?: string; onSubmit: (v: string) => void }
  | { kind: 'confirm'; message: string; detail?: string; confirmLabel?: string; onConfirm: () => void }
  | { kind: 'error'; message: string }

export function FileTree({ project, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<any>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const refresh = useCallback(() => {
    const tree = treeRef.current
    if (!tree) return
    // updateChildren is not exposed on the shipped AsyncDataTree build
    const update = tree.updateChildren ?? tree._updateChildren
    update?.call(tree)?.catch?.(() => {})
  }, [])

  const runOp = useCallback(
    async (op: Promise<Result<void>>) => {
      const result = await op
      if (!result.ok) setDialog({ kind: 'error', message: result.error })
      refresh()
    },
    [refresh]
  )

  const buildMenuItems = useCallback(
    (el: TreeNode | null): MenuItem[] => {
      const root = project.rootPath
      const isRoot = !el || isProject(el)
      const targetPath = isRoot ? root : (el as FileEntry).path
      const isDir = isRoot || (el as FileEntry).kind === 'dir'
      const parentDir = isRoot ? root : parentOf(targetPath)
      const newEntryDir = isDir ? targetPath : parentDir

      const items: MenuItem[] = []

      if (!isRoot && !isDir) {
        items.push({
          label: 'Open',
          run: () => onSelectRef.current({ kind: 'file', wsId: project.id, path: targetPath, name: baseName(targetPath) }, { preview: false })
        })
        items.push({ separator: true })
      }

      items.push({
        label: 'New File…',
        run: () =>
          setDialog({
            kind: 'prompt',
            title: 'New File',
            submitLabel: 'Create',
            onSubmit: (name) => {
              setDialog(null)
              runOp(window.studio.createFile(project.id, joinPath(newEntryDir, name)))
            }
          })
      })
      items.push({
        label: 'New Folder…',
        run: () =>
          setDialog({
            kind: 'prompt',
            title: 'New Folder',
            submitLabel: 'Create',
            onSubmit: (name) => {
              setDialog(null)
              runOp(window.studio.createDir(project.id, joinPath(newEntryDir, name)))
            }
          })
      })
      items.push({ separator: true })
      items.push({
        label: 'Copy Path',
        run: () => navigator.clipboard.writeText(targetPath)
      })
      if (!isRoot) {
        items.push({
          label: 'Copy Relative Path',
          run: () => navigator.clipboard.writeText(relativeTo(root, targetPath))
        })
        items.push({ separator: true })
        items.push({
          label: 'Rename…',
          run: () =>
            setDialog({
              kind: 'prompt',
              title: `Rename '${baseName(targetPath)}'`,
              initialValue: baseName(targetPath),
              submitLabel: 'Rename',
              onSubmit: (name) => {
                setDialog(null)
                if (name !== baseName(targetPath)) {
                  runOp(window.studio.renamePath(project.id, targetPath, joinPath(parentDir, name)))
                }
              }
            })
        })
        items.push({
          label: 'Delete',
          run: () =>
            setDialog({
              kind: 'confirm',
              message: `Are you sure you want to delete '${baseName(targetPath)}'?`,
              detail:
                project.kind === 'local'
                  ? 'You can restore it from the trash.'
                  : 'This permanently deletes it on the remote host.',
              confirmLabel: project.kind === 'local' ? 'Move to Trash' : 'Delete',
              onConfirm: () => {
                setDialog(null)
                runOp(window.studio.deletePath(project.id, targetPath))
              }
            })
        })
      }
      items.push({ separator: true })
      if (project.kind === 'local') {
        items.push({
          label: 'Reveal in File Manager',
          run: () => window.studio.revealInFileManager(targetPath)
        })
      }
      items.push({ label: 'Refresh', run: refresh })

      return items
    },
    [project, refresh, runOp]
  )
  const buildMenuItemsRef = useRef(buildMenuItems)
  buildMenuItemsRef.current = buildMenuItems

  useEffect(() => {
    const container = containerRef.current!

    const dataSource = {
      hasChildren: (n: RootInput | TreeNode) =>
        ('root' in n && n.root === true) || isProject(n as TreeNode) || (n as FileEntry).kind === 'dir',
      getChildren: async (n: RootInput | TreeNode): Promise<TreeNode[]> => {
        if ('root' in n && n.root === true) return [project]
        const dir = isProject(n as TreeNode) ? (n as ProjectInfo).rootPath : (n as FileEntry).path
        const result = await window.studio.readDir(project.id, dir)
        if (!result.ok) throw new Error(result.error)
        return sortEntries(result.data)
      }
    }

    const delegate = {
      getHeight: () => 22,
      getTemplateId: () => 'entry'
    }

    const renderer = {
      templateId: 'entry',
      renderTemplate(templateContainer: HTMLElement) {
        const row = document.createElement('div')
        row.className = 'entry-label'
        const icon = document.createElement('span')
        icon.className = 'seti-icon'
        const name = document.createElement('span')
        name.className = 'label-name'
        const decoration = document.createElement('span')
        decoration.className = 'symlink-decoration'
        decoration.textContent = '⤷'
        row.append(icon, name, decoration)
        templateContainer.appendChild(row)
        return { icon, name, decoration }
      },
      renderElement(node: any, _index: number, t: { icon: HTMLSpanElement; name: HTMLSpanElement; decoration: HTMLSpanElement }) {
        const el: TreeNode = node.element
        const isFile = !isProject(el) && el.kind !== 'dir'
        if (isFile) {
          const { glyph, color } = fileIconStyle(el.name)
          t.icon.style.display = ''
          t.icon.style.color = color
          t.icon.textContent = glyph
        } else {
          t.icon.style.display = 'none'
        }
        t.decoration.style.display = !isProject(el) && el.symlink ? '' : 'none'
        t.name.textContent = el.name
        t.name.parentElement!.title = isProject(el) ? el.rootPath : el.path
      },
      renderCompressedElements(node: any, _index: number, t: { icon: HTMLSpanElement; name: HTMLSpanElement; decoration: HTMLSpanElement }) {
        const chain: TreeNode[] = node.element.elements
        t.icon.style.display = 'none'
        t.decoration.style.display = 'none'
        t.name.textContent = chain.map((e) => e.name).join(' / ')
        const last = chain[chain.length - 1]
        t.name.parentElement!.title = isProject(last) ? last.rootPath : (last as FileEntry).path
      },
      disposeTemplate() {}
    }

    const compressionDelegate = {
      isIncompressible: (el: TreeNode) => isProject(el) || (el as FileEntry).kind !== 'dir'
    }

    const tree = new CompressibleAsyncDataTree('AgentStudioFiles', container, delegate, compressionDelegate, [renderer], dataSource, {
      identityProvider: {
        getId: (el: TreeNode) => (isProject(el) ? `project:${el.rootPath}` : el.path)
      },
      // matches VS Code's defaults: "workbench.tree.renderIndentGuides": "onHover",
      // "workbench.tree.expandMode": "singleClick"
      renderIndentGuides: 'onHover',
      expandOnlyOnTwistieClick: false,
      // expanding "@esbuild" walks straight into the compressed chain
      autoExpandSingleChildren: true,
      accessibilityProvider: {
        getAriaLabel: (el: TreeNode) => (isProject(el) ? el.name : el.name),
        getWidgetAriaLabel: () => 'Files'
      }
    })
    treeRef.current = tree

    const styles = (defaultStyles as any).defaultListStyles ?? (defaultStyles as any).getListStyles?.({})
    if (styles) tree.style(styles)

    tree.setInput({ root: true }).then(() => tree.expand(project).catch(() => {}))

    // Single click previews the file in the transient tab; it's kept permanent
    // via the tab's right-click menu ("Keep Open").
    const openListener = tree.onDidChangeSelection((e: any) => {
      const el: TreeNode | undefined = e.elements?.[0]
      if (el && !isProject(el) && el.kind !== 'dir') {
        onSelectRef.current({ kind: 'file', wsId: project.id, path: el.path, name: el.name }, { preview: true })
      }
    })

    // AsyncDataTree doesn't proxy onContextMenu; the inner ObjectTree's event
    // carries the async node wrapper, so unwrap `.element` once more.
    const innerTree = (tree as any).tree
    const contextListener = innerTree?.onContextMenu?.((e: any) => {
      e.browserEvent.preventDefault()
      e.browserEvent.stopPropagation()
      // unwrap compressed-chain nodes (take the deepest element, like the
      // explorer does) and the async node wrapper
      let el: any = e.element
      if (el && Array.isArray(el.elements)) el = el.elements[el.elements.length - 1]
      if (el && typeof el === 'object' && 'element' in el) el = el.element
      if (el && Array.isArray(el.elements)) el = el.elements[el.elements.length - 1]
      setMenu({
        x: e.browserEvent.clientX,
        y: e.browserEvent.clientY,
        items: buildMenuItemsRef.current(el && el !== null ? el : null)
      })
    })

    const resize = () => tree.layout(container.clientHeight, container.clientWidth)
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    return () => {
      observer.disconnect()
      openListener.dispose()
      contextListener?.dispose?.()
      tree.dispose()
      treeRef.current = null
      container.textContent = ''
    }
  }, [project])

  return (
    <>
      <div ref={containerRef} className="widget-tree" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'prompt' && (
        <PromptDialog
          title={dialog.title}
          initialValue={dialog.initialValue}
          submitLabel={dialog.submitLabel}
          onSubmit={dialog.onSubmit}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          message={dialog.message}
          detail={dialog.detail}
          confirmLabel={dialog.confirmLabel}
          danger
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'error' && (
        <ErrorDialog message={dialog.message} onClose={() => setDialog(null)} />
      )}
    </>
  )
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((e) => e.name !== '.git').sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function relativeTo(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, '') : p
}
