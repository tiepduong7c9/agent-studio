import { useEffect, useRef, useState } from 'react'
import type { GitFileChange, ProjectInfo } from '../../../shared/types'
import { monaco } from '../monaco'

// File and diff viewers backed by Monaco. The tabbed editor area mounts one
// per open file/diff tab.

export function FileView({ path }: { path: string }) {
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

export function DiffView({ project, change }: { project: ProjectInfo; change: GitFileChange }) {
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
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [changeCount, setChangeCount] = useState(0)

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
    editorRef.current = editor
    // getLineChanges is only populated once the diff has been computed.
    const sub = editor.onDidUpdateDiff(() => setChangeCount(editor.getLineChanges()?.length ?? 0))
    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [original, modified, path])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  return (
    <div className="diff-editor">
      <div className="diff-toolbar">
        <span className="diff-toolbar-count">
          {changeCount === 0 ? 'No changes' : `${changeCount} change${changeCount === 1 ? '' : 's'}`}
        </span>
        <span className="topbar-spacer" />
        <button
          className="icon-button codicon codicon-arrow-up"
          title="Previous Change"
          disabled={changeCount === 0}
          onClick={() => editorRef.current?.goToDiff('previous')}
        />
        <button
          className="icon-button codicon codicon-arrow-down"
          title="Next Change"
          disabled={changeCount === 0}
          onClick={() => editorRef.current?.goToDiff('next')}
        />
        <span className="diff-toolbar-sep" />
        <button
          className={`icon-button codicon codicon-editor-layout ${sideBySide ? 'active' : ''}`}
          title={sideBySide ? 'Switch to Inline View' : 'Switch to Side by Side View'}
          onClick={() => setSideBySide((v) => !v)}
        />
      </div>
      <div ref={ref} className="monaco-host" />
    </div>
  )
}

export function ViewerMessage({ message }: { message: string }) {
  return <div className="viewer-message">{message}</div>
}

/**
 * Per-view URI scheme avoids model collisions while keeping the file
 * extension so Monaco detects the language.
 */
function viewerUri(scheme: string, path: string) {
  return monaco.Uri.from({ scheme, path: path.startsWith('/') ? path : `/${path}` })
}

export function baseName(p: string): string {
  return p.split('/').pop() || p
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel}`
}
