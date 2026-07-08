import { useEffect, useRef, useState } from 'react'
import type { GitFileChange, ProjectInfo } from '../../../shared/types'
import { monaco } from '../monaco'
import type { Selection } from '../selection'
import letterpress from '../assets/letterpress-light.svg'

interface Props {
  project: ProjectInfo | null
  selection: Selection | null
}

export function CenterPanel({ project, selection }: Props) {
  if (!project || !selection) {
    // Editor watermark (vscode letterpress-light.svg)
    return (
      <div className="editor-watermark">
        <img src={letterpress} alt="" draggable={false} />
      </div>
    )
  }

  const key =
    selection.kind === 'file'
      ? `file:${selection.path}`
      : `diff:${selection.change.path}:${selection.change.index}${selection.change.worktree}`

  return (
    <div className="center-panel">
      <div className="tab-strip">
        <div className="tab active">
          <span className="codicon codicon-file tab-icon" />
          <span className="tab-name">
            {selection.kind === 'file' ? selection.name : baseName(selection.change.path)}
          </span>
          {selection.kind === 'diff' && <span className="tab-detail">(Working Tree)</span>}
        </div>
      </div>
      {selection.kind === 'file' ? (
        <FileView key={key} path={selection.path} />
      ) : (
        <DiffView key={key} project={project} change={selection.change} />
      )}
    </div>
  )
}

function FileView({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.studio.readFile(path).then((result) => {
      if (cancelled) return
      if (result.ok) setContent(result.data)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  if (error) return <ViewerMessage message={error} />
  if (content === null) return <ViewerMessage message="Loading…" />
  return <MonacoViewer content={content} path={path} />
}

function DiffView({ project, change }: { project: ProjectInfo; change: GitFileChange }) {
  const [contents, setContents] = useState<{ original: string; modified: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const headPath = change.origPath ?? change.path
      const original = await window.studio.gitShowHead(headPath)
      if (!original.ok) throw new Error(original.error)

      const deleted = change.worktree === 'D' || (change.index === 'D' && change.worktree === '.')
      let modified = ''
      if (!deleted) {
        const result = await window.studio.readFile(joinPath(project.rootPath, change.path))
        if (!result.ok) throw new Error(result.error)
        modified = result.data
      }
      return { original: original.data ?? '', modified }
    }
    load().then(
      (data) => !cancelled && setContents(data),
      (err) => !cancelled && setError(err.message)
    )
    return () => {
      cancelled = true
    }
  }, [project, change])

  if (error) return <ViewerMessage message={error} />
  if (!contents) return <ViewerMessage message="Loading…" />
  return <MonacoDiffViewer original={contents.original} modified={contents.modified} path={change.path} />
}

function MonacoViewer({ content, path }: { content: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const model = monaco.editor.createModel(content, undefined, viewerUri('view', path))
    const editor = monaco.editor.create(ref.current!, {
      model,
      readOnly: true,
      automaticLayout: true,
      fontSize: 13,
      renderWhitespace: 'none',
      scrollBeyondLastLine: false
    })
    return () => {
      editor.dispose()
      model.dispose()
    }
  }, [content, path])

  return <div ref={ref} className="monaco-host" />
}

function MonacoDiffViewer({
  original,
  modified,
  path
}: {
  original: string
  modified: string
  path: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const originalModel = monaco.editor.createModel(original, undefined, viewerUri('orig', path))
    const modifiedModel = monaco.editor.createModel(modified, undefined, viewerUri('mod', path))
    const editor = monaco.editor.createDiffEditor(ref.current!, {
      readOnly: true,
      automaticLayout: true,
      fontSize: 13,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    return () => {
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [original, modified, path])

  return <div ref={ref} className="monaco-host" />
}

function ViewerMessage({ message }: { message: string }) {
  return <div className="viewer-message">{message}</div>
}

/**
 * Per-view URI scheme avoids model collisions while keeping the file
 * extension so Monaco detects the language.
 */
function viewerUri(scheme: string, path: string) {
  return monaco.Uri.from({ scheme, path: path.startsWith('/') ? path : `/${path}` })
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel}`
}
