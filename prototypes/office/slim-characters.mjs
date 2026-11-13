// Slims the Kenney Mini Characters for the app: keeps only the animations the
// office uses, drops the external texture reference (the app supplies the
// shared colormap itself), prunes unused data. Run from prototypes/office:
//   node slim-characters.mjs
import { NodeIO } from '@gltf-transform/core'
import { prune, dedup } from '@gltf-transform/functions'
import fs from 'node:fs'
import path from 'node:path'

const SRC = 'assets/mini-characters/Models/GLB format'
const OUT = '../../src/renderer/src/assets/office/characters'
const KEEP = new Set(['idle', 'walk', 'sprint', 'sit', 'interact-right', 'emote-yes', 'emote-no', 'pick-up'])

const io = new NodeIO()
for (const f of fs.readdirSync(SRC).filter((f) => /^character-.*\.glb$/.test(f))) {
  const doc = await io.read(path.join(SRC, f))
  const root = doc.getRoot()
  for (const a of root.listAnimations()) if (!KEEP.has(a.getName())) a.dispose()
  for (const m of root.listMaterials()) m.setBaseColorTexture(null)
  for (const t of root.listTextures()) t.dispose()
  // keepAttributes: the UVs index the shared colormap even with no texture attached.
  await doc.transform(prune({ keepAttributes: true }), dedup())
  await io.write(path.join(OUT, f), doc)
}
