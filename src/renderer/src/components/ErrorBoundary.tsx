import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Inline (contained) fallback for a region like the chat pane. Omit for the
   *  root full-window fallback, which offers a reload. */
  inline?: boolean
  /** When any entry changes, a caught error is cleared and rendering retried —
   *  e.g. pass the active tab/session id so switching away from a crashed view
   *  recovers instead of staying wedged. */
  resetKeys?: ReadonlyArray<unknown>
}

interface State {
  error: Error | null
}

function keysChanged(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
  if (a === b) return false
  if (!a || !b || a.length !== b.length) return true
  return a.some((v, i) => !Object.is(v, b[i]))
}

// Catches render/lifecycle/effect exceptions in its subtree. Without one, a
// single throw (e.g. Monaco's Menu widget failing to construct on right-click,
// or a bad chat render on click) unmounts the whole React root — the blank
// white window that only a window reopen recovered from.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it — a silent blank window leaves nothing to diagnose from.
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null })
    }
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const box: React.CSSProperties = {
      display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start',
      padding: 24, margin: this.props.inline ? 0 : 'auto', maxWidth: 520,
      color: 'var(--vscode-foreground)', font: 'inherit'
    }
    const msg: React.CSSProperties = {
      fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontFamily: 'var(--vscode-editor-font-family, monospace)'
    }
    return (
      <div className="error-boundary" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'auto' }}>
        <div style={box}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {this.props.inline ? 'This view failed to render.' : 'Agent Studio hit an unexpected error.'}
          </div>
          <div style={msg}>{error.message || String(error)}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={this.reset}>Try again</button>
            {!this.props.inline && (
              <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
