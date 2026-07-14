import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConversations, SessionMeta } from '../../../shared/acp'
import type { ProjectInfo } from '../../../shared/types'
import { fuzzyMatch } from '../fuzzy'
import { normRoot } from '../workspace'
import { baseName } from './editors'
import { RemoteFolderPicker } from './RemoteFolderPicker'

// VS Code-style command palette (Ctrl/Cmd+Shift+P). A small, extensible
// multi-step quick pick. Today it drives one command — New Session — where you
// pick an existing project/workspace across any connected host, or browse the
// host's filesystem for a new folder. Whether the new session is pinned is
// decided by the caller (pinned when the sidebar is in Focus mode).

const MAX_RESULTS = 200

interface PaletteItem {
  key: string
  icon: string // codicon name
  label: string
  detail?: string // secondary text, e.g. the folder path
  badge?: string // right-aligned tag, e.g. the host label
  run: () => void
}

interface Props {
  workspaces: ProjectInfo[]
  projects: ProjectConversations[]
  sessions: SessionMeta[]
  remoteHosts: string[]
  /** Spin up a new session rooted at a folder on a host (null = local). */
  onCreateSession: (rootPath: string, host: string | null) => void
  /** Open the native folder picker on the local machine, then create a session. */
  onBrowseLocal: () => void
  onClose: () => void
}

const hostLabel = (host: string | null): string => host ?? 'Local'
const targetKey = (host: string | null, path: string): string => `${host ?? 'local'}:${normRoot(path)}`

export function CommandPalette({
  workspaces,
  projects,
  sessions,
  remoteHosts,
  onCreateSession,
  onBrowseLocal,
  onClose
}: Props) {
  // 'commands' → the top-level command list; 'targets' → pick where a New
  // Session runs. browseHost, when set, overlays the remote folder picker.
  const [step, setStep] = useState<'commands' | 'targets'>('commands')
  const [browseHost, setBrowseHost] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const goTargets = () => {
    setStep('targets')
    setQuery('')
  }

  const commands = useMemo<PaletteItem[]>(
    () => [
      {
        key: 'new-session',
        icon: 'add',
        label: 'New Session',
        detail: 'Create a Claude Code session',
        run: goTargets
      }
    ],
    []
  )

  const targets = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = []
    const seen = new Set<string>()

    // Open folders first — most likely where the user wants to work.
    for (const ws of workspaces) {
      const host = ws.host ?? null
      seen.add(targetKey(host, ws.rootPath))
      items.push({
        key: `ws:${ws.id}`,
        icon: 'root-folder',
        label: ws.name,
        detail: ws.rootPath,
        badge: hostLabel(host),
        run: () => onCreateSession(ws.rootPath, host)
      })
    }

    // Then every discovered project across hosts not already shown as an open folder.
    for (const p of projects) {
      const host = p.host ?? null
      const key = targetKey(host, p.cwd)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        key: `proj:${key}`,
        icon: 'folder',
        label: p.name,
        detail: p.cwd,
        badge: hostLabel(host),
        run: () => onCreateSession(p.cwd, host)
      })
    }

    // Then the folder of any live session not already covered — a remote host's
    // "existing projects" often surface this way (the folder has running
    // sessions but no discovered on-disk history yet), mirroring the sidebar.
    for (const s of sessions) {
      const host = s.host ?? null
      const key = targetKey(host, s.cwd)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        key: `sess:${key}`,
        icon: 'folder',
        label: baseName(s.cwd),
        detail: s.cwd,
        badge: hostLabel(host),
        run: () => onCreateSession(s.cwd, host)
      })
    }

    // Finally a "browse a new folder" action per host (local + connected remotes).
    items.push({
      key: 'browse:local',
      icon: 'search',
      label: 'Browse folder…',
      detail: 'Pick a folder on this machine',
      badge: 'Local',
      run: onBrowseLocal
    })
    for (const host of remoteHosts) {
      items.push({
        key: `browse:${host}`,
        icon: 'search',
        label: 'Browse folder…',
        detail: `Pick a folder on ${host}`,
        badge: host,
        run: () => setBrowseHost(host)
      })
    }
    return items
  }, [workspaces, projects, sessions, remoteHosts, onCreateSession, onBrowseLocal])

  const source = step === 'commands' ? commands : targets

  const results = useMemo(() => {
    const q = query.trim()
    if (!q) return source.slice(0, MAX_RESULTS).map((item) => ({ item, positions: [] as number[] }))
    const scored: { item: PaletteItem; positions: number[]; score: number }[] = []
    for (const item of source) {
      // Rank by the label, but still match on the detail (path) or badge (host)
      // so typing a path segment or host name finds the row — e.g. "agent1"
      // matches a project on "tiepduong@agent-vm1". Only a label hit highlights.
      const onLabel = fuzzyMatch(q, item.label)
      if (onLabel) {
        scored.push({ item, positions: onLabel.positions, score: onLabel.score + 1000 })
        continue
      }
      const onOther = fuzzyMatch(q, `${item.detail ?? ''} ${item.badge ?? ''}`)
      if (onOther) scored.push({ item, positions: [], score: onOther.score })
    }
    scored.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length)
    return scored.slice(0, MAX_RESULTS)
  }, [source, query])

  useEffect(() => setActive(0), [query, step])
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    item.run()
    // Navigation actions keep the palette mounted (New Session drills into the
    // target list; a remote "Browse folder…" overlays the picker in place).
    // Every leaf action dismisses it.
    const navigates =
      item.key === 'new-session' || (item.key.startsWith('browse:') && item.key !== 'browse:local')
    if (!navigates) onClose()
  }

  const back = () => {
    setStep('commands')
    setQuery('')
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
      choose(results[active]?.item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (step === 'targets') back()
      else onClose()
    } else if (e.key === 'Backspace' && query === '' && step === 'targets') {
      e.preventDefault()
      back()
    }
  }

  if (browseHost !== null) {
    return (
      <RemoteFolderPicker
        host={browseHost}
        onOpen={(info) => {
          onCreateSession(info.rootPath, info.host ?? null)
          onClose()
        }}
        onCancel={() => setBrowseHost(null)}
      />
    )
  }

  const placeholder =
    step === 'commands' ? 'Type a command' : 'Select a project or browse a folder to start a session'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        {step === 'targets' && (
          <div className="quick-open-crumb">
            <span className="codicon codicon-add" />
            New Session
          </div>
        )}
        <input
          className="quick-open-input"
          autoFocus
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.length === 0 ? (
          <div className="quick-open-status">No matches</div>
        ) : (
          <div className="quick-open-list" ref={listRef}>
            {results.map(({ item, positions }, i) => (
              <div
                key={item.key}
                className={`quick-open-row ${i === active ? 'active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(item)}
              >
                <span className={`codicon codicon-${item.icon} quick-open-icon`} />
                <span className="quick-open-name">{highlight(item.label, positions)}</span>
                {item.detail && <span className="quick-open-path">{item.detail}</span>}
                {item.badge && <span className="quick-open-ws">{item.badge}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
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
