import { useEffect, useMemo, useState } from 'react'
import { useAcpStore } from './acp/store'
import { textOf } from './acp/buildThread'
import type { AcpContentBlock, AcpEvent } from './acp/protocol'

// The links surfaced in a session are DERIVED from the conversation, not stored:
// we scan the message text for URLs on demand. The thread events (in the acp
// store) are the single source of truth, so there's nothing to keep in sync and
// no stale/duplicate entries. The scan is memoized on the events reference, so
// it only re-runs when the conversation actually changes.

export type LinkSource = 'user' | 'assistant' | 'repo'
export interface SessionLink {
  url: string
  source: LinkSource
}

// Match http(s) URLs. Excluding whitespace and common wrapper characters keeps
// us from swallowing markdown syntax like `](` or surrounding quotes/brackets.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi
// Punctuation/markdown that commonly trails a URL in prose (sentence end, list
// comma) or wraps it (e.g. **bold** emphasis leaves a trailing `**`, or a
// literal "https://…" placeholder) but isn't part of the URL itself.
const TRAILING = /[*_~.,;:!?…]+$/

function normalize(raw: string): string {
  return raw.replace(TRAILING, '')
}

// Keep only strings that parse as an http(s) URL with a *real* host — a dotted
// domain (with a ≥2-letter TLD), an IPv4 address, or localhost. This rejects
// prose placeholders like "https://…" or "https://example" that the greedy
// regex would otherwise pick up.
function isRealUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname
  if (host === 'localhost') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true
  return /\.[a-z]{2,}$/i.test(host)
}

export function extractLinks(events: AcpEvent[] | undefined): SessionLink[] {
  const seen = new Map<string, SessionLink>()
  const add = (text: string, source: LinkSource): void => {
    for (const m of text.matchAll(URL_RE)) {
      const url = normalize(m[0])
      if (!isRealUrl(url)) continue
      // First occurrence wins — and with it the source that first mentioned it.
      if (!seen.has(url)) seen.set(url, { url, source })
    }
  }
  for (const e of events ?? []) {
    if (e.type === 'acp_user') {
      add(e.blocks.map((b: AcpContentBlock) => textOf(b)).join(''), 'user')
    } else if (e.type === 'acp_update') {
      const u = e.update
      if (u.sessionUpdate === 'agent_message_chunk') {
        add(textOf((u as { content: AcpContentBlock }).content), 'assistant')
      } else if (u.sessionUpdate === 'user_message_chunk') {
        add(textOf((u as { content: AcpContentBlock }).content), 'user')
      }
    }
  }
  return [...seen.values()]
}

/** All http(s) links mentioned in a session, in first-seen order, deduped. */
export function useSessionLinks(sid: string): SessionLink[] {
  const events = useAcpStore((s) => s.threads.get(sid)?.events)
  return useMemo(() => extractLinks(events), [events])
}

// Turn a git remote (as reported by `git remote get-url`) into a browsable
// web URL: scp-style `git@host:owner/repo.git` and `ssh://`/`git://` transports
// all become `https://host/owner/repo`, credentials are dropped, and the `.git`
// suffix is trimmed. Returns null for anything that isn't a real http(s) host.
export function repoWebUrl(remote: string): string | null {
  let raw = remote.trim()
  if (!raw) return null
  // scp-like syntax has no `://` — rewrite `user@host:path` to a URL first.
  if (!raw.includes('://')) {
    const scp = /^[^/@]+@([^/:]+):(.+)$/.exec(raw)
    if (scp) raw = `https://${scp[1]}/${scp[2]}`
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const path = u.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
  // Rebuild as browsable https from host + path, dropping any credentials. We
  // construct it by hand rather than setting `u.protocol`, since the URL setter
  // refuses to rewrite a non-special scheme (ssh:, git:) to https. For http(s)
  // we keep the port (self-hosted forges); for git transports we drop it (:22).
  const out =
    u.protocol === 'http:' || u.protocol === 'https:'
      ? `${u.protocol}//${u.host}${path}`
      : `https://${u.hostname}${path}`
  return isRealUrl(out) ? out : null
}

/**
 * The session's git repository as a browsable web link, or null when the
 * workspace isn't a git repo / has no remote. Fetched once per workspace (the
 * remote rarely changes), so it stays off the frequent git-status polls.
 */
export function useRepoLink(wsId: string | null): SessionLink | null {
  const [link, setLink] = useState<SessionLink | null>(null)
  useEffect(() => {
    let cancelled = false
    setLink(null)
    if (!wsId) return
    window.studio
      .gitRemoteUrl(wsId)
      .then((res) => {
        if (cancelled || !res.ok || !res.data) return
        const url = repoWebUrl(res.data)
        if (url) setLink({ url, source: 'repo' })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [wsId])
  return link
}
