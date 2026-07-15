import { useCallback, useEffect, useRef, useState } from 'react'
import type { AcpConversation, ProjectConversations, SessionMeta } from '../../shared/acp'
import type { ProjectInfo, ProjectKind } from '../../shared/types'
import { workspaceId } from '../../shared/types'
import { useAcpStore } from './acp/store'
import { useSessionsStore } from './acp/sessions-store'
import { useUsageStore } from './acp/usage-store'
import { useUsageWarnings } from './acp/usage-warnings'
import { useDrafts } from './acp/drafts-store'
import { CommandPalette } from './components/CommandPalette'
import { EditorArea } from './components/EditorArea'
import { QuickOpen } from './components/QuickOpen'
import { RemoteFolderPicker } from './components/RemoteFolderPicker'
import { RightPanel } from './components/RightPanel'
import { Sash } from './components/Sash'
import { SessionsPanel } from './components/SessionsPanel'
import { SshDialog } from './components/SshDialog'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { baseName } from './components/editors'
import { notifySession } from './notify'
import type { Selection } from './selection'
import { chatTabId, diffTabId, fileTabId, newChatTabId, useTabsStore } from './tabs-store'
import { useViewPrefsStore } from './view-prefs-store'
import { workspaceForSession } from './workspace'

const MIN_PANEL_WIDTH = 170

function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_PANEL_WIDTH), Math.floor(window.innerWidth * 0.4))
}

const normRoot = (p: string): string => p.replace(/\/+$/, '') || '/'

/** A workspace rooted exactly at a session's own cwd/host. */
function matchesSessionDir(w: ProjectInfo, s: SessionMeta): boolean {
  return (w.host ?? null) === (s.host ?? null) && normRoot(w.rootPath) === normRoot(s.cwd)
}

