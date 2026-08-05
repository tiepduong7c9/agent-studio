import { create } from 'zustand'
import type { SkillFiles, SkillRef, SkillsListing } from '../../shared/acp'

// State for the Skills Manager: the aggregated listing across the app-owned
// library and every connected host, plus the currently-selected skill's files.
// Kept in a store (not component state) so a host connect/disconnect can trigger
// a refresh from anywhere and the manager re-renders in place.

interface SkillsState {
  listing: SkillsListing
  loading: boolean
  /** True while a Scan (host discovery + mirror into the library) is running. */
  scanning: boolean
  error: string | null
  /** id of the selected skill, or null. */
  selectedId: string | null
  /** Files of the selected skill (SKILL.md + resources), or null while loading. */
  files: SkillFiles | null
  filesLoading: boolean
  /** Reload the managed library (cheap; no host round-trips). */
  refresh: () => Promise<void>
  /** Scan connected hosts and mirror new skills into the library. */
  scan: () => Promise<void>
  select: (skill: SkillRef | null) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  listing: { skills: [], unreachable: [] },
  loading: false,
  scanning: false,
  error: null,
  selectedId: null,
  files: null,
  filesLoading: false,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const listing = await window.studio.skills.list()
      set({ listing, loading: false })
      // Drop a stale selection whose skill vanished (e.g. host disconnected).
      const sel = get().selectedId
      if (sel && !listing.skills.some((s) => s.id === sel)) {
        set({ selectedId: null, files: null })
      }
    } catch (err: any) {
      set({ loading: false, error: err?.message || String(err) })
    }
  },

  scan: async () => {
    set({ scanning: true, error: null })
    try {
      const listing = await window.studio.skills.scan()
      set({ listing, scanning: false })
      const sel = get().selectedId
      if (sel && !listing.skills.some((s) => s.id === sel)) {
        set({ selectedId: null, files: null })
      }
    } catch (err: any) {
      set({ scanning: false, error: err?.message || String(err) })
    }
  },

  select: async (skill) => {
    if (!skill) {
      set({ selectedId: null, files: null, filesLoading: false })
      return
    }
    set({ selectedId: skill.id, files: null, filesLoading: true })
    try {
      const files = await window.studio.skills.read({
        host: skill.host ?? null,
        scope: skill.scope,
        dir: skill.dir
      })
      // Guard against a race where another skill was selected meanwhile.
      if (get().selectedId === skill.id) set({ files, filesLoading: false })
    } catch (err: any) {
      if (get().selectedId === skill.id) {
        set({ files: { files: [] }, filesLoading: false, error: err?.message || String(err) })
      }
    }
  }
}))
