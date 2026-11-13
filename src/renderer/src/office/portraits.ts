import { useEffect, useState } from 'react'
import type { CharacterLook } from '../characters-store'

// Avatar image cache, kept apart from three-characters.ts so reading a
// finished avatar never pulls in three.js. An avatar depends only on the look
// and the accent colour, so characters that share both share one image.

const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

const avatarKey = (l: CharacterLook, accent: string): string => `${l.body}|${l.head}|${accent}`

function request(look: CharacterLook, accent: string): Promise<string> {
  const key = avatarKey(look, accent)
  let p = pending.get(key)
  if (!p) {
    p = import('./three-characters').then((m) => m.renderPortrait(look, accent)).then((url) => {
      cache.set(key, url)
      return url
    })
    p.catch(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

/** The avatar image for a look on an accent: a data URL once rendered, null
 *  until then. */
export function usePortrait(look: CharacterLook, accent: string): string | null {
  const key = avatarKey(look, accent)
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null)
  useEffect(() => {
    const hit = cache.get(key)
    if (hit) {
      setUrl(hit)
      return
    }
    setUrl(null)
    let alive = true
    request(look, accent).then(
      (u) => alive && setUrl(u),
      () => undefined
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return url
}
