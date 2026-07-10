import type { GitFileChange } from '../../shared/types'

export type Selection =
  | { kind: 'file'; wsId: string; path: string; name: string }
  | { kind: 'diff'; wsId: string; change: GitFileChange }

/**
 * Opens a selection in the editor area. `preview` (the default for a single
 * click) opens the transient preview tab; `preview: false` (a double click in
 * the tree) keeps it as a permanent tab.
 */
export type SelectHandler = (selection: Selection, opts?: { preview?: boolean }) => void
