import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitCommit } from '../../../shared/types'
import { Graph } from '../gitgraph/graph'
import type { Config } from '../gitgraph/types'
import './GitGraphView.css'

// Grid + palette for the vendored renderer. Row height is grid.y; offsetY
// centers a commit's dot in its row. expandY unused (we never expand a commit).
const GRAPH_CONFIG: Config = {
  graphStyle: 'rounded',
  grid: { x: 16, y: 24, offsetX: 8, offsetY: 12, expandY: 0 },
  graphColours: [
    '#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000',
    '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'
  ]
}

const ROW_H = GRAPH_CONFIG.grid.y

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function relTime(ms: number): string {
  if (!ms) return ''
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

// Turn git decoration refs into displayable badges. `%D` yields tokens like
// "HEAD -> main", "origin/main", "tag: v1.0".
function refBadges(refs: string[]): { label: string; cls: string }[] {
  const out: { label: string; cls: string }[] = []
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) {
      out.push({ label: 'HEAD', cls: 'head' })
      out.push({ label: r.slice(8), cls: 'branch' })
    } else if (r === 'HEAD') out.push({ label: 'HEAD', cls: 'head' })
    else if (r.startsWith('tag: ')) out.push({ label: r.slice(5), cls: 'tag' })
    else if (r.includes('/')) out.push({ label: r, cls: 'remote' })
    else out.push({ label: r, cls: 'branch' })
  }
  return out
}

function headHash(commits: GitCommit[]): string | null {
  const head = commits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))
  return head?.hash ?? null
}

export function GitGraphView({ wsId }: { wsId: string }) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gutter, setGutter] = useState(0)
  const [allBranches, setAllBranches] = useState(true)
  const svgHostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setCommits(null)
    setError(null)
    window.studio.gitLog(wsId, 300, allBranches).then((res) => {
      if (cancelled) return
      if (!res.ok) return setError(res.error)
      if (!res.data.isRepo) return setError('This folder is not a git repository.')
      setCommits(res.data.commits)
    })
    return () => {
      cancelled = true
    }
  }, [wsId, allBranches])

  // Draw the SVG graph once commits are in and the host div is mounted. The
  // renderer appends its own <svg>, so clear any prior one first.
  useLayoutEffect(() => {
    const host = svgHostRef.current
    if (!host || !commits) return
    host.replaceChildren()
    if (commits.length === 0) {
      setGutter(0)
      return
    }
    try {
      const graph = new Graph(host, GRAPH_CONFIG)
      const nodes = commits.map((c) => ({ hash: c.hash, parentHashes: c.parents }))
      const lookup: Record<string, number> = {}
      commits.forEach((c, i) => (lookup[c.hash] = i))
      graph.loadCommits(nodes, headHash(commits), lookup)
      graph.render(null)
      setGutter(graph.getWidth() + GRAPH_CONFIG.grid.offsetX + 8)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    return () => host.replaceChildren()
  }, [commits])

  let body: ReactNode
  if (error) body = <div className="git-graph-msg">{error}</div>
  else if (!commits) body = <div className="git-graph-msg">Loading history…</div>
  else if (commits.length === 0) body = <div className="git-graph-msg">No commits yet.</div>
  else {
    body = (
      <div className="git-graph">
        <div className="git-graph-inner">
          <div className="git-graph-svg" ref={svgHostRef} />
          <div className="git-graph-rows" style={{ marginLeft: gutter }}>
            {commits.map((c) => (
              <div className="git-graph-row" key={c.hash} style={{ height: ROW_H }} title={c.subject}>
                {c.refs.length > 0 && (
                  <span className="git-graph-refs">
                    {refBadges(c.refs).map((b, i) => (
                      <span key={i} className={`git-graph-ref ${b.cls}`}>{b.label}</span>
                    ))}
                  </span>
                )}
                <span className="git-graph-subject">{c.subject}</span>
                <span className="git-graph-meta">
                  <span className="git-graph-hash">{shortHash(c.hash)}</span>
                  <span className="git-graph-author">{c.author}</span>
                  <span className="git-graph-date">{relTime(c.date)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="git-graph-wrap">
      <div className="git-graph-toolbar">
        <div className="seg-toggle">
          <button className={`seg ${!allBranches ? 'active' : ''}`} onClick={() => setAllBranches(false)}>
            Current branch
          </button>
          <button className={`seg ${allBranches ? 'active' : ''}`} onClick={() => setAllBranches(true)}>
            All branches
          </button>
        </div>
      </div>
      {body}
    </div>
  )
}
