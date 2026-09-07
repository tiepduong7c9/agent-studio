import { create } from 'zustand'
import type { GitWorktreeInfo } from '../../shared/types'

// Per-session git identity (branch + worktree), cached by host+cwd so the
// sessions list can label every row without one probe per render. Sessions
// sharing a folder share an entry. Not persisted: a branch goes stale the moment
// the agent switches it, so entries are re-probed on an interval and start empty
// each run.

/** Cache key for a working directory on a host ("local" when not remote). */
export const gitInfoKey = (cwd: string, host?: string | null): string => `${host || 'local'} ${cwd}`

interface Entry {
  /** Null once probed and the folder turned out not to be a git repo. */
  info: GitWorktreeInfo | null
  /** True while a probe is in flight, so concurrent rows don't stack requests. */
  loading: boolean
}

interface GitInfoState {
  entries: Record<string, Entry>
  /** Probe this cwd unless it's already cached or in flight. */
  ensure: (cwd: string, host?: string | null) => void
  /** Re-probe everything cached: branches move under us as agents work. */
  refreshAll: () => void
  /** Drop entries whose key isn't in `keep` (sessions that went away). */
  prune: (keep: Set<string>) => void
}

type Set_ = (fn: (s: GitInfoState) => Partial<GitInfoState>) => void
type Get_ = () => GitInfoState

async function probe(key: string, cwd: string, host: string | null, set: Set_, get: Get_): Promise<void> {
  if (get().entries[key]?.loading) return
  set((s) => ({
    entries: { ...s.entries, [key]: { info: s.entries[key]?.info ?? null, loading: true } }
  }))
  const res = await window.studio.gitWorktreeInfo(cwd, host).catch(() => null)
  const info = res && res.ok ? res.data : null
  set((s) => {
    // A prune between request and response means nobody wants this any more.
    if (!s.entries[key]) return s
    return { entries: { ...s.entries, [key]: { info, loading: false } } }
  })
}

export const useGitInfoStore = create<GitInfoState>()((set, get) => ({
  entries: {},
  ensure: (cwd, host) => {
    if (!cwd) return
    const key = gitInfoKey(cwd, host)
    if (get().entries[key]) return
    void probe(key, cwd, host || null, set, get)
  },
  refreshAll: () => {
    for (const key of Object.keys(get().entries)) {
      const sep = key.indexOf(' ')
      const host = key.slice(0, sep)
      void probe(key, key.slice(sep + 1), host === 'local' ? null : host, set, get)
    }
  },
  prune: (keep) => {
    const entries = get().entries
    const next: Record<string, Entry> = {}
    let dropped = false
    for (const [key, entry] of Object.entries(entries)) {
      if (keep.has(key)) next[key] = entry
      else dropped = true
    }
    if (dropped) set(() => ({ entries: next }))
  }
}))
