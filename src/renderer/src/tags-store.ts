import { Ban, Bug, Eye, Flame, FlaskConical, Sparkles, type LucideIcon } from 'lucide-react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The tag palette: markers you can put on a session from its right-click menu,
// orthogonal to the attention-state sections the engine's status drives. A
// session carries at most one tag (see view-prefs-store), and the row shows it
// as a bare coloured icon with the name in the tooltip.
//
// The six built-ins are fixed — each has a hand-picked glyph and colour that
// read at 12px and stay apart from each other, which is not something a name
// field and a swatch strip can be trusted to preserve. Users add to the set
// rather than edit it: a custom tag is a name and a colour, drawn with the
// generic tag glyph, so adding one needs no icon picker.
//
// Definitions live in localStorage next to the other per-machine view state —
// tags are a client-side view concern, and the engine has no home for them.

export interface SessionTag {
  id: string
  /** Shown in the context menu and as the row icon's tooltip. */
  name: string
  /** A TAG_COLORS id, not a hex: the actual colour is a registered theme colour
   *  with a per-base value, so the same tag can be a light-on-dark tint in the
   *  dark theme and a legible dark shade of the same hue in the light one. */
  color: TagColorId
  /** Built-in glyph. Custom tags have none and fall back to the tag icon. */
  icon?: LucideIcon
  /** Built-ins are fixed: shown in the manager but not editable or removable. */
  builtin?: true
}

export type TagColorId =
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'grey'

/** The colours offered for a custom tag, in swatch order. A closed set (not a
 *  free colour input) so every tag stays legible against both themes' sidebar
 *  and stays distinguishable from its neighbours — see theme/tag-colors.ts for
 *  the per-theme values. */
export const TAG_COLORS: { id: TagColorId; name: string }[] = [
  { id: 'red', name: 'Red' },
  { id: 'orange', name: 'Orange' },
  { id: 'amber', name: 'Amber' },
  { id: 'green', name: 'Green' },
  { id: 'teal', name: 'Teal' },
  { id: 'blue', name: 'Blue' },
  { id: 'purple', name: 'Purple' },
  { id: 'pink', name: 'Pink' },
  { id: 'grey', name: 'Grey' }
]

const COLOR_IDS = new Set<string>(TAG_COLORS.map((c) => c.id))

/** The CSS colour for a palette id, for an inline `color` / `background`. Falls
 *  back to grey so an unrecognised id still paints something. */
export const tagColorVar = (id: string): string =>
  `var(--vscode-studio-tag-${COLOR_IDS.has(id) ? id : 'grey'})`

// The fixed set, always first in the menu and the manager. Ids are the slugs
// earlier builds stored against sessions, so existing tags resolve unchanged.
export const BUILTIN_TAGS: SessionTag[] = [
  { id: 'bug', name: 'Bug', color: 'red', icon: Bug, builtin: true },
  { id: 'feature', name: 'Feature', color: 'blue', icon: Sparkles, builtin: true },
  { id: 'review', name: 'In review', color: 'purple', icon: Eye, builtin: true },
  { id: 'blocked', name: 'Blocked', color: 'amber', icon: Ban, builtin: true },
  { id: 'experiment', name: 'Experiment', color: 'teal', icon: FlaskConical, builtin: true },
  { id: 'urgent', name: 'Urgent', color: 'orange', icon: Flame, builtin: true }
]

let tagSeq = 0
/** A fresh id for a user-created tag. Prefixed so it can never collide with a
 *  built-in's slug, which sessions may already hold. */
export function newTagId(): string {
  tagSeq += 1
  return `user:${Date.now().toString(36)}-${tagSeq}`
}

/** What to show for a tag with a blank name (the state a just-added row is in
 *  until it's typed into) so it isn't an invisible menu entry. */
export const tagLabel = (t: SessionTag): string => t.name.trim() || 'Untitled'

interface TagsState {
  /** Every tag in display order: the built-ins, then the user's own. */
  tags: SessionTag[]
  /** Append a custom tag, cycling to the next unused colour. Returns its id. */
  addTag: () => string
  /** Edit a custom tag. Built-ins are fixed, so a patch against one is ignored. */
  updateTag: (id: string, patch: Partial<Pick<SessionTag, 'name' | 'color'>>) => void
  /** Remove a custom tag. Built-ins can't be removed. */
  removeTag: (id: string) => void
}

// Prefer a colour nothing else uses, so a run of added tags doesn't come out
// all one shade and none of them clashes with a built-in. Falls back to cycling
// once every swatch is taken.
function nextColor(tags: SessionTag[]): TagColorId {
  const used = new Set<string>(tags.map((t) => t.color))
  return (
    TAG_COLORS.find((c) => !used.has(c.id))?.id ?? TAG_COLORS[tags.length % TAG_COLORS.length].id
  )
}

// The hexes the swatch strip offered before the palette became themed.
const LEGACY_HEX: Record<string, TagColorId> = {
  '#f14c4c': 'red',
  '#ff8c00': 'orange',
  '#e9a700': 'amber',
  '#89d185': 'green',
  '#4ec9b0': 'teal',
  '#3794ff': 'blue',
  '#c586c0': 'purple',
  '#f06292': 'pink',
  '#9d9d9d': 'grey'
}

export const useTagsStore = create<TagsState>()(
  persist(
    (set) => ({
      tags: BUILTIN_TAGS,

      addTag: () => {
        const id = newTagId()
        set((s) => ({ tags: [...s.tags, { id, name: '', color: nextColor(s.tags) }] }))
        return id
      },
      updateTag: (id, patch) =>
        set((s) => ({ tags: s.tags.map((t) => (t.id === id && !t.builtin ? { ...t, ...patch } : t)) })),
      removeTag: (id) => set((s) => ({ tags: s.tags.filter((t) => t.id !== id || t.builtin) }))
    }),
    {
      name: 'agent-studio.tags',
      // Only the custom tags are state; the built-ins are code (their glyph is a
      // component, which wouldn't survive JSON anyway). Persist the user's own
      // and rebuild the full list on load, so an edit to a built-in's name or
      // colour here ships to everyone rather than being shadowed by stale
      // localStorage.
      partialize: (s) => ({ tags: s.tags.filter((t) => !t.builtin) }),
      merge: (persisted, current) => {
        const saved = (persisted as Partial<TagsState> | undefined)?.tags
        const custom = Array.isArray(saved)
          ? saved
              .filter((t) => !t.builtin)
              // A colour written before the palette moved to per-theme ids is a
              // hex; map it back to its id so the tag keeps its hue.
              .map((t) => ({ ...t, color: (LEGACY_HEX[t.color] ?? t.color) as TagColorId }))
          : []
        return { ...current, tags: [...BUILTIN_TAGS, ...custom] }
      }
    }
  )
)

/** Non-reactive lookup, for callers outside a component. Components should
 *  select from the store instead so a rename or recolour re-renders them. */
export const tagById = (id: string): SessionTag | undefined =>
  useTagsStore.getState().tags.find((t) => t.id === id)
