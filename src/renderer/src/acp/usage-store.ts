import { create } from 'zustand'
import type { AcpUsageDetail } from '../../../shared/acp'

// Per-host subscription usage (account + rate-limit windows). Keyed by host
// string; local is keyed by '' (null host). Fetched out-of-band from the owning
// engine and refreshed on an interval — see App's polling effect.

/** Map key for a host: '' for the local engine, else "user@host". */
export const hostKey = (host?: string | null): string => host ?? ''

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
