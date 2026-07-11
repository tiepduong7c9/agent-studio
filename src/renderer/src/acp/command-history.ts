import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Recently used slash commands (most-recent-first), persisted so the composer's
// autosuggest can surface them ahead of the rest. Names only — the live command
// list (with descriptions) comes from the session's advertised commands.

const MAX = 12

interface CommandHistory {
  recent: string[]
  record: (name: string) => void
}

export const useCommandHistory = create<CommandHistory>()(
  persist(
    (set) => ({
      recent: [],
      record: (name) =>
        set((s) => ({ recent: [name, ...s.recent.filter((n) => n !== name)].slice(0, MAX) }))
    }),
    { name: 'agent-studio.recent-commands' }
  )
)
