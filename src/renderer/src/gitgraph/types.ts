// Types for the vendored git-graph renderer (see ./graph.ts). Extracted from
// neo-git-graph's webview global.d.ts (MIT) and pared to what graph.ts uses.

export interface Config {
  graphColours: string[]
  graphStyle: 'rounded' | 'angular'
  grid: { x: number; y: number; offsetX: number; offsetY: number; expandY: number }
}

export interface Point {
  x: number
  y: number
}

export interface Line {
  p1: Point
  p2: Point
  /** TRUE => line locked to p1, FALSE => locked to p2. */
  lockedFirst: boolean
}

export interface PlacedLine {
  p1: Point
  p2: Point
  isCommitted: boolean
  lockedFirst: boolean
}

/** Only `id` (the row index) is read by the renderer; we never expand a commit. */
export interface ExpandedCommit {
  id: number
}

/** The minimal commit shape the graph layout needs. */
export interface GitCommitNode {
  hash: string
  parentHashes: string[]
}
