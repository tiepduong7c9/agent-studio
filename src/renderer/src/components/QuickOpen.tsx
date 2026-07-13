import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import type { Selection } from '../selection'
import { fuzzyMatch, type FuzzyMatch } from '../fuzzy'

// VS Code-style quick-open (Ctrl/Cmd+P): fuzzy-search every file in the open
// workspaces and open the chosen one in a tab.

const MAX_RESULTS = 200

interface Entry {
  wsId: string
  wsName: string
  rel: string // posix path relative to the workspace root
  abs: string // absolute path on the workspace host
  baseStart: number // index in `rel` where the filename begins
}

interface Result {
  entry: Entry
  match: FuzzyMatch | null
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel}`
}

export function QuickOpen({
  workspaces,
  onSelect,
  onClose
}: {
  workspaces: ProjectInfo[]
  onSelect: (sel: Selection, opts?: { preview?: boolean }) => void
  onClose: () => void
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const showWorkspace = workspaces.length > 1

  useEffect(() => {
    let cancelled = false
    Promise.all(
      workspaces.map(async (ws) => {
        const res = await window.studio.listFiles(ws.id)
        if (!res.ok) return [] as Entry[]
        return res.data.map((rel) => ({
          wsId: ws.id,
          wsName: ws.name,
          rel,
          abs: joinPath(ws.rootPath, rel),
          baseStart: rel.lastIndexOf('/') + 1
        }))
      })
    ).then((lists) => {
      if (!cancelled) setEntries(lists.flat())
    })
    return () => {
      cancelled = true
    }
  }, [workspaces])

  const results = useMemo<Result[]>(() => {
    if (!entries) return []
    const q = query.trim()
    if (!q) return entries.slice(0, MAX_RESULTS).map((entry) => ({ entry, match: null }))
    const scored: { entry: Entry; match: FuzzyMatch }[] = []
    for (const entry of entries) {
      const match = fuzzyMatch(q, entry.rel)
      if (match) scored.push({ entry, match })
    }
    scored.sort((a, b) => b.match.score - a.match.score || a.entry.rel.length - b.entry.rel.length)
    return scored.slice(0, MAX_RESULTS)
  }, [entries, query])

  // Keep the highlighted row valid and scrolled into view.
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (result: Result | undefined) => {
    if (!result) return
    const { entry } = result
    onSelect(
      { kind: 'file', wsId: entry.wsId, path: entry.abs, name: entry.rel.slice(entry.baseStart) },
      { preview: false }
    )
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

  const status = entries === null ? 'Loading…' : results.length === 0 ? 'No matching files' : null

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="quick-open-input"
          autoFocus
          placeholder="Search files by name"
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
              <QuickOpenRow
                key={`${result.entry.wsId}:${result.entry.rel}`}
                result={result}
                active={i === active}
                showWorkspace={showWorkspace}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(result)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function QuickOpenRow({
  result,
  active,
  showWorkspace,
  onMouseMove,
  onClick
}: {
  result: Result
  active: boolean
  showWorkspace: boolean
  onMouseMove: () => void
  onClick: () => void
}) {
  const { entry, match } = result
  const { rel, baseStart } = entry
  const name = rel.slice(baseStart)
  const dir = baseStart > 0 ? rel.slice(0, baseStart - 1) : ''
  const positions = match?.positions ?? []
  const namePos = positions.filter((p) => p >= baseStart).map((p) => p - baseStart)
  const dirPos = positions.filter((p) => p < baseStart)

  return (
    <div
      className={`quick-open-row ${active ? 'active' : ''}`}
      onMouseMove={onMouseMove}
      onClick={onClick}
    >
      <span className="codicon codicon-file quick-open-icon" />
      <span className="quick-open-name">{highlight(name, namePos)}</span>
      {dir && <span className="quick-open-path">{highlight(dir, dirPos)}</span>}
      {showWorkspace && <span className="quick-open-ws">{entry.wsName}</span>}
    </div>
  )
}

/** Renders `text` with the characters at `positions` wrapped for highlighting. */
function highlight(text: string, positions: number[]) {
  if (positions.length === 0) return text
  const set = new Set(positions)
  const out: React.ReactNode[] = []
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
