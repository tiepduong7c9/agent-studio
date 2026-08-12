// PDF detection, shared by the renderer (to pick the viewer) and the main
// process (to set the studio-media:// response Content-Type). PDFs render in
// Chromium's built-in viewer via an <iframe> pointed at the streaming
// protocol, so no content is loaded into the renderer directly.

/** The PDF MIME type for a path's extension, or null when it isn't a PDF. */
export function pdfMimeType(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'pdf' ? 'application/pdf' : null
}
