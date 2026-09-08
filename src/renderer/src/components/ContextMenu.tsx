import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** A clickable action. */
export interface MenuAction {
  separator?: false
  label: string
  enabled?: boolean
  checked?: boolean
  /** Rendered before the label — a colour swatch or icon. */
  icon?: ReactNode
  run: () => void
  submenu?: never
}

/** A row that opens a nested panel on hover instead of doing anything itself. */
export interface MenuSubmenu {
  separator?: false
  label: string
  enabled?: boolean
  submenu: MenuItem[]
  run?: never
}

export type MenuItem = { separator: true } | MenuAction | MenuSubmenu

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
  // Submenus render inside this host, so `contains` covers them too.
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

  return createPortal(
    <div ref={hostRef} className="context-menu-host" style={{ left: pos.x, top: pos.y }} role="menu">
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body
  )
}

// The rows of one panel — the root menu or a submenu. Recursive, so nesting is
// only bounded by what a caller builds.
function MenuItems({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const activate = (item: MenuAction): void => {
    if (item.enabled === false) return
    onClose()
    // A throwing action must not escape into React's event dispatch; report it.
    try {
      item.run()
    } catch (err) {
      console.error('Context menu action failed:', err)
    }
  }

  return (
    <>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" role="separator" />
        ) : item.submenu ? (
          <SubmenuRow key={i} item={item} onClose={onClose} />
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
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        )
      )}
    </>
  )
}

// A submenu row: opens its panel on hover (and on click, for a pointer that
// never hovers), closing when the pointer leaves the row and panel together.
// The panel is a child of the row rather than its own portal, so the parent's
// outside-click handler treats clicks inside it as inside the menu.
function SubmenuRow({ item, onClose }: { item: MenuSubmenu; onClose: () => void }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Opens to the right by default; flips left when that would run off-screen.
  const [flip, setFlip] = useState(false)
  const disabled = item.enabled === false

  useLayoutEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth) setFlip(true)
  }, [open])

  return (
    <div
      className="context-menu-sub"
      onMouseEnter={() => !disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`context-menu-item${disabled ? ' disabled' : ''}`}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="context-menu-check" />
        <span className="context-menu-label">{item.label}</span>
        <span className="context-menu-arrow">›</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          className={`context-menu-host context-menu-panel${flip ? ' flip' : ''}`}
          role="menu"
        >
          <MenuItems items={item.submenu} onClose={onClose} />
        </div>
      )}
    </div>
  )
}
