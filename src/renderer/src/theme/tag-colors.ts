// The session-tag palette, registered as theme colors so each one resolves per
// theme base. The dark values are the ones the tags shipped with; the light
// values are darker takes on the same hue, because the dark set — picked against
// a #181818 sidebar — drops to around 2:1 on a #F8F8F8 one and the 12px glyphs
// all but vanish. Every light value clears 4.3:1 against the lightest sidebar
// and the (grey) selected-row background.
//
// Ids are `studio.tag.<name>`, so CSS reads them as `--vscode-studio-tag-<name>`
// like any other themed color — see tags-store.ts, which stores the palette id
// rather than a hex for exactly this reason.
import { registerColor } from 'monaco-editor/esm/vs/platform/theme/common/colorUtils.js'

// hc* mirror the base they sit on: both sets already exceed the AA threshold,
// and a distinct high-contrast palette would only cost hue recognition.
const tag = (name: string, dark: string, light: string): void => {
  registerColor(
    `studio.tag.${name}`,
    { dark, light, hcDark: dark, hcLight: light },
    `Session tag colour: ${name}.`
  )
}

tag('red', '#f14c4c', '#c22e2e')
tag('orange', '#ff8c00', '#b04a00')
tag('amber', '#e9a700', '#7d6a00')
tag('green', '#89d185', '#0e720e')
tag('teal', '#4ec9b0', '#0f6e64')
tag('blue', '#3794ff', '#005fb8')
tag('purple', '#c586c0', '#8b46a3')
tag('pink', '#f06292', '#c2185b')
tag('grey', '#9d9d9d', '#616161')
