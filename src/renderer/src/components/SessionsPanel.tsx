import { type KeyboardEvent, type MouseEvent, useMemo, useRef, useState } from 'react'
import type { AcpConversation, ProjectConversations, SessionMeta } from '../../../shared/acp'
import { workspaceId, type ProjectInfo } from '../../../shared/types'
import { useViewPrefsStore } from '../view-prefs-store'
import { groupKey, normRoot, workspaceForSession } from '../workspace'

const CUSTOMIZATIONS = [
  { icon: 'sparkle', label: 'Agents' },
  { icon: 'lightbulb', label: 'Skills' },
  { icon: 'book', label: 'Instructions' },
  { icon: 'plug', label: 'Hooks' },
  { icon: 'server', label: 'MCP Servers' },
  { icon: 'extensions', label: 'Plugins' }
]

interface Props {
  workspaces: ProjectInfo[]
  sessions: SessionMeta[]
  projects: ProjectConversations[]
  /** Connected SSH hosts ("user@host"), each rendered as its own host section. */
  remoteHosts: string[]
  /** Transport health per host key ('local' | `ssh:<host>`); absent = connected. */
  engineStatus: Record<string, string>
  activeSid: string | null
  onSelectSession: (sid: string) => void
  onOpenConversation: (project: ProjectConversations, conv: AcpConversation) => void
  onNewSession: (ws: ProjectInfo) => void
  onCloseWorkspace: (wsId: string) => void
  /** Permanently end (kill) a live session on the engine. */
  onDeleteSession: (sid: string) => void
  onOpenLocal: () => void
  onOpenSsh: () => void
  /** Open the remote folder picker for a connected host. */
  onOpenRemoteFolder: (host: string) => void
  /** Disconnect a connected SSH host. */
  onDisconnectRemote: (host: string) => void
}

