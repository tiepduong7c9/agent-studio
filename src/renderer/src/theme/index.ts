import * as monaco from 'monaco-editor'
import { resolveThemeVariables } from './resolve'
import { toMonacoRules } from './tokens'
import type { ThemeManifest } from './types'
import lightModern from './themes/light-modern.json'
import darkModern from './themes/dark-modern.json'

// Built-in themes, flattened from vscode/extensions/theme-defaults/themes/ by
// scripts (include chains merged). Add more by dropping another flattened JSON.
const THEMES: ThemeManifest[] = [lightModern as ThemeManifest, darkModern as ThemeManifest]

const STORAGE_KEY = 'studio.colorTheme'
const DEFAULT_ID = 'light-modern'

export interface ThemeInfo {
  id: string
  label: string
  type: ThemeManifest['type']
}

export function availableThemes(): ThemeInfo[] {
  return THEMES.map((t) => ({ id: t.id, label: t.label, type: t.type }))
}

export function getStoredThemeId(): string {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_ID
}

function find(id: string): ThemeManifest {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

const monacoBase = (type: ThemeManifest['type']): monaco.editor.BuiltinTheme =>
  type === 'light' ? 'vs' : type === 'hcLight' ? 'hc-light' : type === 'hcDark' ? 'hc-black' : 'vs-dark'

// Apply a theme everywhere: inject every resolved --vscode-* custom property on
// :root (the reused vs/base widgets and our CSS both read these), set the
// native color-scheme, and define+select the matching monaco editor theme.
export function applyTheme(id: string): void {
  const manifest = find(id)
  const root = document.documentElement

  const vars = resolveThemeVariables(manifest)
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.colorScheme = manifest.type === 'light' || manifest.type === 'hcLight' ? 'light' : 'dark'

  const monacoName = `studio-${manifest.id}`
  monaco.editor.defineTheme(monacoName, {
    base: monacoBase(manifest.type),
    inherit: true,
    rules: toMonacoRules(manifest.tokenColors),
    colors: manifest.colors
  })
  monaco.editor.setTheme(monacoName)

  localStorage.setItem(STORAGE_KEY, manifest.id)
}

export function initTheme(): void {
  try {
    applyTheme(getStoredThemeId())
  } catch (e) {
    // Never let a theme failure white-screen the app; fall back to the CSS defaults.
    console.error('Failed to apply color theme', e)
  }
}
