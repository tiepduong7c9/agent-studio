import { useEffect, useRef } from 'react'
import { useToastStore } from '../toast-store'
import { peakUtil, peakWindowLabel, useUsageStore } from './usage-store'

// Warn once each time a host's peak rate-limit utilisation climbs past a
// threshold. Checked descending so a single jump reports the highest band
// reached. The per-host record is reset when usage falls back below a band
// (e.g. after a window resets), so a later climb warns again.
const THRESHOLDS = [75, 50]

/** Watch per-host usage and raise a toast when it crosses 50% / 75%. */
export function useUsageWarnings(): void {
  const byHost = useUsageStore((s) => s.byHost)
  // hostKey -> highest threshold currently crossed (0 if below the lowest).
  const warned = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const push = useToastStore.getState().push
    for (const [key, detail] of byHost) {
      const usage = detail?.usage
      if (!usage) continue
      const pct = Math.round(peakUtil(usage))
      const crossed = THRESHOLDS.find((t) => pct >= t) ?? 0
      const prev = warned.current.get(key) ?? 0
      warned.current.set(key, crossed)
      if (crossed <= prev) continue // no new band reached
      const who = key === '' ? 'Claude usage' : `Claude usage on ${key}`
      const label = peakWindowLabel(usage)
      push(
        crossed >= 75 ? 'danger' : 'warn',
        `${who} has reached ${pct}%${label ? ` of the ${label} limit` : ''}.`
      )
    }
  }, [byHost])
}
