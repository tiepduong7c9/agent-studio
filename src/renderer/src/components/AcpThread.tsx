import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, BrainCircuit, Check, ChevronDown, ChevronRight, CircleSlash,
  Clock, Cpu, ListTodo, ShieldQuestion, SquarePen, Square, Wrench, ArrowUp, Zap
} from 'lucide-react'
import type { AcpConversation } from '../../../shared/acp'
import { useAcpStore } from '../acp/store'
import { useSessionsStore } from '../acp/sessions-store'
import { buildThread, modelLabel, recapOf, textOf, type ThreadItem } from '../acp/buildThread'
import type { AcpModeState, AcpModelState, AcpToolContent } from '../acp/protocol'
import './AcpThread.css'

const acp = () => window.studio.acp

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
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

function ToolCard({ item }: { item: Extract<ThreadItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const hasContent = item.content.some((c) => c.type === 'diff' || textOf(c.content))
  const statusColor = item.status === 'completed' ? 'var(--vscode-testing-iconPassed,#388a34)'
    : item.status === 'failed' || item.status === 'cancelled' ? 'var(--vscode-errorForeground,#f14c4c)'
    : 'var(--vscode-charts-yellow,#cca700)'
  return (
    <div className="acp-tool">
      <button className="acp-tool-head" onClick={() => hasContent && setOpen((o) => !o)}>
        {hasContent ? <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .1s' }} /> : <span style={{ width: 12 }} />}
        <Wrench size={12} />
        <span className="acp-tool-title">{item.title}</span>
        <span className="acp-tool-status" style={{ color: statusColor }}>{item.status}</span>
      </button>
      {open && hasContent && (
        <div className="acp-tool-body">
          {item.content.map((c: AcpToolContent, i) => {
            if (c.type === 'diff') return <pre key={i}>{c.path ? `${c.path}\n` : ''}{c.newText ?? ''}</pre>
            const t = textOf(c.content)
            return t ? <pre key={i}>{t}</pre> : null
          })}
        </div>
      )}
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
  return (
    <div className="acp-messages">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return <div key={item.id} className="acp-user">{item.text}</div>
          case 'assistant':
            return <div key={item.id} className="acp-assistant"><Markdown>{item.text}</Markdown></div>
          case 'thought':
            return <div key={item.id} className="acp-thought"><BrainCircuit size={13} /><span>{item.text}</span></div>
          case 'tool':
            return <ToolCard key={item.id} item={item} />
          case 'plan':
            return (
              <div key={item.id} className="acp-plan">
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
            )
          case 'permission':
            return (
              <div key={item.id} className="acp-permission">
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
            )
          case 'notice':
            return <div key={item.id} className="acp-notice"><Cpu size={12} /><span>{item.text}</span></div>
          case 'interrupted':
            return <div key={item.id} className="acp-interrupted"><CircleSlash size={11} /><span>Interrupted by user</span></div>
          case 'error':
            return <div key={item.id} className="acp-error"><AlertTriangle size={14} /><span>{item.message}</span></div>
        }
      })}
      {working && <div className="acp-working"><span>working…</span></div>}
    </div>
  )
})

function Header({ sid, recap, onBeginResume }: { sid: string; recap: string | null; onBeginResume: () => void }) {
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
      <div className="acp-header-title">{recap || 'New conversation'}</div>
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

export function AcpThread({ sid, visible = true }: { sid: string; visible?: boolean }) {
  const thread = useAcpStore((s) => s.threads.get(sid))
  const setHistory = useAcpStore((s) => s.setHistory)
  const resolvePermissionLocal = useAcpStore((s) => s.resolvePermissionLocal)
  const setModeLocal = useAcpStore((s) => s.setModeLocal)
  const setModelLocal = useAcpStore((s) => s.setModelLocal)
  const engineStatus = useSessionsStore((s) => s.engineStatus)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [resuming, setResuming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)

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

  const send = () => {
    const text = draft.trim()
    if (!text) return
    if (text === '/new' || text === '/clear') { acp().newConversation(sid); setDraft(''); return }
    acp().prompt(sid, [{ type: 'text', text }])
    setDraft('')
    stickRef.current = true
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = 'auto' })
  }

  const answerPermission = useCallback((requestId: string, optionId: string | null) => {
    acp().permissionResponse(sid, requestId, optionId)
    resolvePermissionLocal(sid, requestId, optionId)
  }, [sid, resolvePermissionLocal])

  const selectMode = (id: string) => { acp().setMode(sid, id); setModeLocal(sid, id) }
  const selectModel = (id: string) => { acp().setModel(sid, id); setModelLocal(sid, id) }

  return (
    <div className="acp-thread" style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}>
      <Header sid={sid} recap={recap} onBeginResume={beginResume} />

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
          <div className={`acp-input-box ${focused ? 'focused' : ''}`}>
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              placeholder="Reply to Claude…"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => { setDraft(e.target.value); autoGrow(e.target) }}
              onKeyDown={(e) => {
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
                <button className="acp-send" title="Send" disabled={!draft.trim()} onClick={send}><ArrowUp size={16} /></button>
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
