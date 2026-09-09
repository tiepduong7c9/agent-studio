import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConversations, SessionMeta } from '../../../shared/acp'
import type { ProjectInfo } from '../../../shared/types'
import { fuzzyMatch } from '../fuzzy'
import { normRoot } from '../workspace'
import { baseName } from './editors'
import { highlightMatch } from './highlight'
import { RemoteFolderPicker } from './RemoteFolderPicker'

// VS Code-style command palette (Ctrl/Cmd+Shift+P). A small, extensible
// multi-step quick pick. Today it drives one command — New Session — where you
// pick an existing project/workspace across any connected host, or browse the
// host's filesystem for a new folder.

const MAX_RESULTS = 200

interface PaletteItem {
  key: string
  icon: string // codicon name
  label: string
  detail?: string // secondary text, e.g. the folder path
  badge?: string // right-aligned tag, e.g. the host label
  /** The host this target runs on (null = local); absent on non-target rows.
   *  Kept structured, rather than read back off the badge, so the host filter
   *  can't be fooled by a label. */
  host?: string | null
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
  /** Open the session switcher (Ctrl/Cmd+E) to jump to an existing session. */
  onGoToSession: () => void
  /** Which step to open on: 'commands' (default) or straight into 'targets'
   *  (the New Session project picker), e.g. from the sidebar's + button. */
  initialStep?: 'commands' | 'targets'
  /** Narrow the target list to one host, when the caller has already chosen
   *  where the session should run (the sidebar's hosts strip). Wrapped in an
   *  object so `{ host: null }` — the local machine — stays distinct from
   *  "no filter". */
  hostFilter?: { host: string | null }
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
  onGoToSession,
  initialStep = 'commands',
  hostFilter,
  onClose
}: Props) {
  // 'commands' → the top-level command list; 'targets' → pick where a New
  // Session runs. browseHost, when set, overlays the remote folder picker.
  const [step, setStep] = useState<'commands' | 'targets'>(initialStep)
  const [browseHost, setBrowseHost] = useState<string | null>(null)
  // The active host scope. Seeded from hostFilter and dropped when the user
  // steps back to the command list, so re-entering New Session from there asks
  // about every host again rather than silently staying narrowed.
  const [scope, setScope] = useState<{ host: string | null } | undefined>(hostFilter)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const goTargets = () => {
    setStep('targets')
    setQuery('')
  }

  const commands = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        key: 'new-session',
        icon: 'add',
        label: 'New Session',
        detail: 'Create a Claude Code session',
        run: goTargets
      }
    ]
    if (sessions.length > 0) {
      items.push({
        key: 'goto-session',
        icon: 'robot',
        label: 'Go to Session',
        detail: 'Jump to an open session (Ctrl/Cmd+E)',
        run: onGoToSession
      })
    }
    return items
  }, [sessions, onGoToSession])

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
        host,
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
        host,
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
        host,
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
      host: null,
      run: onBrowseLocal
    })
    for (const host of remoteHosts) {
      items.push({
        key: `browse:${host}`,
        icon: 'search',
        label: 'Browse folder…',
        detail: `Pick a folder on ${host}`,
        badge: host,
        host,
        run: () => setBrowseHost(host)
      })
    }
    // Scoped to one host: keep only that host's projects and its own "browse a
    // folder" action. Filtering the finished list (rather than each source)
    // keeps the ordering and de-duplication above untouched.
    if (!scope) return items
    return items.filter((it) => it.host === scope.host)
  }, [workspaces, projects, sessions, remoteHosts, scope, onCreateSession, onBrowseLocal])

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
    setScope(undefined)
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

  const scopedHost = scope ? hostLabel(scope.host) : null
  const placeholder =
    step === 'commands'
      ? 'Type a command'
      : scopedHost
        ? `Select a project on ${scopedHost}, or browse a folder`
        : 'Select a project or browse a folder to start a session'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        {step === 'targets' && (
          <div className="quick-open-crumb">
            <span className="codicon codicon-add" />
            New Session{scopedHost ? ` on ${scopedHost}` : ''}
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
                <span className="quick-open-name">{highlightMatch(item.label, positions)}</span>
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

