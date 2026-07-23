import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, BrainCircuit, Check, ChevronDown, ChevronRight, CircleHelp, CircleSlash,
  Clock, Copy, Cpu, FileText, FolderTree, Gauge, Globe, ListTodo, Loader2, Mail, MailOpen, Pencil, Search,
  ShieldQuestion, SquarePen, Square, Terminal, Trash2, Wrench, X, ArrowUp, Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AcpConversation } from '../../../shared/acp'
import { useAcpStore } from '../acp/store'
import { useSessionsStore } from '../acp/sessions-store'
import { useViewPrefsStore } from '../view-prefs-store'
import { buildThread, modelLabel, recapOf, textOf, type ThreadItem } from '../acp/buildThread'
import type {
  AcpCommand, AcpEffortState, AcpElicitationRequest, AcpElicitationResponse, AcpElicitationValue,
  AcpEnumOption, AcpModeState, AcpModelState, AcpToolContent
} from '../acp/protocol'
import { ASK_OPTION_META_KEY } from '../acp/protocol'
import { useCommandHistory } from '../acp/command-history'
import { useDrafts } from '../acp/drafts-store'
import { fileTabId, useTabsStore } from '../tabs-store'
import type { ProjectInfo } from '../../../shared/types'
import { SessionLinksButton } from './SessionLinksButton'
import './AcpThread.css'

const acp = () => window.studio.acp

const fileBaseName = (p: string): string => p.split('/').pop() || p

// Collapse "." and ".." segments in a posix path, keeping it absolute.
function normalizePosix(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Carries everything the assistant markdown needs to turn a file path it
// mentions into an openable editor tab: the set of the project's files (relative
// to root, so only real files linkify), the project root, the session cwd
// (relative paths are resolved against it), and the opener.
type FileMatch = { rel: string; abs: string }
type FileRefCtx = {
  /** Resolve a raw path token to a project file, or null. */
  match: ((token: string) => FileMatch | null) | null
  open: (absPath: string) => void
}
const FileRefContext = createContext<FileRefCtx | null>(null)

// Build a resolver from the project's file index: maps a raw path token to the
// project file it names, or null. Accepts a path relative to the session cwd,
// relative to the project root, an absolute path under root, or an unambiguous
// basename; a trailing :line[:col] reference is stripped. Returns null unless it
// names a real project file, so prose like `arr.length` or a URL never matches.
function makeMatcher(
  files: Set<string> | null,
  root: string | null,
  cwd: string | null
): ((token: string) => FileMatch | null) | null {
  if (!files || !root) return null
  const r = root.replace(/\/+$/, '')
  // basename → rel, but only where a basename names exactly one file (null marks
  // an ambiguous basename, so it never resolves to an arbitrary match).
  const byBase = new Map<string, string | null>()
  for (const rel of files) {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    byBase.set(base, byBase.has(base) ? null : rel)
  }
  const hit = (rel: string): FileMatch | null => (files.has(rel) ? { rel, abs: `${r}/${rel}` } : null)
  const under = (abs: string): FileMatch | null =>
    abs.startsWith(r + '/') ? hit(abs.slice(r.length + 1)) : null
  return (token: string) => {
    const p = token.replace(/:\d+(?::\d+)?$/, '') // drop a trailing line[:col] ref
    if (!p) return null
    if (p.startsWith('/')) return under(normalizePosix(p))
    if (cwd) { const m = under(normalizePosix(`${cwd}/${p}`)); if (m) return m }
    const m = under(normalizePosix(`${r}/${p}`))
    if (m) return m
    if (!p.includes('/')) { const rel = byBase.get(p); if (rel) return hit(rel) }
    return null
  }
}

// hast node builder for a matched file path — a clickable inline <code>.
function fileRefNode(text: string, m: FileMatch): unknown {
  return {
    type: 'element',
    tagName: 'code',
    properties: { className: ['acp-fileref'], 'data-abs': m.abs, title: `Open ${m.rel}` },
    children: [{ type: 'text', value: text }]
  }
}

// rehype plugin: scan text (prose and inline code alike) for tokens that name a
// project file and turn them into clickable <code class="acp-fileref"> nodes.
// Fenced code (under <pre>) and link text (<a>) are left untouched.
function rehypeFileRefs(match: (t: string) => FileMatch | null) {
  const PATH_RE = /[A-Za-z0-9_@+.~/-]+/g
  const TRAILING = /[).,;:'"`\]}!?]+$/
  // Split a text value into text + file-ref nodes, or null if nothing matched.
  const splitText = (value: string): unknown[] | null => {
    const out: unknown[] = []
    let last = 0
    let changed = false
    let m: RegExpExecArray | null
    PATH_RE.lastIndex = 0
    while ((m = PATH_RE.exec(value))) {
      const raw = m[0]
      const core = raw.replace(TRAILING, '') // strip prose punctuation for display
      if (!core || (!core.includes('/') && !/\.[A-Za-z0-9]+$/.test(core))) continue
      const hit = match(core)
      if (!hit) continue
      changed = true
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
      out.push(fileRefNode(core, hit))
      last = m.index + core.length
    }
    if (!changed) return null
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
    return out
  }
  const annotateCode = (node: any) => {
    const text = (node.children ?? []).map((c: any) => (c.type === 'text' ? c.value : '')).join('')
    const hit = match(text.trim())
    if (!hit) return
    const props = (node.properties = node.properties || {})
    const cn = props.className
    props.className = Array.isArray(cn) ? [...cn, 'acp-fileref'] : ['acp-fileref']
    props['data-abs'] = hit.abs
    props.title = `Open ${hit.rel}`
  }
  const visit = (node: any) => {
    if (!node || !Array.isArray(node.children)) return
    const next: any[] = []
    for (const child of node.children) {
      if (child.type === 'text') {
        const parts = splitText(child.value)
        next.push(...(parts ?? [child]))
      } else if (child.type === 'element' && child.tagName === 'code') {
        annotateCode(child) // inline code (block code lives under <pre>, skipped below)
        next.push(child)
      } else if (child.type === 'element' && (child.tagName === 'pre' || child.tagName === 'a')) {
        next.push(child) // leave fenced code and existing links alone
      } else {
        visit(child)
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: unknown) => visit(tree)
}

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

// Flatten a code element's children to text (react-markdown passes a string or
// an array of strings for a <code>'s content).
function childrenText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children) && children.every((c) => typeof c === 'string')) return children.join('')
  return ''
}

