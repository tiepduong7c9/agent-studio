import type { AcpEvent, AcpSnapshot, SessionMeta, StudioRequest, StudioResult } from '../shared/acp'

// The agent-studio MCP tools, carried out by the app. A session's MCP server
// (engine/src/studio-mcp.ts) defines the tools; its engine relays each call
// here, because only the app is connected to every host. Kept free of Electron
// and the IPC layer — acp-ipc supplies the operations — so it can be exercised
// against a bare engine.

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
  const self = s.id === callerSid ? ' (this session)' : ''
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

  // Resolve once `sid` stops working: it finished the turn ('done'), paused for
  // the user ('waiting'), or its process ended ('exited'). With `start`, the
  // turn is begun after subscribing (so no status change is missed) and a
  // leftover 'idle' from before it is ignored until the turn shows as working.
  const waitForTurn = async (
    sid: string,
    seconds: number,
    start?: () => Promise<void>
  ): Promise<'done' | 'waiting' | 'exited' | 'timeout'> => {
    let seenWorking = !start
    let finish: (r: 'done' | 'waiting' | 'exited' | 'timeout') => void = () => {}
    const result = new Promise<'done' | 'waiting' | 'exited' | 'timeout'>((r) => { finish = r })
    let stopTimer: NodeJS.Timeout | undefined
    const unwatch = await ops.watch(sid, (e) => {
      if (e.type === 'acp_status') {
        if (e.claudeStatus === 'working') seenWorking = true
        else if (e.claudeStatus === 'waiting') finish('waiting')
        else if (seenWorking) finish('done')
      } else if (e.type === 'acp_permission' || e.type === 'acp_elicitation') {
        if (!e.resolved) finish('waiting')
      } else if (e.type === 'acp_stop' || e.type === 'acp_error') {
        // The idle status normally follows; don't hang if it never does.
        seenWorking = true
        clearTimeout(stopTimer)
        stopTimer = setTimeout(() => finish('done'), 2000)
      } else if (e.type === 'exit') {
        finish('exited')
      }
    })
    // Belt and braces: the session list carries status too (e.g. if the event
    // stream drops across a reconnect).
    const startedAt = Date.now()
    const poll = setInterval(async () => {
      const s = await find(sid).catch(() => null)
      if (!s) return finish('exited')
      if (s.claudeStatus === 'working') seenWorking = true
      else if (s.claudeStatus === 'waiting') finish('waiting')
      else if (seenWorking || Date.now() - startedAt > 15_000) finish('done')
    }, 3000)
    const timer = setTimeout(() => finish('timeout'), seconds * 1000)
    try {
      if (start) await start()
      else {
        const s = await find(sid)
        if (!s || s.claudeStatus !== 'working') finish(s?.claudeStatus === 'waiting' ? 'waiting' : 'done')
      }
      return await result
    } finally {
      clearInterval(poll)
      clearTimeout(timer)
      clearTimeout(stopTimer)
      unwatch()
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
      if (!args.wait) {
        await ops.prompt(s.id, blocks)
        return ok(`Sent to "${s.name}" (${s.id}). Use wait_for_session or read_session to see the reply.`)
      }
      const seconds = waitSeconds(args.timeout_seconds)
      const outcome = await waitForTurn(s.id, seconds, () => ops.prompt(s.id, blocks))
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
      if (!args.wait) {
        await ops.prompt(meta.id, blocks)
        return ok(`Started session ${where} and sent the message. Use wait_for_session or read_session to see the reply.`)
      }
      const seconds = waitSeconds(args.timeout_seconds)
      const outcome = await waitForTurn(meta.id, seconds, () => ops.prompt(meta.id, blocks))
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
      return await tool({ ...req, args: req.args || {} })
    } catch (e: any) {
      return err(`Agent Studio couldn't do that: ${e?.message || e}`)
    }
  }
}
