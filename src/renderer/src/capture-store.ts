import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Session "captures": PR numbers and ticket IDs recognised in a session's
// conversation. Each capture is a URL mentioned in the thread that matched a
// configured pattern, with an ID pulled from the pattern's capture group. The
// patterns are user-configurable (GitHub PR ships built-in); the results are
// cached per session id so the sidebar can show badges for every session that
// has been opened — even after a restart, when the thread events are no longer
// in memory. This mirrors how view-prefs-store persists per-session UI state.

/** What a captured identifier represents — drives its badge styling. */
export type CaptureKind = 'pr' | 'ticket'

/** A user-configurable rule: URLs matching `urlRegex` yield a badge whose ID is
 *  the first capture group, formatted through `label` (a `$1` template). */
export interface CapturePattern {
  /** Stable id (built-ins use a fixed slug; user patterns a generated one). */
  id: string
  /** Display name shown in the config dialog (e.g. "Jira", "Wolfpack"). */
  name: string
  kind: CaptureKind
  /** Regex source matched against each session URL; group 1 is the ID. */
  urlRegex: string
  /** Badge label template — `$1` is replaced with the captured group. */
  label: string
  /** Built-in patterns can be edited-around but not deleted. */
  builtin?: boolean
}

/** One recognised identifier in a session. */
export interface Capture {
  patternId: string
  kind: CaptureKind
  /** The raw captured group (e.g. "1234", "WOLF-45"). */
  id: string
  /** The rendered badge text (label template applied). */
  label: string
  /** The URL the capture came from — opened when the badge is clicked. */
  url: string
}

// The one built-in: GitHub pull requests. Kept non-deletable so the headline
// use case works out of the box; users layer ticket patterns on top.
export const GITHUB_PR_PATTERN: CapturePattern = {
  id: 'builtin:github-pr',
  name: 'GitHub PR',
  kind: 'pr',
  urlRegex: '^https?://github\\.com/[^/]+/[^/]+/pull/(\\d+)',
  label: '#$1',
  builtin: true
}

let patternSeq = 0
/** A fresh id for a user-created pattern. Monotonic within a run; persisted. */
export function newPatternId(): string {
  patternSeq += 1
  return `user:${Date.now().toString(36)}-${patternSeq}`
}

interface CaptureState {
  /** Configured patterns, in display order. Built-ins first. */
  patterns: CapturePattern[]
  /** Recognised captures per session id — the persisted result cache. */
  capturesBySid: Record<string, Capture[]>

  addPattern: (p: Omit<CapturePattern, 'id'>) => void
  updatePattern: (id: string, patch: Partial<Omit<CapturePattern, 'id' | 'builtin'>>) => void
  removePattern: (id: string) => void
  /** Restore just the built-in patterns (drops all user patterns). */
  resetPatterns: () => void
  /** Cache a session's captures; a no-op write when unchanged. */
  setCaptures: (sid: string, captures: Capture[]) => void
  /** Drop cached captures for sessions that no longer exist. */
  pruneCaptures: (liveIds: Set<string>) => void
}

// Shallow value-equality for a capture list, so setCaptures can skip identical
// re-writes (which would otherwise churn localStorage and re-render badges).
function sameCaptures(a: Capture[], b: Capture[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    // Compare every rendered field — editing a pattern's label or kind (without
    // touching its regex) changes only those, and must still refresh the badges.
    if (x.patternId !== y.patternId || x.id !== y.id || x.url !== y.url || x.label !== y.label || x.kind !== y.kind)
      return false
  }
  return true
}

export const useCaptureStore = create<CaptureState>()(
  persist(
    (set) => ({
      patterns: [GITHUB_PR_PATTERN],
      capturesBySid: {},

      addPattern: (p) =>
        set((s) => ({ patterns: [...s.patterns, { ...p, id: newPatternId() }] })),
      updatePattern: (id, patch) =>
        set((s) => ({
          patterns: s.patterns.map((p) => (p.id === id && !p.builtin ? { ...p, ...patch } : p))
        })),
      removePattern: (id) =>
        set((s) => ({ patterns: s.patterns.filter((p) => p.id !== id || p.builtin) })),
      resetPatterns: () => set((s) => ({ patterns: s.patterns.filter((p) => p.builtin) })),

      setCaptures: (sid, captures) =>
        set((s) => {
          const prev = s.capturesBySid[sid]
          if (prev && sameCaptures(prev, captures)) return {}
          // Don't persist empty rows — a session with no captures just has no key.
          if (captures.length === 0) {
            if (!prev) return {}
            const { [sid]: _drop, ...rest } = s.capturesBySid
            return { capturesBySid: rest }
          }
          return { capturesBySid: { ...s.capturesBySid, [sid]: captures } }
        }),

      pruneCaptures: (liveIds) =>
        set((s) => {
          let changed = false
          const next: Record<string, Capture[]> = {}
          for (const id of Object.keys(s.capturesBySid)) {
            if (liveIds.has(id)) next[id] = s.capturesBySid[id]
            else changed = true
          }
          return changed ? { capturesBySid: next } : {}
        })
    }),
    {
      name: 'agent-studio.captures',
      // Always keep the built-in PR pattern present (and first), even if an older
      // persisted state predates it or a user somehow dropped it.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CaptureState>
        const saved = Array.isArray(p.patterns) ? p.patterns : []
        const withoutBuiltin = saved.filter((x) => x.id !== GITHUB_PR_PATTERN.id)
        return {
          ...current,
          ...p,
          patterns: [GITHUB_PR_PATTERN, ...withoutBuiltin],
          capturesBySid: p.capturesBySid ?? {}
        }
      }
    }
  )
)
