// Image formats the file viewer renders inline (as a data URL) instead of
// sending through the text/Monaco path. Shared by the renderer (to pick the
// viewer) and the main process (to cap what it base64-encodes).

/** Cap on inline image size; larger images are rejected with a user-facing error. */
export const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** The image MIME type for a path's extension, or null when it isn't an image. */
export function imageMimeType(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME[ext] ?? null
}
