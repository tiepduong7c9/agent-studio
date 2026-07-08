// A handful of colors we use come from VS Code's workbench/extensions (the git
// extension, the chat contrib), not from the base palette monaco ships. Re-
// register them here with VS Code's exact defaults so they resolve per-theme
// (light/dark/hc) through the same registry path as every other color.
import { registerColor, transparent } from 'monaco-editor/esm/vs/platform/theme/common/colorUtils.js'
import { Color } from 'monaco-editor/esm/vs/base/common/color.js'

// gitDecoration.* — from vscode/extensions/git/package.json (git's package.json
// uses highContrast/highContrastLight; the registry keys are hcDark/hcLight).
registerColor(
  'gitDecoration.addedResourceForeground',
  { light: '#587c0c', dark: '#81b88b', hcDark: '#a1e3ad', hcLight: '#374e06' },
  'Added resources git decoration color.'
)
registerColor(
  'gitDecoration.modifiedResourceForeground',
  { light: '#895503', dark: '#E2C08D', hcDark: '#E2C08D', hcLight: '#895503' },
  'Modified resources git decoration color.'
)
registerColor(
  'gitDecoration.deletedResourceForeground',
  { light: '#ad0707', dark: '#c74e39', hcDark: '#c74e39', hcLight: '#ad0707' },
  'Deleted resources git decoration color.'
)
registerColor(
  'gitDecoration.untrackedResourceForeground',
  { light: '#007100', dark: '#73C991', hcDark: '#73C991', hcLight: '#007100' },
  'Untracked resources git decoration color.'
)
registerColor(
  'gitDecoration.conflictingResourceForeground',
  { light: '#ad0707', dark: '#e4676b', hcDark: '#c74e39', hcLight: '#ad0707' },
  'Conflicting resources git decoration color.'
)

// chat.* — from vscode/src/vs/workbench/contrib/chat/common/widget/chatColors.ts
registerColor(
  'chat.linesAddedForeground',
  { dark: '#54B054', light: '#107C10', hcDark: '#54B054', hcLight: '#107C10' },
  'Foreground color of lines added in a code block pill.'
)
registerColor(
  'chat.linesRemovedForeground',
  { dark: '#FC6A6A', light: '#BC2F32', hcDark: '#F48771', hcLight: '#B5200D' },
  'Foreground color of lines removed in a code block pill.'
)

// commandCenter.* — from vscode/src/vs/workbench/common/theme.ts. The title-bar
// command center (our project-name pill). Background is a subtle translucent
// overlay; foreground/border derive from titleBar.activeForeground (resolved
// from the theme JSON via the string reference).
registerColor(
  'commandCenter.background',
  { dark: Color.white.transparent(0.05), light: Color.black.transparent(0.05), hcDark: null, hcLight: null },
  'Background color of the command center.'
)
registerColor(
  'commandCenter.foreground',
  'titleBar.activeForeground',
  'Foreground color of the command center.'
)
registerColor(
  'commandCenter.border',
  {
    dark: transparent('titleBar.activeForeground', 0.2),
    light: transparent('titleBar.activeForeground', 0.2),
    hcDark: 'contrastBorder',
    hcLight: 'contrastBorder'
  },
  'Border color of the command center.'
)