// A <code> the rehype plugin tagged as a project file (class "acp-fileref", plus
// a data-abs hint) renders as a one-click "open in editor" affordance; all other
// code is verbatim. The absolute path comes from data-abs, or is re-resolved from
// the token text as a fallback if that attribute didn't survive rendering.
function CodeText({ className, children, node: _node, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  const ctx = useContext(FileRefContext)
  const rest = props as Record<string, unknown>
  const isRef = (className ?? '').split(/\s+/).includes('acp-fileref')
  const abs = isRef && ctx ? ((rest['data-abs'] as string | undefined) ?? ctx.match?.(childrenText(children))?.abs) : undefined
  if (!abs || !ctx) return <code className={className} {...props}>{children}</code>
  const { ['data-abs']: _abs, ...domProps } = rest
  return (
    <code
      className={className}
      role="link"
      tabIndex={0}
      {...domProps}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); ctx.open(abs) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.open(abs) } }}
    >
      {children}
    </code>
  )
}

const Markdown = memo(function Markdown({ children }: { children: string }) {
  const ctx = useContext(FileRefContext)
  // Rebuilt only when the matcher changes (ctx is stable while streaming).
  const rehypePlugins = useMemo(() => {
    const match = ctx?.match ?? null
    const plugins: [typeof rehypeFileRefs, typeof match][] = match ? [[rehypeFileRefs, match]] : []
    return plugins
  }, [ctx])
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={{ pre: CodeBlock, code: CodeText }}>
      {children}
    </ReactMarkdown>
  )
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

// Secondary text for an AskUserQuestion option, from the adapter's _meta (which
// carries the structured description that EnumOption itself has no slot for).
function optionDescription(o: AcpEnumOption): string | undefined {
  const meta = o._meta?.[ASK_OPTION_META_KEY] as { description?: string } | undefined
  if (meta?.description) return meta.description
  // Fallback: the flattened "label — description" title, minus the label.
  if (o.title && o.title.startsWith(`${o.const} — `)) return o.title.slice(o.const.length + 3)
  return undefined
}

// Renders an ACP form elicitation (AskUserQuestion / MCP elicitation) with its
// own local answer state. Each `question_<n>` property becomes a radio group
// (single-select `oneOf`) or checkbox group (multi-select array `anyOf`); other
// string properties — including the per-question "Other" box — become text
// inputs. Submit returns an `accept` with the collected content; Skip declines
// (the model is told the user skipped, without aborting the turn).
function ElicitationForm({ request, onSubmit, onSkip }: {
  request: AcpElicitationRequest
  onSubmit: (content: Record<string, AcpElicitationValue>) => void
  onSkip: () => void
}) {
  const props = request.requestedSchema?.properties ?? {}
  const keys = Object.keys(props)
  const [values, setValues] = useState<Record<string, AcpElicitationValue>>({})
  const set = (k: string, v: AcpElicitationValue) => setValues((p) => ({ ...p, [k]: v }))
  // Toggle a multi-select label deriving from the latest state (not a
  // render-captured array), so rapid toggles can't clobber each other.
  const toggle = (k: string, label: string) => setValues((p) => {
    const arr = Array.isArray(p[k]) ? (p[k] as string[]) : []
    return { ...p, [k]: arr.includes(label) ? arr.filter((x) => x !== label) : [...arr, label] }
  })
  return (
    <div className="acp-elicit-form">
      {keys.map((k) => {
        const f = props[k]
        const single = Array.isArray(f.oneOf)
        const multi = f.type === 'array' && Array.isArray(f.items?.anyOf)
        const opts: AcpEnumOption[] = single ? f.oneOf! : multi ? f.items!.anyOf! : []
        const picked = Array.isArray(values[k]) ? (values[k] as string[]) : []
        return (
          <div key={k} className="acp-elicit-field">
            {f.title && <div className="acp-elicit-field-title">{f.title}</div>}
            {f.description && <div className="acp-elicit-field-desc">{f.description}</div>}
            {single && opts.map((o) => (
              <label key={o.const} className="acp-elicit-opt">
                <input type="radio" name={k} checked={values[k] === o.const} onChange={() => set(k, o.const)} />
                <span>{o.const}{optionDescription(o) && <span className="acp-elicit-opt-desc"> — {optionDescription(o)}</span>}</span>
              </label>
            ))}
            {multi && opts.map((o) => {
              const checked = picked.includes(o.const)
              return (
                <label key={o.const} className="acp-elicit-opt">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(k, o.const)}
                  />
                  <span>{o.const}{optionDescription(o) && <span className="acp-elicit-opt-desc"> — {optionDescription(o)}</span>}</span>
                </label>
              )
            })}
            {!single && !multi && (
              <input
                className="acp-elicit-text"
                type="text"
                value={(values[k] as string) ?? ''}
                placeholder={f.title || f.description || ''}
                onChange={(e) => set(k, e.target.value)}
              />
            )}
          </div>
        )
      })}
      <div className="acp-perm-actions">
        <button className="acp-btn" style={{ border: '1px solid var(--vscode-sideBar-border)' }} onClick={() => onSubmit(values)}>Submit</button>
        <button className="acp-btn" onClick={onSkip}>Skip</button>
      </div>
    </div>
  )
}

