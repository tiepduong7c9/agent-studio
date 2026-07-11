import { useCallback, useEffect, useRef, useState } from 'react'
import type { AcpConversation, ProjectConversations, SessionMeta } from '../../shared/acp'
import type { ProjectInfo } from '../../shared/types'
import { useAcpStore } from './acp/store'
import { useSessionsStore } from './acp/sessions-store'
import { useUsageStore } from './acp/usage-store'
import { EditorArea } from './components/EditorArea'
import { RemoteFolderPicker } from './components/RemoteFolderPicker'
import { RightPanel } from './components/RightPanel'
import { Sash } from './components/Sash'
import { SessionsPanel } from './components/SessionsPanel'
import { SshDialog } from './components/SshDialog'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { baseName } from './components/editors'
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

  const sessions = useSessionsStore((s) => s.sessions)
  const setSessions = useSessionsStore((s) => s.setSessions)
  const projects = useSessionsStore((s) => s.projects)
  const setProjects = useSessionsStore((s) => s.setProjects)
  const engineStatus = useSessionsStore((s) => s.engineStatus)
  const setHostStatus = useSessionsStore((s) => s.setHostStatus)

  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const maximized = useTabsStore((s) => s.maximized)
  const openTab = useTabsStore((s) => s.open)
  const pruneChats = useTabsStore((s) => s.pruneChats)
  const pruneWorkspace = useTabsStore((s) => s.pruneWorkspace)

  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeSid = active?.kind === 'chat' ? active.sid : null
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
  // resurface without re-entering credentials.
  useEffect(() => {
    window.studio
      .reconnectSavedHosts()
      .then((res) => {
        if (res.ok && res.data.length) {
          setRemoteHosts((hs) => Array.from(new Set([...hs, ...res.data])))
        }
      })
      .catch(() => {})
  }, [])

  // Poll each connected host's subscription usage for the status bar: once now,
  // then every 15 minutes (the rate-limit windows move slowly). Local (null) is
  // always polled; SSH hosts are added as they connect.
  useEffect(() => {
    const refresh = useUsageStore.getState().refresh
    const targets: (string | null)[] = [null, ...remoteHosts]
    const tick = () => targets.forEach((h) => refresh(h))
    tick()
    const id = window.setInterval(tick, 15 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [remoteHosts])

  // Route engine push events into the stores, and seed the session list.
  useEffect(() => {
    const offEvent = window.studio.acp.onEvent(({ sid, event }) => {
      // The wire type is intentionally loose; the store uses the rich union.
      useAcpStore.getState().appendEvent(sid, event as never)
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
    return () => { offEvent(); offSessions(); offResync(); offStatus() }
  }, [setSessions, setHostStatus, refreshProjects])

  // Re-scan when the set of open workspaces or connected hosts changes
  // (connecting a host wires it, so its projects should now appear).
  useEffect(() => {
    refreshProjects()
  }, [workspaces, remoteHosts, refreshProjects])

  // Close chat tabs whose session was killed on the engine, and drop any
  // pin/hide prefs left behind by sessions that no longer exist. Deferred until
  // the engine has reported (so a pre-load empty list can't wipe persisted
  // prefs), and skipped while any host is reconnecting (its sessions aren't in
  // the list yet — pruning then would drop live pins for that host).
  useEffect(() => {
    if (!sessionsLoaded.current) return
    if (remoteHosts.some((h) => engineStatus[`ssh:${h}`] === 'reconnecting')) return
    const live = new Set(sessions.map((s) => s.id))
    pruneChats(live)
    useViewPrefsStore.getState().pruneSessions(live)
  }, [sessions, pruneChats, remoteHosts, engineStatus])

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

  return (
    <div className="app">
      <TitleBar
        activeWorkspace={activeWorkspace}
        leftVisible={leftVisible}
        rightVisible={rightVisible}
        onToggleLeft={() => setLeftVisible(!leftVisible)}
        onToggleRight={() => setRightVisible(!rightVisible)}
        onOpenLocal={openLocal}
        onOpenSsh={() => setSshDialogOpen(true)}
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
      <StatusBar activeHost={activeWorkspace?.host ?? null} />
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
    </div>
  )
}
