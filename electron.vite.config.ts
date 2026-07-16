import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Force native Wayland on a Wayland session. On GNOME 48+/50 an XWayland client
// that emits synthetic/XTEST input makes XWayland open a RemoteDesktop portal +
// libei session, which pops GNOME's "Allow Remote Interaction" prompt on click.
// Native Wayland delivers input directly (no XTEST, no portal). This must be an
// env var read before Electron starts — app.commandLine.appendSwitch() in main
// runs too late to influence ozone platform selection. electron-vite spawns the
// dev/preview Electron with the inherited process.env, so setting it here works.
// The `wayland` hint falls back to X11 when no Wayland session is present.
if (
  process.platform === 'linux' &&
  process.env.WAYLAND_DISPLAY &&
  !process.env.ELECTRON_OZONE_PLATFORM_HINT
) {
  process.env.ELECTRON_OZONE_PLATFORM_HINT = 'wayland'
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
