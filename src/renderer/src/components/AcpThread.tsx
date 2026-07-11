import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, BrainCircuit, Check, ChevronDown, ChevronRight, CircleSlash,
  Clock, Copy, Cpu, FileText, FolderTree, Globe, ListTodo, Loader2, Pencil, Search,
  ShieldQuestion, SquarePen, Square, Terminal, Trash2, Wrench, X, ArrowUp, Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AcpConversation } from '../../../shared/acp'
import { useAcpStore } from '../acp/store'
import { useSessionsStore } from '../acp/sessions-store'
import { buildThread, modelLabel, recapOf, textOf, type ThreadItem } from '../acp/buildThread'
import type { AcpCommand, AcpModeState, AcpModelState, AcpToolContent } from '../acp/protocol'
import { useCommandHistory } from '../acp/command-history'
import './AcpThread.css'

const acp = () => window.studio.acp

// Copy-to-clipboard affordance for code/output blocks; flips to a check briefly.
function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [done, setDone] = useState(false)
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = getText()
    if (!text) return
    navigator.clipboard?.writeText(text).then(() => {
      setDone(true)
      setTimeout(() => setDone(false), 1200)
    }).catch(() => {})
  }
  return (
    <button type="button" className={`acp-copy${className ? ` ${className}` : ''}`} title="Copy" onClick={onCopy}>
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

// Fenced code block in assistant markdown, wrapped with a copy button.
function CodeBlock({ children }: React.ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="acp-code">
      <CopyButton getText={() => ref.current?.textContent ?? ''} />
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>{children}</ReactMarkdown>
})

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, onClose])
  return ref
}

// Map an ACP tool kind to a lucide icon + human verb, VS-Code-chat style. The
// title itself carries the argument (path / command), so the icon + verb just
// classify the action at a glance.
const TOOL_KIND: Record<string, { Icon: LucideIcon; verb: string }> = {
  read: { Icon: FileText, verb: 'Read' },
  edit: { Icon: Pencil, verb: 'Edit' },
  delete: { Icon: Trash2, verb: 'Delete' },
  move: { Icon: FolderTree, verb: 'Move' },
  search: { Icon: Search, verb: 'Search' },
  execute: { Icon: Terminal, verb: 'Run' },
  fetch: { Icon: Globe, verb: 'Fetch' },
  think: { Icon: BrainCircuit, verb: 'Think' },
}

function toolMeta(kind?: string) {
  return (kind && TOOL_KIND[kind]) || { Icon: Wrench, verb: 'Tool' }
}

