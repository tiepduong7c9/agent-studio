import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import type { BrowserChoice } from '../shared/types'

const execFile = promisify(execFileCb)

// Candidate browser binaries on Linux, with friendly labels. We probe PATH for
// each and surface the ones that resolve — so the links list only offers
// browsers actually installed on this machine. (Linux-only, matching the
// environment this app ships in.)
const CANDIDATES: { bin: string; name: string }[] = [
  { bin: 'firefox', name: 'Firefox' },
  { bin: 'google-chrome-stable', name: 'Google Chrome' },
  { bin: 'google-chrome', name: 'Google Chrome' },
  { bin: 'chromium', name: 'Chromium' },
  { bin: 'chromium-browser', name: 'Chromium' },
  { bin: 'brave-browser', name: 'Brave' },
  { bin: 'brave', name: 'Brave' },
  { bin: 'microsoft-edge', name: 'Microsoft Edge' },
  { bin: 'vivaldi', name: 'Vivaldi' },
  { bin: 'opera', name: 'Opera' }
]

let cached: BrowserChoice[] | null = null

async function onPath(bin: string): Promise<boolean> {
  try {
    await execFile('which', [bin])
    return true
  } catch {
    return false
  }
}

/** The system default plus every detected browser, deduped by friendly name so
 *  a browser exposing several aliases (chrome/chrome-stable) shows once. */
export async function listBrowsers(): Promise<BrowserChoice[]> {
  if (cached) return cached
  const found: BrowserChoice[] = [{ id: 'default', name: 'System default' }]
  const seenNames = new Set<string>()
  for (const c of CANDIDATES) {
    if (seenNames.has(c.name)) continue
    if (await onPath(c.bin)) {
      found.push({ id: c.bin, name: c.name })
      seenNames.add(c.name)
    }
  }
  cached = found
  return found
}

/** Open `url` in the chosen browser. 'default' uses the OS handler; any other id
 *  must be a detected binary (guarded against arbitrary command execution). */
export async function openInBrowser(url: string, browserId: string): Promise<void> {
  // Only ever hand a real web URL to a browser process.
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open non-http URL: ${url}`)
  }
  if (browserId === 'default') {
    await shell.openExternal(url)
    return
  }
  const choices = await listBrowsers()
  if (!choices.some((c) => c.id === browserId)) {
    throw new Error(`Unknown browser: ${browserId}`)
  }
  const child = spawn(browserId, [url], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** Resolve the system default browser to a binary on PATH (Linux xdg), or null.
 *  `xdg-settings` reports a .desktop id (e.g. "firefox.desktop"); we map its stem
 *  onto a known/among-PATH binary so we can pass it a --new-window flag. */
async function defaultBrowserBin(): Promise<string | null> {
  try {
    const { stdout } = await execFile('xdg-settings', ['get', 'default-web-browser'])
    const stem = stdout.trim().replace(/\.desktop$/, '')
    if (!stem) return null
    for (const c of CANDIDATES) {
      if ((stem === c.bin || stem.startsWith(c.bin) || c.bin.startsWith(stem)) && (await onPath(c.bin))) {
        return c.bin
      }
    }
    if (await onPath(stem)) return stem
  } catch {
    // xdg-settings missing or no default set — caller falls back.
  }
  return null
}

/** Open `url` in the system browser, forced into a fresh browser window (a single
 *  tab) rather than a new tab in an existing window. Resolves the default browser
 *  and passes --new-window; if it can't be resolved, falls back to the OS handler
 *  (which typically opens a tab). */
export async function openInWindow(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open non-http URL: ${url}`)
  }
  const bin = await defaultBrowserBin()
  if (bin) {
    const child = spawn(bin, ['--new-window', url], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  await shell.openExternal(url)
}
