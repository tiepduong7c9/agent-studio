// Pure reducer from the raw ACP event stream to renderable thread items.
// Ported from ccremote's AcpThread; streaming chunks coalesce into the trailing
// item of the same kind, tool_call_update patches the matching tool card, and a
// single plan card updates in place.

import type { AcpContentBlock, AcpEvent, AcpPlanEntry, AcpPermissionRequest, AcpToolContent } from './protocol'

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string; title: string; status: string; toolKind?: string; content: AcpToolContent[] }
  | { kind: 'plan'; id: string; entries: AcpPlanEntry[] }
  | { kind: 'permission'; id: string; requestId: string; request: AcpPermissionRequest; resolved?: string }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'interrupted'; id: string }
  | { kind: 'error'; id: string; message: string }

export function textOf(c: AcpContentBlock | undefined): string {
  if (!c) return ''
  if (typeof (c as { text?: unknown }).text === 'string') return (c as { text: string }).text
  return ''
}

export function buildThread(events: AcpEvent[]): ThreadItem[] {
  const items: ThreadItem[] = []
  const toolIndex = new Map<string, number>()
  let planIndex = -1

  events.forEach((e, i) => {
    if (e.type === 'acp_user') {
      items.push({ kind: 'user', id: `u${i}`, text: e.blocks.map(textOf).join('') })
    } else if (e.type === 'acp_update') {
      const u = e.update
      const su = u.sessionUpdate
      if (su === 'agent_message_chunk') {
        const last = items[items.length - 1]
        if (last && last.kind === 'assistant') last.text += textOf((u as { content: AcpContentBlock }).content)
        else items.push({ kind: 'assistant', id: `a${i}`, text: textOf((u as { content: AcpContentBlock }).content) })
      } else if (su === 'agent_thought_chunk') {
        const last = items[items.length - 1]
        if (last && last.kind === 'thought') last.text += textOf((u as { content: AcpContentBlock }).content)
        else items.push({ kind: 'thought', id: `t${i}`, text: textOf((u as { content: AcpContentBlock }).content) })
      } else if (su === 'user_message_chunk') {
        const last = items[items.length - 1]
        if (last && last.kind === 'user') last.text += textOf((u as { content: AcpContentBlock }).content)
        else items.push({ kind: 'user', id: `uc${i}`, text: textOf((u as { content: AcpContentBlock }).content) })
      } else if (su === 'tool_call') {
        const tu = u as { toolCallId: string; title?: string; kind?: string; status?: string; content?: AcpToolContent[] }
        toolIndex.set(tu.toolCallId, items.length)
        items.push({ kind: 'tool', id: `tool${i}`, toolCallId: tu.toolCallId, title: tu.title || 'Tool', status: tu.status || 'pending', toolKind: tu.kind, content: tu.content || [] })
      } else if (su === 'tool_call_update') {
        const tu = u as { toolCallId: string; title?: string; status?: string; content?: AcpToolContent[] }
        const idx = toolIndex.get(tu.toolCallId)
        if (idx != null) {
          const it = items[idx] as Extract<ThreadItem, { kind: 'tool' }>
          if (tu.status) it.status = tu.status
          if (tu.title) it.title = tu.title
          if (tu.content && tu.content.length) it.content = tu.content
        } else {
          toolIndex.set(tu.toolCallId, items.length)
          items.push({ kind: 'tool', id: `tool${i}`, toolCallId: tu.toolCallId, title: tu.title || 'Tool', status: tu.status || 'pending', content: tu.content || [] })
        }
      } else if (su === 'plan') {
        const pu = u as { entries: AcpPlanEntry[] }
        if (planIndex >= 0) (items[planIndex] as Extract<ThreadItem, { kind: 'plan' }>).entries = pu.entries
        else { planIndex = items.length; items.push({ kind: 'plan', id: `plan${i}`, entries: pu.entries }) }
      }
    } else if (e.type === 'acp_permission') {
      items.push({ kind: 'permission', id: `perm${i}`, requestId: e.requestId, request: e.request, resolved: e.resolved })
    } else if (e.type === 'acp_stop') {
      if (e.stopReason && /cancel/i.test(e.stopReason)) items.push({ kind: 'interrupted', id: `stop${i}` })
    } else if (e.type === 'acp_notice') {
      items.push({ kind: 'notice', id: `notice${i}`, text: e.text })
    } else if (e.type === 'acp_error') {
      items.push({ kind: 'error', id: `err${i}`, message: e.message })
    }
  })
  return items
}

/** The conversation's opening human prompt, collapsed to one line (heading recap). */
export function recapOf(events: AcpEvent[]): string | null {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ')
  for (const e of events) {
    if (e.type !== 'acp_user') continue
    for (const b of e.blocks) {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string' && t.trim() && !t.trim().startsWith('<')) return clean(t)
    }
  }
  return null
}

/** Friendly model label, e.g. "claude-opus-4-…" -> "Opus 4.x". */
export function modelLabel(id?: string | null): string | null {
  if (!id) return null
  const lower = id.toLowerCase()
  const fam = lower.includes('opus') ? 'Opus' : lower.includes('sonnet') ? 'Sonnet' : lower.includes('haiku') ? 'Haiku' : null
  if (!fam) return id
  const ver = id.match(/(\d+)-(\d+)/)
  return ver ? `${fam} ${ver[1]}.${ver[2]}` : fam
}
