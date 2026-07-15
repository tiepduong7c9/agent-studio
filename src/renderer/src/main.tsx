import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './codicon.css'
import './styles.css'
// Sets up monaco workers and applies the stored color theme (injecting the
// --vscode-* variables on :root) before first paint.
import './monaco'

// Files dropped anywhere but a registered drop zone (the Files tree) would
// otherwise make Electron navigate to / open the dropped file. Swallow those so
// a stray drop is a no-op; the tree's own drop handler runs first (capture
// phase) and does its upload before this bubble-phase guard.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault())
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
