import { create } from 'zustand'
import type { SkillFiles, SkillRef, SkillsListing } from '../../shared/acp'

// State for the Skills Manager: the app-owned library plus the skills a Scan has
// staged for approval, and the currently-selected skill's files.
// Kept in a store (not component state) so a host connect/disconnect can trigger
// a refresh from anywhere and the manager re-renders in place.

interface SkillsState {
  listing: SkillsListing
  loading: boolean
  /** True while a Scan (host discovery + staging for approval) is running. */
  scanning: boolean
  error: string | null
  /** id of the selected skill, or null. */
  selectedId: string | null
  /** Files of the selected skill (SKILL.md + resources), or null while loading. */
  files: SkillFiles | null
  filesLoading: boolean
  /** Reload the managed library (cheap; no host round-trips). */
  refresh: () => Promise<void>
  /** Scan connected hosts and stage new skills for approval. Resolves to how
   *  many skills this scan newly staged. */
  scan: () => Promise<number>
  select: (skill: SkillRef | null) => Promise<void>
  /** Add/remove a library skill from the curated "active" set. */
  setActive: (skill: SkillRef, active: boolean) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => {
  // Drop a selection whose skill vanished (e.g. approved/rejected, or deleted).
  const dropStaleSelection = (listing: SkillsListing) => {
    const sel = get().selectedId
    if (sel && !listing.skills.some((s) => s.id === sel) && !listing.pending.some((s) => s.id === sel)) {
      set({ selectedId: null, files: null })
    }
  }

  return {
    listing: { skills: [], pending: [], unreachable: [], root: '' },
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
        dropStaleSelection(listing)
      } catch (err: any) {
        set({ loading: false, error: err?.message || String(err) })
      }
    },

    scan: async () => {
      set({ scanning: true, error: null })
      try {
        const before = new Set(get().listing.pending.map((s) => s.id))
        const listing = await window.studio.skills.scan()
        set({ listing, scanning: false })
        dropStaleSelection(listing)
        return listing.pending.filter((s) => !before.has(s.id)).length
      } catch (err: any) {
        set({ scanning: false, error: err?.message || String(err) })
        return 0
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
    },

    setActive: async (skill, active) => {
      // Optimistic: the toggle is a checkbox, so it has to feel instant. A failed
      // write reverts by reloading the library, which is the source of truth.
      const flip = (value: boolean) =>
        set((state) => ({
          listing: {
            ...state.listing,
            skills: state.listing.skills.map((s) => (s.id === skill.id ? { ...s, active: value } : s))
          }
        }))
      flip(active)
      try {
        await window.studio.skills.setActive({ dir: skill.dir, active })
      } catch (err: any) {
        set({ error: err?.message || String(err) })
        await get().refresh()
      }
    }
  }
})
