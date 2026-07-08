// VS Code color-scheme keys — the same strings the color registry uses to
// select a color's per-base default (dark/light/hcDark/hcLight).
export type ColorScheme = 'light' | 'dark' | 'hcDark' | 'hcLight'

export interface TokenColorRule {
  scope?: string | string[]
  settings: { foreground?: string; fontStyle?: string }
}

// A flattened VS Code color theme (include chain already merged at author time
// by scripts producing theme/themes/*.json).
export interface ThemeManifest {
  id: string
  label: string
  type: ColorScheme
  colors: Record<string, string>
  tokenColors: TokenColorRule[]
  semanticTokenColors?: Record<string, unknown>
}
