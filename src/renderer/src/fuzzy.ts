// Lightweight fuzzy matcher for the quick-open palette. Subsequence match with
// bonuses for consecutive runs, matches at the start, and matches right after a
// path/word separator — enough to rank file paths sensibly without pulling in a
// dependency. Returns the score and the matched character positions (for
// highlighting), or null when the query isn't a subsequence of the target.

export interface FuzzyMatch {
  score: number
  positions: number[]
}

// Matches `q` (already lowercased) against `s` (already lowercased). Positions
// index into `s`; since lowercasing preserves length they map back to the
// original string too.
function subsequence(q: string, s: string): FuzzyMatch | null {
  const positions: number[] = []
  let qi = 0
  let score = 0
  let prev = -2
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue
    let bonus = 1
    if (i === prev + 1) bonus += 6 // consecutive with the previous match
    if (i === 0) {
      bonus += 10 // very start
    } else {
      const pc = s[i - 1]
      if (pc === '/' || pc === '\\' || pc === '.' || pc === '_' || pc === '-' || pc === ' ') {
        bonus += 9 // word/segment boundary
      }
    }
    score += bonus
    positions.push(i)
    prev = i
    qi++
  }
  return qi === q.length ? { score, positions } : null
}

const BASENAME_BONUS = 1000

/**
 * Scores `query` against a relative file `path`. A slash-free query is matched
 * against the basename first (so typing a filename ranks filename hits above
 * incidental directory hits); otherwise the whole path is matched.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const target = path.toLowerCase()

  if (!q.includes('/')) {
    const baseStart = target.lastIndexOf('/') + 1
    const base = subsequence(q, target.slice(baseStart))
    if (base) {
      return {
        score: base.score + BASENAME_BONUS,
        positions: base.positions.map((p) => p + baseStart)
      }
    }
  }
  return subsequence(q, target)
}
