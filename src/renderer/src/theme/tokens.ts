import type { TokenColorRule } from './types'

// Monaco's standalone editor tokenizes with Monarch (its own token names), not
// TextMate scopes, so a VS Code theme's tokenColors can't be applied verbatim.
// We map the common Monarch token types to the TextMate scopes that carry the
// matching color, giving faithful editor-chrome + reasonable syntax colors.
const MONACO_TOKEN_SCOPES: Record<string, string[]> = {
  comment: ['comment'],
  string: ['string'],
  'string.regexp': ['string.regexp'],
  regexp: ['string.regexp'],
  keyword: ['keyword.control', 'keyword'],
  'keyword.operator': ['keyword.operator'],
  operator: ['keyword.operator'],
  number: ['constant.numeric'],
  constant: ['constant.language', 'constant'],
  type: ['entity.name.type', 'support.type', 'entity.name.class', 'support.class'],
  'type.identifier': ['entity.name.type', 'entity.name.class'],
  function: ['entity.name.function', 'support.function'],
  identifier: ['variable'],
  variable: ['variable'],
  tag: ['entity.name.tag'],
  'attribute.name': ['entity.other.attribute-name'],
  'attribute.value': ['string'],
  namespace: ['entity.name.namespace', 'entity.name.type.module'],
  delimiter: ['punctuation']
}

interface Setting {
  foreground?: string
  fontStyle?: string
}

// Flatten tokenColors into an exact scope → settings lookup (arrays expanded).
function scopeIndex(tokenColors: TokenColorRule[]): Map<string, Setting> {
  const index = new Map<string, Setting>()
  for (const rule of tokenColors) {
    if (!rule.scope || !rule.settings) continue
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : rule.scope.split(',').map((s) => s.trim())
    for (const scope of scopes) {
      if (scope) index.set(scope, rule.settings)
    }
  }
  return index
}

// TextMate resolution: a rule for `comment` applies to `comment.line.double`.
// Walk from the most specific scope down to its prefixes and take the first hit.
function lookup(index: Map<string, Setting>, scope: string): Setting | undefined {
  let key = scope
  while (key) {
    const hit = index.get(key)
    if (hit) return hit
    const dot = key.lastIndexOf('.')
    if (dot === -1) break
    key = key.slice(0, dot)
  }
  return undefined
}

export interface MonacoRule {
  token: string
  foreground?: string
  fontStyle?: string
}

export function toMonacoRules(tokenColors: TokenColorRule[]): MonacoRule[] {
  const index = scopeIndex(tokenColors)
  const rules: MonacoRule[] = []
  for (const [token, scopes] of Object.entries(MONACO_TOKEN_SCOPES)) {
    let setting: Setting | undefined
    for (const scope of scopes) {
      setting = lookup(index, scope)
      if (setting) break
    }
    if (!setting?.foreground && !setting?.fontStyle) continue
    rules.push({
      token,
      // monaco wants a 6-digit hex with no leading '#'
      foreground: setting.foreground?.replace('#', '').slice(0, 6),
      fontStyle: setting.fontStyle || undefined
    })
  }
  return rules
}
