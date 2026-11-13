import type { CSSProperties } from 'react'
import { characterLabel, useSessionCharacter, type Character } from '../characters-store'
import { useAvatarSheet, usePortrait } from '../office/portraits'

/** What an animated avatar is doing. */
export type AvatarMotion = 'idle' | 'busy' | 'alert' | 'done'
const MOTION_CLIP: Record<AvatarMotion, string> = { idle: 'idle', busy: 'walk', alert: 'interact-right', done: 'emote-yes' }

/** A character's round portrait on its accent colour: a plain image with the
 *  disc and ring baked in (see renderPortrait). With `motion` it plays that
 *  animation from a pre-rendered sprite strip instead. Until it has rendered
 *  (the first one loads three.js) an accent disc stands in. */
export function CharacterAvatar({
  character,
  size = 20,
  title,
  motion
}: {
  character: Character
  size?: number
  title?: string
  motion?: AvatarMotion
}) {
  const url = usePortrait(character.look, character.accent)
  const sheet = useAvatarSheet(character.look, character.accent, motion ? MOTION_CLIP[motion] : null)
  if (sheet) {
    const style = {
      width: size,
      height: size,
      backgroundImage: `url(${sheet.url})`,
      '--sheet-w': `${size * sheet.frames}px`,
      '--sheet-frames': sheet.frames,
      '--sheet-dur': `${sheet.duration}s`
    } as CSSProperties
    return <span className="char-avatar char-avatar-anim" style={style} title={title ?? characterTitle(character)} />
  }
  return (
    <span className="char-avatar" style={{ width: size, height: size }} title={title ?? characterTitle(character)}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <svg viewBox="0 0 2 2" aria-hidden>
          <circle cx="1" cy="1" r="1" fill={character.accent} />
        </svg>
      )}
    </span>
  )
}

/** The avatar of whichever character a session has (or the generic one). */
export function SessionAvatar({ sid, size }: { sid: string; size?: number }) {
  return <CharacterAvatar character={useSessionCharacter(sid)} size={size} />
}

/** "Mia · Release" — the character's name and role — or nothing for the
 *  generic character, whose sessions are named by their title alone. */
export function SessionCharacterName({ sid, className }: { sid: string; className?: string }) {
  const c = useSessionCharacter(sid)
  if (!c.name.trim()) return null
  return (
    <span className={`char-name ${className ?? ''}`} style={{ '--char-accent': c.accent } as CSSProperties}>
      {c.name.trim()}
      {c.role.trim() && <span className="char-role"> · {c.role.trim()}</span>}
    </span>
  )
}

const characterTitle = (c: Character): string =>
  c.id === 'generic' ? 'No character assigned' : `${characterLabel(c)}${c.role.trim() ? ` · ${c.role.trim()}` : ''}`
