import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../../shared/types'
import { useAcpStore } from './acp/store'
import { useSessionsStore } from './acp/sessions-store'
import { AcpThread } from './components/AcpThread'
import { CenterPanel } from './components/CenterPanel'
import { ChatCard } from './components/ChatCard'
import { RemoteFolderPicker } from './components/RemoteFolderPicker'
import { RightPanel } from './components/RightPanel'
import { Sash } from './components/Sash'
import { SessionsPanel } from './components/SessionsPanel'
import { SshDialog } from './components/SshDialog'
import { TitleBar } from './components/TitleBar'
import type { Selection } from './selection'

const MIN_PANEL_WIDTH = 170

function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_PANEL_WIDTH), Math.floor(window.innerWidth * 0.4))
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  // Remote home directory to browse after connecting; null when not browsing.
  const [sshBrowseHome, setSshBrowseHome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(340)
  const [leftVisible, setLeftVisible] = useState(true)
  const [rightVisible, setRightVisible] = useState(true)
  const [chatVisible, setChatVisible] = useState(true)
  const [activeSid, setActiveSid] = useState<string | null>(null)
  const dragBase = useRef(0)

  const sessions = useSessionsStore((s) => s.sessions)
  const setSessions = useSessionsStore((s) => s.setSessions)
  const setEngineStatus = useSessionsStore((s) => s.setEngineStatus)

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

  // If the active session disappears (killed), fall back to the new-session card.
  useEffect(() => {
    if (activeSid && !sessions.some((s) => s.id === activeSid)) setActiveSid(null)
  }, [sessions, activeSid])

  const createSession = useCallback(async (text: string) => {
    if (!project) return
    try {
      const meta = await window.studio.acp.createSession(project.rootPath)
      setActiveSid(meta.id)
      await window.studio.acp.prompt(meta.id, [{ type: 'text', text }])
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }, [project])

  const openLocal = useCallback(async () => {
    setError(null)
    const result = await window.studio.openLocalProject()
    if (!result.ok) return setError(result.error)
    if (result.data) {
      setProject(result.data)
      setSelection(null)
    }
  }, [])

  const closeProject = useCallback(async () => {
    await window.studio.closeProject()
    setProject(null)
    setSelection(null)
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
        {leftVisible && (
          <>
            <aside className="panel panel-left" style={{ width: leftWidth }}>
              <SessionsPanel
                project={project}
                sessions={sessions}
                activeSid={activeSid}
                onSelect={setActiveSid}
                onNew={() => setActiveSid(null)}
              />
            </aside>
            <Sash
              onResizeStart={() => (dragBase.current = leftWidth)}
              onResize={(d) => setLeftWidth(clampWidth(dragBase.current + d))}
            />
          </>
        )}
        {chatVisible && (
          <div className="panel panel-chat">
            {activeSid ? (
              <AcpThread sid={activeSid} />
            ) : (
              <ChatCard
                project={project}
                onClose={() => setChatVisible(false)}
                onPickFolder={openLocal}
                onCreate={createSession}
              />
            )}
          </div>
        )}
        <main className="panel panel-center">
          <CenterPanel project={project} selection={selection} />
        </main>
        {rightVisible && (
          <>
            <Sash
              onResizeStart={() => (dragBase.current = rightWidth)}
              onResize={(d) => setRightWidth(clampWidth(dragBase.current - d))}
            />
            <aside className="panel panel-right" style={{ width: rightWidth }}>
              <RightPanel project={project} selection={selection} onSelect={setSelection} />
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
            setSelection(null)
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
