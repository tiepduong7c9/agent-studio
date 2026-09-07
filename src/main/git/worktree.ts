import { execFile } from 'child_process'
import * as path from 'path'
import { promisify } from 'util'
import type { Client as SshClient } from 'ssh2'
import type { GitWorktreeInfo } from '../../shared/types'
import { shellQuote, sshExec } from '../ssh-exec'

const execFileAsync = promisify(execFile)

// Where a session is actually working, in git terms: its branch, and whether the
// cwd is a linked worktree (`git worktree add`) rather than the repo's main
// checkout. The sessions list shows this per row, and a row's folder may never
// have been opened as a workspace — so this probe runs off (host, cwd) alone
// rather than through a ProjectProvider.

// Paths + branch in one call. `--path-format=absolute` matters: without it git
// answers relative to the cwd (".git", "../../.git"), which we can't compare.
// `--abbrev-ref HEAD` prints the branch, or the literal "HEAD" when detached.
const REV_PARSE = [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-common-dir',
  '--git-dir',
  '--abbrev-ref',
  'HEAD'
]

/** Git identity of `cwd` on the local machine, or null when it isn't a repo. */
export async function localWorktreeInfo(cwd: string): Promise<GitWorktreeInfo | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...REV_PARSE])
    const short = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD']).catch(
      () => ({ stdout: '' }) // a repo with no commits yet
    )
    return parseWorktreeInfo(stdout, short.stdout)
  } catch {
    return null // not a repo, gone from disk, or git unavailable
  }
}

/** Git identity of `cwd` on a connected ssh host, or null when it isn't a repo.
 *  Both probes go over in one remote command — a round trip costs far more than
 *  the second rev-parse. */
export async function remoteWorktreeInfo(
  client: SshClient,
  cwd: string
): Promise<GitWorktreeInfo | null> {
  const dir = shellQuote(cwd)
  const args = REV_PARSE.map(shellQuote).join(' ')
  try {
    const res = await sshExec(
      client,
      `git -C ${dir} ${args} && git -C ${dir} rev-parse --short HEAD`,
      64 * 1024
    )
    if (res.code !== 0) return null
    // The two commands share one stream: the first four lines are the rev-parse
    // above, the fifth (when present) the short sha.
    const lines = res.stdout.split('\n')
    return parseWorktreeInfo(lines.slice(0, 4).join('\n'), lines[4] ?? '')
  } catch {
    return null
  }
}

/** Shape the rev-parse output (toplevel, common dir, git dir, branch) plus a
 *  short sha into a GitWorktreeInfo. Exported for tests. */
export function parseWorktreeInfo(revParse: string, shortSha: string): GitWorktreeInfo | null {
  const [root, commonDir, gitDir, ref] = revParse.trim().split('\n').map((l) => l.trim())
  if (!root || !commonDir || !gitDir) return null
  const main = mainRoot(commonDir)
  return {
    root,
    // Named exactly as the folder is: a ".git" suffix (bare clone, or just a
    // folder named that way) is part of how you'd recognise the repo.
    repo: path.posix.basename(main) || main,
    repoRoot: main,
    // "HEAD" from --abbrev-ref means detached; there's no branch to name.
    branch: ref && ref !== 'HEAD' ? ref : null,
    head: shortSha.trim(),
    // A linked worktree keeps its own git dir under <main>/.git/worktrees/<name>,
    // while sharing the common dir with every other worktree of the repo.
    linked: gitDir !== commonDir
  }
}

// The main worktree's root, derived from the common dir so every worktree of a
// repo reports the same one: "<main>/.git" for a normal clone, "<repo>.git" for
// a bare one (which has no checkout, so the git dir itself is the best anchor).
function mainRoot(commonDir: string): string {
  const dir = commonDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.posix.basename(dir) === '.git' ? path.posix.dirname(dir) : dir
}
