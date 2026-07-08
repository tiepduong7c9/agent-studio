import { Color } from 'monaco-editor/esm/vs/base/common/color.js'
import { colorRegistry, type ColorThemeLike } from './registry'
import type { ThemeManifest } from './types'

// Build the IColorTheme the registry resolves against: a color is the theme's
// explicit override if present, otherwise the registered default resolved for
// this base type (which may itself reference/derive from other colors, so the
// object is passed back into resolveDefaultColor recursively — exactly how
// VS Code's ColorThemeData.getColor works).
function makeTheme(manifest: ThemeManifest): ColorThemeLike {
  const theme: ColorThemeLike = {
    type: manifest.type,
    // Whether the theme JSON explicitly sets this color (used by the registry's
    // ifDefinedThenElse transform), matching VS Code's ColorThemeData.defines.
    defines(id: string) {
      return typeof manifest.colors[id] === 'string'
    },
    getColor(id: string) {
      const override = manifest.colors[id]
      if (typeof override === 'string') return Color.fromHex(override)
      return colorRegistry.resolveDefaultColor(id, theme)
    }
  }
  return theme
}

const cssVarName = (id: string) => '--vscode-' + id.replace(/\./g, '-')

// Resolve every color the app or the reused widgets might reference: the union
// of all registered colors and everything the theme JSON overrides. Returns a
// map of `--vscode-*` custom properties to CSS color strings.
export function resolveThemeVariables(manifest: ThemeManifest): Record<string, string> {
  const theme = makeTheme(manifest)
  const ids = new Set<string>()
  for (const c of colorRegistry.getColors()) ids.add(c.id)
  for (const id of Object.keys(manifest.colors)) ids.add(id)

  const vars: Record<string, string> = {}
  for (const id of ids) {
    const color = theme.getColor(id)
    if (color) vars[cssVarName(id)] = color.toString()
  }
  return vars
}
