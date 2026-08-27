import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta } from '../../../shared/acp'
import type { Capture } from '../capture-store'
import { useCaptureStore } from '../capture-store'
import { fuzzyMatch } from '../fuzzy'
import { hostLabel, projectLabel, sessionActivity } from '../session-format'
import { highlightMatch } from './highlight'

// VS Code-style quick-open (Ctrl/Cmd+E) for jumping to a live session by fuzzy
// matching its title, project folder, host, or a captured PR / ticket id. Enter
// opens the chosen session.

const NO_CAPTURES: Capture[] = []

interface Entry {
  s: SessionMeta
  project: string
  host: string
  captures: Capture[]
}
interface Result {
  entry: Entry
  positions: number[]
  /** Captures whose id or label matched the query — shown as badges. */
  hits: Capture[]
}

export function SessionSwitcher({
  sessions,
  onSelect,
  onClose
}: {
  sessions: SessionMeta[]
  onSelect: (sid: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const capturesBySid = useCaptureStore((s) => s.capturesBySid)

  // Most-recently-active first, so an empty query is a usable recents list.
  const entries = useMemo<Entry[]>(
    () =>
      [...sessions]
        .sort((a, b) => sessionActivity(b) - sessionActivity(a))
        .map((s) => ({
          s,
          project: projectLabel(s.cwd),
          host: hostLabel(s.host),
          captures: capturesBySid[s.id] ?? NO_CAPTURES
        })),
    [sessions, capturesBySid]
  )

  const results = useMemo<Result[]>(() => {
    const q = query.trim()
    if (!q) return entries.map((entry) => ({ entry, positions: [], hits: NO_CAPTURES }))
    const lower = q.toLowerCase()
    const scored: { entry: Entry; positions: number[]; hits: Capture[]; score: number }[] = []
    for (const entry of entries) {
      // Captured PR / ticket ids first: they're the most specific thing a query
      // can be, and substring (not fuzzy) matching keeps "4002" from landing on
      // an unrelated "#4102". A session is findable by "4002", "#4002", or
      // "WOLF-45", matching the sidebar search.
      const hits = entry.captures.filter(
        (c) => c.id.toLowerCase().includes(lower) || c.label.toLowerCase().includes(lower)
      )
      // Rank by the title, but still match on project/host so typing a folder or
      // host name finds the session; only a title hit highlights.
      const onName = fuzzyMatch(q, entry.s.name)
      if (hits.length) {
        // Exact id / label equality tops the list; a partial id hit still beats
        // an incidental fuzzy title or project match.
        const exact = hits.some((c) => c.id.toLowerCase() === lower || c.label.toLowerCase() === lower)
        scored.push({
          entry,
          positions: onName?.positions ?? [],
          hits,
          score: (exact ? 3000 : 2000) + (onName?.score ?? 0)
        })
        continue
      }
      if (onName) {
        scored.push({ entry, positions: onName.positions, hits: NO_CAPTURES, score: onName.score + 1000 })
        continue
      }
      const onOther = fuzzyMatch(q, `${entry.project} ${entry.host}`)
      if (onOther) scored.push({ entry, positions: [], hits: NO_CAPTURES, score: onOther.score })
    }
    scored.sort((a, b) => b.score - a.score || a.entry.s.name.length - b.entry.s.name.length)
    return scored
  }, [entries, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (result: Result | undefined) => {
    if (!result) return
    onSelect(result.entry.s.id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const status = sessions.length === 0 ? 'No open sessions' : results.length === 0 ? 'No matching sessions' : null

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="quick-open-input"
          autoFocus
          placeholder="Go to session by name, project, host, or #PR / ticket"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {status ? (
          <div className="quick-open-status">{status}</div>
        ) : (
          <div className="quick-open-list" ref={listRef}>
            {results.map((result, i) => (
              <div
                key={result.entry.s.id}
                className={`quick-open-row ${i === active ? 'active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(result)}
              >
                <span className="codicon codicon-robot quick-open-icon" />
                <span className="quick-open-name">{highlightMatch(result.entry.s.name, result.positions)}</span>
                {result.hits.length > 0 && (
                  <span className="quick-open-badges">
                    {result.hits.map((c) => (
                      <span
                        key={`${c.patternId}:${c.id}`}
                        className={`acp-session-badge acp-session-badge-${c.kind}`}
                        title={c.url}
                      >
                        {c.label}
                      </span>
                    ))}
                  </span>
                )}
                <span className="quick-open-path">{result.entry.project}</span>
                <span className="quick-open-ws">{result.entry.host}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
