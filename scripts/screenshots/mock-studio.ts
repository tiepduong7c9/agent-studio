// A fake `window.studio` backend for rendering the UI in a plain browser with
// sample data — used to take the README screenshots (see README.md in this
// folder). Loaded by vite.config.ts before the renderer's own entry, so the app
// boots against this instead of the Electron preload.

import type { AcpSnapshot, SessionMeta } from '../../src/shared/acp'
import type { FileEntry, GitStatus } from '../../src/shared/types'

const now = Date.now()
const ago = (min: number): string => new Date(now - min * 60_000).toISOString()

const HOME = '/home/sam'
const GPU = 'sam@gpu-box'
const STAGING = 'deploy@staging'

const session = (
  id: string, name: string, cwd: string, host: string | null,
  claudeStatus: SessionMeta['claudeStatus'], minAgo: number, extra: Partial<SessionMeta> = {}
): SessionMeta => ({
  id, name, cwd, host, mode: 'acp', status: 'running', claudeStatus, titleLocked: true,
  createdAt: ago(minAgo + 90), lastAttachedAt: ago(minAgo), ...extra
})

const WEB = `${HOME}/acme/web`
const API = `${HOME}/acme/billing-api`

const sessions: SessionMeta[] = [
  session('s-ratelimit', 'Add rate limiting to the public API', API, null, 'waiting', 2),
  session('s-e2e', 'Fix flaky checkout e2e test', WEB, null, 'working', 1),
  session('s-oauth', 'Migrate login to OAuth 2.1 + PKCE', WEB, null, 'idle', 35),
  session('s-vite', 'Bump vite to v7 and fix the build', WEB, null, 'idle', 180),
  session('s-sentry', 'Triage new Sentry errors', API, null, 'idle', 240, {
    schedule: { crons: [{ id: 'c1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'Triage new Sentry errors' }] }
  }),
  session('s-invoice', 'Invoice PDF renders blank totals', API, null, 'idle', 60 * 26),
  session('s-batch', 'Tune batch size for the embedding job', '/srv/ml/pipeline', GPU, 'working', 4),
  session('s-oom', 'Investigate OOM in the trainer', '/srv/ml/pipeline', GPU, 'waiting', 12),
  session('s-loaders', 'Document the data loaders', '/srv/ml/pipeline', GPU, 'idle', 60 * 5),
  session('s-pg', 'Roll out the Postgres 17 upgrade', '/opt/infra', STAGING, 'working', 3),
  session('s-certs', 'Rotate TLS certificates', '/opt/infra', STAGING, 'idle', 60 * 30)
]

// Seed the persisted view state: a couple of pins, tags, and PR/ticket badges.
localStorage.setItem('agent-studio.view-prefs', JSON.stringify({
  state: {
    pinnedSessions: { 's-ratelimit': true, 's-pg': true, 's-e2e': true },
    pinnedMeta: {},
    hiddenSessions: {},
    hiddenProjects: {},
    unreadSessions: {},
    sessionTag: { 's-ratelimit': 'feature', 's-e2e': 'bug', 's-oom': 'urgent', 's-oauth': 'review' },
    focusMode: false,
    showHidden: false,
    changesViewMode: 'list',
    activeBarVisible: true
  },
  version: 2
}))
const pr = (n: number) => ({
  patternId: 'builtin:github-pr', kind: 'pr', id: String(n), label: `#${n}`,
  url: `https://github.com/acme/web/pull/${n}`
})
localStorage.setItem('agent-studio.captures', JSON.stringify({
  state: { capturesBySid: { 's-oauth': [pr(412)], 's-vite': [pr(398)], 's-e2e': [pr(415)] } },
  version: 0
}))

// ── the conversation shown in the session view ───────────────────────────────

const text = (t: string) => ({ type: 'text', text: t })
let seq = 0
const ev = (e: Record<string, unknown>) => ({ ...e, seq: seq++, rxAt: now - 5 * 60_000 + seq * 4000 })
const upd = (update: Record<string, unknown>) => ev({ type: 'acp_update', update })
const say = (t: string) => upd({ sessionUpdate: 'agent_message_chunk', content: text(t) })
const tool = (id: string, title: string, kind: string, content: unknown[] = []) =>
  upd({ sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'completed', content })
const out = (t: string) => [{ type: 'content', content: text(t) }]

const RATE_LIMIT_OLD = `export function createApp(deps: Deps) {
  const app = express()
  app.use(express.json())
  app.use('/v1', publicRoutes(deps))
  return app
}`
const RATE_LIMIT_NEW = `export function createApp(deps: Deps) {
  const app = express()
  app.use(express.json())
  app.use('/v1', rateLimit({ store: deps.redis, limit: 100, windowMs: 60_000 }))
  app.use('/v1', publicRoutes(deps))
  return app
}`

const ratelimitThread = [
  ev({ type: 'acp_user', blocks: [text('Add per-API-key rate limiting to the public /v1 routes. 100 req/min, backed by Redis so it works across instances. Return a proper 429 with Retry-After.')] }),
  upd({ sessionUpdate: 'agent_thought_chunk', content: text('I need to find where the /v1 router is mounted and whether Redis is already wired into the app deps…') }),
  tool('t1', 'Search "publicRoutes"', 'search', out('src/app.ts:14\nsrc/routes/public.ts:8')),
  tool('t2', 'Read src/app.ts', 'read'),
  tool('t3', 'Read src/deps.ts', 'read'),
  upd({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Add a Redis-backed sliding-window limiter middleware', status: 'completed' },
      { content: 'Mount it in front of the /v1 routes', status: 'completed' },
      { content: 'Return 429 with Retry-After and X-RateLimit-* headers', status: 'completed' },
      { content: 'Cover it with integration tests', status: 'in_progress' }
    ]
  }),
  tool('t4', 'Write src/middleware/rate-limit.ts', 'edit', [{ type: 'diff', path: `${API}/src/middleware/rate-limit.ts`, oldText: null, newText: '// sliding-window limiter…' }]),
  tool('t5', 'Edit src/app.ts', 'edit', [{ type: 'diff', path: `${API}/src/app.ts`, oldText: RATE_LIMIT_OLD, newText: RATE_LIMIT_NEW }]),
  tool('t6', 'npm test -- rate-limit', 'execute', out(' PASS  test/rate-limit.test.ts\n  ✓ allows 100 requests per key per minute (41 ms)\n  ✓ returns 429 with Retry-After once over the limit (12 ms)\n  ✓ keys are isolated from each other (9 ms)\n\nTests: 3 passed, 3 total')),
  say(`Rate limiting is in place for every \`/v1\` route:

- **\`src/middleware/rate-limit.ts\`** — a sliding-window limiter keyed on the API key, stored in Redis so all instances share the count.
- **\`src/app.ts\`** — mounted in front of \`publicRoutes\`.
- Over the limit, clients get a \`429\` with \`Retry-After\` plus \`X-RateLimit-Limit\` / \`X-RateLimit-Remaining\` headers.

\`\`\`ts
app.use('/v1', rateLimit({ store: deps.redis, limit: 100, windowMs: 60_000 }))
\`\`\`

The three new tests pass. I'd like to run the full suite against the local Redis before opening the PR.`),
  ev({
    type: 'acp_permission',
    requestId: 'perm1',
    request: {
      toolCall: { title: 'docker compose up -d redis && npm test', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    }
  })
]

const snapshot = (sid: string): AcpSnapshot => {
  const meta = sessions.find((s) => s.id === sid)
  const events = sid === 's-ratelimit'
    ? ratelimitThread
    : [
        ev({ type: 'acp_user', blocks: [text(meta?.name ?? 'Hello')] }),
        say('On it — taking a look now.')
      ]
  return {
    events,
    claudeStatus: meta?.claudeStatus,
    acpSessionId: `acp-${sid}`,
    model: 'claude-opus-5-5',
    modelState: {
      currentModelId: 'opus',
      availableModels: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' }]
    },
    modeState: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'acceptEdits', name: 'Accept edits' },
        { id: 'plan', name: 'Plan mode' }
      ]
    },
    effortState: {
      currentEffortId: 'high',
      availableEfforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]
    },
    usage: { used: 48_200, size: 200_000 },
    availableCommands: [{ name: 'review', description: 'Review the current changes' }]
  }
}