export function App() {
  const [workspaces, setWorkspaces] = useState<ProjectInfo[]>([])
  // Providers rooted at a session's own cwd, so the right panel can follow a
  // selected session whose folder was never opened as a workspace.
  const [sessionWorkspaces, setSessionWorkspaces] = useState<ProjectInfo[]>([])
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  // Connected SSH hosts ("user@host"). Their projects/sessions surface in the
  // sidebar without opening a folder; each gets its own host section.
  const [remoteHosts, setRemoteHosts] = useState<string[]>([])
  // Host whose remote folder picker is open (optional "open folder" action);
  // null when not picking.
  const [folderPickerHost, setFolderPickerHost] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(340)
  const [leftVisible, setLeftVisible] = useState(true)
  const [rightVisible, setRightVisible] = useState(true)
  const dragBase = useRef(0)
  // Gate pruning of persisted view-prefs/tabs until the engine has actually
  // reported its sessions. Without this, the initial empty list (before
  // listSessions resolves) would wipe every persisted pin/hide on each launch.
  const sessionsLoaded = useRef(false)
  // False until reconnectSavedHosts() has settled. Until then remoteHosts may
  // still be empty, so the prune gate below has no host to skip on and would
  // wipe remote pins against a local-only session list. State (not a ref) so
  // flipping it re-runs the prune effect.
  const [savedHostsResolved, setSavedHostsResolved] = useState(false)

  const sessions = useSessionsStore((s) => s.sessions)
  const setSessions = useSessionsStore((s) => s.setSessions)
  const projects = useSessionsStore((s) => s.projects)
  const setProjects = useSessionsStore((s) => s.setProjects)
  const engineStatus = useSessionsStore((s) => s.engineStatus)
  const setHostStatus = useSessionsStore((s) => s.setHostStatus)
  const pinnedSessions = useViewPrefsStore((s) => s.pinnedSessions)

  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const maximized = useTabsStore((s) => s.maximized)
  const openTab = useTabsStore((s) => s.open)
  const pruneChats = useTabsStore((s) => s.pruneChats)
  const pruneWorkspace = useTabsStore((s) => s.pruneWorkspace)

  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeSid = active?.kind === 'chat' ? active.sid : null

  // Selecting/opening a session means the user is now looking at it — clear its
  // "done" (unread-completion) marker. Deliberately not cleared on mere window
  // refocus, so a session that finished while you were away still reads as
  // "done" when you come back, until you actually visit it or start a new turn.
  useEffect(() => {
    if (activeSid) useSessionsStore.getState().clearDone(activeSid)
  }, [activeSid])

  // Watch the session list for a working → idle transition (a finished turn).
  // The engine mirrors claudeStatus onto every session's meta and broadcasts it
  // regardless of which session the UI is attached to, so this catches
  // background sessions — the per-session event stream does not (it only flows
  // while a session is attached/viewed). A turn that finishes while the session
  // isn't being watched flips it to "done"; starting a new turn clears it.
  const prevClaudeStatus = useRef<Map<string, string | undefined>>(new Map())
  useEffect(() => {
    const prev = prevClaudeStatus.current
    const { markDone, clearDone } = useSessionsStore.getState()
    // OS notifications are only useful when the app isn't in front of the user;
    // if the window is focused we never send one (regardless of which session's
    // tab is active). The "done" marker is separate — it's per-session, so it
    // still uses `watching` (this session's tab active *and* window focused).
    const focused = document.hasFocus()
    for (const s of sessions) {
      const before = prev.get(s.id)
      const now = s.claudeStatus
      const watching = useTabsStore.getState().activeSid === s.id && focused
      if (before === 'working' && now === 'idle') {
        if (!watching) markDone(s.id)
        if (!focused) notifySession(s.id, s.name, 'done')
      } else if (now === 'working') {
        clearDone(s.id)
      }
      // A turn that pauses for input (permission prompt) flips to "waiting".
      // Guard on a known prior status so sessions already waiting when the app
      // starts don't fire a notification on first observation.
      if (before !== undefined && before !== 'waiting' && now === 'waiting' && !focused) {
        notifySession(s.id, s.name, 'waiting')
      }
      prev.set(s.id, now)
    }
    const live = new Set(sessions.map((s) => s.id))
    for (const id of [...prev.keys()]) if (!live.has(id)) prev.delete(id)
  }, [sessions])
  const activeChatMeta =
    active?.kind === 'chat' ? (sessions.find((s) => s.id === active.sid) ?? null) : null
  // The right panel follows the active tab's workspace. For a chat that's the
  // session's workspace: an open folder that contains it, else a provider rooted
  // at the session's own cwd (ensured by the effect below). File/diff tabs carry
  // an explicit workspace id. With no active tab, fall back to the first open one.
  const activeWorkspace: ProjectInfo | null = !active
    ? (workspaces[0] ?? null)
    : active.kind === 'chat'
      ? activeChatMeta
        ? (workspaceForSession(activeChatMeta, workspaces) ??
           sessionWorkspaces.find((w) => matchesSessionDir(w, activeChatMeta)) ??
           null)
        : null
      : ([...workspaces, ...sessionWorkspaces].find((w) => w.id === active.wsId) ?? null)
  const selection: Selection | null =
    active?.kind === 'file'
      ? { kind: 'file', wsId: active.wsId, path: active.path, name: active.name }
      : active?.kind === 'diff'
        ? { kind: 'diff', wsId: active.wsId, change: active.change }
        : null

  const addWorkspace = useCallback((info: ProjectInfo) => {
    setWorkspaces((ws) => (ws.some((w) => w.id === info.id) ? ws : [...ws, info]))
  }, [])

  // (Re)scan every connected host's ~/.claude/projects for the grouped history.
  const refreshProjects = useCallback(() => {
    window.studio.acp.listProjects().then(setProjects).catch(() => {})
  }, [setProjects])

  useEffect(() => {
    const initial = window.studio.initialProjectPath
    if (!initial) return
    window.studio.openLocalPath(initial).then((result) => {
      if (result.ok) addWorkspace(result.data)
      else setError(result.error)
    })
  }, [addWorkspace])

  // Reconnect remembered SSH hosts on startup so their projects/sessions
  // resurface without re-entering credentials. Every remembered host is added to
  // the sidebar — including ones that failed to come back up, which are marked
  // 'lost' so they show as disconnected (with a Reconnect action) rather than
  // silently vanishing. Connected hosts get their 'connected' status from the
  // engine-status event fired during the reconnect.
  useEffect(() => {
    window.studio
      .reconnectSavedHosts()
      .then((res) => {
        if (res.ok && res.data.length) {
          setRemoteHosts((hs) => Array.from(new Set([...hs, ...res.data.map((h) => h.host)])))
          for (const h of res.data) if (!h.connected) setHostStatus(`ssh:${h.host}`, 'lost')
        }
      })
      .catch(() => {})
      .finally(() => setSavedHostsResolved(true))
  }, [setHostStatus])

  // Poll each connected host's subscription usage for the status bar and the
  // 50%/75% warnings: once now, then every 5 minutes. Local (null) is always
  // polled; SSH hosts are added as they connect.
  useEffect(() => {
    const refresh = useUsageStore.getState().refresh
    const targets: (string | null)[] = [null, ...remoteHosts]
    const tick = () => targets.forEach((h) => refresh(h))
    tick()
    const id = window.setInterval(tick, 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [remoteHosts])

  // Pop a toast when any host's usage crosses 50% / 75%.
  useUsageWarnings()

  // Route engine push events into the stores, and seed the session list.
  useEffect(() => {
    // Coalesce incoming events per animation frame: a resumed conversation
    // replays its whole history as individual frames, and applying each one
    // separately re-renders the thread (and rebuilds it) once per event — O(n²)
    // and a scroll jump per event. Buffering a frame's worth into one store
    // update collapses that to a single render per frame.
    const buffer = new Map<string, unknown[]>()
    let raf = 0
    const flush = () => {
      raf = 0
      const store = useAcpStore.getState()
      for (const [sid, evs] of buffer) store.appendEvents(sid, evs as never)
      buffer.clear()
    }
    const offEvent = window.studio.acp.onEvent(({ sid, event }) => {
      // Stamp arrival time now, before batching, so folding a frame's events in
      // one update doesn't collapse their individual timings. The wire type is
      // intentionally loose; the store uses the rich union.
      const e = event && (event as { rxAt?: number }).rxAt != null ? event : { ...(event as object), rxAt: Date.now() }
      const arr = buffer.get(sid)
      if (arr) arr.push(e)
      else buffer.set(sid, [e])
      if (!raf) raf = requestAnimationFrame(flush)
    })
    const markLoaded = (list: SessionMeta[]) => {
      sessionsLoaded.current = true
      setSessions(list)
    }
    const offSessions = window.studio.acp.onSessions(markLoaded)
    // A reconnect pushes a fresh snapshot per attached session; re-seat the thread.
    const offResync = window.studio.acp.onResync(({ sid, snapshot }) => {
      useAcpStore.getState().setHistory(sid, snapshot)
    })
    const offStatus = window.studio.acp.onEngineStatus(({ hostKey, connected, permanent }) => {
      setHostStatus(hostKey, connected ? 'connected' : permanent ? 'lost' : 'reconnecting')
      // A host coming (back) online may expose new projects — re-scan.
      if (connected) refreshProjects()
    })
    window.studio.acp.listSessions().then(markLoaded).catch(() => {})
    refreshProjects()
    return () => { offEvent(); offSessions(); offResync(); offStatus(); if (raf) cancelAnimationFrame(raf) }
  }, [setSessions, setHostStatus, refreshProjects])

  // Re-scan when the set of open workspaces or connected hosts changes
  // (connecting a host wires it, so its projects should now appear).
  useEffect(() => {
    refreshProjects()
  }, [workspaces, remoteHosts, refreshProjects])

  // Close chat tabs whose session was killed on the engine, and drop any
  // pin/hide prefs left behind by sessions that no longer exist. This is gated
  // so a startup snapshot that doesn't yet include a host's sessions can't wipe
  // that host's persisted pins:
  //  - sessionsLoaded: the engine has reported at least once (a pre-load empty
  //    list would otherwise wipe everything).
  //  - savedHostsResolved: reconnectSavedHosts() has settled, so remoteHosts is
  //    populated and the per-host check below actually has hosts to guard.
  //  - every remembered host is 'connected': a host still connecting (status
  //    undefined) or reconnecting hasn't delivered its sessions yet, so pruning
  //    against a list missing them would drop that host's live pins — the bug
  //    where remote pins went missing after an app restart.
  useEffect(() => {
    if (!sessionsLoaded.current || !savedHostsResolved) return
    if (remoteHosts.some((h) => engineStatus[`ssh:${h}`] !== 'connected')) return
    const live = new Set(sessions.map((s) => s.id))
    pruneChats(live)
    useViewPrefsStore.getState().pruneSessions(live)
    useDrafts.getState().prune(live)
  }, [sessions, pruneChats, remoteHosts, engineStatus, savedHostsResolved])

  // Keep a cached snapshot of each pinned session's metadata (name/cwd/host)
  // fresh from the live list. When the session's host later goes offline (a lost
  // connection, or a saved host that didn't reconnect after restart) it stops
  // pushing that session, so this cache is what lets the sidebar still render the
  // pinned row — dimmed and reconnectable — instead of dropping it.
  useEffect(() => {
    const metas = sessions
      .filter((s) => pinnedSessions[s.id])
      .map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, host: s.host ?? null }))
    if (metas.length) useViewPrefsStore.getState().rememberPinned(metas)
  }, [sessions, pinnedSessions])

  // When a chat is active and no open folder contains its session, root a
  // provider at the session's own cwd so the right panel reflects its directory.
  useEffect(() => {
    if (!activeChatMeta) return
    const meta = activeChatMeta
    if (workspaceForSession(meta, workspaces)) return
    if (sessionWorkspaces.some((w) => matchesSessionDir(w, meta))) return
    window.studio
      .ensureProjectForSession(meta.cwd, meta.host ?? null)
      .then((res) => {
        if (res.ok) {
          setSessionWorkspaces((prev) =>
            prev.some((w) => w.id === res.data.id) ? prev : [...prev, res.data]
          )
        }
      })
      .catch(() => {})
  }, [activeChatMeta, workspaces, sessionWorkspaces])

  const openChat = useCallback(
    (sid: string) => {
      const meta = sessions.find((s) => s.id === sid)
      const ws = meta ? workspaceForSession(meta, workspaces) : null
      // wsId '' = an "Other sessions" chat with no open folder; the right panel
      // (which keys off the active tab's workspace) just shows its placeholder.
      openTab({ id: chatTabId(sid), kind: 'chat', title: 'Claude Code', sid, wsId: ws?.id ?? '' })
    },
    [sessions, workspaces, openTab]
  )

  // Clicking an OS notification focuses the window (done in main) and asks us to
  // surface the session it was about.
  useEffect(() => {
    return window.studio.onNotificationActivate((sid) => openChat(sid))
  }, [openChat])

  const newSession = useCallback(
    async (ws: ProjectInfo, opts?: { pin?: boolean }) => {
      try {
        // Open workspaces already resolve in the panels. For a discovered project
        // with no open folder, root a provider at its directory (and register it)
        // so the file/git panels can follow the new session.
        if (!workspaces.some((w) => w.id === ws.id)) {
          const res = await window.studio.ensureProjectForSession(ws.rootPath, ws.host ?? null)
          if (!res.ok) return setError(res.error)
          ws = res.data
          setSessionWorkspaces((prev) => (prev.some((w) => w.id === ws.id) ? prev : [...prev, ws]))
        }
        // Spin up the live session and open its chat tab straight away.
        const meta = await window.studio.acp.createSession(ws.rootPath, ws.host ?? null)
        // Pin on request (e.g. started from Focus mode) so it surfaces there.
        if (opts?.pin) useViewPrefsStore.getState().togglePin(meta.id)
        openTab({ id: chatTabId(meta.id), kind: 'chat', title: 'Claude Code', sid: meta.id, wsId: ws.id })
      } catch (err: any) {
        setError(err?.message || String(err))
      }
    },
    [workspaces, openTab]
  )

  // Start a session at an arbitrary folder/host chosen from the command palette.
  // Reuse an already-open workspace when the folder matches one; otherwise build
  // a provider descriptor for it and let newSession root it. Pin the session
  // when the sidebar is in Focus mode, so it surfaces there straight away.
  const newSessionAt = useCallback(
    (rootPath: string, host: string | null) => {
      const kind: ProjectKind = host ? 'ssh' : 'local'
      const id = workspaceId({ kind, host: host ?? undefined, rootPath })
      const ws =
        [...workspaces, ...sessionWorkspaces].find((w) => w.id === id) ??
        ({ id, kind, name: baseName(rootPath), rootPath, host: host ?? undefined } as ProjectInfo)
      void newSession(ws, { pin: useViewPrefsStore.getState().focusMode })
    },
    [workspaces, sessionWorkspaces, newSession]
  )

  // Command-palette "Browse folder… (Local)": native folder picker, then a session.
  const browseLocalForSession = useCallback(async () => {
    const result = await window.studio.openLocalProject()
    if (!result.ok) return setError(result.error)
    if (result.data) {
      addWorkspace(result.data)
      void newSession(result.data, { pin: useViewPrefsStore.getState().focusMode })
    }
  }, [addWorkspace, newSession])

  // Open a past conversation from the history: spin up a live session in the
  // project's folder and resume that conversation into it. If the project is an
  // open workspace the chat tab is tagged with it (so the right panel follows).
  const openConversation = useCallback(
    async (project: ProjectConversations, conv: AcpConversation) => {
      try {
        const meta = await window.studio.acp.createSession(
          project.cwd,
          project.host ?? null,
          conv.title ?? undefined
        )
        await window.studio.acp.resumeConversation(meta.id, conv.sessionId)
        const ws = workspaceForSession(meta, workspaces)
        openTab({ id: chatTabId(meta.id), kind: 'chat', title: 'Claude Code', sid: meta.id, wsId: ws?.id ?? '' })
      } catch (err: any) {
        setError(err?.message || String(err))
      }
    },
    [workspaces, openTab]
  )

  const onSelect = useCallback(
    (sel: Selection, opts?: { preview?: boolean }) => {
      // Single click previews (reuses one transient tab); double click keeps.
      const previewOpts = { preview: opts?.preview !== false }
      // Tag the tab with the active session so it lives in that session's group.
      const ownerSid = useTabsStore.getState().activeSid
      if (sel.kind === 'file') {
        openTab(
          { id: fileTabId(ownerSid, sel.wsId, sel.path), kind: 'file', title: sel.name, path: sel.path, name: sel.name, wsId: sel.wsId, ownerSid },
          previewOpts
        )
      } else {
        openTab(
          {
            id: diffTabId(ownerSid, sel.wsId, sel.change),
            kind: 'diff',
            // Just the file name; the git-compare icon already marks it a diff.
            title: baseName(sel.change.path),
            change: sel.change,
            wsId: sel.wsId,
            ownerSid
          },
          previewOpts
        )
      }
    },
    [openTab]
  )

  // Ctrl/Cmd+P toggles quick-open; adding Shift toggles the command palette.
  // Capture-phase so it wins over Monaco and any focused input; guarded against
  // the Alt combo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        if (e.shiftKey) setPaletteOpen((v) => !v)
        else setQuickOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  const createSession = useCallback(async (ws: ProjectInfo, text: string) => {
    try {
      const meta = await window.studio.acp.createSession(ws.rootPath, ws.host ?? null)
      openTab({ id: chatTabId(meta.id), kind: 'chat', title: 'Claude Code', sid: meta.id, wsId: ws.id })
      useTabsStore.getState().close(newChatTabId(ws.id))
      await window.studio.acp.prompt(meta.id, [{ type: 'text', text }])
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }, [openTab])

  const openLocal = useCallback(async () => {
    setError(null)
    const result = await window.studio.openLocalProject()
    if (!result.ok) return setError(result.error)
    if (result.data) addWorkspace(result.data)
  }, [addWorkspace])

  // Permanently end a session on the engine. Its removal from the pushed session
  // list prunes the chat tab and its stale prefs via the effect above.
  const deleteSession = useCallback(async (sid: string) => {
    try {
      await window.studio.acp.kill(sid)
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }, [])

  const closeWorkspace = useCallback(
    async (wsId: string) => {
      await window.studio.closeProject(wsId)
      setWorkspaces((ws) => ws.filter((w) => w.id !== wsId))
      pruneWorkspace(wsId)
    },
    [pruneWorkspace]
  )

  // Disconnect an SSH host: tear down its engine/connection and drop everything
  // scoped to it. Its live sessions disappear from the pushed list (which prunes
  // their chat tabs); its discovered projects vanish on the next scan.
  const disconnectRemote = useCallback(async (host: string) => {
    await window.studio.sshDisconnect(host)
    setRemoteHosts((hs) => hs.filter((h) => h !== host))
    setWorkspaces((ws) => ws.filter((w) => (w.host ?? null) !== host))
    setSessionWorkspaces((ws) => ws.filter((w) => (w.host ?? null) !== host))
    refreshProjects()
  }, [refreshProjects])

  // Re-establish a disconnected host from its saved credentials (the sidebar's
  // Reconnect action). Mark it reconnecting for immediate feedback; a success
  // flips it to 'connected' via the engine-status event (and re-scans projects),
  // a failure drops it back to 'lost'.
  const reconnectRemote = useCallback(async (host: string) => {
    setHostStatus(`ssh:${host}`, 'reconnecting')
    setRemoteHosts((hs) => (hs.includes(host) ? hs : [...hs, host]))
    const res = await window.studio.reconnectSsh(host)
    if (!res.ok) {
      setHostStatus(`ssh:${host}`, 'lost')
      setError(res.error)
    }
  }, [setHostStatus])

  return (
    <div className="app">
      <TitleBar
        activeWorkspace={activeWorkspace}
        leftVisible={leftVisible}
        rightVisible={rightVisible}
        onToggleLeft={() => setLeftVisible(!leftVisible)}
        onToggleRight={() => setRightVisible(!rightVisible)}
      />
      {error && (
        <div className="error-banner">
          {error}
          <button className="error-dismiss codicon codicon-close" onClick={() => setError(null)} />
        </div>
      )}
      <div className="panels">
        {leftVisible && !maximized && (
          <>
            <aside className="panel panel-left" style={{ width: leftWidth }}>
              <SessionsPanel
                workspaces={workspaces}
                sessions={sessions}
                projects={projects}
                remoteHosts={remoteHosts}
                engineStatus={engineStatus}
                activeSid={activeSid}
                onSelectSession={openChat}
                onOpenConversation={openConversation}
                onNewSession={newSession}
                onCloseWorkspace={closeWorkspace}
                onDeleteSession={deleteSession}
                onOpenLocal={openLocal}
                onOpenSsh={() => setSshDialogOpen(true)}
                onOpenRemoteFolder={(host) => setFolderPickerHost(host)}
                onDisconnectRemote={disconnectRemote}
                onReconnectRemote={reconnectRemote}
              />
            </aside>
            <Sash
              onResizeStart={() => (dragBase.current = leftWidth)}
              onResize={(d) => setLeftWidth(clampWidth(dragBase.current + d))}
            />
          </>
        )}
        <main className="panel panel-center">
          <EditorArea
            workspaces={workspaces}
            sessionWorkspaces={sessionWorkspaces}
            onCreateSession={createSession}
            onPickFolder={openLocal}
          />
        </main>
        {rightVisible && !maximized && (
          <>
            <Sash
              onResizeStart={() => (dragBase.current = rightWidth)}
              onResize={(d) => setRightWidth(clampWidth(dragBase.current - d))}
            />
            <aside className="panel panel-right" style={{ width: rightWidth }}>
              <RightPanel project={activeWorkspace} selection={selection} onSelect={onSelect} />
            </aside>
          </>
        )}
      </div>
      <StatusBar
        activeHost={activeWorkspace?.host ?? null}
        activeWorkspace={activeWorkspace}
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        leftVisible={leftVisible}
        rightVisible={rightVisible}
        maximized={maximized}
      />
      {sshDialogOpen && (
        <SshDialog
          onConnected={(host) => {
            setSshDialogOpen(false)
            setRemoteHosts((hs) => (hs.includes(host) ? hs : [...hs, host]))
            setError(null)
          }}
          onCancel={() => setSshDialogOpen(false)}
        />
      )}
      {quickOpen && (
        <QuickOpen
          workspaces={activeWorkspace ? [activeWorkspace] : []}
          onSelect={onSelect}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          workspaces={workspaces}
          projects={projects}
          sessions={sessions}
          remoteHosts={remoteHosts}
          onCreateSession={newSessionAt}
          onBrowseLocal={browseLocalForSession}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {folderPickerHost !== null && (
        <RemoteFolderPicker
          host={folderPickerHost}
          onOpen={(info) => {
            addWorkspace(info)
            setFolderPickerHost(null)
            setError(null)
          }}
          onCancel={() => setFolderPickerHost(null)}
        />
      )}
      <Toasts />
    </div>
  )
}
