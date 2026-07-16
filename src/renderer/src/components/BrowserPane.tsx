import { useEffect, useRef, useState, type FormEvent } from 'react'

/** The methods/events we drive on the Electron webview guest element. */
interface WebviewEl extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getURL(): string
}

/** Coerce an address-bar entry into a navigable URL (default to https). */
function toUrl(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * An in-app browser tab: an isolated Electron <webview> with a minimal nav bar
 * (back / forward / reload / address). Opened from a session's links list.
 */
export function BrowserPane({ url }: { url: string }) {
  const ref = useRef<WebviewEl | null>(null)
  const [address, setAddress] = useState(url)
  const [loading, setLoading] = useState(true)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const syncNav = (): void => {
      setAddress(el.getURL())
      setCanBack(el.canGoBack())
      setCanForward(el.canGoForward())
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', syncNav)
    el.addEventListener('did-navigate-in-page', syncNav)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', syncNav)
      el.removeEventListener('did-navigate-in-page', syncNav)
    }
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    ref.current?.loadURL(toUrl(address)).catch(() => {})
  }

  return (
    <div className="browser-pane">
      <div className="browser-nav">
        <button
          className="icon-button codicon codicon-arrow-left"
          title="Back"
          disabled={!canBack}
          onClick={() => ref.current?.goBack()}
        />
        <button
          className="icon-button codicon codicon-arrow-right"
          title="Forward"
          disabled={!canForward}
          onClick={() => ref.current?.goForward()}
        />
        <button
          className={`icon-button codicon ${loading ? 'codicon-close' : 'codicon-refresh'}`}
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
        />
        <form className="browser-address" onSubmit={submit}>
          <input
            value={address}
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </form>
      </div>
      <webview ref={ref as never} className="browser-webview" src={url} allowpopups={true} />
    </div>
  )
}
