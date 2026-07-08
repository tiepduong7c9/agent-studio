import type { GitFileChange } from '../../shared/types'

export type Selection =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'diff'; change: GitFileChange }