// File-operation tools carry a full path in their title; collapse paths to
// their basename (like the VS Code extension's "Edit AcpThread.tsx"), while
// leaving shell commands untouched so their paths stay meaningful. Matches a
// whole path token (including its leading segment) so a relative path like
// "src/App.tsx" collapses to "App.tsx" rather than "srcApp.tsx".
const FILE_KINDS = new Set(['read', 'edit', 'delete', 'move'])
function displayTitle(kind: string | undefined, title: string): string {
  if (!kind || !FILE_KINDS.has(kind)) return title
  return title.replace(/[^\s'"]*\/[^\s'"]+/g, (p) => p.split('/').pop() || p)
}

// Aggregate added/removed line counts across all diff blocks for the header badge.
function diffStat(content: AcpToolContent[]): { add: number; del: number } | null {
  let add = 0, del = 0, has = false
  for (const c of content) {
    if (c.type !== 'diff') continue
    has = true
    for (const r of diffLines(c.oldText ?? '', c.newText ?? '')) {
      if (r.type === 'add') add++
      else if (r.type === 'del') del++
    }
  }
  return has ? { add, del } : null
}

function ToolStatus({ status }: { status: string }) {
  if (status === 'completed') return <Check className="acp-tool-status ok" size={13} />
  if (status === 'failed' || status === 'cancelled') return <X className="acp-tool-status err" size={13} />
  return <Loader2 className="acp-tool-status run" size={13} />
}

function ToolCard({ item }: { item: Extract<ThreadItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const hasContent = item.content.some((c) => c.type === 'diff' || textOf(c.content))
  const running = item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled'
  const { Icon } = toolMeta(item.toolKind)
  const title = useMemo(() => displayTitle(item.toolKind, item.title), [item.toolKind, item.title])
  const stat = useMemo(() => diffStat(item.content), [item.content])
  return (
    <div className={`acp-tool${running ? ' running' : ''}${item.status === 'failed' ? ' failed' : ''}`}>
      <button className="acp-tool-head" disabled={!hasContent} onClick={() => setOpen((o) => !o)}>
        <Icon className="acp-tool-icon" size={13} />
        <span className="acp-tool-title" title={item.title}>{title}</span>
        {stat && (
          <span className="acp-tool-stat">
            {stat.add > 0 && <span className="add">+{stat.add}</span>}
            {stat.del > 0 && <span className="del">−{stat.del}</span>}
          </span>
        )}
        <ToolStatus status={item.status} />
        {hasContent && (
          <ChevronRight className="acp-tool-chev" size={13}
            style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .1s' }} />
        )}
      </button>
      {open && hasContent && (
        <div className="acp-tool-body">
          {item.content.map((c: AcpToolContent, i) => {
            if (c.type === 'diff') {
              return (
                <div key={i} className="acp-tool-diff">
                  {c.path && <div className="acp-tool-diff-path">{c.path}</div>}
                  <DiffView oldText={c.oldText ?? ''} newText={c.newText ?? ''} />
                </div>
              )
            }
            const t = textOf(c.content)
            return t ? <ToolOutput key={i} text={t} /> : null
          })}
        </div>
      )}
    </div>
  )
}

// Tool output arrives as markdown-ish text: often a single fenced code block,
// and frequently laced with <system-reminder> control text. Unwrap the fence so
// we don't show literal ``` markers, and dim the reminders so real output leads.
function ToolOutput({ text }: { text: string }) {
  const fence = text.trim().match(/^```([\w+-]*)\n([\s\S]*?)\n?```$/)
  const lang = fence?.[1] || undefined
  const body = fence ? fence[2] : text
  const parts = body.split(/(<system-reminder>[\s\S]*?<\/system-reminder>)/g)
  return (
    <div className="acp-tool-out">
      {lang && <div className="acp-tool-out-head">{lang}</div>}
      <CopyButton getText={() => body} />
      <pre>
        {parts.map((p, i) =>
          p.startsWith('<system-reminder>')
            ? <span key={i} className="acp-tool-reminder">{p}</span>
            : <span key={i}>{p}</span>
        )}
      </pre>
    </div>
  )
}

// Lightweight line-level diff: rows present only in the old text are removals,
// rows only in the new text are additions, matched lines are context.
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  return (
    <pre className="acp-diff">
      {rows.map((r, i) => (
        <div key={i} className={`acp-diff-row ${r.type}`}>
          <span className="acp-diff-gutter">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
          <span>{r.text}</span>
        </div>
      ))}
    </pre>
  )
}

type DiffRow = { type: 'add' | 'del' | 'ctx'; text: string }
function diffLines(oldText: string, newText: string): DiffRow[] {
  if (!oldText) return newText.split('\n').map((text) => ({ type: 'add', text }))
  if (!newText) return oldText.split('\n').map((text) => ({ type: 'del', text }))
  // Longest-common-subsequence over lines, then walk the table into rows.
  const a = oldText.split('\n'), b = newText.split('\n')
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const rows: DiffRow[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ type: 'ctx', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', text: a[i] }); i++ }
    else { rows.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < a.length) rows.push({ type: 'del', text: a[i++] })
  while (j < b.length) rows.push({ type: 'add', text: b[j++] })
  return rows
}

// Reasoning stream, rendered as a collapsible "Thinking" block. The brain
// pulses while this (the latest) thought is still streaming; once it settles we
// show how long it ran. Neither the API, the Agent SDK, nor ACP emits a thinking
// duration, so we derive it from event arrival times (store-stamped `rxAt`) —
// first to last chunk. A thought loaded from history has no rxAt, so no duration.
// A "brain" glyph (VS Code codicon path) used for the Thinking block header —
// reads more clearly as reasoning than the generic sparkle.
function ThinkingIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M3 15C3 15.552 2.552 16 2 16C1.448 16 1 15.552 1 15C1 14.448 1.448 14 2 14C2.552 14 3 14.448 3 15ZM7 13.5C7 14.327 6.327 15 5.5 15C4.673 15 4 14.327 4 13.5C4 12.673 4.673 12 5.5 12C6.327 12 7 12.673 7 13.5ZM6 13.5C6 13.224 5.776 13 5.5 13C5.224 13 5 13.224 5 13.5C5 13.776 5.224 14 5.5 14C5.776 14 6 13.776 6 13.5ZM16 6.24998C16 8.04198 14.43 9.49998 12.5 9.49998C12.468 9.49998 12.437 9.49998 12.405 9.49998C12.037 10.937 10.634 12.001 9 12.001C7.5 12.001 6.179 11.098 5.696 9.82098C5.314 9.93898 4.909 10.001 4.5 10.001C2.57 10.001 1 8.65498 1 7.00098C1 5.46298 2.357 4.19098 4.1 4.02098C4.035 3.76998 4 3.51098 4 3.25098C4 1.45898 5.57 0.000976562 7.5 0.000976562C8.517 0.000976562 9.479 0.411977 10.14 1.11598C10.418 1.03998 10.706 1.00098 11 1.00098C12.487 1.00098 13.723 1.98498 13.959 3.29598C15.192 3.82098 16 4.97198 16 6.24998ZM15 6.24998C15 5.30398 14.334 4.45198 13.344 4.13198C13.145 4.06898 13.007 3.88798 12.998 3.67898C12.955 2.73798 12.077 1.99998 11 1.99998C10.71 1.99998 10.429 2.05398 10.163 2.16098C9.952 2.24498 9.712 2.17898 9.576 1.99698C9.109 1.37298 8.333 0.999977 7.5 0.999977C6.121 0.999977 5 2.00998 5 3.24998C5 3.60798 5.092 3.95098 5.271 4.26898C5.363 4.43098 5.358 4.62998 5.257 4.78698C5.156 4.94398 4.976 5.02698 4.792 5.01498C4.696 5.00598 4.599 5.00098 4.499 5.00098C3.12 5.00098 1.999 5.89798 1.999 7.00098C1.999 8.10398 3.12 9.00098 4.499 9.00098C4.962 9.00098 5.415 8.89698 5.81 8.70198C5.879 8.66798 5.956 8.64998 6.032 8.64998C6.111 8.64998 6.189 8.66898 6.261 8.70598C6.403 8.77898 6.5 8.91498 6.526 9.07198C6.7 10.172 7.763 11.001 9 11.001C10.301 11.001 11.396 10.087 11.492 8.91998C11.503 8.78098 11.571 8.65398 11.68 8.56798C11.789 8.48098 11.933 8.44498 12.065 8.46598C12.207 8.48698 12.351 8.49998 12.5 8.49998C13.879 8.49998 15 7.48998 15 6.24998Z" />
    </svg>
  )
}

function ThoughtBlock({ item, live }: { item: Extract<ThreadItem, { kind: 'thought' }>; live: boolean }) {
  const [open, setOpen] = useState(true)
  const hasText = item.text.trim().length > 0
  const secs = item.startedAt != null && item.endedAt != null
    ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000))
    : null
  const label = live ? 'Thinking…' : secs != null ? `Thought for ${secs}s` : 'Thinking'
  return (
    <div className={`acp-thought${live ? ' live' : ''}`}>
      <button className="acp-thought-head" disabled={!hasText} onClick={() => setOpen((o) => !o)}>
        <ThinkingIcon className="acp-thought-icon" />
        <span className="acp-thought-label">{label}</span>
        {hasText && (
          <ChevronRight className="acp-thought-chev" size={12}
            style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .1s' }} />
        )}
      </button>
      {open && hasText && <div className="acp-thought-body">{item.text}</div>}
    </div>
  )
}

