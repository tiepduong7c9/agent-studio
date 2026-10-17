import type { AcpEvent, AcpSnapshot, SessionMeta, StudioRequest, StudioResult } from '../shared/acp'

// The agent-studio MCP tools, carried out by the app. The controller session's
// MCP server (engine/src/studio-mcp.ts) defines the tools; its engine relays
// each call here, because only the app is connected to every host. Only the
// controller may call them — it's the one session given the server, and this
// is checked again here so moving the role takes effect at once. Kept free of
// Electron and the IPC layer — acp-ipc supplies the operations — so it can be
// exercised against a bare engine.

export interface StudioOps {
  /** Every session on every connected host, host-decorated. */
  list(): Promise<SessionMeta[]>
  /** Connected host keys: 'local' | 'ssh:user@host'. */
  hostKeys(): string[]
  snapshot(sid: string): Promise<AcpSnapshot | null>
  prompt(sid: string, blocks: unknown[]): Promise<void>
  cancel(sid: string): Promise<void>
  create(hostKey: string, cwd: string, name?: string): Promise<SessionMeta>
  /** Follow a session's live events; resolves to an unsubscribe fn. */
  watch(sid: string, cb: (e: AcpEvent) => void): Promise<() => void>
}

type Lane = 'needs_you' | 'running' | 'scheduled' | 'idle'

// Mirrors the board's lanes (SessionsBoard laneOf), minus the renderer-only
// "finished while you weren't looking" marker.
function laneOf(s: SessionMeta): Lane {
  if (s.status === 'exited' || s.claudeStatus === 'waiting') return 'needs_you'
  if (s.claudeStatus === 'working') return 'running'
  if (s.schedule) return 'scheduled'
  return 'idle'
}

const hostLabel = (s: SessionMeta): string => s.host ?? 'local'
const hostKeyOf = (host: string | null | undefined): string =>
  !host || host === 'local' ? 'local' : host.startsWith('ssh:') ? host : `ssh:${host}`

const DEFAULT_WAIT_S = 300
const MAX_WAIT_S = 1800
const MAX_TEXT = 4000
// How long a session gets to take a delivered message (a dormant one resumes first).
const TAKE_MESSAGE_S = 60

const ok = (text: string): StudioResult => ({ text })
const err = (text: string): StudioResult => ({ text, isError: true })

function clip(text: string, max = MAX_TEXT): string {
  const t = text.trim()
  if (t.length <= max) return t
  const half = Math.floor(max / 2)
  return `${t.slice(0, half)}\n… [${t.length - max} characters omitted] …\n${t.slice(-half)}`
}

const blockText = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? blocks.map((b) => (typeof (b as { text?: unknown })?.text === 'string' ? (b as { text: string }).text : '')).join('')
    : ''

interface Turn {
  user: string
  parts: string[]
  pending: string[]
}

// Fold a session's event history into turns: what the user sent, then the
// agent's replies and tool calls in order, plus anything left waiting on the user.
function turnsOf(events: AcpEvent[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null
  let text = ''
  const tools = new Map<string, { title: string; status: string; at: number }>()
  const flush = () => {
    if (cur && text.trim()) cur.parts.push(`Assistant: ${clip(text)}`)
    text = ''
  }
  for (const e of events) {
    if (e.type === 'acp_user') {
      flush()
      cur = { user: blockText(e.blocks), parts: [], pending: [] }
      turns.push(cur)
      continue
    }
    if (!cur) continue
    if (e.type === 'acp_update') {
      const u = e.update || {}
      if (u.sessionUpdate === 'agent_message_chunk') text += u.content?.text ?? ''
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const known = tools.get(u.toolCallId)
        if (known) {
          if (u.title) known.title = u.title
          if (u.status) known.status = u.status
          const line = `  • ${known.title} (${known.status})`
          cur.parts[known.at] = line
        } else {
          flush()
          const t = { title: u.title || 'Tool', status: u.status || 'pending', at: cur.parts.length }
          tools.set(u.toolCallId, t)
          cur.parts.push(`  • ${t.title} (${t.status})`)
        }
      }
    } else if (e.type === 'acp_permission' && !e.resolved) {
      const what = e.request?.toolCall?.title || 'a tool call'
      const opts = (e.request?.options || []).map((o: { name: string }) => o.name).join(' / ')
      cur.pending.push(`Waiting for the user to approve: ${what}${opts ? ` (${opts})` : ''}`)
    } else if (e.type === 'acp_elicitation' && !e.resolved) {
      cur.pending.push(`Waiting for the user to answer: ${e.request?.message || 'a question'}`)
    } else if (e.type === 'acp_error') {
      flush()
      cur.parts.push(`Error: ${e.message}`)
    } else if (e.type === 'acp_stop' && /cancel/i.test(e.stopReason || '')) {
      flush()
      cur.parts.push('(turn interrupted)')
    }
  }
  flush()
  return turns
}

