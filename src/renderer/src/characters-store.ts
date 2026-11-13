import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Characters: a named persona (name, role, accent colour, 3D look) the user
// creates once and assigns to sessions. Sessions without one show the generic
// character. Stored on this machine, like tags and pins.
//
// A look is a body model plus a head model from the Kenney Mini Characters set
// (src/renderer/src/assets/office/characters). Every model shares one skeleton,
// so any head goes on any body.

export const CHARACTER_MODELS = [
  'female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f',
  'male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f', 'male-g',
  'worker', 'soldier', 'knight', 'raider', 'robot', 'alien', 'zombie'
] as const
export type CharacterModel = (typeof CHARACTER_MODELS)[number]

export const modelLabel = (m: CharacterModel): string =>
  m.replace(/^(female|male)-(\w)$/, (_, g: string, v: string) => `${g === 'female' ? 'Female' : 'Male'} ${v.toUpperCase()}`)
    .replace(/^\w/, (c) => c.toUpperCase())

/** Accent colours: the name badge, avatar ring and (in the office) the glow of
 *  the character's monitor. Real colours rather than theme variables, since
 *  the 3D scene needs them too. */
export const CHARACTER_ACCENTS = [
  '#4c9aff', '#39c5cf', '#3fb950', '#e3b341', '#f0883e', '#ff7b72', '#db61a2', '#a371f7', '#8b949e'
] as const

export interface CharacterLook {
  body: CharacterModel
  head: CharacterModel
}

export interface Character {
  id: string
  name: string
  role: string
  accent: string
  look: CharacterLook
}

/** Shown for every session that has no character assigned. */
export const GENERIC_CHARACTER: Character = {
  id: 'generic',
  name: '',
  role: '',
  accent: '#8b949e',
  look: { body: 'robot', head: 'robot' }
}

export const characterLabel = (c: Character): string => c.name.trim() || (c.id === GENERIC_CHARACTER.id ? 'Generic' : 'Unnamed')

const HUMANS = CHARACTER_MODELS.filter((m) => m.startsWith('female') || m.startsWith('male'))
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]

/** A random human look: the fantasy models are there to pick, not to land on. */
export function randomLook(): CharacterLook {
  return { body: pick(HUMANS), head: pick(HUMANS) }
}

interface CharactersState {
  characters: Character[]
  /** Session id → character id. */
  assignments: Record<string, string>
  /** Adds a character with a random look and returns its id. */
  addCharacter: (init?: Partial<Omit<Character, 'id'>>) => string
  updateCharacter: (id: string, patch: Partial<Omit<Character, 'id'>>) => void
  /** Removes a character and unassigns it from every session. */
  removeCharacter: (id: string) => void
  /** Assigns a character to a session; null reverts it to the generic one. */
  assign: (sid: string, characterId: string | null) => void
  /** Drops assignments for sessions that no longer exist. */
  pruneAssignments: (liveIds: Set<string>) => void
}

const newId = (): string => `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const useCharactersStore = create<CharactersState>()(
  persist(
    (set) => ({
      characters: [],
      assignments: {},

      addCharacter: (init = {}) => {
        const id = newId()
        set((s) => ({
          characters: [
            ...s.characters,
            {
              id,
              name: '',
              role: '',
              // Prefer an accent no other character uses.
              accent: CHARACTER_ACCENTS.find((a) => !s.characters.some((c) => c.accent === a)) ?? pick(CHARACTER_ACCENTS),
              look: randomLook(),
              ...init
            }
          ]
        }))
        return id
      },
      updateCharacter: (id, patch) =>
        set((s) => ({ characters: s.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
      removeCharacter: (id) =>
        set((s) => ({
          characters: s.characters.filter((c) => c.id !== id),
          assignments: Object.fromEntries(Object.entries(s.assignments).filter(([, cid]) => cid !== id))
        })),
      assign: (sid, characterId) =>
        set((s) => {
          const assignments = { ...s.assignments }
          if (characterId) assignments[sid] = characterId
          else delete assignments[sid]
          return { assignments }
        }),
      pruneAssignments: (liveIds) =>
        set((s) => {
          const kept = Object.entries(s.assignments).filter(([sid]) => liveIds.has(sid))
          return kept.length === Object.keys(s.assignments).length ? s : { assignments: Object.fromEntries(kept) }
        })
    }),
    { name: 'agent-studio.characters', version: 1 }
  )
)

/** The character a session shows: its assigned one, or the generic character. */
export function useSessionCharacter(sid: string): Character {
  return useCharactersStore((s) => {
    const id = s.assignments[sid]
    return (id && s.characters.find((c) => c.id === id)) || GENERIC_CHARACTER
  })
}
