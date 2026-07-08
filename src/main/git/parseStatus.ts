import type { GitFileChange, GitStatus } from '../../shared/types'

/**
 * Parses `git status --porcelain=v2 --branch -z` output.
 *
 * The `-z` flag is required for correctness: without it git C-quotes paths with
 * special/Unicode characters (per core.quotePath) and separates a rename's two
 * paths with a literal tab — both of which corrupt naive parsing. With `-z`,
 * records are NUL-terminated and paths are raw, and a rename/copy (type 2)
 * record is followed by its origin path as a separate NUL-terminated token.
 */
export function parseGitStatus(stdout: string): GitStatus {
  const status: GitStatus = { isRepo: true, ahead: 0, behind: 0, changes: [] }

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (!line) continue

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      status.branch = head === '(detached)' ? 'detached HEAD' : head
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        status.ahead = parseInt(m[1], 10)
        status.behind = parseInt(m[2], 10)
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(' ')
      const xy = parts[1]
      const path = parts.slice(8).join(' ')
      status.changes.push(change(path, xy))
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
      const parts = line.split(' ')
      const xy = parts[1]
      const path = parts.slice(9).join(' ')
      const origPath = tokens[++i] // origin path is the next NUL-terminated token
      status.changes.push({ ...change(path, xy), origPath })
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = line.split(' ')
      const xy = parts[1]
      const path = parts.slice(10).join(' ')
      status.changes.push({ ...change(path, xy), conflicted: true })
    } else if (line.startsWith('? ')) {
      status.changes.push({
        path: line.slice(2),
        index: '.',
        worktree: '?',
        untracked: true,
        conflicted: false
      })
    }
  }

  return status
}

function change(path: string, xy: string): GitFileChange {
  return {
    path,
    index: xy[0] ?? '.',
    worktree: xy[1] ?? '.',
    untracked: false,
    conflicted: false
  }
}
