import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../../shared/types'
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
  const dragBase = useRef(0)

  useEffect(() => {
    const initial = window.studio.initialProjectPath
    if (!initial) return
    window.studio.openLocalPath(initial).then((result) => {
      if (result.ok) setProject(result.data)
      else setError(result.error)
    })
  }, [])

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
              <SessionsPanel project={project} />
            </aside>
            <Sash
              onResizeStart={() => (dragBase.current = leftWidth)}
              onResize={(d) => setLeftWidth(clampWidth(dragBase.current + d))}
            />
          </>
        )}
        {chatVisible && (
          <div className="panel panel-chat">
            <ChatCard
              project={project}
              onClose={() => setChatVisible(false)}
              onPickFolder={openLocal}
            />
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
