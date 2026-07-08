export const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024

/**
 * Converts raw file bytes to text for display, rejecting binary or oversized
 * content with a user-facing error.
 */
export function ensureText(buf: Buffer, size = buf.length): string {
  if (size > MAX_TEXT_FILE_SIZE) {
    throw new Error(`File is too large to display (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }
  if (buf.subarray(0, 8000).includes(0)) {
    throw new Error('File appears to be binary')
  }
  return buf.toString('utf8')
}