const MessageList = memo(function MessageList({
  items, working, onAnswerPermission, onAnswerElicitation,
}: {
  items: ThreadItem[]
  working: boolean
  onAnswerPermission: (requestId: string, optionId: string | null) => void
  onAnswerElicitation: (requestId: string, response: AcpElicitationResponse) => void
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
          case 'elicitation':
            content = (
              <div className="acp-permission">
                <div className="acp-permission-title"><CircleHelp size={15} /> Question</div>
                {item.request.message && <div className="acp-elicit-message">{item.request.message}</div>}
                {item.resolved ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {item.resolved.action === 'accept' ? 'Answered' : item.resolved.action === 'decline' ? 'Skipped' : 'Cancelled'}
                  </div>
                ) : (
                  <ElicitationForm
                    request={item.request}
                    onSubmit={(content) => onAnswerElicitation(item.requestId, { action: 'accept', content })}
                    onSkip={() => onAnswerElicitation(item.requestId, { action: 'decline' })}
                  />
                )}
              </div>
            ); break
          case 'notice':
            content = <div className="acp-notice">{item.notice === 'effort' ? <Gauge size={12} /> : <Cpu size={12} />}<span>{item.text}</span></div>; break
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

export function AcpThread({ sid, workspace = null, visible = true }: { sid: string; workspace?: ProjectInfo | null; visible?: boolean }) {
  const thread = useAcpStore((s) => s.threads.get(sid))
  const setHistory = useAcpStore((s) => s.setHistory)
  const resolvePermissionLocal = useAcpStore((s) => s.resolvePermissionLocal)
  const resolveElicitationLocal = useAcpStore((s) => s.resolveElicitationLocal)
  const setModeLocal = useAcpStore((s) => s.setModeLocal)
  const setModelLocal = useAcpStore((s) => s.setModelLocal)
  const setEffortLocal = useAcpStore((s) => s.setEffortLocal)
  // Transport health for this session's host only — other hosts may be fine.
  const host = useSessionsStore((s) => s.sessions.find((x) => x.id === sid)?.host ?? null)
  // Claude-generated session title shown in the thread header (the tab reads a
  // fixed "Claude Code" label instead).
  const sessionName = useSessionsStore((s) => s.sessions.find((x) => x.id === sid)?.name ?? null)
  const engineStatus = useSessionsStore((s) => s.engineStatus[host ? `ssh:${host}` : 'local']) ?? 'connected'
  // Manual "follow up later" flag, mirrored from the sidebar's context menu.
  const unread = useViewPrefsStore((s) => !!s.unreadSessions[sid])
  const toggleUnread = useViewPrefsStore((s) => s.toggleUnread)
  // Workspace of this session's chat tab — used to anchor in-app browser tabs
  // opened from the links popover.
  const wsId = useTabsStore((s) => s.tabs.find((t) => t.kind === 'chat' && t.sid === sid)?.wsId ?? null)
  // The session's working directory — file paths the assistant mentions relative
  // to it are resolved against this to open them in the editor.
  const cwd = useSessionsStore((s) => s.sessions.find((x) => x.id === sid)?.cwd ?? null)
  // Draft lives in a per-session store, not local state: the composer remounts on
  // every session switch (its tab key changes), so keeping it here would drop
  // whatever was typed. Reading from the store restores it when switching back.
  const draft = useDrafts((s) => s.drafts[sid] ?? '')
  const setSessionDraft = useDrafts((s) => s.set)
  const setDraft = useCallback((text: string) => setSessionDraft(sid, text), [setSessionDraft, sid])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [focused, setFocused] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdHighlight, setCmdHighlight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)
  const attachSeq = useRef(0)
  // Prompt-history navigation (up/down arrows). navPos counts steps back from the
  // live draft: 0 = the draft the user is typing, 1 = the most recent sent prompt,
  // etc. draftStash preserves the in-progress draft so arrowing back down past the
  // newest entry restores it.
  const navPos = useRef(0)
  const draftStash = useRef('')
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
  // Sent prompts this session, oldest first — the source for up/down history
  // navigation. Skips system-injected messages (angle-bracket prefixed) so only
  // things the user actually typed can be recalled.
  const promptHistory = useMemo(() => {
    const out: string[] = []
    for (const it of items) {
      if (it.kind !== 'user') continue
      const t = it.text.trim()
      if (t && !t.startsWith('<')) out.push(t)
    }
    return out
  }, [items])
  const working = thread?.claudeStatus === 'working'
  const waiting = thread?.claudeStatus === 'waiting'
  const modeState = thread?.modeState ?? null
  const modelState = thread?.modelState ?? null
  const model = modelLabel(thread?.model)
  // Effort levels are only offered for models that support them; null hides the picker.
  const effortState = thread?.effortState ?? null
  // Context-window occupancy from the latest usage_update (see acp store).
  const usage = thread?.usage ?? null
  const contextPct =
    usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null
  // Built-ins first, then the agent's advertised commands (deduped by name).
  const commands = useMemo(() => {
    const seen = new Set(BUILTIN_COMMANDS.map((c) => c.name))
    return [...BUILTIN_COMMANDS, ...(thread?.availableCommands ?? []).filter((c) => !seen.has(c.name))]
  }, [thread?.availableCommands])

  // Project file index (paths relative to the workspace root), loaded lazily so
  // the assistant's file mentions can be matched to real files and turned into
  // one-click "open in editor" links. Reloaded when the workspace changes.
  const wsRoot = workspace?.rootPath ?? null
  const [projectFiles, setProjectFiles] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!workspace) { setProjectFiles(null); return }
    let cancelled = false
    window.studio.listFiles(workspace.id).then((res) => {
      if (!cancelled) setProjectFiles(res.ok ? new Set(res.data) : null)
    }).catch(() => { if (!cancelled) setProjectFiles(null) })
    return () => { cancelled = true }
  }, [workspace?.id])

  // Open a project file the assistant mentioned in the editor, in this session's
  // group, as a transient preview tab (VS Code style — a single click reuses it).
  const openProjectFile = useCallback((absPath: string) => {
    if (!workspace) return
    useTabsStore.getState().open(
      {
        id: fileTabId(sid, workspace.id, absPath),
        kind: 'file',
        title: fileBaseName(absPath),
        path: absPath,
        name: fileBaseName(absPath),
        wsId: workspace.id,
        ownerSid: sid
      },
      { preview: true }
    )
  }, [workspace?.id, sid])

  const fileCtx = useMemo<FileRefCtx>(
    () => ({ match: makeMatcher(projectFiles, wsRoot, cwd), open: openProjectFile }),
    [projectFiles, wsRoot, cwd, openProjectFile]
  )

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

  // A collapsed caret sitting on the first/last visual line — the boundary at
  // which an arrow key steps into prompt history instead of moving within the
  // textarea, so multi-line drafts stay navigable.
  const caretOnFirstLine = (el: HTMLTextAreaElement) =>
    el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n')
  const caretOnLastLine = (el: HTMLTextAreaElement) =>
    el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes('\n')

  // Step through sent prompts: dir 1 = older, dir -1 = newer. Returns true when
  // the key was consumed (so the caller preventDefaults); false lets the arrow
  // fall through to normal caret movement. On the way up, the live draft is
  // stashed and restored when you arrow back down past the newest entry.
  const recallHistory = (dir: 1 | -1): boolean => {
    const hist = promptHistory
    if (hist.length === 0) return false
    let pos = navPos.current
    if (dir === 1) {
      if (pos >= hist.length) return true // already at the oldest — swallow the key
      if (pos === 0) draftStash.current = draft
      pos += 1
    } else {
      if (pos === 0) return false // already live — let the caret move down
      pos -= 1
    }
    navPos.current = pos
    const text = pos === 0 ? draftStash.current : hist[hist.length - pos]
    setDraft(text)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      autoGrow(el)
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return true
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
    // Sending a prompt means you've followed up — drop any "unread" flag.
    if (unread) toggleUnread(sid)
    setDraft('')
    setAttachments([])
    setCmdOpen(false)
    navPos.current = 0
    draftStash.current = ''
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

  // Tab completes the command text without submitting, so the user can add
  // arguments and send it themselves. A trailing space is left for typing.
  const completeCommand = (c: AcpCommand) => {
    setCmdOpen(false)
    setDraft(`/${c.name} `)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const answerPermission = useCallback((requestId: string, optionId: string | null) => {
    acp().permissionResponse(sid, requestId, optionId)
    resolvePermissionLocal(sid, requestId, optionId)
  }, [sid, resolvePermissionLocal])
  const answerElicitation = useCallback((requestId: string, response: AcpElicitationResponse) => {
    acp().elicitationResponse(sid, requestId, response)
    resolveElicitationLocal(sid, requestId, response)
  }, [sid, resolveElicitationLocal])

  const selectMode = (id: string) => { acp().setMode(sid, id); setModeLocal(sid, id) }
  const selectModel = (id: string) => { acp().setModel(sid, id); setModelLocal(sid, id) }
  const selectEffort = (id: string) => { acp().setEffort(sid, id); setEffortLocal(sid, id) }

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
          <FileRefContext.Provider value={fileCtx}>
            <MessageList items={items} working={working} onAnswerPermission={answerPermission} onAnswerElicitation={answerElicitation} />
          </FileRefContext.Provider>
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
              onChange={(e) => { navPos.current = 0; setDraft(e.target.value); autoGrow(e.target); setCmdOpen(true); setCmdHighlight(0) }}
              onKeyDown={(e) => {
                if (showCmd) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdHighlight((h) => (h + 1) % cmdSuggestions.length); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setCmdHighlight((h) => (h - 1 + cmdSuggestions.length) % cmdSuggestions.length); return }
                  if (e.key === 'Enter') { e.preventDefault(); applyCommand(cmdSuggestions[Math.min(cmdHighlight, cmdSuggestions.length - 1)]); return }
                  if (e.key === 'Tab') { e.preventDefault(); completeCommand(cmdSuggestions[Math.min(cmdHighlight, cmdSuggestions.length - 1)]); return }
                  if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); return }
                }
                // Arrow up/down recall previously sent prompts to edit and resend,
                // but only from the first/last line so multi-line editing still works.
                if (e.key === 'ArrowUp' && caretOnFirstLine(e.currentTarget) && recallHistory(1)) { e.preventDefault(); return }
                if (e.key === 'ArrowDown' && caretOnLastLine(e.currentTarget) && recallHistory(-1)) { e.preventDefault(); return }
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
              {effortState && effortState.availableEfforts.length > 0 && (
                <Dropdown label={effortState.availableEfforts.find((e) => e.id === effortState.currentEffortId)?.name ?? 'Effort'} icon={<Gauge size={12} />}>
                  {(close) => <EffortMenu effortState={effortState} onSelect={(id) => { selectEffort(id); close() }} />}
                </Dropdown>
              )}
              {contextPct != null && (
                <span
                  className={`acp-context${contextPct >= 90 ? ' danger' : contextPct >= 75 ? ' warn' : ''}`}
                  title="Context window used"
                >
                  {contextPct}% context
                </span>
              )}
              <span className="acp-input-sep" />
              <SessionLinksButton sid={sid} wsId={workspace?.id ?? wsId} />
              <button
                className={`acp-btn acp-unread-toggle ${unread ? 'active' : ''}`}
                title={unread ? 'Marked unread — click to mark read' : 'Mark as unread to follow up later'}
                onClick={() => toggleUnread(sid)}
              >
                {unread ? <Mail size={14} /> : <MailOpen size={14} />}
              </button>
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

function EffortMenu({ effortState, onSelect }: { effortState: AcpEffortState; onSelect: (id: string) => void }) {
  return (
    <>
      <div className="acp-menu-label">Thinking effort</div>
      {effortState.availableEfforts.map((e) => (
        <button key={e.id} className={`acp-menu-item ${e.id === effortState.currentEffortId ? 'active' : ''}`} onClick={() => onSelect(e.id)}>
          {e.name}{e.id === effortState.currentEffortId && <Check size={12} style={{ marginLeft: 6 }} />}
          {e.description && <div className="acp-menu-desc">{e.description}</div>}
        </button>
      ))}
    </>
  )
}
