import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
// VS Code's real context menu widget, reused from monaco-editor's esm distribution
import { Menu } from 'monaco-editor/esm/vs/base/browser/ui/menu/menu.js'
import { Action, Separator } from 'monaco-editor/esm/vs/base/common/actions.js'
import { defaultMenuStyles } from 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js'

export type MenuItem =
  | { separator: true }
  | { separator?: false; label: string; enabled?: boolean; checked?: boolean; run: () => void }

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current!

    const actions = items.map((item) => {
      if (item.separator) return new Separator()
      const action = new Action(item.label, item.label, undefined, item.enabled !== false, async () => {
        onClose()
        item.run()
      })
      // the vs/base Menu renders a check mark for checked actions
      action.checked = item.checked
      return action
    })

    const menu = new Menu(host, actions, {}, defaultMenuStyles)
    const cancelListener = menu.onDidCancel?.(() => onClose())
    menu.focus?.(0)

    // keep the menu inside the window
    const rect = host.getBoundingClientRect()
    if (rect.right > window.innerWidth) host.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`
    if (rect.bottom > window.innerHeight) host.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`

    const onMouseDown = (e: MouseEvent) => {
      if (!host.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown, true)

    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      cancelListener?.dispose?.()
      menu.dispose()
      host.textContent = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div ref={hostRef} className="context-menu-host" style={{ left: x, top: y }} />,
    document.body
  )
}
