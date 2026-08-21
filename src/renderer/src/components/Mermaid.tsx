import { isValidElement, memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// Mermaid diagram rendering for markdown fenced blocks (```mermaid). Shared by
// the session chat and the file/markdown preview. Mermaid is heavy (~500KB), so
// the module is imported on demand the first time a diagram appears — sessions
// with no diagrams never pay for it.

type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

// The theme system sets document root color-scheme to light/dark (see theme/index.ts);
// mirror that so diagrams match the surrounding chrome.
function currentTheme(): 'dark' | 'default' {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'default'
}

// Track the app's light/dark scheme reactively so already-rendered diagrams
// re-theme when the user switches themes (applyTheme mutates :root's inline style).
function useColorScheme(): 'dark' | 'default' {
  const [theme, setTheme] = useState<'dark' | 'default'>(currentTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

// Monotonic id: mermaid.render needs a unique DOM id per call (it mounts a temp
// node while measuring). Not persisted — resets are harmless.
let renderSeq = 0

/**
 * If `children` (a markdown <pre>'s content) is a ```mermaid fenced block,
 * return its source text; otherwise null. react-markdown renders a fenced block
 * as <pre><code class="language-xxx">…</code></pre>.
 */
export function mermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  if (!/(?:^|\s)language-mermaid(?:\s|$)/.test(props.className ?? '')) return null
  const c = props.children
  if (typeof c === 'string') return c
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join('')
  return null
}

/**
 * Renders a mermaid diagram to SVG. While the source is incomplete (assistant
 * messages stream token-by-token, so the block is malformed until the closing
 * fence lands) or fails to parse, it falls back to showing the raw source — the
 * render attempt is debounced so streaming doesn't thrash the parser.
 */
export const Mermaid = memo(function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const theme = useColorScheme()

  useEffect(() => {
    let cancelled = false
    const src = code.trim()
    if (!src) {
      setSvg(null)
      setFailed(false)
      return
    }
    const timer = setTimeout(() => {
      loadMermaid()
        .then(async (mermaid) => {
          // suppressErrorRendering lets render() clean up its temporary DOM node
          // when a diagram parses but fails to draw (e.g. edge limits), instead
          // of leaving an orphaned error node in document.body.
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme })
          const valid = await mermaid.parse(src, { suppressErrors: true })
          if (!valid) {
            if (!cancelled) setFailed(true)
            return
          }
          const { svg: out } = await mermaid.render(`studio-mermaid-${++renderSeq}`, src)
          if (!cancelled) {
            setSvg(out)
            setFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, theme])

  // Incomplete/streaming or unparseable → show the source so nothing is lost.
  if (svg === null || failed) return <pre className="mermaid-source">{code}</pre>
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
})
