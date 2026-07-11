import { useEffect, useRef, useState } from 'react'
import type { AcpUsageData, AcpUsageWindow } from '../../../shared/acp'
import { hostKey, useUsageStore } from '../acp/usage-store'

interface Props {
  /** Host whose account usage to show: null = local engine, else "user@host". */
  activeHost: string | null
}

/** Highest utilization across the windows — drives the bar's summary colour. */
function peakUtil(u: AcpUsageData | null | undefined): number {
  if (!u) return 0
  const wins = [u.five_hour, u.seven_day, u.seven_day_opus, u.seven_day_sonnet]
  return wins.reduce((m, w) => (w ? Math.max(m, w.utilization) : m), 0)
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

/** Bottom status bar: subscription usage limits for the active host's account. */
export function StatusBar({ activeHost }: Props) {
  const detail = useUsageStore((s) => s.byHost.get(hostKey(activeHost)))
  const refresh = useUsageStore((s) => s.refresh)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Dismiss the popover on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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
    setOpen(next)
    if (next) refresh(activeHost) // pull fresh numbers when opening
  }

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        {plan && <span className="status-item status-muted">{plan}</span>}
      </div>
      <div className="status-bar-right" ref={ref}>
        {open && (
          <div className="usage-popover" role="dialog">
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
          </div>
        )}
        <button
          type="button"
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
    </footer>
  )
}
