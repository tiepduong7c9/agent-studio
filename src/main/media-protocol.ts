import { protocol, session } from 'electron'
import { Readable } from 'stream'
import { videoMimeType } from '../shared/videoTypes'
import { imageMimeType } from '../shared/imageTypes'
import { pdfMimeType } from '../shared/pdfTypes'
import { PREVIEW_PARTITION, webMimeType } from '../shared/webTypes'
import { isStreamHost } from '../shared/mediaUrl'
import { getProvider, getProviderByWsHost } from './ipc'
import type { ProjectProvider } from './providers/types'

// A custom scheme that streams project files to the renderer with HTTP Range
// support, so <video> can seek and play large files without loading them whole
// (unlike the base64 data-URL path used for images). URLs look like:
//   studio-media://stream/?ws=<workspace id>&p=<absolute path on host>
//
// The scheme also serves a project the way a web server would, for the HTML
// preview:
//   studio-media://<workspace host>/<path relative to the project root>
// Here the workspace is the URL host, so a previewed page's own relative and
// root-relative links resolve to project files (see shared/mediaUrl.ts).
//
// Either way the path is confined to the project root, same as every other file
// read — the renderer is only semi-trusted.

export const MEDIA_SCHEME = 'studio-media'

/**
 * Must run before app `ready` (registers the scheme's privileges). `stream`
 * enables ranged/streamed responses; `standard`+`secure` give it a normal,
 * secure origin so the renderer's CSP can allowlist `studio-media:`.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/** Registers the request handler. Call once, after app `ready`. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
  // Preview guests live in their own session, which starts with no protocol
  // handlers of its own — register there too, or every preview 404s.
  const preview = session.fromPartition(PREVIEW_PARTITION)
  preview.protocol.handle(MEDIA_SCHEME, handleMediaRequest)
  // A previewed page is repository code: let it render and fetch, but never
  // prompt for the camera, microphone, location or notifications.
  preview.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}

async function handleMediaRequest(request: Request): Promise<Response> {
  try {
    return await serve(request)
  } catch (err: any) {
    // A rejected handler surfaces as an opaque network error in the guest;
    // a 500 at least says which file failed.
    return new Response(err?.message || 'Media request failed', { status: 500 })
  }
}

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const resolved = isStreamHost(url.hostname) ? resolveStream(url) : await resolveSite(url)
  if ('error' in resolved) return new Response(resolved.error, { status: resolved.status })
  const { provider, filePath } = resolved

  let size: number
  try {
    size = await provider.mediaFileSize(filePath)
  } catch (err: any) {
    return new Response(err?.message || 'Not found', { status: 404 })
  }

  const contentType =
    videoMimeType(filePath) ??
    imageMimeType(filePath) ??
    pdfMimeType(filePath) ??
    webMimeType(filePath) ??
    'application/octet-stream'

  // An empty file has no byte range to read: createMediaStream would be asked
  // for bytes 0..-1 and throw. Empty .js/.css files are ordinary, so answer
  // them directly.
  if (size === 0) {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': '0', 'Cache-Control': 'no-store' }
    })
  }

  const range = parseRange(request.headers.get('Range'), size)

  // No/invalid Range → whole file (200); a satisfiable Range → 206 partial.
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1

  const body = webStream(provider.createMediaStream(filePath, { start, end }))
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    }
  })
}

type Resolved =
  | { provider: ProjectProvider; filePath: string }
  | { error: string; status: number }

/** `studio-media://stream/?ws=&p=` — an explicit workspace id and host path. */
function resolveStream(url: URL): Resolved {
  const wsId = url.searchParams.get('ws')
  const filePath = url.searchParams.get('p')
  if (!wsId || !filePath) return { error: 'Missing ws/p', status: 400 }
  const provider = getProvider(wsId)
  if (!provider) return { error: 'Project is not open', status: 404 }
  return { provider, filePath }
}

/**
 * `studio-media://<workspace host>/<relative path>` — served from the project
 * root, so a directory (or the bare root) falls back to its index.html the way
 * a web server would. Paths that climb out of the root are refused here rather
 * than left to the provider, since a previewed page picks its own URLs.
 */
async function resolveSite(url: URL): Promise<Resolved> {
  const provider = getProviderByWsHost(url.hostname)
  if (!provider) return { error: 'Project is not open', status: 404 }
  // Windows roots arrive with backslashes; both providers accept forward
  // slashes, so normalizing lets one set of string ops serve either platform.
  const root = provider.info.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    // A stray `%` in a filename makes this throw rather than mean anything.
    return { error: 'Malformed path', status: 400 }
  }
  const filePath = joinUnderRoot(root, rel)
  if (filePath === null) return { error: 'Outside the project root', status: 403 }
  return { provider, filePath: await withIndexFallback(provider, filePath, rel) }
}

/**
 * Joins a request path onto the project root, collapsing `.`/`..`. Returns null
 * when the path climbs past the root. Splitting the root keeps its leading
 * empty segment (posix) or drive letter (Windows) intact, so the result carries
 * the same shape back.
 */
function joinUnderRoot(root: string, rel: string): string | null {
  const base = root.split('/')
  const segments = [...base]
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segments.length <= base.length) return null
      segments.pop()
    } else {
      segments.push(seg)
    }
  }
  return segments.join('/')
}

/**
 * Directory requests serve the directory's index.html, like a web server. A
 * trailing slash (or the bare root) says so outright; otherwise only an
 * extension-less path can be a directory, and confirming that costs a listing —
 * so ordinary asset requests never pay for the check.
 */
async function withIndexFallback(
  provider: ProjectProvider,
  filePath: string,
  rel: string
): Promise<string> {
  const name = filePath.split('/').pop() ?? ''
  if (rel === '' || rel.endsWith('/')) return `${filePath}/index.html`
  if (name.includes('.')) return filePath
  try {
    await provider.readDir(filePath)
  } catch {
    return filePath // not a directory (or unreadable) — let the file read decide
  }
  return `${filePath}/index.html`
}

/**
 * Parses a single-range `bytes=start-end` header against a known size.
 * Returns null when absent, 'invalid' when unsatisfiable, else the clamped range.
 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: last N bytes.
    const suffix = parseInt(m[2], 10)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1)
  }
  if (Number.isNaN(start) || start > end || start >= size) return 'invalid'
  return { start, end }
}

function webStream(node: Readable): ReadableStream {
  // Node stream → Web stream for the fetch Response body. Errors on the source
  // (e.g. a dropped SFTP connection) propagate as a stream error.
  return Readable.toWeb(node) as ReadableStream
}
