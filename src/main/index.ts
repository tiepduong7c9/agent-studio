import { app, BrowserWindow, shell } from 'electron'
import * as path from 'path'
import { registerAcpIpc } from './acp-ipc'
import { disposeProvider, registerIpcHandlers } from './ipc'
import { registerMediaProtocol, registerMediaScheme } from './media-protocol'

// The studio-media:// streaming scheme must be declared before app `ready`.
registerMediaScheme()

// Render via XWayland, same as VS Code and most Electron apps. On GNOME (48+/50)
// Chromium's *native-Wayland* input path opens a RemoteDesktop portal session on
// window focus, which triggers GNOME's "Allow Remote Interaction" consent prompt
// on every interaction. XWayland uses X11 input directly and avoids it entirely.
// The desktop session stays Wayland — only this app uses the XWayland layer.
// Set ELECTRON_OZONE_PLATFORM_HINT=wayland to opt into native Wayland (and the
// prompt) once the upstream Electron/GNOME behavior is fixed.
if (!process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11')
}

let mainWindow: BrowserWindow | null = null
let disposeAcp: (() => void) | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#f8f8f8',
    title: 'Agent Studio',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer (available in
      // sandboxed preloads), so keep the renderer sandboxed.
      sandbox: true
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  disposeAcp = () => acpHub.dispose()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Dispose the ACP hub first so its drop handlers don't schedule reconnects
  // while the providers' ssh clients (which back the engine tunnels) are ending.
  disposeAcp?.()
  disposeProvider()
  if (process.platform !== 'darwin') app.quit()
})
