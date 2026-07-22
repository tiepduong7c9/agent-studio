import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'lucide-react'
import type { BrowserChoice } from '../../../shared/types'
import { browserTabId, useTabsStore } from '../tabs-store'
import { useSessionLinks } from '../session-links'
import { ContextMenu, type MenuItem } from './ContextMenu'

/** Hostname for a link, for the tab title and compact row label. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The path/query/hash after the host — shown dimmed next to the host. */
function restOf(url: string): string {
  try {
    const u = new URL(url)
    const rest = u.pathname + u.search + u.hash
    return rest === '/' ? '' : rest
  } catch {
    return ''
  }
}

/**
 * Composer control that surfaces every http(s) link mentioned in the session
 * (by you or Claude), deduped, in a popover. Clicking a link opens it in an
 * in-app browser tab; right-click / the ⋯ button picks a different target
 * (system default or a specific installed browser).
 */
export function SessionLinksButton({ sid, wsId }: { sid: string; wsId: string | null }) {
  const links = useSessionLinks(sid)
  const openTab = useTabsStore((s) => s.open)
  const [open, setOpen] = useState(false)
  // Detected browsers, fetched once lazily when a target menu is first opened.
  const browsersRef = useRef<BrowserChoice[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // The modal is portaled to <body> (centered), so outside-click is handled by
  // the backdrop; here we only close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const openInApp = (url: string): void => {
    // The in-app browser only needs the URL — no workspace required — so open it
    // even for sessions with no workspace (wsId is '' there, still valid).
    openTab({
      id: browserTabId(sid, wsId ?? '', url),
      kind: 'browser',
      title: hostOf(url),
      url,
      wsId: wsId ?? '',
      ownerSid: sid
    })
    setOpen(false)
  }

  const openExternal = (url: string, browserId: string): void => {
    window.studio.links.openIn(url, browserId).catch(() => {})
  }

  const openWindow = (url: string): void => {
    window.studio.links.openInWindow(url).catch(() => {})
  }

  const showTargetMenu = async (e: MouseEvent, url: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const { clientX: x, clientY: y } = e
    if (!browsersRef.current) {
      const res = await window.studio.links.listBrowsers()
      browsersRef.current = res.ok ? res.data : [{ id: 'default', name: 'System default' }]
    }
    const items: MenuItem[] = [
      { label: 'Open in app', run: () => openInApp(url) },
      { label: 'Open in new window', run: () => openWindow(url) },
      { separator: true },
      ...browsersRef.current.map((b) => ({
        label: b.id === 'default' ? 'Open in system default' : `Open in ${b.name}`,
        run: () => openExternal(url, b.id)
      })),
      { separator: true },
      { label: 'Copy link', run: () => navigator.clipboard?.writeText(url).catch(() => {}) }
    ]
    setMenu({ x, y, items })
  }

  return (
    <>
      <button
        className="acp-btn acp-links-toggle"
        title={links.length ? `Session links (${links.length})` : 'Session links'}
        onClick={() => setOpen((o) => !o)}
      >
        <Link size={14} />
        {links.length > 0 && <span className="acp-links-badge">{links.length}</span>}
      </button>
      {open &&
        createPortal(
          <div
            className="acp-links-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpen(false)
            }}
          >
            <div className="acp-links-modal" role="dialog" aria-label="Session links">
              <div className="acp-links-modal-header">
                <Link size={14} />
                <span className="acp-links-modal-title">Links</span>
                {links.length > 0 && <span className="acp-links-count">{links.length}</span>}
                <button
                  className="acp-links-close codicon codicon-close"
                  title="Close"
                  onClick={() => setOpen(false)}
                />
              </div>
              <div className="acp-links-modal-body">
                {links.length === 0 && (
                  <div className="acp-links-empty">No links in this session yet</div>
                )}
                {links.map((link) => (
                  <div
                    key={link.url}
                    className="acp-links-item"
                    title={link.url}
                    onClick={() => openInApp(link.url)}
                    onContextMenu={(e) => showTargetMenu(e, link.url)}
                  >
                    <span
                      className={`acp-links-src acp-links-src-${link.source}`}
                      title={link.source === 'user' ? 'Sent by you' : 'Sent by Claude'}
                    >
                      {link.source === 'user' ? 'You' : 'Claude'}
                    </span>
                    <span className="acp-links-url">
                      <span className="acp-links-host">{hostOf(link.url)}</span>
                      <span className="acp-links-rest">{restOf(link.url)}</span>
                    </span>
                    <button
                      className="acp-links-more codicon codicon-chevron-down"
                      title="Open in…"
                      onClick={(e) => {
                        e.stopPropagation()
                        showTargetMenu(e, link.url)
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  )
}
