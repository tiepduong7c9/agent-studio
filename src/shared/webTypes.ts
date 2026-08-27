// HTML-preview plumbing shared by the renderer (which mounts the preview) and
// the main process (which serves it). The MIME table matters because Chromium
// refuses to run a script or apply a stylesheet served with the wrong type, so
// the preview only works if these are right.

/**
 * Session partition for preview guests. Previewed pages run repository code and
 * can reach the network, so they get their own ephemeral session (no `persist:`
 * prefix — cleared on quit) instead of sharing cookies and storage with the app
 * and the in-app browser tab. The media protocol is registered on it explicitly
 * (see main/media-protocol.ts); a partition doesn't inherit the default
 * session's handlers.
 */
export const PREVIEW_PARTITION = 'html-preview'

const WEB_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject'
}

/** The MIME type for a web asset's extension, or null when it isn't one. */
export function webMimeType(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return WEB_MIME[ext] ?? null
}

/** Whether a path is an HTML document (drives the preview/source toggle). */
export function isHtml(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'html' || ext === 'htm' || ext === 'xhtml'
}
