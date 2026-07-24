import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GitFileChange, ProjectInfo } from '../../../shared/types'
import { imageMimeType } from '../../../shared/imageTypes'
import { videoMimeType } from '../../../shared/videoTypes'
import { monaco } from '../monaco'
import { useMarkdownViewStore } from '../markdown-view-store'
import { isSideBySide, useDiffViewStore } from '../diff-view-store'
import { useEditorBufferStore } from '../editor-buffer-store'
import { fileIconStyle } from './FileIcon'

// File and diff viewers backed by Monaco. The tabbed editor area mounts one
// per open file/diff tab. Text/markdown files open in an editable Monaco whose
// working content lives in the editor-buffer store (so edits survive tab
// switches); diffs stay read-only.

/** Routes video/image/markdown files to their inline viewers; everything else to Monaco. */
export function FileView({
  wsId,
  path,
  tabId,
  untitled
}: {
  wsId: string
  path: string
  tabId: string
  untitled?: boolean
}) {
  // Untitled scratch buffers have no file on disk: skip the read and open an
  // empty editable editor straight away.
  if (untitled) return <MonacoEditor tabId={tabId} path={path} untitled fallback="" />
  if (videoMimeType(path)) return <VideoView wsId={wsId} path={path} />
  const mimeType = imageMimeType(path)
  if (mimeType) return <ImageView wsId={wsId} path={path} mimeType={mimeType} />
  if (isMarkdown(path)) return <MarkdownFileView wsId={wsId} path={path} tabId={tabId} />
  return <TextFileView wsId={wsId} path={path} tabId={tabId} />
}

/** Whether a path is a markdown document (drives the preview toggle in the tab strip). */
export function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'md' || ext === 'markdown' || ext === 'mdx' || ext === 'mkd'
}

/** Loads a text file's contents over IPC, cancelling on path change/unmount. */
function useFileContent(wsId: string, path: string) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    window.studio.readFile(wsId, path).then((result) => {
      if (cancelled) return
      if (result.ok) setContent(result.data)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [wsId, path])

  return { content, error }
}

/** Streams a video via the studio-media:// protocol (see main/media-protocol.ts). */
function VideoView({ wsId, path }: { wsId: string; path: string }) {
  const src = `studio-media://stream/?ws=${encodeURIComponent(wsId)}&p=${encodeURIComponent(path)}`
  return (
    <div className="video-viewer">
      <video src={src} controls preload="metadata" />
    </div>
  )
}

function TextFileView({ wsId, path, tabId }: { wsId: string; path: string; tabId: string }) {
  const { content, error } = useFileContent(wsId, path)
  if (error) return <ViewerMessage message={error} />
  if (content === null) return <ViewerMessage message="Loading…" />
  return <MonacoEditor tabId={tabId} path={path} untitled={false} fallback={content} />
}

