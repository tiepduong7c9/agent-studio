import type { GitCommit, GitLog } from '../../shared/types'

// `git log` format: fields separated by unit-sep (\x1f), records by record-sep
// (\x1e), so commit subjects (which can contain anything but those control
// bytes) never break parsing. Fields: hash, parents, author, email, author
// date (unix seconds), decoration refs, subject.
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e'

export function parseGitLog(stdout: string): GitLog {
  const commits: GitCommit[] = []
  for (const record of stdout.split('\x1e')) {
    const rec = record.replace(/^\s+/, '') // strip the newline git emits between records
    if (!rec) continue
    const f = rec.split('\x1f')
    if (f.length < 7) continue
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
      author: f[2],
      email: f[3],
      date: (Number(f[4]) || 0) * 1000,
      refs: parseRefs(f[5]),
      subject: f[6]
    })
  }
  return { isRepo: true, commits }
}

// The %D decoration list, e.g. "HEAD -> main, origin/main, tag: v1.0".
function parseRefs(decoration: string): string[] {
  return decoration
    .split(', ')
    .map((r) => r.trim())
    .filter(Boolean)
}
