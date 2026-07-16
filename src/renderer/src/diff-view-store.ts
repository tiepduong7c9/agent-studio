import { create } from 'zustand'

// Bridges each open diff editor to the tab strip, which hosts the diff's
// controls (navigate changes, toggle side-by-side) so they cost no editor
// space — mirroring the markdown preview toggle. Keyed by editor tab id.
//
// `sideBySide` is reactive view state the strip owns; `controller` is the live
// handle a mounted MonacoDiffViewer registers so the strip can drive it
// imperatively (jump to a hunk) and reflect its change count. The controller
// object is replaced whenever the change count updates, so selectors re-render.

export interface DiffController {
  changeCount: number
  goToDiff: (dir: 'previous' | 'next') => void
}

interface DiffViewState {
  /** false = inline; absent/true = side-by-side (the default). */
  sideBySide: Record<string, boolean>
  /** Live handles for currently-mounted diff editors. */
  controllers: Record<string, DiffController>
  toggleSideBySide: (tabId: string) => void
  setController: (tabId: string, controller: DiffController | null) => void
}

export const useDiffViewStore = create<DiffViewState>((set) => ({
  sideBySide: {},
  controllers: {},
  toggleSideBySide: (tabId) =>
    set((s) => ({
      sideBySide: { ...s.sideBySide, [tabId]: s.sideBySide[tabId] === false }
    })),
  setController: (tabId, controller) =>
    set((s) => {
      const next = { ...s.controllers }
      if (controller) next[tabId] = controller
      else delete next[tabId]
      return { controllers: next }
    })
}))

/** Side-by-side defaults to on when the tab has no stored preference. */
export function isSideBySide(map: Record<string, boolean>, tabId: string): boolean {
  return map[tabId] !== false
}
