import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './codicon.css'
import './styles.css'
// Sets up monaco workers and applies the stored color theme (injecting the
// --vscode-* variables on :root) before first paint.
import './monaco'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
