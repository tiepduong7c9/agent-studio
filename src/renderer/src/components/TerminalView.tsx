import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './TerminalView.css'

// A concrete monospace stack — xterm measures the font for its cell grid off a
// real family name, so a CSS var (which it can't resolve) would silently fall
// back to a mis-sized default and clip glyphs. Ordered by platform preference.
const MONO_FONT =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", Menlo, "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", Consolas, monospace'

// A single integrated terminal, backed by a main-process PTY (see
// terminal-ipc.ts). The xterm instance lives for the mount lifetime; the PTY is
// created on mount and killed on unmount, so the shell survives tab switches
// (the view is hidden, not unmounted) and dies only when the tab is closed.
//
// `active` tells us the tab is the visible one: xterm can't measure itself while
// display:none, so we (re)fit and focus whenever it becomes active.

// VS Code's default dark terminal palette — readable regardless of the app's
// (light) chrome, matching how VS Code keeps a dark terminal in a light theme.
const THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

export function TerminalView({
  wsId: _wsId,
  cwd,
  host,
  active
}: {
  wsId: string
  cwd: string
  host: string | null
  active: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // The PTY id, once created. Held in a ref so the (stable) onData handler and
  // the resize observer can read the latest value without re-subscribing.
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: MONO_FONT,
      fontSize: 13,
      // A little leading stops tall glyphs/box-drawing from clipping at the cell
      // edges (the cramped look of lineHeight 1).
      lineHeight: 1.2,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      theme: THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    // WebGL renderer for crisp, GPU-accelerated glyphs (what VS Code uses). If
    // the context can't be created or is lost, drop it and fall back to the DOM
    // renderer rather than leaving a blank canvas.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL (headless/software GL) — the default DOM renderer still works.
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const copySelection = () => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
    }
    const paste = () => {
      void navigator.clipboard.readText().then((text) => {
        if (text && idRef.current) window.studio.terminal.input(idRef.current, text)
      })
    }

    // xterm sends Ctrl+C to the PTY as SIGINT, so clipboard copy/paste use the
    // Linux terminal convention (Ctrl+Shift+C/V, plus the Insert variants).
    // preventDefault is essential: Chromium natively treats Ctrl+Shift+V as
    // "paste as plain text" into the hidden textarea, which — on top of our own
    // paste() — would insert the text twice. Returning false also stops xterm
    // from forwarding the keystroke to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && key === 'c') {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.ctrlKey && e.shiftKey && key === 'v') {
        e.preventDefault()
        paste()
        return false
      }
      if (e.ctrlKey && e.key === 'Insert') {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.shiftKey && e.key === 'Insert') {
        e.preventDefault()
        paste()
        return false
      }
      return true
    })

    // Right-click opens the native Copy/Paste/Select All menu (built in the main
    // process, since xterm's selection is invisible to Electron's default menu).
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      void window.studio.terminal.contextMenu({ hasSelection: term.hasSelection() }).then((action) => {
        if (action === 'copy') copySelection()
        else if (action === 'paste') paste()
        else if (action === 'selectAll') term.selectAll()
      })
    }
    hostRef.current!.addEventListener('contextmenu', onContextMenu)

    // Keystrokes → PTY (dropped until the PTY exists; the shell isn't up yet).
    term.onData((data) => {
      if (idRef.current) window.studio.terminal.input(idRef.current, data)
    })

    // PTY output → xterm, filtered to this terminal's id.
    const offData = window.studio.terminal.onData(({ id, data }) => {
      if (id === idRef.current) term.write(data)
    })
    const offExit = window.studio.terminal.onExit(({ id, exitCode }) => {
      if (id !== idRef.current) return
      term.write(`\r\n\x1b[90m[process exited${exitCode ? ` with code ${exitCode}` : ''}]\x1b[0m\r\n`)
      idRef.current = null
    })

    let disposed = false
    window.studio.terminal
      .create({ cwd, host, cols: term.cols, rows: term.rows })
      .then((res) => {
        if (disposed) {
          // Unmounted before creation resolved — reap the orphan PTY.
          if (res.ok) window.studio.terminal.kill(res.data.id)
          return
        }
        if (!res.ok) {
          term.write(`\r\n\x1b[31mFailed to start terminal: ${res.error}\x1b[0m\r\n`)
          return
        }
        idRef.current = res.data.id
      })

    // Keep the PTY's window size in sync with the rendered grid. Fires when the
    // pane resizes and when it flips from hidden (0×0) to visible.
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        // fit throws if the element is detached mid-teardown; ignore.
      }
      if (idRef.current) window.studio.terminal.resize(idRef.current, term.cols, term.rows)
    })
    ro.observe(hostRef.current!)

    const hostEl = hostRef.current!
    return () => {
      disposed = true
      ro.disconnect()
      hostEl.removeEventListener('contextmenu', onContextMenu)
      offData()
      offExit()
      if (idRef.current) window.studio.terminal.kill(idRef.current)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      idRef.current = null
    }
    // Created once per mount; cwd/host are fixed for a given terminal tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the tab becomes visible, the pane just gained real dimensions — refit,
  // resize the PTY, and focus so typing goes straight to the shell.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit || !hostRef.current || hostRef.current.clientHeight === 0) return
      fit.fit()
      if (idRef.current) window.studio.terminal.resize(idRef.current, term.cols, term.rows)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  return <div className="terminal-view" ref={hostRef} onClick={() => termRef.current?.focus()} />
}