function describe(s: SessionMeta, callerSid?: string): string {
  const self = s.id === callerSid ? ' (this session, the controller)' : ''
  return `"${s.name}"${self} — id: ${s.id} · status: ${laneOf(s)} · host: ${hostLabel(s)} · folder: ${s.cwd}`
}

function formatTurns(s: SessionMeta, snap: AcpSnapshot | null, count: number): string {
  const head = `Session ${describe(s)}`
  const turns = turnsOf((snap?.events ?? []) as AcpEvent[])
  if (!turns.length) return `${head}\n\n(no conversation yet)`
  const shown = turns.slice(-count)
  const skipped = turns.length - shown.length
  const body = shown.map((t, i) => {
    const lines = [`--- turn ${turns.length - shown.length + i + 1} of ${turns.length} ---`, `User: ${clip(t.user)}`, ...t.parts, ...t.pending]
    return lines.join('\n')
  })
  return [head, skipped ? `(${skipped} earlier turn${skipped === 1 ? '' : 's'} not shown)` : '', ...body].filter(Boolean).join('\n\n')
}

// The latest turn's reply and anything it's waiting on — what a waiter wants back.
function latestReply(snap: AcpSnapshot | null): string {
  const turns = turnsOf((snap?.events ?? []) as AcpEvent[])
  const t = turns[turns.length - 1]
  if (!t) return '(no conversation yet)'
  const lines = [...t.parts, ...t.pending]
  return lines.length ? lines.join('\n') : '(no reply yet)'
}

