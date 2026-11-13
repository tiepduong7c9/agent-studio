const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 2560, height: 1600, enableLargerThanScreen: true, show: false, webPreferences: { offscreen: true } })
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('console:', msg) })
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(2))
  await win.loadURL('http://localhost:8765/' + (process.env.PAGE || 'index.html'))
  for (let i = 0; i < 60; i++) {
    const ok = await win.webContents.executeJavaScript('!!window.__ready && window.__frames > 30')
    if (ok) break
    await new Promise((r) => setTimeout(r, 500))
  }
  await new Promise((r) => setTimeout(r, Number(process.env.DELAY || 800)))
  console.log('state', await win.webContents.executeJavaScript('JSON.stringify({ready: window.__ready, frames: window.__frames, dpr: devicePixelRatio})'))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(process.env.OUT || require('path').join(__dirname, 'screenshots', 'shot.png'), img.toPNG())
  console.log('size', JSON.stringify(img.getSize()))
  app.quit()
})