// ── project files + git ──────────────────────────────────────────────────────

const TREE: Record<string, string[]> = {
  '': ['src/', 'test/', '.env.example', 'docker-compose.yml', 'package.json', 'README.md', 'tsconfig.json'],
  src: ['middleware/', 'routes/', 'app.ts', 'deps.ts', 'server.ts'],
  'src/middleware': ['auth.ts', 'rate-limit.ts'],
  'src/routes': ['invoices.ts', 'public.ts'],
  test: ['invoices.test.ts', 'rate-limit.test.ts']
}
const rootOf = (wsId: string): string => wsId.split(':').slice(2).join(':')
const readDir = (wsId: string, dir: string): FileEntry[] => {
  const root = rootOf(wsId)
  const rel = dir === root ? '' : dir.slice(root.length + 1)
  return (TREE[rel] ?? []).map((n) => {
    const name = n.replace(/\/$/, '')
    return { name, path: `${dir}/${name}`, kind: n.endsWith('/') ? 'dir' : 'file' }
  })
}
const allFiles = Object.entries(TREE).flatMap(([dir, names]) =>
  names.filter((n) => !n.endsWith('/')).map((n) => (dir ? `${dir}/${n}` : n))
)
const gitStatus: GitStatus = {
  isRepo: true,
  branch: 'feat/rate-limit',
  upstream: 'origin/feat/rate-limit',
  ahead: 2,
  behind: 0,
  changes: [
    { path: 'src/app.ts', index: '.', worktree: 'M', untracked: false, conflicted: false },
    { path: 'src/middleware/rate-limit.ts', index: '.', worktree: '.', untracked: true, conflicted: false },
    { path: 'test/rate-limit.test.ts', index: '.', worktree: '.', untracked: true, conflicted: false },
    { path: 'package.json', index: 'M', worktree: '.', untracked: false, conflicted: false }
  ]
}

