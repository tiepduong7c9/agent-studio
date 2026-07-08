// Reuse VS Code's real color registry, shipped inside monaco-editor. Each
// `colors/*.js` module calls registerColor() at import time with the exact
// defaults and cross-color derivations VS Code uses (e.g.
// list.activeSelectionBackground, descriptionForeground = transparent(fg,.7)).
// Importing them for their side effects populates the global registry so we
// can resolve any theme the way the workbench does.
import { Registry } from 'monaco-editor/esm/vs/platform/registry/common/platform.js'
import { Extensions } from 'monaco-editor/esm/vs/platform/theme/common/colorUtils.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/baseColors.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/listColors.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/menuColors.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/inputColors.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/editorColors.js'
import 'monaco-editor/esm/vs/platform/theme/common/colors/miscColors.js'
// Workbench/extension colors monaco doesn't ship (git, chat), registered with
// VS Code's real defaults so they resolve per-theme too.
import './extra-colors'
import type { ColorScheme } from './types'

// Minimal shape of the IColorTheme the registry's resolveDefaultColor expects.
export interface ColorThemeLike {
  type: ColorScheme
  defines(id: string): boolean
  getColor(id: string): { toString(): string } | undefined
}

interface ColorRegistry {
  getColors(): { id: string }[]
  resolveDefaultColor(id: string, theme: ColorThemeLike): { toString(): string } | undefined
}

export const colorRegistry = Registry.as(Extensions.ColorContribution) as unknown as ColorRegistry
