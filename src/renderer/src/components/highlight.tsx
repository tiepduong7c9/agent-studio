import type { ReactNode } from 'react'

/** Renders `text` with the characters at `positions` wrapped in a highlight span
 *  (the match markers from a fuzzy search). Shared by the quick-open pickers. */
export function highlightMatch(text: string, positions: number[]): ReactNode {
  if (positions.length === 0) return text
  const set = new Set(positions)
  const out: ReactNode[] = []
  let run = ''
  let hlRun = ''
  const flush = () => {
    if (run) {
      out.push(run)
      run = ''
    }
    if (hlRun) {
      out.push(
        <span key={out.length} className="quick-open-hl">
          {hlRun}
        </span>
      )
      hlRun = ''
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (run) flush()
      hlRun += text[i]
    } else {
      if (hlRun) flush()
      run += text[i]
    }
  }
  flush()
  return out
}