function relTime(ms: number): string {
  if (!ms || Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusClass(status?: string): string {
  if (status === 'working') return 'acp-status-working'
  if (status === 'waiting') return 'acp-status-waiting'
  return 'acp-status-idle'
}

const activity = (s: SessionMeta): number => Date.parse(s.lastAttachedAt || s.createdAt)

// Max rows shown per project group / bucket before a "Show more" toggle.
const ROW_LIMIT = 5

// A row in a project group: either a live (running/suspended) session, or a
// past conversation on disk that can be resumed on click.
type Row =
  | { kind: 'live'; s: SessionMeta }
  | { kind: 'conv'; project: ProjectConversations; conv: AcpConversation }

interface Group {
  key: string
  cwd: string
  name: string
  host: string | null
  /** Set when this project is an open workspace (gets + / close controls). */
  workspace: ProjectInfo | null
  project: ProjectConversations | null
  live: SessionMeta[]
}

/** The project a "New Session" targets for a group — the open workspace if the
 *  group is one, else a project synthesized from its folder (discovered on-disk
 *  projects with no open workspace still get to start sessions). */
function groupProject(g: Group): ProjectInfo {
  if (g.workspace) return g.workspace
  const kind = g.host ? 'ssh' : 'local'
  return {
    id: workspaceId({ kind, host: g.host ?? undefined, rootPath: g.cwd }),
    kind,
    name: g.name,
    rootPath: g.cwd,
    host: g.host ?? undefined
  }
}

interface LiveRowProps {
  s: SessionMeta
  active: boolean
  pinned: boolean
  hidden: boolean
  onSelect: () => void
  onTogglePin: () => void
  onHide: () => void
  onUnhide: () => void
  onDelete: () => void
}

function LiveRow({ s, active, pinned, hidden, onSelect, onTogglePin, onHide, onUnhide, onDelete }: LiveRowProps) {
  const [confirming, setConfirming] = useState(false)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div className={`acp-session-row-wrap ${hidden ? 'hidden' : ''}`}>
      <button className={`acp-session-row ${active ? 'active' : ''}`} onClick={onSelect}>
        <span className={`acp-status-dot ${statusClass(s.claudeStatus)}`} />
        <span className="acp-session-main">
          <span className="acp-session-name">{s.name}</span>
          <span className="acp-session-sub">
            {s.claudeStatus ?? s.status} · {relTime(activity(s))}
          </span>
        </span>
      </button>
      <span className={`acp-session-actions ${confirming ? 'confirming' : ''}`}>
        {confirming ? (
          <>
            <button
              className="icon-button act codicon codicon-trash danger"
              title="Confirm delete — ends the agent"
              onClick={stop(onDelete)}
            />
            <button
              className="icon-button act codicon codicon-close"
              title="Cancel"
              onClick={stop(() => setConfirming(false))}
            />
          </>
        ) : (
          <>
            <button
              className={`icon-button act pin-btn codicon ${pinned ? 'codicon-pinned pinned' : 'codicon-pin'}`}
              title={pinned ? 'Unpin' : 'Pin'}
              onClick={stop(onTogglePin)}
            />
            {hidden ? (
              <button
                className="icon-button act codicon codicon-eye"
                title="Unhide"
                onClick={stop(onUnhide)}
              />
            ) : (
              <button
                className="icon-button act codicon codicon-eye-closed"
                title="Hide"
                onClick={stop(onHide)}
              />
            )}
            <button
              className="icon-button act codicon codicon-trash"
              title="Delete session"
              onClick={stop(() => setConfirming(true))}
            />
          </>
        )}
      </span>
    </div>
  )
}

function ConvRow({ conv, onOpen }: { conv: AcpConversation; onOpen: () => void }) {
  return (
    <button className="acp-session-row acp-session-history" onClick={onOpen} title="Resume this conversation">
      <span className="acp-status-dot acp-status-idle" />
      <span className="acp-session-main">
        <span className="acp-session-name">{conv.title || 'Untitled conversation'}</span>
        <span className="acp-session-sub">resume · {relTime(conv.mtime)}</span>
      </span>
    </button>
  )
}

export function SessionsPanel({
  workspaces,
  sessions,
  projects,
  remoteHosts,
  engineStatus,
  activeSid,
  onSelectSession,
  onOpenConversation,
  onNewSession,
  onCloseWorkspace,
  onDeleteSession,
  onOpenLocal,
  onOpenSsh,
  onOpenRemoteFolder,
  onDisconnectRemote
}: Props) {
  const pinnedSessions = useViewPrefsStore((s) => s.pinnedSessions)
  const hiddenSessions = useViewPrefsStore((s) => s.hiddenSessions)
  const hiddenProjects = useViewPrefsStore((s) => s.hiddenProjects)
  const focusMode = useViewPrefsStore((s) => s.focusMode)
  const showHidden = useViewPrefsStore((s) => s.showHidden)
  const togglePin = useViewPrefsStore((s) => s.togglePin)
  const hideSession = useViewPrefsStore((s) => s.hideSession)
  const unhideSession = useViewPrefsStore((s) => s.unhideSession)
  const hideProject = useViewPrefsStore((s) => s.hideProject)
  const unhideProject = useViewPrefsStore((s) => s.unhideProject)
  const setFocusMode = useViewPrefsStore((s) => s.setFocusMode)
  const setShowHidden = useViewPrefsStore((s) => s.setShowHidden)

  // Merge open workspaces, the discovered on-disk history, and live sessions
  // into one project-grouped list (VS Code Agent-window style). Sessions that
  // don't fall under any known project land in a per-host "Other sessions" group.
  const { groups, otherByHost, otherHosts } = useMemo(() => {
    const groups = new Map<string, Group>()

    // 1. Open workspaces first — they own the + / close controls and ordering.
    for (const ws of workspaces) {
      const key = groupKey(ws.host ?? null, ws.rootPath)
      groups.set(key, {
        key,
        cwd: ws.rootPath,
        name: ws.name,
        host: ws.host ?? null,
        workspace: ws,
        project: null,
        live: []
      })
    }

    // 2. Discovered projects — merge into a matching workspace group or append.
    for (const p of projects) {
      const key = groupKey(p.host ?? null, p.cwd)
      const existing = groups.get(key)
      if (existing) existing.project = p
      else
        groups.set(key, {
          key,
          cwd: p.cwd,
          name: p.name,
          host: p.host ?? null,
          workspace: null,
          project: p,
          live: []
        })
    }

    // 3. Live sessions — attach to an exact project group, else the most specific
    //    open workspace, else the per-host "Other sessions" bucket.
    const otherByHost = new Map<string | null, SessionMeta[]>()
    for (const s of sessions) {
      const exact = groups.get(groupKey(s.host ?? null, s.cwd))
      if (exact) {
        exact.live.push(s)
        continue
      }
      const ws = workspaceForSession(s, workspaces)
      const wsGroup = ws ? groups.get(groupKey(ws.host ?? null, ws.rootPath)) : undefined
      if (wsGroup) wsGroup.live.push(s)
      else {
        const host = s.host ?? null
        const arr = otherByHost.get(host) ?? []
        arr.push(s)
        otherByHost.set(host, arr)
      }
    }

    const otherHosts = [...otherByHost.keys()]
    return { groups: [...groups.values()], otherByHost, otherHosts }
  }, [workspaces, projects, sessions])

  // Pinned sessions sort ahead of the rest; ties break on recency.
  const byPinThenActivity = (a: SessionMeta, b: SessionMeta): number => {
    const pa = pinnedSessions[a.id] ? 1 : 0
    const pb = pinnedSessions[b.id] ? 1 : 0
    if (pa !== pb) return pb - pa
    return activity(b) - activity(a)
  }
  const visibleLive = (list: SessionMeta[]): SessionMeta[] =>
    list.filter((s) => showHidden || !hiddenSessions[s.id]).sort(byPinThenActivity)

  // Build the display rows for a group: live sessions first (pinned first), then
  // conversations not already represented by a live session (matched on acpSessionId).
  const rowsFor = (g: Group): Row[] => {
    const live = visibleLive(g.live)
    const liveAcpIds = new Set(live.map((s) => s.acpSessionId).filter(Boolean) as string[])
    const rows: Row[] = live.map((s) => ({ kind: 'live', s }))
    if (g.project) {
      for (const conv of g.project.conversations) {
        if (liveAcpIds.has(conv.sessionId)) continue
        rows.push({ kind: 'conv', project: g.project, conv })
      }
    }
    return rows
  }

  // Hidden project groups drop out entirely unless showHidden is on.
  const isHiddenGroup = (g: Group): boolean => !!hiddenProjects[g.key]
  const visibleGroups = groups.filter((g) => showHidden || !isHiddenGroup(g))

  const hiddenCount =
    sessions.filter((s) => hiddenSessions[s.id]).length + groups.filter(isHiddenGroup).length

  // Collapsed groups, keyed by group key ('other:<host>' for the fallback
  // buckets). Groups are expanded by default; a key present here is collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Per-group "show more": each group/bucket shows at most ROW_LIMIT rows until
  // expanded. Searching/scoping force-expands so matches aren't hidden.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Collapse All / Expand All toggle over every host section + project group +
  // "other" bucket.
  const allCollapsibleKeys = useMemo(() => {
    const remoteHostSet = new Set<string>([
      ...remoteHosts,
      ...visibleGroups.map((g) => g.host).filter((h): h is string => !!h),
      ...otherHosts.filter((h): h is string => !!h)
    ])
    const sectionKeys = ['host:local', ...[...remoteHostSet].map((h) => `host:${h}`)]
    return [
      ...sectionKeys,
      ...visibleGroups.map((g) => g.key),
      ...otherHosts.map((h) => `other:${h ?? 'local'}`)
    ]
  }, [visibleGroups, otherHosts, remoteHosts])
  const allCollapsed =
    allCollapsibleKeys.length > 0 && allCollapsibleKeys.every((k) => collapsed.has(k))
  const toggleCollapseAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(allCollapsibleKeys))

  // Search works in two stages. With no project scoped, typing offers project
  // suggestions (Tab/Enter/click to scope) and also free-text filters the whole
  // list. Once a project is scoped, the query filters sessions within it only.
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<{ key: string; name: string; host: string | null } | null>(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matches = (t?: string | null): boolean => !!t && t.toLowerCase().includes(q)
  const groupMatches = (g: Group): boolean => matches(g.name) || matches(g.host) || matches(g.cwd)

  // Project suggestions while no scope is chosen: all projects, narrowed by the
  // typed text. Empty query lists them all (a quick project picker).
  const suggestions = scope ? [] : visibleGroups.filter((g) => !searching || groupMatches(g)).slice(0, 8)
  const showSuggest = suggestOpen && !scope && suggestions.length > 0

  const selectScope = (g: Group): void => {
    setScope({ key: g.key, name: g.name, host: g.host })
    setQuery('')
    setSuggestOpen(false)
    setHighlight(0)
    inputRef.current?.focus()
  }
  const clearSearch = (): void => {
    setScope(null)
    setQuery('')
    setSuggestOpen(false)
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (showSuggest) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        selectScope(suggestions[Math.min(highlight, suggestions.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggestOpen(false)
        return
      }
    }
    // Backspace on an empty query pops the scope chip.
    if (e.key === 'Backspace' && query === '' && scope) {
      e.preventDefault()
      setScope(null)
      return
    }
    if (e.key === 'Escape') {
      if (query) setQuery('')
      else clearSearch()
    }
  }

  // Props shared by every rendered live session row.
  const liveRowProps = (s: SessionMeta): LiveRowProps => ({
    s,
    active: s.id === activeSid,
    pinned: !!pinnedSessions[s.id],
    hidden: !!hiddenSessions[s.id],
    onSelect: () => onSelectSession(s.id),
    onTogglePin: () => togglePin(s.id),
    onHide: () => hideSession(s.id),
    onUnhide: () => unhideSession(s.id),
    onDelete: () => onDeleteSession(s.id)
  })

  // Focus mode: a cross-project list of pinned sessions (most recent first),
  // filtered by the search query. Scoping is bypassed.
  const focusList = sessions
    .filter((s) => pinnedSessions[s.id] && !hiddenSessions[s.id])
    .filter((s) => !searching || matches(s.name))
    .sort(byPinThenActivity)

  // Group the focus list by project so each carries its host/project heading
  // instead of a context-free flat list. Insertion order follows focusList, so
  // the most recently active project's group leads. The display name comes from
  // a matching project group when one exists, else the folder's basename.
  const focusGroups = useMemo(() => {
    const nameByKey = new Map(groups.map((g) => [g.key, g.name]))
    const map = new Map<string, { key: string; name: string; host: string | null; cwd: string; list: SessionMeta[] }>()
    for (const s of focusList) {
      const key = groupKey(s.host ?? null, s.cwd)
      let entry = map.get(key)
      if (!entry) {
        entry = {
          key,
          name: nameByKey.get(key) ?? normRoot(s.cwd).split('/').pop() ?? s.cwd,
          host: s.host ?? null,
          cwd: s.cwd,
          list: []
        }
        map.set(key, entry)
      }
      entry.list.push(s)
    }
    return [...map.values()]
  }, [focusList, groups])

  // Groups to render. Scoped: just that project, its rows filtered by the query.
  // Unscoped: free-text filter across every group (project name/host/path match
  // keeps all rows, else only matching rows).
  const shownGroups: { g: Group; rows: Row[] }[] = scope
    ? visibleGroups
        .filter((g) => g.key === scope.key)
        .map((g) => {
          const rows = rowsFor(g)
          const visible = searching
            ? rows.filter((r) => (r.kind === 'live' ? matches(r.s.name) : matches(r.conv.title)))
            : rows
          return { g, rows: visible }
        })
    : visibleGroups
        .map((g) => {
          const rows = rowsFor(g)
          const hit = groupMatches(g)
          const visible =
            !searching || hit
              ? rows
              : rows.filter((r) => (r.kind === 'live' ? matches(r.s.name) : matches(r.conv.title)))
          return { g, rows: visible, hit }
        })
        .filter(({ rows, hit }) => !searching || hit || rows.length > 0)

  const shownOthers = scope
    ? []
    : otherHosts
        .map((host) => {
          const all = visibleLive(otherByHost.get(host) ?? [])
          // Matching the host keeps the whole bucket; otherwise filter by name.
          const list = !searching || matches(host) ? all : all.filter((s) => matches(s.name))
          return { host, list }
        })
        .filter(({ host, list }) => !searching || matches(host) || list.length > 0)

  const nothing = groups.length === 0 && otherHosts.length === 0 && remoteHosts.length === 0
  const noResults = (searching || !!scope) && shownGroups.length === 0 && shownOthers.length === 0

  // One project group: live sessions first, then resumable past conversations.
  const renderGroup = ({ g, rows }: { g: Group; rows: Row[] }) => {
    // Force-expand while searching or scoped so matches stay visible.
    const isCollapsed = !searching && !scope && collapsed.has(g.key)
    const groupHidden = isHiddenGroup(g)
    // Cap to ROW_LIMIT rows unless expanded (or searching/scoped, which show all).
    const showAll = searching || !!scope || expanded.has(g.key)
    const shownRows = showAll ? rows : rows.slice(0, ROW_LIMIT)
    return (
      <div key={g.key} className={`sessions-group ${groupHidden ? 'hidden' : ''}`}>
        <div
          className="sessions-group-header"
          onClick={() => toggle(g.key)}
          role="button"
          aria-expanded={!isCollapsed}
        >
          <span
            className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} sessions-group-twistie`}
          />
          <span className="sessions-group-name" title={g.host ? `${g.host}:${g.cwd}` : g.cwd}>
            {g.name}
          </span>
          <span className="topbar-spacer" />
          <button
            className="icon-button codicon codicon-add"
            title="New Session"
            onClick={(e) => {
              e.stopPropagation()
              onNewSession(groupProject(g))
            }}
          />
          {groupHidden ? (
            <button
              className="icon-button codicon codicon-eye"
              title="Unhide Project"
              onClick={(e) => {
                e.stopPropagation()
                unhideProject(g.key)
              }}
            />
          ) : (
            <button
              className="icon-button codicon codicon-eye-closed"
              title="Hide Project"
              onClick={(e) => {
                e.stopPropagation()
                hideProject(g.key)
              }}
            />
          )}
          {g.workspace && (
            <button
              className="icon-button codicon codicon-close"
              title="Close Folder"
              onClick={(e) => {
                e.stopPropagation()
                onCloseWorkspace(g.workspace!.id)
              }}
            />
          )}
        </div>
        {!isCollapsed &&
          (rows.length > 0 ? (
            <>
              {shownRows.map((r) =>
                r.kind === 'live' ? (
                  <LiveRow key={r.s.id} {...liveRowProps(r.s)} />
                ) : (
                  <ConvRow
                    key={r.conv.sessionId}
                    conv={r.conv}
                    onOpen={() => onOpenConversation(r.project, r.conv)}
                  />
                )
              )}
              {!searching && !scope && rows.length > ROW_LIMIT && (
                <button className="sessions-more" onClick={() => toggleExpanded(g.key)}>
                  {expanded.has(g.key) ? 'Show less' : `Show ${rows.length - ROW_LIMIT} more`}
                </button>
              )}
            </>
          ) : (
            <div className="sessions-empty">No sessions yet</div>
          ))}
      </div>
    )
  }

  // A per-host "Other sessions" bucket (sessions under no known project).
  const renderOther = ({ host, list }: { host: string | null; list: SessionMeta[] }) => {
    const key = `other:${host ?? 'local'}`
    const isCollapsed = !searching && collapsed.has(key)
    const showAll = searching || expanded.has(key)
    const shownList = showAll ? list : list.slice(0, ROW_LIMIT)
    return (
      <div key={key} className="sessions-group">
        <div
          className="sessions-group-header"
          onClick={() => toggle(key)}
          role="button"
          aria-expanded={!isCollapsed}
        >
          <span
            className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} sessions-group-twistie`}
          />
          <span className="sessions-group-name sessions-group-other">Other sessions</span>
        </div>
        {!isCollapsed && (
          <>
            {shownList.map((s) => <LiveRow key={s.id} {...liveRowProps(s)} />)}
            {!searching && list.length > ROW_LIMIT && (
              <button className="sessions-more" onClick={() => toggleExpanded(key)}>
                {expanded.has(key) ? 'Show less' : `Show ${list.length - ROW_LIMIT} more`}
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  // Sectioning: local groups render flat; each connected remote host gets a
  // header (with open-folder / disconnect controls) above its own groups. While
  // scoped to one project, sectioning is skipped (that single group is shown).
  const localGroups = shownGroups.filter(({ g }) => (g.host ?? null) === null)
  const localOthers = shownOthers.filter(({ host }) => host === null)
  const remoteSectionHosts = [
    ...new Set<string>([
      ...remoteHosts,
      ...shownGroups.map(({ g }) => g.host).filter((h): h is string => !!h),
      ...shownOthers.map(({ host }) => host).filter((h): h is string => !!h)
    ])
  ].sort((a, b) => a.localeCompare(b))

  const statusFor = (host: string): string | undefined => {
    const st = engineStatus[`ssh:${host}`]
    return st && st !== 'connected' ? st : undefined
  }

  // Host sections collapse too (via the header twistie or Collapse All), but stay
  // expanded while searching so matches remain visible.
  const isSectionCollapsed = (key: string): boolean => !searching && collapsed.has(key)

  return (
    <div className="sessions-panel agent-sessions-workbench">
      <div className="sessions-header">
        <span className="sessions-title">Sessions</span>
        {!nothing && (
          <div className="seg-toggle">
            <button className={`seg ${!focusMode ? 'active' : ''}`} onClick={() => setFocusMode(false)}>
              All
            </button>
            <button
              className={`seg ${focusMode ? 'active' : ''}`}
              title="Show only pinned sessions"
              onClick={() => setFocusMode(true)}
            >
              <span className="codicon codicon-pinned" />
              Focus
            </button>
          </div>
        )}
        <span className="topbar-spacer" />
        {!focusMode && hiddenCount > 0 && (
          <button
            className={`sessions-show-hidden ${showHidden ? 'active' : ''}`}
            onClick={() => setShowHidden(!showHidden)}
            title={showHidden ? 'Stop showing hidden items' : `Show ${hiddenCount} hidden item(s)`}
          >
            <span className={`codicon ${showHidden ? 'codicon-eye' : 'codicon-eye-closed'}`} />
            {hiddenCount}
          </button>
        )}
        {!focusMode && (
          <button
            className={`icon-button codicon ${allCollapsed ? 'codicon-expand-all' : 'codicon-collapse-all'}`}
            title={allCollapsed ? 'Expand All' : 'Collapse All'}
            onClick={toggleCollapseAll}
          />
        )}
        <button className="icon-button codicon codicon-new-folder" title="Open Folder" onClick={onOpenLocal} />
        <button className="icon-button codicon codicon-remote" title="Connect SSH" onClick={onOpenSsh} />
      </div>
      {!nothing && (
        <div className="sessions-search-wrap">
          <div className="sessions-search">
            <span className="codicon codicon-search sessions-search-icon" />
            {scope && !focusMode && (
              <span className="sessions-search-scope" title={scope.host ? `${scope.host}` : undefined}>
                {scope.host && <span className="codicon codicon-remote" />}
                <span className="sessions-search-scope-name">{scope.name}</span>
                <span
                  className="codicon codicon-close sessions-search-scope-remove"
                  role="button"
                  title="Remove project filter"
                  onClick={() => {
                    setScope(null)
                    inputRef.current?.focus()
                  }}
                />
              </span>
            )}
            <input
              ref={inputRef}
              className="sessions-search-input"
              type="text"
              placeholder={
                focusMode
                  ? 'Search pinned sessions'
                  : scope
                    ? `Search in ${scope.name}`
                    : 'Search projects, sessions, hosts'
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSuggestOpen(true)
                setHighlight(0)
              }}
              onFocus={() => !scope && !focusMode && setSuggestOpen(true)}
              onBlur={() => setSuggestOpen(false)}
              onKeyDown={onSearchKeyDown}
              spellCheck={false}
            />
            {(query || scope) && (
              <button
                className="icon-button codicon codicon-close sessions-search-clear"
                title="Clear"
                onClick={clearSearch}
              />
            )}
          </div>
          {showSuggest && !focusMode && (
            <ul className="sessions-suggest" role="listbox">
              {suggestions.map((g, i) => (
                <li
                  key={g.key}
                  role="option"
                  aria-selected={i === highlight}
                  className={`sessions-suggest-item ${i === highlight ? 'active' : ''}`}
                  // mouseDown fires before the input blur, so the click registers.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectScope(g)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {g.host && <span className="codicon codicon-remote sessions-suggest-remote" />}
                  <span className="sessions-suggest-name">{g.name}</span>
                  {g.host && <span className="sessions-suggest-host">{g.host}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="sessions-body pane-body">
        {nothing ? (
          <div className="sessions-empty-cta">
            <div className="sessions-empty">No sessions found</div>
            <button className="btn btn-primary" onClick={onOpenLocal}>Open Folder</button>
            <button className="btn" onClick={onOpenSsh}>Connect SSH…</button>
          </div>
        ) : focusMode ? (
          // Focus mode — pinned sessions grouped under their host/project heading.
          focusList.length > 0 ? (
            focusGroups.map((fg) => (
              <div key={fg.key} className="sessions-group sessions-focus-group">
                <div
                  className="sessions-group-header sessions-focus-group-header"
                  title={fg.host ? `${fg.host}:${fg.cwd}` : fg.cwd}
                >
                  <span
                    className={`codicon ${fg.host ? 'codicon-server' : 'codicon-device-desktop'} sessions-focus-group-icon`}
                  />
                  <span className="sessions-group-name">{fg.name}</span>
                  {fg.host && (
                    <span className="sessions-group-host">{fg.host.slice(fg.host.lastIndexOf('@') + 1)}</span>
                  )}
                </div>
                {fg.list.map((s) => (
                  <LiveRow key={s.id} {...liveRowProps(s)} />
                ))}
              </div>
            ))
          ) : (
            <div className="sessions-empty sessions-focus-empty">
              {searching
                ? 'No pinned sessions match.'
                : 'No pinned sessions yet. Pin a session (hover a row → pin) to focus on it here.'}
            </div>
          )
        ) : noResults ? (
          <div className="sessions-empty">No matching sessions</div>
        ) : scope ? (
          // Scoped to a single project — render it flat, no host section.
          <>{shownGroups.map(renderGroup)}</>
        ) : (
          <>
            {(!searching || localGroups.length > 0 || localOthers.length > 0) &&
              (() => {
                const collapsedSection = isSectionCollapsed('host:local')
                return (
                  <div className="sessions-host-section">
                    <div
                      className="sessions-host-header"
                      onClick={() => toggle('host:local')}
                      role="button"
                      aria-expanded={!collapsedSection}
                    >
                      <span
                        className={`codicon ${collapsedSection ? 'codicon-chevron-right' : 'codicon-chevron-down'} sessions-group-twistie`}
                      />
                      <span className="codicon codicon-device-desktop sessions-host-icon" />
                      <span className="sessions-host-name">Local</span>
                      <span className="topbar-spacer" />
                      <button
                        className="icon-button codicon codicon-new-folder"
                        title="Open Folder"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenLocal()
                        }}
                      />
                    </div>
                    {!collapsedSection &&
                      (localGroups.length > 0 || localOthers.length > 0 ? (
                        <>
                          {localGroups.map(renderGroup)}
                          {localOthers.map(renderOther)}
                        </>
                      ) : (
                        <div className="sessions-empty">No projects yet</div>
                      ))}
                  </div>
                )
              })()}
            {remoteSectionHosts.map((host) => {
              const hostGroups = shownGroups.filter(({ g }) => g.host === host)
              const hostOthers = shownOthers.filter((o) => o.host === host)
              // While searching, hide a host with no matches so results stay tight.
              if (searching && hostGroups.length === 0 && hostOthers.length === 0) return null
              const status = statusFor(host)
              const collapsedSection = isSectionCollapsed(`host:${host}`)
              return (
                <div key={`host:${host}`} className="sessions-host-section">
                  <div
                    className="sessions-host-header"
                    onClick={() => toggle(`host:${host}`)}
                    role="button"
                    aria-expanded={!collapsedSection}
                  >
                    <span
                      className={`codicon ${collapsedSection ? 'codicon-chevron-right' : 'codicon-chevron-down'} sessions-group-twistie`}
                    />
                    <span className="codicon codicon-server sessions-host-icon" />
                    <span className="sessions-host-name" title={host}>
                      {host.slice(host.lastIndexOf('@') + 1)}
                    </span>
                    {status && <span className={`sessions-host-status ${status}`}>{status}</span>}
                    <span className="topbar-spacer" />
                    <button
                      className="icon-button codicon codicon-new-folder"
                      title="Open Remote Folder"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenRemoteFolder(host)
                      }}
                    />
                    <button
                      className="icon-button codicon codicon-debug-disconnect"
                      title="Disconnect"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDisconnectRemote(host)
                      }}
                    />
                  </div>
                  {!collapsedSection &&
                    (hostGroups.length > 0 || hostOthers.length > 0 ? (
                      <>
                        {hostGroups.map(renderGroup)}
                        {hostOthers.map(renderOther)}
                      </>
                    ) : (
                      <div className="sessions-empty">No projects yet</div>
                    ))}
                </div>
              )
            })}
          </>
        )}
      </div>
      <div className="customizations">
        <div className="customizations-label">Customizations</div>
        {CUSTOMIZATIONS.map((c) => (
          <div key={c.label} className="customization-row">
            <span className={`codicon codicon-${c.icon}`} />
            <span className="customization-name">{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
