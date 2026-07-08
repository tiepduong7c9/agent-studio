/**
 * Seti file icons, extracted from
 * vscode/extensions/theme-seti/icons/vs-seti-icon-theme.json.
 * Each entry is [fontCharacter, fontColor] from the theme's iconDefinitions.
 */

type IconDef = [string, string]

const DEFAULT: IconDef = ['', '#c4c4c4'] // _default

const BY_FILENAME: Record<string, IconDef> = {
  'tsconfig.json': ['', '#519aba'], // _tsconfig
  'readme.md': ['', '#519aba'], // _info
  readme: ['', '#519aba'],
  license: ['', '#cbcb41'], // _license
  'license.txt': ['', '#cbcb41'],
  'license.md': ['', '#cbcb41'],
  makefile: ['', '#e37933'], // _makefile
  dockerfile: ['', '#519aba'], // _docker
  '.gitignore': ['', '#41535b'], // _git
  '.gitattributes': ['', '#41535b'],
  '.eslintrc': ['', '#a074c4'], // _eslint
  '.editorconfig': ['', '#6d8086'], // _config
  '.nvmrc': ['', '#6d8086']
}

const BY_EXTENSION: Record<string, IconDef> = {
  ts: ['', '#519aba'], // _typescript
  mts: ['', '#519aba'],
  cts: ['', '#519aba'],
  tsx: ['', '#519aba'], // _react
  js: ['', '#cbcb41'], // _javascript
  mjs: ['', '#cbcb41'],
  cjs: ['', '#cbcb41'],
  jsx: ['', '#519aba'],
  json: ['', '#cbcb41'], // _json
  jsonc: ['', '#cbcb41'],
  md: ['', '#519aba'], // _markdown
  markdown: ['', '#519aba'],
  css: ['', '#519aba'], // _css
  scss: ['', '#f55385'], // _sass
  sass: ['', '#f55385'],
  less: ['', '#519aba'], // _less
  html: ['', '#e37933'], // _html_3
  htm: ['', '#e37933'],
  xml: ['', '#e37933'], // _xml
  svg: ['', '#a074c4'], // _svg
  png: ['', '#a074c4'], // _image
  jpg: ['', '#a074c4'],
  jpeg: ['', '#a074c4'],
  gif: ['', '#a074c4'],
  ico: ['', '#a074c4'],
  ttf: ['', '#cc3e44'], // _font
  woff: ['', '#cc3e44'],
  woff2: ['', '#cc3e44'],
  py: ['', '#519aba'], // _python
  sh: ['', '#8dc149'], // _shell
  bash: ['', '#8dc149'],
  zsh: ['', '#8dc149'],
  yml: ['', '#a074c4'], // _yml
  yaml: ['', '#a074c4'],
  toml: ['', '#6d8086'], // _config
  ini: ['', '#6d8086'],
  conf: ['', '#6d8086'],
  lock: ['', '#8dc149'], // _lock
  rs: ['', '#6d8086'], // _rust
  go: ['', '#519aba'], // _go
  java: ['', '#cc3e44'], // _java
  php: ['', '#a074c4'], // _php
  rb: ['', '#cc3e44'], // _ruby
  c: ['', '#519aba'], // _c
  h: ['', '#a074c4'],
  cpp: ['', '#519aba'], // _cpp
  hpp: ['', '#a074c4'],
  vue: ['', '#8dc149'], // _vue
  svelte: ['', '#cc3e44'], // _svelte
  txt: ['', '#c4c4c4']
}

export function FileIcon({ name }: { name: string }) {
  const [glyph, color] = lookup(name)
  return (
    <span className="seti-icon" style={{ color }}>
      {glyph}
    </span>
  )
}

/** Non-JSX variant for use inside VS Code widget renderers. */
export function fileIconStyle(name: string): { glyph: string; color: string } {
  const [glyph, color] = lookup(name)
  return { glyph, color }
}

function lookup(name: string): IconDef {
  const lower = name.toLowerCase()
  const byName = BY_FILENAME[lower]
  if (byName) return byName
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return BY_EXTENSION[ext] ?? DEFAULT
}
