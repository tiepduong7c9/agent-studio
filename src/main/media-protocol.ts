import { protocol } from 'electron'
import { Readable } from 'stream'
import { videoMimeType } from '../shared/videoTypes'
import { getProvider } from './ipc'

// A custom scheme that streams project files to the renderer with HTTP Range
// support, so <video> can seek and play large files without loading them whole
// (unlike the base64 data-URL path used for images). URLs look like:
//   studio-media://stream/?ws=<workspace id>&p=<absolute path on host>
// The path is confined to the project root by the provider, same as every other
// file read — the renderer is only semi-trusted.

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
}

async function handleMediaRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const wsId = url.searchParams.get('ws')
  const filePath = url.searchParams.get('p')
  if (!wsId || !filePath) return new Response('Missing ws/p', { status: 400 })

  const provider = getProvider(wsId)
  if (!provider) return new Response('Project is not open', { status: 404 })

  let size: number
  try {
    size = await provider.mediaFileSize(filePath)
  } catch (err: any) {
    return new Response(err?.message || 'Not found', { status: 404 })
  }

  const contentType = videoMimeType(filePath) ?? 'application/octet-stream'
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
