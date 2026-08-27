// URL builders for the studio-media:// scheme (see main/media-protocol.ts).
// Shared so the renderer and the protocol handler agree on both shapes:
//
//   stream:  studio-media://stream/?ws=<workspace id>&p=<absolute host path>
//   site:    studio-media://<workspace host>/<path relative to the project root>
//
// The stream form addresses one file at a time (images, video, PDF). The site
// form serves a project like a web server would: the workspace lives in the
// host, so a document's own relative links ("./app.js") and root-relative ones
// ("/assets/app.js") resolve to the right project files. That's what makes the
// HTML preview behave like a browser.

const STREAM_HOST = 'stream'

/** FNV-1a over the workspace id — a short, stable, hostname-safe handle. */
function fnv1a(input: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The URL host standing in for a workspace id. Workspace ids
 * (`kind:host:/root/path`) can't be hosts themselves, and a hash keeps the
 * label short enough to stay a valid hostname. The "ws" prefix keeps it from
 * ever being all-digits, which URL parsers read as an IPv4 address.
 */
export function wsHostId(wsId: string): string {
  return `ws${fnv1a(wsId, 0x811c9dc5)}${fnv1a(wsId, 0x01000193)}`
}

/** A single-file streaming URL (ranged; used by image/video/PDF viewers). */
export function mediaStreamUrl(wsId: string, absPath: string): string {
  return `studio-media://${STREAM_HOST}/?ws=${encodeURIComponent(wsId)}&p=${encodeURIComponent(absPath)}`
}

/** A site URL for a project-root-relative path (used by the HTML preview). */
export function mediaSiteUrl(wsId: string, relPath: string): string {
  const segments = relPath.split('/').filter(Boolean).map(encodeURIComponent)
  return `studio-media://${wsHostId(wsId)}/${segments.join('/')}`
}

/** Whether a request URL's host addresses a workspace (site form) or a stream. */
export function isStreamHost(host: string): boolean {
  return host === STREAM_HOST
}
