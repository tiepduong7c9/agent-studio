import { create } from 'zustand'
import type { AcpUsageData, AcpUsageWindow, AcpUsageDetail } from '../../../shared/acp'

// Per-host subscription usage (account + rate-limit windows). Keyed by host
// string; local is keyed by '' (null host). Fetched out-of-band from the owning
// engine and refreshed on an interval — see App's polling effect.

/** Map key for a host: '' for the local engine, else "user@host". */
export const hostKey = (host?: string | null): string => host ?? ''

/** The rate-limit windows we surface, in display order, with human labels. */
export const USAGE_WINDOWS: { key: keyof AcpUsageData; label: string }[] = [
  { key: 'five_hour', label: '5-hour' },
  { key: 'seven_day', label: '7-day' },
  { key: 'seven_day_opus', label: '7-day Opus' },
  { key: 'seven_day_sonnet', label: '7-day Sonnet' }
]

const windowsOf = (u?: AcpUsageData | null): { label: string; win: AcpUsageWindow }[] =>
  u
    ? USAGE_WINDOWS.flatMap(({ key, label }) => {
        const win = u[key] as AcpUsageWindow | null | undefined
        return win ? [{ label, win }] : []
      })
    : []

/** Highest utilization (0–100) across the windows — drives the summary colour. */
export function peakUtil(u?: AcpUsageData | null): number {
  return windowsOf(u).reduce((m, { win }) => Math.max(m, win.utilization), 0)
}

/** Label of the window currently at peak utilization (null if none). */
export function peakWindowLabel(u?: AcpUsageData | null): string | null {
  let best: { label: string; util: number } | null = null
  for (const { label, win } of windowsOf(u)) {
    if (!best || win.utilization > best.util) best = { label, util: win.utilization }
  }
  return best?.label ?? null
}

interface UsageStore {
  /** hostKey -> latest detail (null while a first fetch is in flight). */
  byHost: Map<string, AcpUsageDetail | null>
  /** Fetch (or re-fetch) one host's usage and store the result. */
  refresh: (host?: string | null) => Promise<void>
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  byHost: new Map(),

  refresh: async (host) => {
    const key = hostKey(host)
    // Mark as loading only on the very first fetch, so a periodic refresh
    // doesn't flash the bar back to a placeholder.
    if (!get().byHost.has(key)) {
      set((s) => ({ byHost: new Map(s.byHost).set(key, null) }))
    }
    try {
      const detail = await window.studio.acp.getUsage(host ?? null)
      set((s) => ({ byHost: new Map(s.byHost).set(key, detail) }))
    } catch {
      // Leave the previous value in place on a transient failure.
    }
  },
}))
