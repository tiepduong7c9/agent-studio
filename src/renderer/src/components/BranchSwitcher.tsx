import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitBranches } from '../../../shared/types'
import { useToastStore } from '../toast-store'
import { fuzzyMatch } from '../fuzzy'

// Centered popup for switching branches, opened by clicking the branch name in
// the status bar. Clicking a branch does everything in one click: check it out,
// then — if "Pull latest" is ticked — pull it. "Ignore local changes" forces
// past uncommitted tracked changes: the switch uses `checkout --force` and the
// pull hard-resets to the upstream (untracked files are kept either way).

interface BranchItem {
  /** What we hand to gitCheckout — a plain branch name git can DWIM. */
  target: string
  /** Row label. */
  label: string
  /** True for a remote-only branch (checked out as a new tracking branch). */
  remote: boolean
}

interface Props {
  wsId: string
  /** Current branch (or null in detached HEAD), for the header + active marker. */
  current: string | null
  onClose: () => void
  /** Called after a successful switch/pull so the caller can refetch the branch. */
  onChanged: () => void
}

export function BranchSwitcher({ wsId, current, onClose, onChanged }: Props) {
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pullLatest, setPullLatest] = useState(true)
  const [discardLocal, setDiscardLocal] = useState(false)
  // Non-null while a switch/pull runs — disables the UI and shows what's busy.
  const [busy, setBusy] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const push = useToastStore((s) => s.push)

  // Git output (a pull's summary, or an error) can run to many lines and would
  // overflow the toast off-screen. Show a short line inline when the output is
  // brief; otherwise keep the summary and stash the full text behind "Details".
  const pushOutput = (kind: 'info' | 'danger', summary: string, full: string) => {
    const text = full.trim()
    const brief = !text.includes('\n') && text.length <= 100
    if (brief) push(kind, summary ? `${summary} · ${text}` : text)
    else push(kind, summary || text.split('\n', 1)[0], text)
  }

  useEffect(() => {
    let cancelled = false
    window.studio.gitBranches(wsId).then((res) => {
      if (cancelled) return
      if (res.ok) setBranches(res.data)
      else setLoadError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [wsId])

  // Local branches, then any remote-only branch (its stripped name isn't already
  // a local branch). Switching to a remote-only branch creates a tracking branch.
  const items = useMemo<BranchItem[]>(() => {
    if (!branches) return []
    const locals = new Set(branches.local)
    const out: BranchItem[] = branches.local.map((b) => ({ target: b, label: b, remote: false }))
    for (const r of branches.remote) {
      const short = r.slice(r.indexOf('/') + 1) // strip the remote prefix ("origin/")
      if (!locals.has(short)) out.push({ target: short, label: r, remote: true })
    }
    return out
  }, [branches])

  const results = useMemo(() => {
    const q = query.trim()
    if (!q) return items
    return items
      .map((item) => ({ item, m: fuzzyMatch(q, item.label) }))
      .filter((r) => r.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((r) => r.item)
  }, [items, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // One click = checkout (if not already there), then pull (if ticked). Either
  // step can be skipped, so clicking the current branch with "Pull latest" off
  // just closes, and with it on pulls the current branch in place.
  const run = async (item: BranchItem | undefined) => {
    if (!item || busy) return
    const switching = item.target !== current
    if (!switching && !pullLatest) return onClose() // nothing to do

    if (switching) {
      setBusy(`Switching to ${item.label}…`)
      const res = await window.studio.gitCheckout(wsId, item.target, discardLocal)
      if (!res.ok) {
        setBusy(null)
        return pushOutput('danger', 'Switch failed', res.error)
      }
    }
    if (pullLatest) {
      setBusy(discardLocal ? 'Resetting to upstream…' : 'Pulling…')
      const res = await window.studio.gitPull(wsId, discardLocal)
      if (!res.ok) {
        setBusy(null)
        // The switch (if any) still succeeded — reflect it before reporting.
        onChanged()
        return pushOutput('danger', 'Pull failed', res.error)
      }
      pushOutput('info', switching ? `Switched to ${item.target}` : 'Pulled latest', res.data)
    } else {
      push('info', `Switched to ${item.target}`)
    }
    setBusy(null)
    onChanged()
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
      run(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="branch-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="quick-open-crumb">
          <span className="codicon codicon-git-branch" />
          {current ? `On branch ${current}` : 'Detached HEAD'}
        </div>
        <input
          className="quick-open-input"
          autoFocus
          placeholder="Search branches to switch"
          value={query}
          spellCheck={false}
          disabled={busy !== null}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="branch-actions">
          <label className="branch-check" title="After switching, pull the branch's upstream">
            <input
              type="checkbox"
              checked={pullLatest}
              disabled={busy !== null}
              onChange={(e) => setPullLatest(e.target.checked)}
            />
            Pull latest
          </label>
          <label className="branch-check" title="Force past uncommitted changes to tracked files">
            <input
              type="checkbox"
              checked={discardLocal}
              disabled={busy !== null}
              onChange={(e) => setDiscardLocal(e.target.checked)}
            />
            Ignore local changes
          </label>
        </div>

        {busy ? (
          <div className="quick-open-status">{busy}</div>
        ) : loadError ? (
          <div className="quick-open-status">{loadError}</div>
        ) : results.length === 0 ? (
          <div className="quick-open-status">{branches ? 'No matching branches' : 'Loading…'}</div>
        ) : (
          <div className="quick-open-list" ref={listRef}>
            {results.map((item, i) => (
              <div
                key={(item.remote ? 'r:' : 'l:') + item.target}
                className={`quick-open-row ${i === active ? 'active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => run(item)}
              >
                <span
                  className={`codicon codicon-${item.target === current ? 'check' : item.remote ? 'cloud' : 'git-branch'} quick-open-icon`}
                />
                <span className="quick-open-name">{item.label}</span>
                {item.remote && <span className="quick-open-ws">remote</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
