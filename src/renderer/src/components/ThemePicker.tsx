import { useState } from 'react'
import { SunMoon } from 'lucide-react'
import { applyTheme, availableThemes, getStoredThemeId } from '../theme'
import { ContextMenu, type MenuItem } from './ContextMenu'

// Titlebar control that switches the color theme, VS Code-style. Applying a
// theme reinjects the --vscode-* variables on :root, so the reused vs/base
// widgets and the monaco editor re-theme live — no reload, no React re-render
// of the app tree needed.
// `activity`: drawn as an activity bar item, with the menu opening beside it.
export function ThemePicker({ variant = 'titlebar' }: { variant?: 'titlebar' | 'activity' }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState(getStoredThemeId())

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(
      variant === 'activity'
        ? { x: Math.round(r.right + 4), y: Math.round(r.top) }
        : { x: Math.round(r.left), y: Math.round(r.bottom + 2) }
    )
  }

  const items: MenuItem[] = availableThemes().map((t) => ({
    label: t.label,
    checked: t.id === current,
    run: () => {
      applyTheme(t.id)
      setCurrent(t.id)
    }
  }))

  return (
    <>
      {variant === 'activity' ? (
        <button className={`activity-bar-item ${menu ? 'open' : ''}`} title="Select Color Theme" onClick={open}>
          <SunMoon size={22} strokeWidth={1.6} />
        </button>
      ) : (
        <button className="icon-button codicon codicon-color-mode" title="Select Color Theme" onClick={open} />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}
