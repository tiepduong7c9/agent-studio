import { Ban, Bug, Eye, Flame, FlaskConical, Sparkles, type LucideIcon } from 'lucide-react'

// The fixed tag palette. A tag is a manual, per-machine marker you put on a
// session from its right-click menu — orthogonal to the attention-state
// sections, which the engine's status drives. A session carries at most one,
// shown at the head of its row as a bare icon (name in the tooltip), so each
// one needs a glyph that reads at 12px and a colour distinct from the others.
//
// This list is deliberately closed: the set is small enough to recognise by
// colour alone, and a user-editable set would need a management dialog, an icon
// picker, and persisted definitions. Add entries here to extend it.
export interface SessionTag {
  id: string
  /** Shown in the context menu and as the row icon's tooltip. */
  name: string
  icon: LucideIcon
  /** Row icon colour, also the menu swatch. Literal hex rather than a theme
   *  token: these must stay distinguishable from each other in both themes,
   *  which the semantic tokens don't guarantee. */
  color: string
}

export const SESSION_TAGS: SessionTag[] = [
  { id: 'bug', name: 'Bug', icon: Bug, color: '#f14c4c' },
  { id: 'feature', name: 'Feature', icon: Sparkles, color: '#3794ff' },
  { id: 'review', name: 'In review', icon: Eye, color: '#c586c0' },
  { id: 'blocked', name: 'Blocked', icon: Ban, color: '#e9a700' },
  { id: 'experiment', name: 'Experiment', icon: FlaskConical, color: '#4ec9b0' },
  { id: 'urgent', name: 'Urgent', icon: Flame, color: '#ff8c00' }
]

const BY_ID = new Map(SESSION_TAGS.map((t) => [t.id, t]))

/** Resolve a persisted tag id. Unknown ids (a tag removed from the palette
 *  while still stored against a session) resolve to undefined and are skipped
 *  rather than rendered blank. */
export const tagById = (id: string): SessionTag | undefined => BY_ID.get(id)
