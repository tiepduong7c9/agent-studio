import { app, BrowserWindow, clipboard, Menu, shell } from 'electron'
import * as path from 'path'
import { registerAcpIpc } from './acp-ipc'
import { disposeProvider, dismissAllNotifications, registerIpcHandlers } from './ipc'
import { registerMediaProtocol, registerMediaScheme } from './media-protocol'
import { registerTerminalIpc } from './terminal-ipc'
import icon from '../../resources/icon.png?asset'

// Note: the native-Wayland ozone platform (which avoids GNOME 48+/50's "Allow
// Remote Interaction" RemoteDesktop prompt — see electron.vite.config.ts) is
// selected before this file runs, so it can't be set here. It's applied at
// launch via ELECTRON_OZONE_PLATFORM_HINT (dev/preview: electron.vite.config.ts;
// packaged: build.linux.executableArgs in package.json). app.commandLine
// switches run too late to influence ozone platform selection.

// The studio-media:// streaming scheme must be declared before app `ready`.
registerMediaScheme()

let mainWindow: BrowserWindow | null = null
let disposeAcp: (() => void) | null = null
let disposeTerminals: (() => void) | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#f8f8f8',
    title: 'Agent Studio',
    icon,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer (available in
      // sandboxed preloads), so keep the renderer sandboxed.
      sandbox: true,
      // Enable <webview> for the in-app browser tab (opened from a session's
      // links list). The guest page runs in its own isolated process.
      webviewTag: true
    }
  })

  // Belt-and-suspenders for the window icon on X11 sessions, where the
  // constructor `icon` option alone is unreliable. Note: on a GNOME/Wayland
  // session (this app runs via XWayland) neither sets the taskbar/dock icon —
  // GNOME takes that from a .desktop file matched to WM_CLASS ("agent-studio")
  // via StartupWMClass. The packaged AppImage ships one (build/icon.png); for a
  // dev run, install ~/.local/share/applications/agent-studio.desktop.
  mainWindow.setIcon(icon)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Returning to the app clears any pending session notifications — a more
  // reliable dismissal than the individual notification click on Linux, and it
  // covers coming back to the app by any means (alt-tab, dock, etc.).
  mainWindow.on('focus', () => dismissAllNotifications())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // setWindowOpenHandler only catches window.open / target="_blank". Plain
  // links (e.g. markdown anchors in the chat) navigate the window itself, which
  // would replace the app with the page. Intercept those: same-origin
  // navigation (dev-server reload/HMR) is allowed through; everything else
  // opens in the external browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    try {
      if (current && new URL(url).origin === new URL(current).origin) return
    } catch {
      // Unparseable URL — fall through and treat as external.
    }
    event.preventDefault()
    shell.openExternal(url)
  })

  // Right-clicking a link offers open/copy. Gated on linkURL so it only shows
  // on actual links — other right-clicks fall through to the app's own custom
  // context menus (session rows, etc.).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const url = params.linkURL
    if (!url) return
    Menu.buildFromTemplate([
      { label: 'Open Link', click: () => shell.openExternal(url) },
      { label: 'Copy Link', click: () => clipboard.writeText(url) }
    ]).popup()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Dev aid: STUDIO_SCREENSHOT=/path/out.png captures the window and quits.
  // STUDIO_CLICK='sel1;;sel2' clicks elements (1s apart) before capturing.
  // STUDIO_EVAL runs arbitrary JS — gate the whole harness to unpackaged
  // (dev) builds so it can never be triggered via a leaked env var in prod.
  const shotPath = process.env.STUDIO_SCREENSHOT
  if (!app.isPackaged && shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const wc = mainWindow!.webContents
        if (process.env.STUDIO_EVAL) {
          const result = await wc
            .executeJavaScript(process.env.STUDIO_EVAL)
            .catch((err) => `EVAL_ERROR: ${err?.message}`)
          console.log(`STUDIO_EVAL -> ${JSON.stringify(result)}`)
        }
        for (let selector of (process.env.STUDIO_CLICK || '').split(';;').filter(Boolean)) {
          // "context:<selector>" dispatches a right-click / contextmenu event
          const isContext = selector.startsWith('context:')
          if (isContext) selector = selector.slice('context:'.length)
          await wc.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            if (!el) return false
            const r = el.getBoundingClientRect()
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: ${isContext ? 2 : 0} }
            if (${isContext}) {
              el.dispatchEvent(new MouseEvent('contextmenu', opts))
            } else {
              for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts))
              }
            }
            return true
          })()`)
          await new Promise((r) => setTimeout(r, 1000))
          const rows = await wc.executeJavaScript(
            `document.querySelectorAll('.widget-tree .monaco-list-row').length`
          )
          console.log(`STUDIO_CLICK ${selector} -> rows: ${rows}`)
        }
        const image = await wc.capturePage()
        const { writeFile } = await import('fs/promises')
        await writeFile(shotPath, image.toPNG())
        app.quit()
      }, 4000)
    })
  }
}

app.whenReady().then(() => {
  const acpHub = registerAcpIpc(() => mainWindow)
  registerIpcHandlers(() => mainWindow, acpHub)
  registerMediaProtocol()
  disposeTerminals = registerTerminalIpc(() => mainWindow)
  disposeAcp = () => acpHub.dispose()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Dispose the ACP hub first so its drop handlers don't schedule reconnects
  // while the providers' ssh clients (which back the engine tunnels) are ending.
  disposeTerminals?.()
  disposeAcp?.()
  disposeProvider()
  if (process.platform !== 'darwin') app.quit()
})
