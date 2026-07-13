import { create } from 'zustand'

// Unsubmitted composer text, kept per session so switching away from a chat and
// back restores what was typed. The AcpThread composer remounts on every session
// switch (its tab key changes), which would otherwise drop the local draft; this
// store outlives that remount. In-memory only — drafts are ephemeral and clear on
// restart, and are dropped when a session goes away.

interface DraftsStore {
  drafts: Record<string, string>
  set: (sid: string, text: string) => void
  /** Forget drafts for sessions no longer live (called alongside chat pruning). */
  prune: (liveSids: Set<string>) => void
}

export const useDrafts = create<DraftsStore>((set) => ({
  drafts: {},
  set: (sid, text) =>
    set((s) => {
      if ((s.drafts[sid] ?? '') === text) return s
      if (text === '') {
        if (!(sid in s.drafts)) return s
        const { [sid]: _drop, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [sid]: text } }
    }),
  prune: (liveSids) =>
    set((s) => {
      const entries = Object.entries(s.drafts).filter(([sid]) => liveSids.has(sid))
      if (entries.length === Object.keys(s.drafts).length) return s
      return { drafts: Object.fromEntries(entries) }
    })
}))