function Dropdown({ label, icon, children, align = 'left' }: { label: React.ReactNode; icon?: React.ReactNode; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="acp-btn" onClick={() => setOpen((o) => !o)}>
        {icon}<span>{label}</span><ChevronDown size={11} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .1s' }} />
      </button>
      {open && <div className={`acp-menu ${align === 'right' ? 'right' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

const MessageList = memo(function MessageList({
  items, working, onAnswerPermission,
}: {
  items: ThreadItem[]
  working: boolean
  onAnswerPermission: (requestId: string, optionId: string | null) => void
}) {
  if (items.length === 0) {
    return (
      <div className="acp-empty">
        <div className="acp-empty-title">Ask Claude anything in this repo</div>
        <div className="acp-empty-sub">Edits, commands, and explanations. Tool calls and permission requests appear inline.</div>
      </div>
    )
  }
  // The final thought only "pulses" while Claude is still working on it.
  let lastThoughtId: string | undefined
  for (const it of items) if (it.kind === 'thought') lastThoughtId = it.id
  // While a thought is actively streaming, "Thinking…" already signals activity
  // — don't also show the standalone "Working…" row (they read as duplicated).
  const last = items[items.length - 1]
  const thinking = working && last?.kind === 'thought' && last.id === lastThoughtId
  return (
    <div className="acp-messages">
      {items.map((item) => {
        let content: React.ReactNode
        switch (item.kind) {
          case 'user':
            content = (
              <div className="acp-user">
                {item.images?.length ? (
                  <div className="acp-user-images">
                    {item.images.map((img, i) => (
                      <img
                        key={i}
                        className="acp-user-image"
                        src={`data:${img.mimeType};base64,${img.data}`}
                        alt="pasted"
                      />
                    ))}
                  </div>
                ) : null}
                {item.text && <div className="acp-user-text">{item.text}</div>}
              </div>
            ); break
          case 'assistant':
            content = <div className="acp-assistant"><Markdown>{item.text}</Markdown></div>; break
          case 'thought':
            content = <ThoughtBlock item={item} live={working && item.id === lastThoughtId} />; break
          case 'tool':
            content = <ToolCard item={item} />; break
          case 'plan':
            content = (
              <div className="acp-plan">
                <div className="acp-plan-title"><ListTodo size={14} /> Plan</div>
                <ul>
                  {item.entries.map((en, i) => (
                    <li key={i}>
                      <span>{en.status === 'completed' ? '✓' : '○'}</span>
                      <span className={en.status === 'completed' ? 'acp-plan-done' : ''}>{en.content}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ); break
          case 'permission':
            content = (
              <div className="acp-permission">
                <div className="acp-permission-title"><ShieldQuestion size={15} /> Permission required</div>
                {item.request.toolCall?.title && <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.75 }}>{item.request.toolCall.title}</div>}
                {item.resolved ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {item.resolved === '__cancelled__' ? 'Cancelled' : `Answered: ${item.request.options.find((o) => o.optionId === item.resolved)?.name ?? item.resolved}`}
                  </div>
                ) : (
                  <div className="acp-perm-actions">
                    {item.request.options.map((opt) => (
                      <button key={opt.optionId} className="acp-btn" style={{ border: '1px solid var(--vscode-sideBar-border)' }} onClick={() => onAnswerPermission(item.requestId, opt.optionId)}>{opt.name}</button>
                    ))}
                    {!item.request.options.some((o) => o.kind === 'reject_once' || o.kind === 'reject_always') && (
                      <button className="acp-btn" onClick={() => onAnswerPermission(item.requestId, null)}>Reject</button>
                    )}
                  </div>
                )}
              </div>
            ); break
          case 'notice':
            content = <div className="acp-notice"><Cpu size={12} /><span>{item.text}</span></div>; break
          case 'interrupted':
            content = <div className="acp-interrupted"><CircleSlash size={11} /><span>Interrupted by user</span></div>; break
          case 'error':
            content = <div className="acp-error"><AlertTriangle size={14} /><span>{item.message}</span></div>; break
        }
        const failed = item.kind === 'tool' && (item.status === 'failed' || item.status === 'cancelled')
        return (
          <div key={item.id} className={`acp-row acp-row-${item.kind}${failed ? ' failed' : ''}`}>
            <span className="acp-row-dot" aria-hidden />
            {content}
          </div>
        )
      })}
      {working && !thinking && (
        <div className="acp-row acp-row-working">
          <span className="acp-row-dot" aria-hidden />
          <div className="acp-working"><span className="acp-working-icon codicon codicon-sparkle" aria-hidden /><span>Working…</span></div>
        </div>
      )}
    </div>
  )
})

function Header({ sid, title, onBeginResume }: { sid: string; title: string; onBeginResume: () => void }) {
  const currentConvId = useAcpStore((s) => s.threads.get(sid)?.acpSessionId ?? null)
  const [open, setOpen] = useState(false)
  const [convs, setConvs] = useState<AcpConversation[] | null>(null)
  const ref = useOutsideClose(open, () => setOpen(false))

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) { setConvs(null); acp().listConversations(sid).then(setConvs) }
  }
  return (
    <div className="acp-header">
      <div className="acp-header-title">{title}</div>
      <div ref={ref} className="acp-header-actions">
        <button className="acp-btn" title="Resume a conversation" onClick={toggle}><Clock size={15} /></button>
        <button className="acp-btn" title="New conversation" onClick={() => acp().newConversation(sid)}><SquarePen size={15} /></button>
        {open && (
          <div className="acp-menu right">
            <div className="acp-menu-label">Resume conversation</div>
            {convs === null && <div className="acp-menu-item">Loading…</div>}
            {convs && convs.length === 0 && <div className="acp-menu-item">No past conversations</div>}
            {convs && convs.map((c) => (
              <button key={c.sessionId} className={`acp-menu-item ${c.sessionId === currentConvId ? 'active' : ''}`}
                onClick={() => { if (c.sessionId !== currentConvId) { onBeginResume(); acp().resumeConversation(sid, c.sessionId) } setOpen(false) }}>
                {c.title || 'Untitled conversation'}
                {c.sessionId === currentConvId && <Check size={12} style={{ marginLeft: 6 }} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** A pasted image staged in the composer, sent as an ACP image block on submit. */
type Attachment = { id: string; mimeType: string; data: string }

// Client-side slash commands, handled locally in runText rather than sent to the
// agent. Merged into the autosuggest so they're discoverable alongside the
// agent's own advertised commands.
const BUILTIN_COMMANDS: AcpCommand[] = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'clear', description: 'Start a new conversation' }
]

export function AcpThread({ sid, visible = true }: { sid: string; visible?: boolean }) {
  const thread = useAcpStore((s) => s.threads.get(sid))
  const setHistory = useAcpStore((s) => s.setHistory)
  const resolvePermissionLocal = useAcpStore((s) => s.resolvePermissionLocal)
  const setModeLocal = useAcpStore((s) => s.setModeLocal)
  const setModelLocal = useAcpStore((s) => s.setModelLocal)
  // Transport health for this session's host only — other hosts may be fine.
  const host = useSessionsStore((s) => s.sessions.find((x) => x.id === sid)?.host ?? null)
  // Claude-generated session title shown in the thread header (the tab reads a
  // fixed "Claude Code" label instead).
  const sessionName = useSessionsStore((s) => s.sessions.find((x) => x.id === sid)?.name ?? null)
  const engineStatus = useSessionsStore((s) => s.engineStatus[host ? `ssh:${host}` : 'local']) ?? 'connected'
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [focused, setFocused] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdHighlight, setCmdHighlight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)
  const attachSeq = useRef(0)
  const recentCommands = useCommandHistory((s) => s.recent)
  const recordCommand = useCommandHistory((s) => s.record)

  // Attach on mount: begin event forwarding (main side) and load the snapshot.
  useEffect(() => {
    let cancelled = false
    acp().attach(sid).then((snap) => { if (!cancelled && snap) setHistory(sid, snap) })
    return () => { cancelled = true; acp().detach(sid) }
  }, [sid, setHistory])

  const items = useMemo(() => buildThread(thread?.events ?? []), [thread?.events])
  const recap = useMemo(() => recapOf(thread?.events ?? []), [thread?.events])
  const working = thread?.claudeStatus === 'working'
  const waiting = thread?.claudeStatus === 'waiting'
  const modeState = thread?.modeState ?? null
  const modelState = thread?.modelState ?? null
  const model = modelLabel(thread?.model)
  // Built-ins first, then the agent's advertised commands (deduped by name).
  const commands = useMemo(() => {
    const seen = new Set(BUILTIN_COMMANDS.map((c) => c.name))
    return [...BUILTIN_COMMANDS, ...(thread?.availableCommands ?? []).filter((c) => !seen.has(c.name))]
  }, [thread?.availableCommands])

  // Slash-command autosuggest: active only while typing the command token — a
  // leading "/" with no space yet. Recently used commands rank first, the rest
  // alphabetically. Matched on the text after the slash.
  const cmdQuery = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase() ?? null
  const cmdSuggestions = useMemo(() => {
    if (cmdQuery == null || commands.length === 0) return []
    const rank = (name: string) => {
      const i = recentCommands.indexOf(name)
      return i === -1 ? recentCommands.length + 1 : i
    }
    return commands
      .filter((c) => c.name.toLowerCase().includes(cmdQuery))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [cmdQuery, commands, recentCommands])
  const showCmd = cmdOpen && cmdQuery != null && cmdSuggestions.length > 0

  // Auto-scroll while parked at the bottom.
  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items.length, working])

  useEffect(() => { if (visible) taRef.current?.focus() }, [visible])

  // Resume loading overlay: cover the thread while a resumed/reconnected
  // conversation's history streams in, so the user never watches it grow.
  const beginResume = () => { stickRef.current = true; setResuming(true) }
  useEffect(() => {
    if (thread?.historyLoading) setResuming(true)
  }, [thread?.historyLoading, thread?.historyEpoch])
  useEffect(() => {
    if (!resuming) return
    // Lift the overlay once the thread has been quiet for a short beat; a hard
    // cap guards against an empty/failed resume that never streams anything.
    const settle = setTimeout(() => setResuming(false), 500)
    const cap = setTimeout(() => setResuming(false), 12000)
    return () => { clearTimeout(settle); clearTimeout(cap) }
  }, [resuming, items.length])

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // Pasted images become inline attachments (base64 ACP image blocks), sent
  // alongside the text on the next prompt. Non-image clipboard content pastes
  // as usual (the default text paste is left untouched).
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith('image/'))
    if (!images.length) return
    e.preventDefault()
    for (const it of images) {
      const file = it.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        const res = String(reader.result)
        const data = res.slice(res.indexOf(',') + 1) // strip the "data:...;base64," prefix
        if (data) {
          setAttachments((prev) => [
            ...prev,
            { id: `att${attachSeq.current++}`, mimeType: file.type || 'image/png', data }
          ])
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const runText = (raw: string) => {
    const text = raw.trim()
    if (!text && attachments.length === 0) return
    // Slash shortcuts only apply to a bare text command (no attachments).
    if (!attachments.length && (text === '/new' || text === '/clear')) {
      acp().newConversation(sid); setDraft(''); setCmdOpen(false); return
    }
    // Remember the command so it ranks first in the autosuggest next time.
    if (text.startsWith('/')) recordCommand(text.slice(1).split(/\s+/)[0])
    const blocks = [
      ...attachments.map((a) => ({ type: 'image', mimeType: a.mimeType, data: a.data })),
      ...(text ? [{ type: 'text', text }] : [])
    ]
    acp().prompt(sid, blocks)
    setDraft('')
    setAttachments([])
    setCmdOpen(false)
    stickRef.current = true
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = 'auto' })
  }
  const send = () => runText(draft)

  // Choose a command from the autosuggest: commands taking input get filled in
  // for the user to complete; argument-less commands run immediately.
  const applyCommand = (c: AcpCommand) => {
    setCmdOpen(false)
    if (c.input) {
      setDraft(`/${c.name} `)
      requestAnimationFrame(() => taRef.current?.focus())
    } else {
      runText(`/${c.name}`)
    }
  }

  const answerPermission = useCallback((requestId: string, optionId: string | null) => {
    acp().permissionResponse(sid, requestId, optionId)
    resolvePermissionLocal(sid, requestId, optionId)
  }, [sid, resolvePermissionLocal])

  const selectMode = (id: string) => { acp().setMode(sid, id); setModeLocal(sid, id) }
  const selectModel = (id: string) => { acp().setModel(sid, id); setModelLocal(sid, id) }

  return (
    <div className="acp-thread" style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}>
      <Header sid={sid} title={sessionName || recap || 'New conversation'} onBeginResume={beginResume} />

      {engineStatus !== 'connected' && (
        <div className="acp-banner">
          {engineStatus === 'lost' ? 'Connection lost.' : 'Connection lost — reconnecting…'}
        </div>
      )}

      <div className="acp-body">
        <div ref={scrollRef} className="acp-scroll" onScroll={onScroll}>
          <MessageList items={items} working={working} onAnswerPermission={answerPermission} />
        </div>
        {resuming && (
          <div className="acp-overlay">
            <span className="acp-spinner" />
          </div>
        )}
      </div>

      <div className="acp-composer">
        <div className="acp-composer-inner">
          {waiting && <div className="acp-waiting"><ShieldQuestion size={12} /> Claude is waiting for your permission above.</div>}
          {showCmd && (
            <ul className="acp-cmd-suggest" role="listbox">
              {cmdSuggestions.map((c, i) => (
                <li
                  key={c.name}
                  role="option"
                  aria-selected={i === cmdHighlight}
                  className={`acp-cmd-item ${i === cmdHighlight ? 'active' : ''}`}
                  // mouseDown fires before the textarea blur, so the click registers.
                  onMouseDown={(e) => { e.preventDefault(); applyCommand(c) }}
                  onMouseEnter={() => setCmdHighlight(i)}
                >
                  <span className="acp-cmd-name">/{c.name}</span>
                  {c.description && <span className="acp-cmd-desc">{c.description}</span>}
                  {recentCommands.includes(c.name) && <Clock className="acp-cmd-recent" size={11} />}
                </li>
              ))}
            </ul>
          )}
          <div className={`acp-input-box ${focused ? 'focused' : ''}`}>
            {attachments.length > 0 && (
              <div className="acp-attachments">
                {attachments.map((a) => (
                  <div key={a.id} className="acp-attachment">
                    <img src={`data:${a.mimeType};base64,${a.data}`} alt="attachment" />
                    <button
                      className="acp-attachment-remove"
                      title="Remove image"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              placeholder="Reply to Claude…"
              onFocus={() => setFocused(true)}
              onBlur={() => { setFocused(false); setCmdOpen(false) }}
              onPaste={onPaste}
              onChange={(e) => { setDraft(e.target.value); autoGrow(e.target); setCmdOpen(true); setCmdHighlight(0) }}
              onKeyDown={(e) => {
                if (showCmd) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdHighlight((h) => (h + 1) % cmdSuggestions.length); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setCmdHighlight((h) => (h - 1 + cmdSuggestions.length) % cmdSuggestions.length); return }
                  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyCommand(cmdSuggestions[Math.min(cmdHighlight, cmdSuggestions.length - 1)]); return }
                  if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); return }
                }
                if (e.key === 'Escape' && working) { e.preventDefault(); acp().cancel(sid); return }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
            />
            <div className="acp-input-row">
              {modeState && (
                <Dropdown label={modeState.availableModes.find((m) => m.id === modeState.currentModeId)?.name ?? modeState.currentModeId} icon={<Zap size={13} />}>
                  {(close) => <ModeMenu modeState={modeState} onSelect={(id) => { selectMode(id); close() }} />}
                </Dropdown>
              )}
              {modelState && modelState.availableModels.length > 0 ? (
                <Dropdown label={modelState.availableModels.find((m) => m.id === modelState.currentModelId)?.name ?? model ?? 'Model'} icon={<Cpu size={12} />}>
                  {(close) => <ModelMenu modelState={modelState} onSelect={(id) => { selectModel(id); close() }} />}
                </Dropdown>
              ) : (model && <span className="acp-pill"><Cpu size={12} /> {model}</span>)}
              <span className="acp-input-spacer" />
              {working ? (
                <button className="acp-send" title="Stop" onClick={() => acp().cancel(sid)}><Square size={14} /></button>
              ) : (
                <button className="acp-send" title="Send" disabled={!draft.trim() && attachments.length === 0} onClick={send}><ArrowUp size={16} /></button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModeMenu({ modeState, onSelect }: { modeState: AcpModeState; onSelect: (id: string) => void }) {
  return (
    <>
      <div className="acp-menu-label">Permission mode</div>
      {modeState.availableModes.map((m) => (
        <button key={m.id} className={`acp-menu-item ${m.id === modeState.currentModeId ? 'active' : ''}`} onClick={() => onSelect(m.id)}>
          {m.name}{m.id === modeState.currentModeId && <Check size={12} style={{ marginLeft: 6 }} />}
          {m.description && <div className="acp-menu-desc">{m.description}</div>}
        </button>
      ))}
    </>
  )
}

function ModelMenu({ modelState, onSelect }: { modelState: AcpModelState; onSelect: (id: string) => void }) {
  return (
    <>
      <div className="acp-menu-label">Model</div>
      {modelState.availableModels.map((m) => (
        <button key={m.id} className={`acp-menu-item ${m.id === modelState.currentModelId ? 'active' : ''}`} onClick={() => onSelect(m.id)}>
          {m.name}{m.id === modelState.currentModelId && <Check size={12} style={{ marginLeft: 6 }} />}
          {m.description && <div className="acp-menu-desc">{m.description}</div>}
        </button>
      ))}
    </>
  )
}