// ── the API ──────────────────────────────────────────────────────────────────

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data })
const noop = () => () => {}
let engineCb: ((s: { hostKey: string; connected: boolean }) => void) | null = null

const usage = {
  account: { email: 'sam@acme.dev', subscriptionType: 'max' },
  usage: {
    five_hour: { utilization: 34, resets_at: new Date(now + 2 * 3600_000).toISOString() },
    seven_day: { utilization: 22, resets_at: new Date(now + 4 * 86400_000).toISOString() }
  }
}

const studio = {
  platform: 'linux',
  initialProjectPath: null,
  demoSessions: true,
  reconnectSavedHosts: () => {
    setTimeout(() => {
      for (const h of [GPU, STAGING]) engineCb?.({ hostKey: `ssh:${h}`, connected: true })
      engineCb?.({ hostKey: 'local', connected: true })
    }, 0)
    return ok([{ host: GPU, connected: true }, { host: STAGING, connected: true }])
  },
  ensureProjectForSession: (cwd: string, host: string | null) =>
    ok({ id: `${host ? 'ssh' : 'local'}:${host ?? 'local'}:${cwd}`, kind: host ? 'ssh' : 'local', name: cwd.split('/').pop(), rootPath: cwd, host: host ?? undefined }),
  readDir: (wsId: string, dir: string) => ok(readDir(wsId, dir)),
  listFiles: () => ok(allFiles),
  readFile: () => ok(RATE_LIMIT_NEW + '\n'),
  gitStatus: () => ok(gitStatus),
  gitRemoteUrl: () => ok('https://github.com/acme/billing-api'),
  gitShowHead: () => ok(RATE_LIMIT_OLD + '\n'),
  gitLog: () => ok({ isRepo: true, commits: [] }),
  gitBranches: () => ok({ current: 'feat/rate-limit', local: ['main', 'feat/rate-limit'], remote: ['origin/main'] }),
  gitWorktreeInfo: (cwd: string) =>
    ok({ root: cwd, repo: cwd.split('/').pop(), repoRoot: cwd, branch: cwd === API ? 'feat/rate-limit' : 'main', head: 'a1b2c3d', linked: false }),
  getVersion: () => ok('0.5.7'),
  onTransferProgress: noop,
  onNotificationActivate: noop,
  setBadgeCount: () => ok(undefined),
  skills: {
    list: () => Promise.resolve({ skills: [], pending: [], unreachable: [], root: `${HOME}/.agent-studio/skills` }),
    forProject: () => Promise.resolve([])
  },
  links: { listBrowsers: () => ok([{ id: 'default', name: 'Default browser' }]) },
  terminal: { onData: noop, onExit: noop },
  acp: {
    listSessions: () => Promise.resolve(sessions),
    listProjects: () => Promise.resolve([]),
    getUsage: () => Promise.resolve(usage),
    attach: (sid: string) => Promise.resolve(snapshot(sid)),
    listConversations: () => Promise.resolve([]),
    onEvent: noop,
    onSessions: noop,
    onResync: noop,
    onEngineStatus: (cb: typeof engineCb) => { engineCb = cb; return () => {} }
  }
}

// Anything not modelled above resolves to an empty success, so incidental calls
// (detach, mode switches, …) are harmless no-ops.
const fallback = (target: any): any =>
  new Proxy(target, {
    get(t, key) {
      if (key in t) {
        const v = t[key]
        return v && typeof v === 'object' && !Array.isArray(v) ? fallback(v) : v
      }
      if (typeof key === 'symbol' || key === 'then') return undefined
      return () => Promise.resolve({ ok: true, data: null })
    }
  })

;(window as any).studio = fallback(studio)
