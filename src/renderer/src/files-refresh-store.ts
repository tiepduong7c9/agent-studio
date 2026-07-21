import { create } from 'zustand'

// A one-shot signal asking any open file tree to reload, for file changes made
// outside the tree's own operations (e.g. saving a new untitled file). Keyed by
// workspace id so a tree only reacts to changes in its own project.
interface FilesRefreshStore {
  nonce: number
  wsId: string | null
  /** Ask the file tree for `wsId` to reload. */
  bump: (wsId: string) => void
}

export const useFilesRefreshStore = create<FilesRefreshStore>((set) => ({
  nonce: 0,
  wsId: null,
  bump: (wsId) => set((s) => ({ nonce: s.nonce + 1, wsId }))
}))
