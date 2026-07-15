import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
// VS Code's real tree widget, reused from monaco-editor's esm distribution.
// The compressible variant folds single-child folder chains into one row
// ("@esbuild / linux-x64"), like the agent window's Files view.
import { CompressibleAsyncDataTree } from 'monaco-editor/esm/vs/base/browser/ui/tree/asyncDataTree.js'
import * as defaultStyles from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'
import type { FileEntry, ProjectInfo, Result } from '../../../shared/types'
import type { Selection, SelectHandler } from '../selection'
import { useToastStore } from '../toast-store'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConfirmDialog, ErrorDialog, PromptDialog } from './Dialogs'
import { fileIconStyle } from './FileIcon'
import type { PanelHandle } from './RightPanel'

interface Props {
  project: ProjectInfo
  selection: Selection | null
  onSelect: SelectHandler
  /** Case-insensitive substring; hides non-matching (loaded) entries. */
  filter?: string
}

type RootInput = { root: true }
type TreeNode = ProjectInfo | FileEntry

const isProject = (n: TreeNode): n is ProjectInfo => 'rootPath' in n

type Dialog =
  | { kind: 'prompt'; title: string; initialValue?: string; submitLabel?: string; onSubmit: (v: string) => void }
  | { kind: 'confirm'; message: string; detail?: string; confirmLabel?: string; onConfirm: () => void }
  | { kind: 'error'; message: string }

export const FileTree = forwardRef<PanelHandle, Props>(function FileTree(
  { project, onSelect, filter = '' },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<any>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const pushToast = useToastStore((s) => s.push)
  // The tree's filter callback reads the live (lowercased) query from here.
  const filterRef = useRef('')

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

  // Upload into `destDir`. `sourcePaths` given → a drag-drop (upload those);
  // omitted → open the native picker in the main process. Progress shows in the
  // status bar; on completion we toast and refresh the tree.
  const runUpload = useCallback(
    async (destDir: string, sourcePaths?: string[]) => {
      const res = await window.studio.uploadFiles(project.id, destDir, sourcePaths)
      if (!res.ok) {
        setDialog({ kind: 'error', message: res.error })
        return
      }
      const n = res.data.uploaded
      if (n > 0) {
        pushToast('info', `Uploaded ${n} item${n === 1 ? '' : 's'}`)
        refresh()
      }
    },
    [project, refresh, pushToast]
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
      if (isDir) {
        items.push({
          label: 'Upload…',
          run: () => runUpload(newEntryDir)
        })
      }
      if (!isRoot) {
        items.push({
          label: 'Download…',
          run: async () => {
            const res = await window.studio.downloadPath(project.id, targetPath, isDir ? 'dir' : 'file')
            if (!res.ok) {
              setDialog({ kind: 'error', message: res.error })
              return
            }
            if (res.data.saved) pushToast('info', `Downloaded to ${res.data.path}`)
          }
        })
      }
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
    [project, refresh, runOp, runUpload, pushToast]
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
        const row = t.name.parentElement as HTMLElement
        row.title = isProject(el) ? el.rootPath : el.path
        // Drop-target metadata read by the drag-drop upload handler.
        row.dataset.entryPath = isProject(el) ? el.rootPath : el.path
        row.dataset.entryDir = isProject(el) || el.kind === 'dir' ? '1' : ''
      },
      renderCompressedElements(node: any, _index: number, t: { icon: HTMLSpanElement; name: HTMLSpanElement; decoration: HTMLSpanElement }) {
        const chain: TreeNode[] = node.element.elements
        t.icon.style.display = 'none'
        t.decoration.style.display = 'none'
        t.name.textContent = chain.map((e) => e.name).join(' / ')
        const last = chain[chain.length - 1]
        const row = t.name.parentElement as HTMLElement
        row.title = isProject(last) ? last.rootPath : (last as FileEntry).path
        // Compressed chains are folder runs, so the row is always a directory.
        row.dataset.entryPath = isProject(last) ? last.rootPath : (last as FileEntry).path
        row.dataset.entryDir = '1'
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
      },
      // Files match on name; the project root and folders recurse so they show
      // only when a descendant matches. (0=hide, 1=show, 2=recurse)
      filter: {
        filter(el: TreeNode) {
          const q = filterRef.current
          if (!q) return 1
          if (isProject(el) || el.kind === 'dir') return 2
          return el.name.toLowerCase().includes(q) ? 1 : 0
        }
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

  // OS drag-drop upload: drop files/folders from the desktop onto the tree.
  // Dropping onto a folder row targets that folder, a file row its parent, and
  // empty space the project root — matching VS Code's explorer.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      container.classList.add('drag-over')
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) container.classList.remove('drag-over')
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      container.classList.remove('drag-over')
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.studio.getPathForFile(f))
        .filter(Boolean)
      if (paths.length === 0) return
      const row = (e.target as HTMLElement | null)?.closest?.('.entry-label') as HTMLElement | null
      const rowPath = row?.dataset.entryPath
      const destDir = rowPath
        ? row!.dataset.entryDir
          ? rowPath
          : parentOf(rowPath)
        : project.rootPath
      runUpload(destDir, paths)
    }
    // Capture phase so these fire even though monaco's list owns the subtree.
    const opts = { capture: true }
    container.addEventListener('dragover', onOver, opts)
    container.addEventListener('dragenter', onEnter, opts)
    container.addEventListener('dragleave', onLeave, opts)
    container.addEventListener('drop', onDrop, opts)
    return () => {
      container.removeEventListener('dragover', onOver, opts)
      container.removeEventListener('dragenter', onEnter, opts)
      container.removeEventListener('dragleave', onLeave, opts)
      container.removeEventListener('drop', onDrop, opts)
    }
  }, [project, runUpload])

  // Re-run the filter whenever the query changes. The AsyncDataTree proxies
  // refilter to its inner ObjectTree (`.tree`), so call it there.
  useEffect(() => {
    filterRef.current = filter.trim().toLowerCase()
    const inner = (treeRef.current as any)?.tree
    inner?.refilter?.()
  }, [filter])

  useImperativeHandle(ref, () => ({
    collapseAll() {
      const tree = treeRef.current
      if (!tree) return
      // Collapse everything under the project, then re-open the project so its
      // top-level entries stay visible (matches VS Code's Collapse All).
      tree.collapse(project, true)
      tree.expand(project).catch(() => {})
    }
  }))

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
})

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
