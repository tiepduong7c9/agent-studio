// Lightweight fuzzy matcher for the quick-open palette. Subsequence match with
// bonuses for consecutive runs, matches at the start, and matches right after a
// path/word separator — enough to rank file paths sensibly without pulling in a
// dependency. Returns the score and the matched character positions (for
// highlighting), or null when the query isn't a subsequence of the target.

export interface FuzzyMatch {
  score: number
  positions: number[]
}

const CONSECUTIVE_BONUS = 6
const START_BONUS = 10
const BOUNDARY_BONUS = 9

function isBoundary(c: string): boolean {
  return c === '/' || c === '\\' || c === '.' || c === '_' || c === '-' || c === ' '
}

// Matches `q` (already lowercased) against `s` (already lowercased). Positions
// index into `s`; since lowercasing preserves length they map back to the
// original string too.
//
// Finds the highest-scoring alignment, not just the first greedy one: a plain
// left-to-right scan would match "emerge" against the trailing "e" of
// "Configur[e]" plus "[merge]ncy", missing the word-boundary "[Emerge]ncy" run
// that should rank the entry first. A small O(q·s) DP picks the best positions.
function subsequence(q: string, s: string): FuzzyMatch | null {
  const n = q.length
  const m = s.length
  if (n === 0) return { score: 0, positions: [] }
  if (n > m) return null

  const NEG = -Infinity
  // score[j]: best score for matching q[0..qi] with q[qi] landing on s[j].
  // back[qi][j]: the s-position of q[qi-1] in that best alignment.
  let score = new Array<number>(m).fill(NEG)
  const back: number[][] = []

  const first = new Array<number>(m).fill(-1)
  for (let j = 0; j < m; j++) {
    if (s[j] !== q[0]) continue
    let bonus = 1
    if (j === 0) bonus += START_BONUS
    else if (isBoundary(s[j - 1])) bonus += BOUNDARY_BONUS
    score[j] = bonus
  }
  back.push(first)

  for (let qi = 1; qi < n; qi++) {
    const cur = new Array<number>(m).fill(NEG)
    const from = new Array<number>(m).fill(-1)
    // Running best of the previous row over positions p <= j-2 (a non-adjacent
    // gap); the adjacent position j-1 is handled separately as a consecutive run.
    let bestGap = NEG
    let bestGapIdx = -1
    for (let j = qi; j < m; j++) {
      const p = j - 2
      if (p >= 0 && score[p] > bestGap) {
        bestGap = score[p]
        bestGapIdx = p
      }
      if (s[j] !== q[qi]) continue
      let baseBonus = 1
      if (isBoundary(s[j - 1])) baseBonus += BOUNDARY_BONUS
      let best = NEG
      let bestFrom = -1
      if (score[j - 1] > NEG) {
        best = score[j - 1] + baseBonus + CONSECUTIVE_BONUS
        bestFrom = j - 1
      }
      if (bestGap > NEG && bestGap + baseBonus > best) {
        best = bestGap + baseBonus
        bestFrom = bestGapIdx
      }
      cur[j] = best
      from[j] = bestFrom
    }
    score = cur
    back.push(from)
  }

  let end = -1
  let bestScore = NEG
  for (let j = 0; j < m; j++) {
    if (score[j] > bestScore) {
      bestScore = score[j]
      end = j
    }
  }
  if (end === -1) return null

  const positions: number[] = new Array<number>(n)
  let j = end
  for (let qi = n - 1; qi >= 0; qi--) {
    positions[qi] = j
    j = back[qi][j]
  }
  return { score: bestScore, positions }
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