// Fenced code block in the preview, wrapped with a hover copy button.
function MarkdownCodeBlock({ children }: React.ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    const text = ref.current?.textContent ?? ''
    if (!text) return
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return (
    <div className="markdown-code">
      <button
        type="button"
        className={`markdown-copy codicon ${copied ? 'codicon-check' : 'codicon-copy'}`}
        title="Copy"
        onClick={onCopy}
      />
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

/**
 * Resolves a markdown `<img>` src for display. Remote/data/blob URLs pass
 * through untouched; a repo-local path (absolute or relative to the markdown
 * file) is streamed via the studio-media:// protocol, since the renderer's
 * origin can't read project files directly.
 */
function resolveMarkdownImageSrc(
  src: string | undefined,
  wsId: string,
  fileDir: string
): string | undefined {
  if (!src) return src
  // Anything with an explicit scheme (http:, https:, data:, blob:…) or a
  // protocol-relative URL is left as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return src
  const abs = normalizePath(src.startsWith('/') ? src : joinPath(fileDir, src))
  return `studio-media://stream/?ws=${encodeURIComponent(wsId)}&p=${encodeURIComponent(abs)}`
}

/** Builds the markdown preview's element overrides, bound to the file's location. */
function markdownComponents(wsId: string, fileDir: string) {
  return {
    // Prevent link clicks from navigating the renderer away from the app.
    a: ({ children, href, ...props }: React.ComponentPropsWithoutRef<'a'>) => (
      <a {...props} href={href} title={href} onClick={(e) => e.preventDefault()}>
        {children}
      </a>
    ),
    // Resolve repo-local image paths so they load through the media protocol.
    img: ({ src, alt, ...props }: React.ComponentPropsWithoutRef<'img'>) => (
      <img {...props} src={resolveMarkdownImageSrc(src, wsId, fileDir)} alt={alt ?? ''} />
    ),
    pre: MarkdownCodeBlock
  }
}

/**
 * Markdown files open in a rendered preview by default. The preview/source
 * toggle lives in the tab strip (see EditorArea) so it costs no editor space;
 * this reads the resulting mode from the shared store, keyed by tab id.
 */
function MarkdownFileView({ wsId, path, tabId }: { wsId: string; path: string; tabId: string }) {
  const { content, error } = useFileContent(wsId, path)
  const sourceMode = useMarkdownViewStore((s) => !!s.sourceMode[tabId])
  // Once the file has been edited in source mode the preview should reflect the
  // unsaved working copy, not the stale on-disk content.
  const edited = useEditorBufferStore((s) => s.buffers[tabId]?.content)

  const components = useMemo(() => markdownComponents(wsId, dirName(path)), [wsId, path])

  if (error) return <ViewerMessage message={error} />
  if (content === null) return <ViewerMessage message="Loading…" />
  if (sourceMode) return <MonacoEditor tabId={tabId} path={path} untitled={false} fallback={content} />

  return (
    <div className="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {edited ?? content}
      </ReactMarkdown>
    </div>
  )
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 32
const ZOOM_STEP = 1.2

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

function ImageView({ wsId, path, mimeType }: { wsId: string; path: string; mimeType: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Intrinsic pixel size, known once the image loads; null until then.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  // In fit mode the zoom tracks the container (recomputed on resize); any manual
  // zoom pins it to an explicit factor until the user clicks "Fit" again.
  const [fit, setFit] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setError(null)
    setNatural(null)
    window.studio.readFileBase64(wsId, path).then((result) => {
      if (cancelled) return
      if (result.ok) setSrc(`data:${mimeType};base64,${result.data}`)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [wsId, path, mimeType])

  // The zoom that makes the image fit the viewport (never upscaling past 100%).
  const fitZoom = useCallback((): number => {
    const el = viewportRef.current
    if (!el || !natural) return 1
    const availW = el.clientWidth - 32 // matches the viewport's 16px padding
    const availH = el.clientHeight - 32
    if (availW <= 0 || availH <= 0) return 1
    return Math.min(1, availW / natural.w, availH / natural.h)
  }, [natural])

  // While fitting, follow the container size.
  useLayoutEffect(() => {
    if (!fit || !natural) return
    const el = viewportRef.current
    if (!el) return
    const apply = () => setZoom(fitZoom())
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit, natural, fitZoom])

  const zoomTo = useCallback((z: number) => {
    setFit(false)
    setZoom(clampZoom(z))
  }, [])

  // Ctrl/Cmd + wheel zooms toward the cursor. Attached natively so we can
  // preventDefault (React's wheel listener is passive and can't).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setFit(false)
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (error) return <ViewerMessage message={error} />

  const imgStyle = natural
    ? {
        width: `${Math.round(natural.w * zoom)}px`,
        height: `${Math.round(natural.h * zoom)}px`,
        maxWidth: 'none',
        maxHeight: 'none'
      }
    : undefined

  return (
    <div className="image-editor">
      <div className="image-toolbar">
        <span className="image-toolbar-info">
          {natural ? `${natural.w} × ${natural.h}` : ''}
        </span>
        <span className="topbar-spacer" />
        <button
          className="icon-button codicon codicon-zoom-out"
          title="Zoom Out"
          disabled={!natural || zoom <= MIN_ZOOM}
          onClick={() => zoomTo(zoom / ZOOM_STEP)}
        />
        <span className="image-toolbar-zoom">{Math.round(zoom * 100)}%</span>
        <button
          className="icon-button codicon codicon-zoom-in"
          title="Zoom In"
          disabled={!natural || zoom >= MAX_ZOOM}
          onClick={() => zoomTo(zoom * ZOOM_STEP)}
        />
        <span className="diff-toolbar-sep" />
        <button
          className="image-toolbar-btn"
          title="Actual Size (100%)"
          disabled={!natural}
          onClick={() => zoomTo(1)}
        >
          1:1
        </button>
        <button
          className={`image-toolbar-btn ${fit ? 'active' : ''}`}
          title="Fit to Window"
          disabled={!natural}
          onClick={() => setFit(true)}
        >
          Fit
        </button>
      </div>
      <div className="image-viewer" ref={viewportRef}>
        {src && (
          <img
            src={src}
            alt={baseName(path)}
            style={imgStyle}
            onLoad={(e) =>
              setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
        )}
      </div>
    </div>
  )
}

export function DiffView({
  project,
  change,
  tabId
}: {
  project: ProjectInfo
  change: GitFileChange
  tabId: string
}) {
  const [contents, setContents] = useState<{ original: string; modified: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const headPath = change.origPath ?? change.path
      const original = await window.studio.gitShowHead(project.id, headPath)
      if (!original.ok) throw new Error(original.error)

      const deleted = change.worktree === 'D' || (change.index === 'D' && change.worktree === '.')
      let modified = ''
      if (!deleted) {
        const result = await window.studio.readFile(project.id, joinPath(project.rootPath, change.path))
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
  return (
    <MonacoDiffViewer
      original={contents.original}
      modified={contents.modified}
      path={change.path}
      tabId={tabId}
    />
  )
}

/**
 * Editable Monaco editor bound to the editor-buffer store. The model is seeded
 * from any existing buffer (preserving unsaved edits across tab switches),
 * falling back to `fallback` (the on-disk content) on first open; every change
 * is written back to the store. Saving to disk is handled at the app level
 * (Ctrl/Cmd+S), which reads the buffer this keeps current.
 */
function MonacoEditor({
  tabId,
  path,
  untitled,
  fallback
}: {
  tabId: string
  path: string
  untitled: boolean
  fallback: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const store = useEditorBufferStore.getState()
    const existing = store.buffers[tabId]
    const initial = existing ? existing.content : fallback
    store.ensure(tabId, initial, untitled)
    // Untitled buffers get a per-tab uri (no extension → plaintext); saved files
    // key off their path so Monaco infers the language from the extension.
    const uri = untitled
      ? monaco.Uri.from({ scheme: 'untitled', path: `/${tabId}` })
      : viewerUri('view', path)
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(initial, undefined, uri)
    if (model.getValue() !== initial) model.setValue(initial)
    const editor = monaco.editor.create(ref.current!, {
      model,
      readOnly: false,
      automaticLayout: true,
      fontSize: 13,
      renderWhitespace: 'none',
      scrollBeyondLastLine: false
    })
    const sub = model.onDidChangeContent(() =>
      useEditorBufferStore.getState().setContent(tabId, model.getValue())
    )
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
    }
  }, [tabId, path, untitled, fallback])

  return <div ref={ref} className="monaco-host" />
}

function MonacoDiffViewer({
  original,
  modified,
  path,
  tabId
}: {
  original: string
  modified: string
  path: string
  tabId: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  // Side-by-side vs inline is owned by the tab strip (see EditorArea), which
  // hosts the diff controls; default to side-by-side when unset.
  const sideBySide = useDiffViewStore((s) => isSideBySide(s.sideBySide, tabId))
  const setController = useDiffViewStore((s) => s.setController)

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
    const goToDiff = (dir: 'previous' | 'next') => editor.goToDiff(dir)
    // getLineChanges is only populated once the diff has been computed. The
    // event can fire more than once (e.g. layout/option changes), so scroll to
    // the first hunk only on the initial computation that yields changes.
    let revealed = false
    const sub = editor.onDidUpdateDiff(() => {
      const changes = editor.getLineChanges() ?? []
      // Publish the change count to the tab strip so it can enable/disable the
      // navigation buttons (new object identity re-renders subscribers).
      setController(tabId, { changeCount: changes.length, goToDiff })
      if (!revealed && changes.length > 0) {
        revealed = true
        const first = changes[0]
        // Prefer the modified side; fall back to the original for pure deletions.
        const line = first.modifiedStartLineNumber || first.originalStartLineNumber
        const target = first.modifiedStartLineNumber
          ? editor.getModifiedEditor()
          : editor.getOriginalEditor()
        target.revealLineNearTop(line, monaco.editor.ScrollType.Immediate)
      }
    })
    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
      originalModel.dispose()
      modifiedModel.dispose()
      setController(tabId, null)
    }
  }, [original, modified, path, tabId, setController])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  return <div ref={ref} className="monaco-host" />
}

export function ViewerMessage({ message }: { message: string }) {
  return <div className="viewer-message">{message}</div>
}

/**
 * VS Code-style breadcrumb bar: the file's repo-relative path split into
 * chevron-separated folder crumbs, ending in the file (with its icon).
 * `relPath` is already relative to the workspace root.
 */
export function Breadcrumbs({ relPath }: { relPath: string }) {
  const segments = relPath.split('/').filter(Boolean)
  if (segments.length === 0) return null
  const last = segments.length - 1
  const { glyph, color } = fileIconStyle(segments[last])
  return (
    <div className="breadcrumbs" role="navigation" aria-label="Breadcrumbs">
      {segments.map((seg, i) => (
        <span key={i} className="breadcrumb-item" title={seg}>
          {i > 0 && <span className="breadcrumb-sep codicon codicon-chevron-right" />}
          {i === last ? (
            <span className="seti-icon breadcrumb-icon" style={{ color }}>
              {glyph}
            </span>
          ) : (
            <span className="codicon codicon-folder breadcrumb-icon" />
          )}
          <span className="breadcrumb-label">{seg}</span>
        </span>
      ))}
    </div>
  )
}

/** Strips the workspace root prefix, yielding a repo-relative path. */
export function relativeToRoot(root: string | undefined, path: string): string {
  if (!root) return path
  const trimmed = root.replace(/\/+$/, '')
  return path.startsWith(trimmed + '/') ? path.slice(trimmed.length + 1) : path
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

/** The directory portion of an absolute path (its parent, or "/" at the root). */
function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** Collapses `.`/`..` segments in a path (POSIX-style), preserving leading `/`. */
function normalizePath(p: string): string {
  const isAbs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!isAbs) out.push('..')
    } else {
      out.push(seg)
    }
  }
  return (isAbs ? '/' : '') + out.join('/')
}
