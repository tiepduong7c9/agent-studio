import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | { separator: true }
  | { separator?: false; label: string; enabled?: boolean; checked?: boolean; run: () => void }

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

// A lightweight context menu rendered as plain DOM (portaled to <body>).
// Previously this wrapped monaco's vs/base Menu widget, but constructing that
// heavyweight widget inside an effect could throw and — before error
// boundaries existed — blanked the whole window on right-click. A handful of
// simple items don't need it.
export function ContextMenu({ x, y, items, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Once measured, nudge the menu back inside the viewport.
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth ? Math.max(0, window.innerWidth - rect.width - 4) : x
    const ny = y + rect.height > window.innerHeight ? Math.max(0, window.innerHeight - rect.height - 4) : y
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  // Close on outside click / another right-click / Escape. Attaching on the next
  // tick avoids the opening right-click's own event immediately closing it.
  useEffect(() => {
    const outside = (e: Event) => {
      if (!hostRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', outside, true)
      window.addEventListener('contextmenu', outside, true)
    }, 0)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('contextmenu', outside, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const activate = (item: Extract<MenuItem, { separator?: false }>): void => {
    if (item.enabled === false) return
    onClose()
    // A throwing action must not escape into React's event dispatch; report it.
    try {
      item.run()
    } catch (err) {
      console.error('Context menu action failed:', err)
    }
  }

  return createPortal(
    <div ref={hostRef} className="context-menu-host" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            className={`context-menu-item${item.enabled === false ? ' disabled' : ''}`}
            role="menuitem"
            disabled={item.enabled === false}
            onClick={() => activate(item)}
          >
            <span className="context-menu-check">{item.checked ? '✓' : ''}</span>
            <span className="context-menu-label">{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
