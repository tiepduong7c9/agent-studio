import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AcpUsageWindow } from '../../../shared/acp'
import type { ProjectInfo } from '../../../shared/types'
import { hostKey, peakUtil, useUsageStore } from '../acp/usage-store'
import { gitGraphTabId, terminalTabId, useTabsStore } from '../tabs-store'
import { useTransferStore, type Transfer } from '../transfer-store'

interface Props {
  /** Host whose account usage to show: null = local engine, else "user@host". */
  activeHost: string | null
  /** Workspace of the active tab — drives the branch indicator + graph button. */
  activeWorkspace: ProjectInfo | null
  // Panel geometry, so the branch/graph items line up under the editor column.
  leftWidth: number
  rightWidth: number
  leftVisible: boolean
  rightVisible: boolean
  maximized: boolean
}

function level(pct: number): string {
  return pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : ''
}

function fmtResets(iso?: string): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Resets now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `Resets in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `Resets in ${h}h`
  return `Resets in ${Math.floor(h / 24)}d`
}

const planLabel = (t?: string): string | null =>
  t ? `Claude ${t.charAt(0).toUpperCase()}${t.slice(1)}` : null

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Live upload/download indicator: the most recent transfer, its percent (or
 *  bytes moved when the total is unknown), and a "+N" count for any others. */
function TransferIndicator({ transfers }: { transfers: Transfer[] }) {
  const t = transfers[transfers.length - 1]
  if (!t) return null
  const verb = t.kind === 'upload' ? 'Uploading' : 'Downloading'
  const icon = t.kind === 'upload' ? 'cloud-upload' : 'cloud-download'
  const detail =
    t.total > 0
      ? `${Math.min(100, Math.round((t.transferred / t.total) * 100))}%`
      : fmtBytes(t.transferred)
  const extra = transfers.length - 1
  return (
    <span className="status-item status-transfer" title={`${verb} ${t.name}`}>
      <span className={`codicon codicon-${icon} status-transfer-icon`} />
      <span className="status-transfer-label">
        {t.name} {detail}
        {extra > 0 ? ` (+${extra})` : ''}
      </span>
    </span>
  )
}

function UsageBar({ label, win }: { label: string; win?: AcpUsageWindow | null }) {
  if (!win) return null
  const pct = Math.max(0, Math.min(100, Math.round(win.utilization)))
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span>{label}</span>
        <span className="usage-row-pct">{pct}%</span>
      </div>
      <div className={`usage-meter wide${level(pct)}`}>
        <span className="usage-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="usage-row-reset">{fmtResets(win.resets_at)}</div>
    </div>
  )
}

/** Bottom status bar: current branch + git-graph launcher (aligned under the
 *  editor column) on the left, subscription usage on the right. */
export function StatusBar({
  activeHost, activeWorkspace,
  leftWidth, rightWidth, leftVisible, rightVisible, maximized
}: Props) {
  const detail = useUsageStore((s) => s.byHost.get(hostKey(activeHost)))
  const refresh = useUsageStore((s) => s.refresh)
  const transfers = useTransferStore((s) => s.transfers)
  const [open, setOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  // Anchor coords for the portaled popover (fixed, relative to the viewport).
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Fetch the active workspace's branch. Refetched when the workspace changes,
  // and kept current with external branch switches (e.g. `git checkout` in a
  // terminal) by re-polling on window focus and on a slow interval while the
  // window is visible — there's no fs watcher to notify us otherwise.
  const wsId = activeWorkspace?.id ?? null
  useEffect(() => {
    let cancelled = false
    setBranch(null)
    if (!wsId) return

    const load = async () => {
      const res = await window.studio.gitStatus(wsId)
      if (!cancelled && res.ok && res.data.isRepo) setBranch(res.data.branch ?? null)
    }
    load()

    const onFocus = () => {
      if (document.visibilityState === 'visible') load()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const timer = window.setInterval(onFocus, 5000)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(timer)
    }
  }, [wsId])

  const openGraph = () => {
    if (!activeWorkspace) return
    // Own the tab by the persistent session context (the store's activeSid), not
    // the prop — the prop is null whenever a non-chat tab is active, and the tab
    // strip filters by the store's value, so using the prop would hide the tab.
    const ownerSid = useTabsStore.getState().activeSid
    useTabsStore.getState().open({
      id: gitGraphTabId(ownerSid, activeWorkspace.id),
      kind: 'git-graph',
      title: 'Git Graph',
      wsId: activeWorkspace.id,
      ownerSid
    })
  }

  const openTerminal = () => {
    if (!activeWorkspace) return
    // Same as openGraph: own by the store's session context so the tab is visible
    // even when the click happens while another terminal/file tab is active.
    const ownerSid = useTabsStore.getState().activeSid
    // Each click opens a new terminal; number them per session (Terminal,
    // Terminal 2, …) so several can be open side by side.
    const count = useTabsStore
      .getState()
      .tabs.filter(
        (t) => t.kind === 'terminal' && t.ownerSid === ownerSid && t.wsId === activeWorkspace.id
      ).length
    useTabsStore.getState().open({
      id: terminalTabId(ownerSid, activeWorkspace.id, crypto.randomUUID()),
      kind: 'terminal',
      title: count === 0 ? 'Terminal' : `Terminal ${count + 1}`,
      wsId: activeWorkspace.id,
      ownerSid,
      cwd: activeWorkspace.rootPath,
      host: activeWorkspace.host ?? null
    })
  }

  // Left segment spans the sidebar (+1px border) so the center segment — and
  // thus the branch/graph items — begins at the editor column's left edge.
  const leftSegW = leftVisible && !maximized ? leftWidth + 1 : 0
  // Right segment spans the right panel column so the transfer indicator lines up
  // under it (auto width — content only — when the panel is hidden/maximized).
  const rightSegW = rightVisible && !maximized ? rightWidth + 1 : undefined

  // Dismiss the popover on an outside click. The popover is portaled to
  // <body> (see below), so it's outside `ref` — check it separately.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const usage = detail?.usage ?? null
  const account = detail?.account ?? null
  const plan = planLabel(account?.subscriptionType)

  const five = usage?.five_hour ? Math.round(usage.five_hour.utilization) : null
  const seven = usage?.seven_day ? Math.round(usage.seven_day.utilization) : null
  const peak = peakUtil(usage)

  const toggle = () => {
    const next = !open
    if (next) {
      const r = btnRef.current?.getBoundingClientRect()
      if (r)
        setAnchor({
          right: window.innerWidth - r.right,
          bottom: window.innerHeight - r.top + 6
        })
      refresh(activeHost) // pull fresh numbers when opening
    }
    setOpen(next)
  }

  return (
    <footer className="status-bar">
      <div className="status-seg status-bar-left" style={{ width: leftSegW }}>
        {plan && <span className="status-item status-muted">{plan}</span>}
      </div>
      <div className="status-seg status-bar-center">
        {branch && (
          <span className="status-item status-branch" title={`On branch ${branch}`}>
            <span className="codicon codicon-git-branch" />
            {branch}
          </span>
        )}
        {activeWorkspace && (
          <button
            type="button"
            className="status-item status-graph-btn"
            title="Open Git Graph"
            onClick={openGraph}
          >
            <span className="codicon codicon-git-commit" />
            Graph
          </button>
        )}
        {activeWorkspace && (
          <button
            type="button"
            className="status-item status-graph-btn"
            title="Open Terminal"
            onClick={openTerminal}
          >
            <span className="codicon codicon-terminal" />
            Terminal
          </button>
        )}
        <div className="status-usage" ref={ref}>
          {open &&
            anchor &&
            createPortal(
              <div
                className="usage-popover"
                role="dialog"
                ref={popRef}
                style={{ right: anchor.right, bottom: anchor.bottom }}
              >
                <div className="usage-popover-head">
                  <span>Subscription usage</span>
                  {account?.email && <span className="usage-popover-email">{account.email}</span>}
                </div>
                {usage ? (
                  <>
                    <UsageBar label="Session (5h)" win={usage.five_hour} />
                    <UsageBar label="Weekly (7d)" win={usage.seven_day} />
                    <UsageBar label="Weekly Opus" win={usage.seven_day_opus} />
                    <UsageBar label="Weekly Sonnet" win={usage.seven_day_sonnet} />
                    {usage.extra_usage && usage.extra_usage.used_credits > 0 && (
                      <div className="usage-row-extra">
                        <span>Extra usage</span>
                        <span>
                          {usage.extra_usage.used_credits} {usage.extra_usage.currency}
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="usage-empty">Usage data unavailable.</div>
                )}
              </div>,
              document.body
            )}
          <button
            type="button"
            ref={btnRef}
            className={`status-item status-usage-btn${open ? ' active' : ''}`}
            onClick={toggle}
            title="Subscription usage"
          >
            {usage ? (
              <>
                <span className={`usage-dot${level(peak)}`} />
                <span className="usage-summary">
                  5h <span className="usage-num">{five ?? 0}%</span>
                  <span className="usage-sep"> · </span>7d{' '}
                  <span className="usage-num">{seven ?? 0}%</span>
                </span>
              </>
            ) : (
              <span className="status-muted">
                {detail === null ? 'Usage…' : 'Usage —'}
              </span>
            )}
          </button>
        </div>
      </div>
      <div className="status-bar-right" style={{ width: rightSegW }}>
        {transfers.length > 0 && <TransferIndicator transfers={transfers} />}
      </div>
    </footer>
  )
}
