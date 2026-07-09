import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../../shared/types'
import { useAcpStore } from './acp/store'
import { useSessionsStore } from './acp/sessions-store'
import { EditorArea } from './components/EditorArea'
import { RemoteFolderPicker } from './components/RemoteFolderPicker'
import { RightPanel } from './components/RightPanel'
import { Sash } from './components/Sash'
import { SessionsPanel } from './components/SessionsPanel'
import { SshDialog } from './components/SshDialog'
import { TitleBar } from './components/TitleBar'
import { baseName } from './components/editors'
import type { Selection } from './selection'
import {
  NEW_CHAT_ID,
  chatTabId,
  diffTabId,
  fileTabId,
  useTabsStore
} from './tabs-store'

const MIN_PANEL_WIDTH = 170

function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_PANEL_WIDTH), Math.floor(window.innerWidth * 0.4))
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  // Remote home directory to browse after connecting; null when not browsing.
  const [sshBrowseHome, setSshBrowseHome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(340)
  const [leftVisible, setLeftVisible] = useState(true)
  const [rightVisible, setRightVisible] = useState(true)
  const dragBase = useRef(0)

  const sessions = useSessionsStore((s) => s.sessions)
  const setSessions = useSessionsStore((s) => s.setSessions)
  const setEngineStatus = useSessionsStore((s) => s.setEngineStatus)

  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const maximized = useTabsStore((s) => s.maximized)
  const openTab = useTabsStore((s) => s.open)
  const pruneChats = useTabsStore((s) => s.pruneChats)

  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeSid = active?.kind === 'chat' ? active.sid : null
  const selection: Selection | null =
    active?.kind === 'file'
      ? { kind: 'file', path: active.path, name: active.name }
      : active?.kind === 'diff'
        ? { kind: 'diff', change: active.change }
        : null

  useEffect(() => {
    const initial = window.studio.initialProjectPath
    if (!initial) return
    window.studio.openLocalPath(initial).then((result) => {
      if (result.ok) setProject(result.data)
      else setError(result.error)
    })
  }, [])

  // Route engine push events into the stores, and seed the session list.
  useEffect(() => {
    const offEvent = window.studio.acp.onEvent(({ sid, event }) => {
      // The wire type is intentionally loose; the store uses the rich union.
      useAcpStore.getState().appendEvent(sid, event as never)
    })
    const offSessions = window.studio.acp.onSessions((list) => setSessions(list))
    // A reconnect pushes a fresh snapshot per attached session; re-seat the thread.
    const offResync = window.studio.acp.onResync(({ sid, snapshot }) => {
      useAcpStore.getState().setHistory(sid, snapshot)
    })
    const offStatus = window.studio.acp.onEngineStatus(({ connected, permanent }) =>
      setEngineStatus(connected ? 'connected' : permanent ? 'lost' : 'reconnecting')
    )
    window.studio.acp.listSessions().then(setSessions).catch(() => {})
    return () => { offEvent(); offSessions(); offResync(); offStatus() }
  }, [setSessions, setEngineStatus])

  // Close chat tabs whose session was killed on the engine.
  useEffect(() => {
    pruneChats(new Set(sessions.map((s) => s.id)))
  }, [sessions, pruneChats])

  const openChat = useCallback(
    (sid: string) => {
      const meta = sessions.find((s) => s.id === sid)
      openTab({ id: chatTabId(sid), kind: 'chat', title: meta?.name ?? 'Session', sid })
    },
    [sessions, openTab]
  )

  const newChat = useCallback(() => {
    openTab({ id: NEW_CHAT_ID, kind: 'new-chat', title: 'New Session' })
  }, [openTab])

  const onSelect = useCallback(
    (sel: Selection) => {
      if (sel.kind === 'file') {
        openTab({ id: fileTabId(sel.path), kind: 'file', title: sel.name, path: sel.path, name: sel.name })
      } else {
        openTab({
          id: diffTabId(sel.change),
          kind: 'diff',
          title: baseName(sel.change.path),
          detail: '(Working Tree)',
          change: sel.change
        })
      }
    },
    [openTab]
  )

  const createSession = useCallback(async (text: string) => {
    if (!project) return
    try {
      const meta = await window.studio.acp.createSession(project.rootPath)
      openTab({ id: chatTabId(meta.id), kind: 'chat', title: meta.name, sid: meta.id })
      useTabsStore.getState().close(NEW_CHAT_ID)
      await window.studio.acp.prompt(meta.id, [{ type: 'text', text }])
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }, [project, openTab])

  const openLocal = useCallback(async () => {
    setError(null)
    const result = await window.studio.openLocalProject()
    if (!result.ok) return setError(result.error)
    if (result.data) setProject(result.data)
  }, [])

  const closeProject = useCallback(async () => {
    await window.studio.closeProject()
    setProject(null)
    setError(null)
  }, [])

  return (
    <div className="app">
      <TitleBar
        project={project}
        leftVisible={leftVisible}
        rightVisible={rightVisible}
        onToggleLeft={() => setLeftVisible(!leftVisible)}
        onToggleRight={() => setRightVisible(!rightVisible)}
        onOpenLocal={openLocal}
        onOpenSsh={() => setSshDialogOpen(true)}
        onClose={closeProject}
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
                project={project}
                sessions={sessions}
                activeSid={activeSid}
                onSelect={openChat}
                onNew={newChat}
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
            project={project}
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
              <RightPanel project={project} selection={selection} onSelect={onSelect} />
            </aside>
          </>
        )}
      </div>
      {sshDialogOpen && (
        <SshDialog
          onConnected={(home) => {
            setSshDialogOpen(false)
            setSshBrowseHome(home)
            setError(null)
          }}
          onCancel={() => setSshDialogOpen(false)}
        />
      )}
      {sshBrowseHome !== null && (
        <RemoteFolderPicker
          initialPath={sshBrowseHome}
          onOpen={(info) => {
            setProject(info)
            setSshBrowseHome(null)
            setError(null)
          }}
          onCancel={() => {
            window.studio.sshCancel()
            setSshBrowseHome(null)
          }}
        />
      )}
    </div>
  )
}
