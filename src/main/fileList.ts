import { promises as fs } from 'fs'
import * as path from 'path'

// Shared bits for the quick-open file listing (see providers' listFiles). In a
// git repo we defer to `git ls-files` (honors .gitignore); otherwise we walk the
// tree ourselves, skipping the usual heavyweight/vendored directories.

/** Hard cap so a pathological tree can't exhaust memory or freeze the palette. */
export const MAX_LISTED_FILES = 50000

/** Directories skipped by the non-git walk (git handles ignores on its own). */
export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components',
  'dist', 'out', 'build', '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache',
  'target', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.gradle', '.idea', 'coverage'
])

/** Dedupe (git can list a path twice) and cap to MAX_LISTED_FILES, order-preserving. */
export function capFiles(files: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of files) {
    if (!f || seen.has(f)) continue
    seen.add(f)
    out.push(f)
    if (out.length >= MAX_LISTED_FILES) break
  }
  return out
}

/** Recursive fallback for non-git folders: relative posix paths, ignoring IGNORED_DIRS. */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_LISTED_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — skip
    }
    for (const e of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full)
      } else {
        // Files and symlinks (we don't follow symlinked dirs, avoiding cycles).
        out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  await walk(root)
  return out
}
