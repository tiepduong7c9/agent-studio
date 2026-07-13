// Video formats the file viewer plays inline via the studio-media:// streaming
// protocol (range requests, so seeking works without loading the whole file).
// Shared by the renderer (to pick the viewer) and the main process (to set the
// response Content-Type). Limited to containers/codecs Chromium can actually
// play — mkv and most exotic codecs are intentionally omitted.

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime'
}

/** The video MIME type for a path's extension, or null when it isn't a video. */
export function videoMimeType(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_MIME[ext] ?? null
}