export function createStudioTools(ops: StudioOps) {
  const find = async (sid: unknown): Promise<SessionMeta | null> => {
    if (typeof sid !== 'string' || !sid) return null
    return (await ops.list()).find((s) => s.id === sid) ?? null
  }
  const waitSeconds = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_WAIT_S
    return Math.min(MAX_WAIT_S, Math.max(1, Math.round(n)))
  }

  type Outcome = 'done' | 'waiting' | 'exited' | 'timeout'

  // Follow `sid` until it stops working: it finished its turn ('done'), paused
  // for the user ('waiting'), or its process ended ('exited'). Returns `follow`,
  // which starts tracking once the caller knows the turn has begun, and `result`.
  const tracker = async (sid: string, seconds: number) => {
    let following = false
    let finish: (r: Outcome) => void = () => {}
    const result = new Promise<Outcome>((r) => { finish = r })
    let stopTimer: NodeJS.Timeout | undefined
    let followedAt = 0
    let onEvent: (e: AcpEvent) => void = () => {}
    const unwatch = await ops.watch(sid, (e) => {
      onEvent(e)
      if (!following) return
      if (e.type === 'acp_status') {
        if (e.claudeStatus === 'waiting') finish('waiting')
        else if (e.claudeStatus === 'idle') finish('done')
      } else if ((e.type === 'acp_permission' || e.type === 'acp_elicitation') && !e.resolved) {
        finish('waiting')
      } else if (e.type === 'acp_stop' || e.type === 'acp_error') {
        // The idle status normally follows; don't hang if it never does.
        clearTimeout(stopTimer)
        stopTimer = setTimeout(() => finish('done'), 2000)
      } else if (e.type === 'exit') {
        finish('exited')
      }
    })
    // Belt and braces: the session list carries status too (e.g. if the event
    // stream drops across a reconnect). Give the list a moment to catch up
    // with the turn starting before trusting a not-working status from it.
    const poll = setInterval(async () => {
      if (!following || Date.now() - followedAt < 4000) return
      const s = await find(sid).catch(() => null)
      if (!s) finish('exited')
      else if (s.claudeStatus === 'waiting') finish('waiting')
      else if (s.claudeStatus !== 'working') finish('done')
    }, 3000)
    const timer = setTimeout(() => finish('timeout'), seconds * 1000)
    return {
      result,
      follow: () => { following = true; followedAt = Date.now() },
      onEvent: (fn: (e: AcpEvent) => void) => { onEvent = fn },
      finish,
      dispose: () => { clearInterval(poll); clearTimeout(timer); clearTimeout(stopTimer); unwatch() }
    }
  }

  // Sessions an agent message is currently being delivered to. Checking "is it
  // busy?" and then prompting isn't atomic, so without this two sends (e.g. the
  // controller's parallel tool calls) could both land mid-turn.
  const delivering = new Set<string>()

  // Send `blocks` to `sid`. Resolves 'sent' once the session has taken the
  // message (its own acp_user for it shows up), or — with `wait` — once that
  // turn ends. Only events after our message count, so a status left over from
  // before it (e.g. while a dormant session resumes) can't end the wait early.
  const deliver = async (sid: string, blocks: { type: string; text: string }[], wait: number | null): Promise<Outcome | 'sent' | 'busy' | 'failed'> => {
    if (delivering.has(sid)) return 'busy'
    delivering.add(sid)
    const t = await tracker(sid, wait ?? TAKE_MESSAGE_S)
    let taken = false
    // However long the caller will wait for the reply, the message itself must
    // be taken promptly — otherwise the session never started its turn.
    const takeTimer = setTimeout(() => { if (!taken) t.finish('timeout') }, TAKE_MESSAGE_S * 1000)
    try {
      t.onEvent((e) => {
        if (taken || e.type !== 'acp_user' || blockText(e.blocks) !== blocks[0].text) return
        taken = true
        delivering.delete(sid)
        if (wait === null) t.finish('done')
        else t.follow()
      })
      await ops.prompt(sid, blocks)
      const outcome = await t.result
      if (!taken) return 'failed'
      return wait === null ? 'sent' : outcome
    } finally {
      clearTimeout(takeTimer)
      delivering.delete(sid)
      t.dispose()
    }
  }

  // Wait for a turn already under way (no message sent by us).
  const waitForTurn = async (sid: string, seconds: number): Promise<Outcome> => {
    const t = await tracker(sid, seconds)
    try {
      t.follow()
      const s = await find(sid)
      if (!s) return 'exited'
      if (s.claudeStatus === 'waiting') return 'waiting'
      if (s.claudeStatus !== 'working') return 'done'
      return await t.result
    } finally {
      t.dispose()
    }
  }

  const outcomeText = async (s: SessionMeta, outcome: string, seconds: number): Promise<string> => {
    const snap = await ops.snapshot(s.id).catch(() => null)
    const status =
      outcome === 'timeout' ? `still working after ${seconds}s (call wait_for_session to keep waiting)`
      : outcome === 'waiting' ? 'waiting for the user'
      : outcome === 'exited' ? 'session ended'
      : 'finished its turn'
    return `Session "${s.name}" (${s.id}): ${status}.\n\nLatest turn:\n${latestReply(snap)}`
  }

  const labelled = (caller: SessionMeta | null, callerSid: string, message: string) => [
    { type: 'text', text: `[Message from session "${caller?.name ?? callerSid}" (${callerSid}) via Agent Studio]\n\n${message}` }
  ]

  const tools: Record<string, (req: StudioRequest) => Promise<StudioResult>> = {
    async list_sessions({ callerSid, args }) {
      let list = await ops.list()
      const statuses = Array.isArray(args.status) ? (args.status as string[]) : null
      if (statuses?.length) list = list.filter((s) => statuses.includes(laneOf(s)))
      if (typeof args.host === 'string' && args.host) {
        const key = hostKeyOf(args.host)
        list = list.filter((s) => hostKeyOf(s.host) === key)
      }
      const hosts = ops.hostKeys().map((k) => (k === 'local' ? 'local' : k.slice(4))).join(', ')
      if (!list.length) return ok(`No matching sessions. Connected hosts: ${hosts}.`)
      return ok(`${list.length} session${list.length === 1 ? '' : 's'} (connected hosts: ${hosts}):\n${list.map((s) => `- ${describe(s, callerSid)}`).join('\n')}`)
    },

    async read_session({ args }) {
      const s = await find(args.session_id)
      if (!s) return err(`No session "${args.session_id}". Use list_sessions to find ids.`)
      const turns = typeof args.turns === 'number' ? Math.min(20, Math.max(1, Math.round(args.turns))) : 3
      return ok(formatTurns(s, await ops.snapshot(s.id), turns))
    },

    async send_prompt({ callerSid, args }) {
      const s = await find(args.session_id)
      if (!s) return err(`No session "${args.session_id}". Use list_sessions to find ids.`)
      if (s.id === callerSid) return err('That is your own session — you cannot send a prompt to yourself.')
      if (typeof args.message !== 'string' || !args.message.trim()) return err('message is required.')
      if (s.claudeStatus === 'working') return err(`Session "${s.name}" is in the middle of a turn. Call wait_for_session first, then send.`)
      if (s.claudeStatus === 'waiting') return err(`Session "${s.name}" is waiting for the user to answer a prompt in Agent Studio; it can't take a new message until they do.`)
      const blocks = labelled(await find(callerSid), callerSid, args.message)
      const seconds = waitSeconds(args.timeout_seconds)
      const outcome = await deliver(s.id, blocks, args.wait ? seconds : null)
      if (outcome === 'busy') return err(`Another message to "${s.name}" is still being delivered. Wait for it, then try again.`)
      if (outcome === 'failed') return err(`"${s.name}" didn't take the message (it may have failed to start). Check it with read_session.`)
      if (outcome === 'sent') return ok(`Sent to "${s.name}" (${s.id}). Use wait_for_session or read_session to see the reply.`)
      return ok(await outcomeText(s, outcome, seconds))
    },

    async wait_for_session({ callerSid, args }) {
      const s = await find(args.session_id)
      if (!s) return err(`No session "${args.session_id}". Use list_sessions to find ids.`)
      if (s.id === callerSid) return err('That is your own session — waiting on it would never finish.')
      const seconds = waitSeconds(args.timeout_seconds)
      return ok(await outcomeText(s, await waitForTurn(s.id, seconds), seconds))
    },

    async create_session({ callerSid, args }) {
      if (typeof args.cwd !== 'string' || !/^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(args.cwd)) {
        return err('cwd must be an absolute folder path on the target host.')
      }
      const key = hostKeyOf(typeof args.host === 'string' ? args.host : null)
      if (!ops.hostKeys().includes(key)) {
        const hosts = ops.hostKeys().map((k) => (k === 'local' ? 'local' : k.slice(4))).join(', ')
        return err(`Host "${args.host}" isn't connected. Connected hosts: ${hosts}.`)
      }
      const meta = await ops.create(key, args.cwd, typeof args.name === 'string' && args.name ? args.name : undefined)
      const where = `"${meta.name}" (${meta.id}) on ${key === 'local' ? 'local' : key.slice(4)} in ${meta.cwd}`
      if (typeof args.message !== 'string' || !args.message.trim()) return ok(`Started session ${where}.`)
      const blocks = labelled(await find(callerSid), callerSid, args.message)
      const seconds = waitSeconds(args.timeout_seconds)
      const outcome = await deliver(meta.id, blocks, args.wait ? seconds : null)
      if (outcome === 'busy' || outcome === 'failed') return err(`Started session ${where}, but it didn't take the message. Check it with read_session.`)
      if (outcome === 'sent') return ok(`Started session ${where} and sent the message. Use wait_for_session or read_session to see the reply.`)
      return ok(`Started session ${where}.\n\n${await outcomeText(meta, outcome, seconds)}`)
    },

    async cancel_turn({ callerSid, args }) {
      const s = await find(args.session_id)
      if (!s) return err(`No session "${args.session_id}". Use list_sessions to find ids.`)
      if (s.id === callerSid) return err('That is your own session.')
      if (s.claudeStatus !== 'working' && s.claudeStatus !== 'waiting') return ok(`Session "${s.name}" isn't running a turn.`)
      await ops.cancel(s.id)
      return ok(`Stopped the current turn of "${s.name}" (${s.id}).`)
    }
  }

  return async (req: StudioRequest): Promise<StudioResult> => {
    const tool = tools[req.tool]
    if (!tool) return err(`Unknown tool: ${req.tool}`)
    try {
      const caller = await find(req.callerSid)
      if (!caller?.controller || caller.host) {
        return err('Only the controller session can use the Agent Studio tools. In Agent Studio, right-click a session on this machine and choose "Make Controller Session".')
      }
      return await tool({ ...req, args: req.args || {} })
    } catch (e: any) {
      return err(`Agent Studio couldn't do that: ${e?.message || e}`)
    }
  }
}
