// The office: a three.js scene of the session floor (exec office, glass meeting
// room, kitchen, lounge, open-plan desks) with a character per session at its
// seat. Ported from prototypes/office/office.html, the approved reference.
// Imported lazily by OfficeView, so three.js costs nothing until it's opened.
//
// Everything static is merged into a handful of draw calls and its shadows are
// baked once; characters cast a soft blob instead. Rendering is capped at
// 30 fps and stops while the window is hidden.

import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { CharacterLook } from '../characters-store'
import { buildCharacter } from './three-characters'

export type ActorState = 'working' | 'waiting' | 'done' | 'scheduled' | 'idle'

export interface OfficeActor {
  sid: string
  look: CharacterLook
  accent: string
  /** The name tag: the character's name, or the session title. */
  name: string
  role: string
  /** Tooltip: session title and status. */
  tooltip: string
  state: ActorState
  /** Desk index this actor owns (stable across states). */
  desk: number
  /** When idle, the lounge/kitchen seat it relaxes in, if any. */
  relax: number | null
}

export interface Office {
  setActors: (actors: OfficeActor[]) => void
  /** Number of desks; actors beyond this aren't placed. */
  readonly deskCount: number
  readonly relaxCount: number
  dispose: () => void
}

// ---------------------------------------------------------------- assets

const FURNITURE = import.meta.glob<string>('../assets/office/furniture/*.glb', { query: '?inline', import: 'default' })
const loader = new GLTFLoader()
const furniture = new Map<string, Promise<GLTF>>()
function loadFurniture(name: string): Promise<GLTF> {
  let p = furniture.get(name)
  if (!p) {
    const src = FURNITURE[`../assets/office/furniture/${name}.glb`]
    if (!src) throw new Error(`Unknown furniture: ${name}`)
    p = src().then((url) => {
      const bin = atob(url.slice(url.indexOf(',') + 1))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return loader.parseAsync(bytes.buffer, '')
    })
    furniture.set(name, p)
  }
  return p
}

// ---------------------------------------------------------------- textures (drawn in code)

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void
function tex(w: number, h: number, draw: Draw, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (repeat) t.repeat.set(...repeat)
  return t
}
// Seeded, so the room looks the same every time it's opened.
function seeded(seed: number): () => number {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}
const shade = (hex: string, f: number): string => {
  const c = new THREE.Color(hex)
  c.offsetHSL(0, 0, f)
  return '#' + c.getHexString()
}

function makeTextures() {
  const rnd = seeded(7)
  const woodGrain = (base: string, w = 512, h = 256, planks = 1, contrast = 1): Draw => (g) => {
    g.fillStyle = base
    g.fillRect(0, 0, w, h)
    for (let p = 0; p < planks; p++) {
      const y0 = (h / planks) * p
      const ph = h / planks
      g.fillStyle = shade(base, (rnd() - 0.5) * 0.06 * contrast)
      g.fillRect(0, y0, w, ph)
      for (let i = 0; i < 46; i++) {
        const y = y0 + rnd() * ph
        const amp = 1 + rnd() * 3
        g.strokeStyle = rnd() < 0.5 ? shade(base, -0.05 - rnd() * 0.06) : shade(base, 0.03 + rnd() * 0.04)
        g.globalAlpha = (0.35 + rnd() * 0.4) * contrast
        g.lineWidth = 0.6 + rnd() * 1.6
        g.beginPath()
        g.moveTo(0, y)
        for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x / (40 + rnd() * 30) + i) * amp)
        g.stroke()
      }
      g.globalAlpha = 1
      if (planks > 1) {
        g.fillStyle = shade(base, -0.07 * contrast)
        g.fillRect(0, y0, w, 2)
        g.fillRect(rnd() * w, y0, 2, ph)
      }
    }
  }
  return {
    rnd,
    walnut: tex(512, 256, woodGrain('#8b5a36')),
    walnutDark: tex(512, 256, woodGrain('#5f3b23')),
    floorWood: tex(512, 512, woodGrain('#4b3326', 512, 512, 8, 0.45), [3, 3]),
    carpet: tex(256, 256, (g, w, h) => {
      for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
        g.fillStyle = shade('#6d7585', (rnd() - 0.5) * 0.025)
        g.fillRect(tx * 128, ty * 128, 128, 128)
      }
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(40,46,58,.28)' : 'rgba(150,160,178,.22)'
        g.fillRect(rnd() * w, rnd() * h, 1.2, 1.2)
      }
      g.strokeStyle = 'rgba(30,35,45,.16)'
      g.lineWidth = 1.5
      g.strokeRect(1, 1, 127, 127); g.strokeRect(129, 1, 126, 127); g.strokeRect(1, 129, 127, 126); g.strokeRect(129, 129, 126, 126)
    }),
    tile: tex(256, 256, (g, w, h) => {
      for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
        const grd = g.createLinearGradient(tx * 128, ty * 128, tx * 128 + 128, ty * 128 + 128)
        grd.addColorStop(0, shade('#e2ded6', 0.02))
        grd.addColorStop(1, shade('#d2cdc3', (rnd() - 0.5) * 0.02))
        g.fillStyle = grd
        g.fillRect(tx * 128, ty * 128, 128, 128)
      }
      g.strokeStyle = '#b8b2a7'
      g.lineWidth = 4
      for (let i = 0; i <= 2; i++) {
        g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, h); g.stroke()
        g.beginPath(); g.moveTo(0, i * 128); g.lineTo(w, i * 128); g.stroke()
      }
    }),
    rug: tex(512, 384, (g, w, h) => {
      g.fillStyle = '#7f8794'; g.fillRect(0, 0, w, h)
      g.strokeStyle = '#5e6572'; g.lineWidth = 18; g.strokeRect(18, 18, w - 36, h - 36)
      g.strokeStyle = '#a3aab5'; g.lineWidth = 4; g.strokeRect(40, 40, w - 80, h - 80)
      for (let i = 0; i < 6000; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.06)'
        g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5)
      }
    }),
    wall: tex(64, 256, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h)
      grd.addColorStop(0, '#2b3f60'); grd.addColorStop(1, '#152238')
      g.fillStyle = grd; g.fillRect(0, 0, w, h)
    }),
    glass: tex(256, 128, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, w, h)
      grd.addColorStop(0, '#9fe3f2'); grd.addColorStop(1, '#4fb3cd')
      g.fillStyle = grd; g.fillRect(0, 0, w, h)
      g.fillStyle = 'rgba(255,255,255,.35)'
      g.beginPath(); g.moveTo(w * 0.15, 0); g.lineTo(w * 0.3, 0); g.lineTo(w * 0.12, h); g.lineTo(0, h); g.fill()
      g.fillStyle = 'rgba(255,255,255,.18)'
      g.beginPath(); g.moveTo(w * 0.42, 0); g.lineTo(w * 0.48, 0); g.lineTo(w * 0.3, h); g.lineTo(w * 0.24, h); g.fill()
    }),
    drawers: tex(128, 256, (g, w) => {
      g.fillStyle = '#3a4252'; g.fillRect(0, 0, w, 256)
      for (let i = 0; i < 2; i++) {
        g.fillStyle = '#454e60'; g.fillRect(8, 10 + i * 124, w - 16, 112)
        g.fillStyle = '#9aa4b2'; g.fillRect(w / 2 - 18, 22 + i * 124, 36, 7)
      }
    }),
    cabinet: tex(256, 512, (g, w) => {
      g.fillStyle = '#4a5468'; g.fillRect(0, 0, w, 512)
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#56617a'; g.fillRect(10, 10 + i * 125, w - 20, 113)
        g.fillStyle = '#c3cad4'; g.fillRect(w / 2 - 26, 24 + i * 125, 52, 8)
      }
    }),
    keyboard: tex(256, 96, (g, w, h) => {
      g.fillStyle = '#20252e'; g.fillRect(0, 0, w, h)
      for (let r = 0; r < 4; r++) for (let c = 0; c < 15; c++) { g.fillStyle = '#3b4250'; g.fillRect(8 + c * 16, 10 + r * 20, 13, 15) }
    }),
    paper: tex(128, 160, (g, w, h) => {
      g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, w, h)
      g.fillStyle = '#9aa3b0'
      for (let i = 0; i < 9; i++) g.fillRect(14, 18 + i * 14, 50 + ((i * 37) % 50), 4)
    }),
    printer: tex(256, 256, (g, w, h) => {
      g.fillStyle = '#e4e7eb'; g.fillRect(0, 0, w, h)
      g.fillStyle = '#c4c9d0'; g.fillRect(0, 150, w, 10)
      g.fillStyle = '#2f3540'; g.fillRect(20, 30, 90, 40)
      g.fillStyle = '#4fd1c5'; g.fillRect(28, 38, 30, 10)
      g.fillStyle = '#9aa3ad'; g.fillRect(20, 190, w - 40, 30)
    }),
    server: tex(128, 512, (g, w) => {
      g.fillStyle = '#1b2029'; g.fillRect(0, 0, w, 512)
      for (let i = 0; i < 16; i++) {
        g.fillStyle = '#272e3a'; g.fillRect(8, 8 + i * 31, w - 16, 25)
        g.fillStyle = i % 3 ? '#39d98a' : '#4c9aff'; g.fillRect(w - 26, 18 + i * 31, 6, 6)
      }
    }),
    art: ([['#7fb6d6', '#3e6f8f', '#e3c27a'], ['#c9e0e8', '#4f7c62', '#2f5a7a'], ['#f2c6a0', '#8a5a7a', '#3c5a8a']] as const).map(
      ([sky, hills, accent]) =>
        tex(256, 160, (g, w, h) => {
          const grd = g.createLinearGradient(0, 0, 0, h)
          grd.addColorStop(0, sky); grd.addColorStop(1, '#ffffff')
          g.fillStyle = grd; g.fillRect(0, 0, w, h)
          g.fillStyle = hills
          g.beginPath(); g.moveTo(0, h)
          for (let x = 0; x <= w; x += 8) g.lineTo(x, h * 0.62 - Math.sin(x / 38) * 18 - Math.sin(x / 13) * 4)
          g.lineTo(w, h); g.fill()
          g.fillStyle = accent
          g.beginPath(); g.arc(w * 0.72, h * 0.3, 16, 0, Math.PI * 2); g.fill()
          g.strokeStyle = '#2b2f36'; g.lineWidth = 14; g.strokeRect(0, 0, w, h)
        })
    ),
    fabric: tex(128, 128, (g, w, h) => {
      for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
        const twill = (x / 4 + y / 4) % 4 < 2 ? 34 : -18
        const v = 128 + twill + (rnd() - 0.5) * 30
        g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 4, 4)
      }
      for (let i = 0; i < 14; i++) {
        const r = g.createRadialGradient(rnd() * w, rnd() * h, 0, rnd() * w, rnd() * h, 30)
        r.addColorStop(0, 'rgba(255,255,255,.10)'); r.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = r; g.fillRect(0, 0, w, h)
      }
    }),
    blob: tex(64, 64, (g) => {
      const r = g.createRadialGradient(32, 32, 1, 32, 32, 31)
      r.addColorStop(0, 'rgba(0,0,0,1)'); r.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = r; g.fillRect(0, 0, 64, 64)
    })
  }
}

function dashboard(accent: string): THREE.CanvasTexture {
  return tex(256, 160, (g) => {
    g.fillStyle = '#0d2a4a'; g.fillRect(0, 0, 256, 160)
    g.fillStyle = accent; g.fillRect(0, 0, 256, 20)
    g.fillStyle = '#2b5f93'; g.fillRect(10, 30, 68, 120)
    g.fillStyle = '#9fd4ff'
    for (let i = 0; i < 6; i++) g.fillRect(16, 38 + i * 18, 40 + ((i * 13) % 20), 6)
    g.fillStyle = '#1c4a78'; g.fillRect(90, 30, 156, 70)
    g.strokeStyle = accent; g.lineWidth = 4
    g.beginPath(); g.moveTo(96, 92)
    for (let i = 0; i <= 8; i++) g.lineTo(96 + i * 18, 92 - [8, 30, 18, 44, 26, 52, 36, 58, 48][i])
    g.stroke()
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#3d7dbf' : '#5fa8e8'; g.fillRect(90 + i * 40, 110, 32, 40) }
  })
}

// ---------------------------------------------------------------- layout

const W = 16
const D = 11
const DESK_Y = 0.56
const SEAT_Y = 0.24
const S = 1.5 // furniture-kit scale

interface Seat {
  x: number
  z: number
  rotY: number
  y: number
}
const OPEN_DESKS: [number, number][] = [0.4, 3.4].flatMap((z) => [-5.9, -4.4, -1.6, -0.1].map((x) => [x, z] as [number, number]))
/** Desks in the order sessions take them: the open plan, then the exec office,
 *  then the meeting table as overflow. */
const DESK_SEATS: Seat[] = [
  ...OPEN_DESKS.map(([x, z]) => ({ x, z: z + 0.68, rotY: Math.PI, y: SEAT_Y })),
  { x: -6.0, z: -3.0, rotY: Math.PI, y: SEAT_Y },
  ...[0, 1, 2, 3].map((i) => ({ x: -1.35 + i * 0.9, z: -2.5, rotY: Math.PI, y: SEAT_Y })),
  ...[0, 1, 2, 3].map((i) => ({ x: -1.35 + i * 0.9, z: -4.3, rotY: 0, y: SEAT_Y }))
]
/** Where idle characters relax, in the order they fill up: one per spot
 *  around the floor first (so name tags don't collide), then the second seat
 *  at each. */
const RELAX_SEATS: Seat[] = [
  { x: 5.15, z: 2.12, rotY: 0, y: 0.12 }, // lounge sofa
  { x: 4.5, z: -2.9, rotY: Math.PI / 2, y: SEAT_Y }, // kitchen table
  { x: -6.65, z: -1.9, rotY: Math.PI / 2, y: 0.12 }, // exec armchair
  { x: 5.85, z: 3.83, rotY: Math.PI, y: 0.12 }, // far sofa
  { x: 6.3, z: -2.9, rotY: -Math.PI / 2, y: SEAT_Y },
  { x: -5.55, z: -1.9, rotY: -Math.PI / 2, y: 0.12 },
  { x: 5.95, z: 2.12, rotY: 0, y: 0.12 },
  { x: 5.05, z: 3.83, rotY: Math.PI, y: 0.12 }
]

// ---------------------------------------------------------------- the scene

export async function createOffice(container: HTMLElement, onOpen: (sid: string) => void): Promise<Office> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.VSMShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.domElement.className = 'office-canvas'
  container.appendChild(renderer.domElement)
  const labels = new CSS2DRenderer()
  labels.domElement.className = 'office-labels'
  container.appendChild(labels.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0c1320)
  const statics = new THREE.Group()
  scene.add(statics)

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  camera.position.set(0, 12, 7.2)
  camera.lookAt(0, 0, 0.25)

  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x5d6575, 1.9))
  const sun = new THREE.DirectionalLight(0xfff1de, 2.3)
  sun.position.set(-5, 12, 6)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.radius = 5
  sun.shadow.blurSamples = 16
  sun.shadow.bias = -0.0004
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 8, bottom: -8 })
  scene.add(sun)
  const rim = new THREE.DirectionalLight(0xbfd4ff, 0.55)
  rim.position.set(6, 7, -8)
  scene.add(rim)

  const T = makeTextures()

  // ---- materials
  const matCache = new Map<string, THREE.MeshStandardMaterial>()
  const mat = (color: number, map?: THREE.Texture | null, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial => {
    const key = `${color}|${map ? map.uuid : ''}|${JSON.stringify(extra)}`
    let m = matCache.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, map: map ?? null, roughness: 0.82, metalness: 0, ...extra })
      matCache.set(key, m)
    }
    return m
  }
  // Upholstery: woven fabric projected in world space (works on any model and
  // survives merging), darkening toward the floor for depth.
  const fabricCache = new Map<number, THREE.MeshStandardMaterial>()
  const fabricMat = (color: number): THREE.MeshStandardMaterial => {
    let m = fabricCache.get(color)
    if (m) return m
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 })
    m.onBeforeCompile = (sh) => {
      sh.uniforms.fabric = { value: T.fabric }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * objectNormal);'
        )
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D fabric; varying vec3 vWPos; varying vec3 vWNrm;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec3 bw = pow(abs(vWNrm), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
          float f = texture2D(fabric, vWPos.zy * 3.2).r * bw.x + texture2D(fabric, vWPos.xz * 3.2).r * bw.y + texture2D(fabric, vWPos.xy * 3.2).r * bw.z;
          diffuseColor.rgb *= (0.62 + 0.75 * f) * mix(0.55, 1.18, smoothstep(0.15, 0.95, vWPos.y));`
        )
    }
    m.customProgramCacheKey = () => 'fabric'
    fabricCache.set(color, m)
    return m
  }
  const M = {
    walnut: mat(0xffffff, T.walnut),
    walnutDark: mat(0xffffff, T.walnutDark),
    wall: mat(0xffffff, T.wall),
    wallCap: mat(0x34496b),
    glass: mat(0xffffff, T.glass, { roughness: 0.25 }),
    frame: mat(0x16233a),
    metalDark: mat(0x2b313c),
    drawers: mat(0xffffff, T.drawers),
    cabinet: mat(0xffffff, T.cabinet),
    keyboard: mat(0xffffff, T.keyboard),
    paper: mat(0xffffff, T.paper),
    white: mat(0xf2f2f0),
    counter: mat(0xe9e6df),
    printer: mat(0xffffff, T.printer),
    server: mat(0xffffff, T.server),
    screenOff: new THREE.MeshBasicMaterial({ color: 0x18202b }),
    planter: mat(0x3a4250),
    soil: mat(0x4a3628),
    mug: [mat(0xffffff), mat(0xd9604c), mat(0x4c9aff)]
  }

  // ---- builders
  type Faces = THREE.Material | { side: THREE.Material; top?: THREE.Material; front?: THREE.Material; back?: THREE.Material }
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: Faces, rotY = 0): THREE.Mesh => {
    const mm = m instanceof THREE.Material ? m : [m.side, m.side, m.top ?? m.side, m.side, m.front ?? m.side, m.back ?? m.side]
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mm)
    mesh.position.set(x, y + h / 2, z)
    mesh.rotation.y = rotY
    mesh.castShadow = mesh.receiveShadow = true
    statics.add(mesh)
    return mesh
  }
  // Soft dark patch under furniture: cheap contact shadow.
  const aoMats = new Map<number, THREE.MeshBasicMaterial>()
  const ao = (x: number, z: number, w: number, d: number, o = 0.42): void => {
    let m = aoMats.get(o)
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: T.blob, transparent: true, opacity: o, depthWrite: false, color: 0x000000 })
      aoMats.set(o, m)
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, 0.012, z)
    mesh.renderOrder = 1
    scene.add(mesh)
  }
  // Zone floors sit a hair above the carpet so they never z-fight with it.
  let floorLayer = 0
  const floor = (x: number, z: number, w: number, d: number, t: THREE.Texture, tile = 2): void => {
    const tt = t.clone()
    tt.needsUpdate = true
    tt.repeat.set(w / tile, d / tile)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0xffffff, tt))
    m.rotation.x = -Math.PI / 2
    m.position.set(x, 0.001 + 0.0015 * floorLayer++, z)
    m.receiveShadow = true
    scene.add(m)
  }
  const REMAP: Record<string, number> = {
    wood: 0x8b5a36, woodDark: 0x5f3b23, carpet: 0x2c4f86, carpetWhite: 0xeeeeee, metal: 0x9aa3ad,
    metalMedium: 0x343b47, metalDark: 0x2b313c, metalLight: 0xe3e7ec, plant: 0x3f9a4a, lamp: 0xfff1c8, glass: 0x9fe3f2
  }
  const prop = async (
    name: string, x: number, z: number, rotY = 0, y = 0,
    opts: { remap?: Record<string, number>; s?: number; ao?: boolean } = {}
  ): Promise<void> => {
    const g = await loadFurniture(name)
    const inner = g.scene.clone(true)
    inner.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = mesh.receiveShadow = true
      const src = mesh.material as THREE.MeshStandardMaterial
      const r = { ...REMAP, ...(opts.remap ?? {}) }[src.name]
      const color = r !== undefined ? r : src.color.getHex()
      mesh.material = src.name === 'carpet' ? fabricMat(color) : mat(color)
    })
    const bb = new THREE.Box3().setFromObject(inner)
    const c = bb.getCenter(new THREE.Vector3())
    inner.position.set(-c.x, -bb.min.y, -c.z)
    const holder = new THREE.Group()
    holder.add(inner)
    const s = opts.s ?? S
    holder.scale.setScalar(s)
    holder.rotation.y = rotY
    holder.position.set(x, y, z)
    statics.add(holder)
    if (!y && opts.ao !== false) {
      const sz = bb.getSize(new THREE.Vector3()).multiplyScalar(s)
      const sw = Math.abs(Math.sin(rotY)) > 0.5
      ao(x, z, (sw ? sz.z : sz.x) * 1.35, (sw ? sz.x : sz.z) * 1.35)
    }
  }

  const WALL_H = 0.62
  const WT = 0.2
  const wall = (x1: number, z1: number, x2: number, z2: number, glass = 0): void => {
    const horiz = z1 === z2
    const len = Math.abs(horiz ? x2 - x1 : z2 - z1)
    const cx = (x1 + x2) / 2
    const cz = (z1 + z2) / 2
    box(horiz ? len : WT, WALL_H, horiz ? WT : len, cx, 0, cz, { side: M.wall, top: M.wallCap })
    box(horiz ? len + WT : WT + 0.04, 0.05, horiz ? WT + 0.04 : len + WT, cx, WALL_H, cz, M.wallCap)
    if (!glass) return
    const n = Math.max(1, Math.round(len / glass))
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      const px = horiz ? x1 + (x2 - x1) * t : cx
      const pz = horiz ? cz : z1 + (z2 - z1) * t
      const pane = (len / n) * 0.78
      box(horiz ? pane : WT + 0.05, 0.36, horiz ? WT + 0.05 : pane, px, 0.17, pz, { side: M.glass, top: M.frame })
    }
  }
  const glassPartition = (x1: number, x2: number, z: number): void => {
    const len = x2 - x1
    box(len, 0.06, 0.1, (x1 + x2) / 2, 0, z, M.frame)
    box(len, 0.5, 0.06, (x1 + x2) / 2, 0.06, z, { side: M.glass, top: M.frame })
    for (let x = x1; x <= x2 + 0.01; x += len / 4) box(0.1, 0.6, 0.12, x, 0, z, M.frame)
  }
  const screens: THREE.Mesh[] = []
  const screen = (x: number, y: number, z: number, w = 0.56, h = 0.31, material: THREE.Material = M.screenOff): THREE.Mesh => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material)
    s.position.set(x, y, z)
    scene.add(s)
    return s
  }
  const workstation = (x: number, z: number, clutter: number): void => {
    const w = 1.3
    const d = 0.62
    box(w, 0.05, d, x, DESK_Y, z, { top: M.walnut, side: M.walnutDark })
    box(w - 0.08, 0.32, 0.03, x, DESK_Y - 0.33, z - d / 2 + 0.04, M.walnutDark)
    box(0.04, DESK_Y, 0.04, x - w / 2 + 0.05, 0, z + d / 2 - 0.05, M.metalDark)
    box(0.04, DESK_Y, 0.04, x - w / 2 + 0.05, 0, z - d / 2 + 0.05, M.metalDark)
    box(0.32, DESK_Y - 0.02, d - 0.06, x + w / 2 - 0.2, 0, z, { side: M.metalDark, front: M.drawers, top: M.metalDark })
    ao(x, z, w * 1.3, d * 1.6)
    box(0.16, 0.012, 0.1, x, DESK_Y + 0.05, z - 0.14, M.metalDark)
    box(0.04, 0.16, 0.03, x, DESK_Y + 0.06, z - 0.16, M.metalDark)
    box(0.62, 0.36, 0.035, x, DESK_Y + 0.16, z - 0.17, M.frame)
    screens.push(screen(x, DESK_Y + 0.34, z - 0.15))
    box(0.46, 0.018, 0.14, x, DESK_Y + 0.05, z + 0.08, { top: M.keyboard, side: M.metalDark })
    box(0.06, 0.02, 0.09, x + 0.32, DESK_Y + 0.05, z + 0.1, M.metalDark)
    if (clutter % 3 === 0) {
      box(0.22, 0.008, 0.3, x - 0.45, DESK_Y + 0.05, z + 0.02, M.paper, 0.2)
      box(0.22, 0.008, 0.3, x - 0.43, DESK_Y + 0.058, z + 0.04, M.paper, -0.1)
    }
    if (clutter % 3 === 1) {
      box(0.16, 0.05, 0.12, x - 0.48, DESK_Y + 0.05, z - 0.05, M.metalDark)
      box(0.05, 0.03, 0.11, x - 0.48, DESK_Y + 0.1, z - 0.05, M.metalDark)
    }
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.09, 14), M.mug[clutter % 3])
    mug.position.set(x + 0.48, DESK_Y + 0.095, z + 0.12)
    mug.castShadow = true
    statics.add(mug)
  }
  const coffeeTable = (x: number, z: number, w: number, d: number, h = 0.32): void => {
    box(w, 0.05, d, x, h - 0.05, z, { top: M.walnut, side: M.walnutDark })
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(0.05, h - 0.05, 0.05, x + sx * (w / 2 - 0.06), 0, z + sz * (d / 2 - 0.06), M.walnutDark)
    box(w - 0.12, 0.03, d - 0.12, x, 0.08, z, M.walnutDark)
    ao(x, z, w * 1.4, d * 1.5, 0.3)
  }
  const roundTable = (x: number, z: number, r = 0.45, h = 0.56): void => {
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 40), [M.walnutDark, M.walnut, M.walnut])
    top.position.set(x, h - 0.025, z)
    top.castShadow = top.receiveShadow = true
    statics.add(top)
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h - 0.05, 16), M.metalDark)
    post.position.set(x, (h - 0.05) / 2, z)
    post.castShadow = true
    statics.add(post)
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.03, 24), M.metalDark)
    foot.position.set(x, 0.015, z)
    statics.add(foot)
    ao(x, z, r * 2.6, r * 2.6, 0.35)
  }
  const bookMats = [0x2d4a7a, 0x8b1e3f, 0xd9a441, 0x3f9a4a, 0xe9e6df, 0x5c4a8a, 0xc0583a].map((c) => mat(c))
  const bookcase = (x: number, z: number, w = 0.9, h = 1.05, d = 0.32): void => {
    box(w, 0.04, d, x, h - 0.04, z, { top: M.walnut, side: M.walnutDark })
    box(0.04, h - 0.04, d, x - w / 2 + 0.02, 0, z, M.walnutDark)
    box(0.04, h - 0.04, d, x + w / 2 - 0.02, 0, z, M.walnutDark)
    box(w, h, 0.02, x, 0, z - d / 2 + 0.01, M.walnutDark)
    for (let sh = 0; sh < 3; sh++) {
      const y = 0.04 + sh * 0.32
      box(w - 0.06, 0.025, d - 0.02, x, y, z, M.walnut)
      let bx = x - w / 2 + 0.07
      for (let i = 0; bx < x + w / 2 - 0.12; i++) {
        const bw = 0.04 + ((i * 7 + sh * 3) % 4) * 0.012
        const bh = 0.18 + ((i * 5 + sh) % 3) * 0.03
        box(bw, bh, d - 0.08, bx + bw / 2, y + 0.025, z + 0.01, bookMats[(i * 3 + sh * 2) % bookMats.length])
        bx += bw + 0.008
      }
    }
    ao(x, z, w * 1.3, d * 2.2, 0.35)
  }
  const planter = async (x: number, z: number, len: number): Promise<void> => {
    box(len, 0.32, 0.26, x, 0, z, { side: M.planter, top: M.soil })
    ao(x, z, len * 1.2, 0.6)
    for (let i = 0; i < Math.round(len / 0.45); i++)
      await prop(['plantSmall1', 'plantSmall2', 'plantSmall3'][i % 3], x - len / 2 + 0.25 + i * 0.45, z, i * 1.3, 0.32, { s: 1.6, ao: false })
  }

  // ---- floors, rugs, walls
  floor(0, 0, W, D, T.carpet, 1.3)
  floor(-5.5, -3.25, 5, 4.5, T.floorWood)
  floor(5.5, -3.25, 5, 4.5, T.tile, 1.2)
  floor(5.5, 2.3, 4.8, 6.4, T.floorWood, 3)
  const rugM = mat(0xffffff, T.rug)
  for (const [x, z, w, d] of [[-6.1, -2.2, 2.4, 1.7], [5.5, 2.9, 3.2, 2.3]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), rugM)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, 0.006, z)
    m.receiveShadow = true
    scene.add(m)
  }
  wall(-W / 2, -D / 2, W / 2, -D / 2, 1.6)
  wall(-W / 2, -D / 2, -W / 2, D / 2, 1.6)
  wall(W / 2, -D / 2, W / 2, D / 2, 1.6)
  wall(-W / 2, -1.0, -4.3, -1.0)
  wall(-3.4, -1.0, -3.0, -1.0)
  wall(-3.0, -D / 2, -3.0, -1.0)
  wall(3.0, -D / 2, 3.0, -1.0)
  wall(3.0, -1.0, 4.4, -1.0)
  wall(5.3, -1.0, 8, -1.0)
  glassPartition(-3.0, 3.0, -1.0)
  wall(3.0, 1.4, 3.0, D / 2)

  // ---- open plan
  OPEN_DESKS.forEach(([x, z], i) => workstation(x, z, i))
  for (const z of [0.4, 3.4]) await planter(-3.0, z - 0.05, 1.2)
  for (const [x, z] of OPEN_DESKS) await prop('chairDesk', x, z + 0.68, Math.PI, 0, { ao: false })

  // ---- exec office (its desk is DESK_SEATS[8])
  box(2.0, 0.06, 0.85, -6.0, 0.6, -3.6, { top: M.walnut, side: M.walnutDark })
  box(1.9, 0.58, 0.08, -6.0, 0.02, -3.98, M.walnutDark)
  box(0.45, 0.58, 0.75, -6.75, 0.02, -3.6, M.walnutDark)
  box(0.45, 0.58, 0.75, -5.25, 0.02, -3.6, M.walnutDark)
  ao(-6.0, -3.6, 2.6, 1.3)
  box(0.62, 0.36, 0.035, -6.0, 0.66, -3.85, M.frame)
  screens.push(screen(-6.0, 0.84, -3.83))
  await prop('lampSquareTable', -6.75, -3.55, 0, 0.66, { ao: false })
  await prop('chairDesk', -6.0, -3.0, Math.PI, 0, { remap: { carpet: 0x6e2a2a } })
  bookcase(-7.25, -5.18)
  box(1.5, 0.45, 0.42, -4.1, 0, -5.05, { side: M.walnutDark, top: M.walnut, front: M.drawers })
  await prop('loungeChair', -6.7, -1.9, Math.PI / 2)
  await prop('loungeChair', -5.5, -1.9, -Math.PI / 2)
  coffeeTable(-6.1, -1.9, 0.6, 0.6)
  await prop('pottedPlant', -3.5, -4.95, 0)

  // ---- meeting room (overflow desks)
  box(3.6, 0.06, 1.15, 0, 0.56, -3.4, { top: M.walnut, side: M.walnutDark })
  box(0.12, 0.56, 0.6, -1.4, 0, -3.4, M.metalDark)
  box(0.12, 0.56, 0.6, 1.4, 0, -3.4, M.metalDark)
  ao(0, -3.4, 4.6, 1.9)
  for (let i = 0; i < 4; i++) {
    await prop('chairDesk', -1.35 + i * 0.9, -4.3, 0, 0, { ao: false })
    await prop('chairDesk', -1.35 + i * 0.9, -2.5, Math.PI, 0, { ao: false })
  }
  box(0.24, 0.008, 0.32, -0.6, 0.62, -3.5, M.paper, 0.15)
  box(0.24, 0.008, 0.32, 0.8, 0.62, -3.3, M.paper, -0.2)
  await prop('plantSmall2', 0, -3.4, 0, 0.62, { ao: false })
  box(1.7, 0.95, 0.06, 0, 0.2, -5.32, M.frame)
  screen(0, 0.675, -5.285, 1.6, 0.85, new THREE.MeshBasicMaterial({ map: dashboard('#39c5cf') }))
  await prop('pottedPlant', -2.55, -4.95, 0)
  await prop('pottedPlant', 2.55, -4.95, 0)

  // ---- kitchen
  box(2.6, 0.55, 0.6, 4.6, 0, -5.0, { side: M.cabinet, front: M.cabinet, top: M.counter })
  ao(4.6, -5.0, 3.2, 1.0)
  await prop('kitchenCoffeeMachine', 4.0, -5.05, 0, 0.55, { ao: false })
  await prop('kitchenMicrowave', 5.1, -5.05, 0, 0.55, { ao: false })
  await prop('kitchenFridge', 6.75, -4.95, 0)
  roundTable(5.4, -2.9)
  await prop('chairCushion', 4.45, -2.9, Math.PI / 2, 0, { ao: false })
  await prop('chairCushion', 6.35, -2.9, -Math.PI / 2, 0, { ao: false })
  await prop('pottedPlant', 7.45, -1.6, 0)

  // ---- lounge
  await prop('loungeSofa', 5.5, 2.0, 0)
  await prop('loungeSofa', 5.5, 3.95, Math.PI)
  coffeeTable(5.5, 2.95, 1.1, 0.55)
  await prop('lampRoundFloor', 7.3, 1.2, 0)
  await prop('pottedPlant', 3.6, 4.95, 0)
  await prop('pottedPlant', 7.4, 4.95, 0)

  // ---- extras
  box(0.8, 0.55, 0.6, 1.75, 0, -0.55, { side: M.printer, front: M.printer, top: M.white })
  box(0.6, 1.05, 0.6, 2.5, 0, -0.55, { side: M.metalDark, front: M.server, top: M.metalDark })
  ao(2.1, -0.5, 2.0, 1.0)
  for (let i = 0; i < 2; i++) box(0.5, 0.75, 0.48, -7.5, 0, 1.6 + i * 0.55, { side: M.metalDark, front: M.cabinet, top: M.metalDark }, -Math.PI / 2)
  ao(-7.4, 1.88, 0.8, 1.3)
  await prop('pottedPlant', -7.4, 5.0, 0)
  await prop('pottedPlant', 2.3, 5.0, 0)
  const art = (i: number, x: number, z: number, w = 1.0, h = 0.55): void => {
    const m = screen(x, 0.3, z, w, h, new THREE.MeshBasicMaterial({ map: T.art[i] }))
    m.rotation.x = -0.15
  }
  art(0, -5.6, -5.38)
  art(1, 1.6, -5.38, 0.8, 0.45)
  art(2, 5.5, -5.38, 0.8, 0.45)

  mergeStatics(statics)
  renderer.shadowMap.needsUpdate = true

  // ---------------------------------------------------------------- actors

  interface Live {
    a: OfficeActor
    root: THREE.Group
    model: THREE.Object3D | null
    mixer: THREE.AnimationMixer | null
    clips: THREE.AnimationClip[]
    clip: string
    label: HTMLDivElement
    lookKey: string
    token: number
  }
  const live = new Map<string, Live>()
  const blobMat = new THREE.MeshBasicMaterial({ map: T.blob, transparent: true, opacity: 0.35, depthWrite: false, color: 0x000000 })
  const dashboards = new Map<string, THREE.MeshBasicMaterial>()
  const dashFor = (accent: string): THREE.MeshBasicMaterial => {
    let m = dashboards.get(accent)
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: dashboard(accent) })
      dashboards.set(accent, m)
    }
    return m
  }

  const BUBBLE: Record<ActorState, { text: string; cls: string } | null> = {
    working: { text: '⌨ working', cls: '' },
    waiting: { text: '!', cls: 'alert' },
    done: { text: '✓', cls: 'done' },
    scheduled: { text: '⏰', cls: '' },
    idle: null
  }
  const renderLabel = (l: Live): void => {
    const { a } = l
    const b = BUBBLE[a.state]
    l.label.style.setProperty('--accent', a.accent)
    l.label.title = a.tooltip
    l.label.replaceChildren()
    if (b) {
      const bubble = document.createElement('div')
      bubble.className = `office-bubble ${b.cls}`
      bubble.textContent = b.text
      l.label.appendChild(bubble)
    }
    const name = document.createElement('div')
    name.className = 'office-name'
    name.textContent = a.name
    if (a.role) {
      const role = document.createElement('span')
      role.className = 'office-role'
      role.textContent = ` · ${a.role}`
      name.appendChild(role)
    }
    l.label.appendChild(name)
  }

  const seatFor = (a: OfficeActor): Seat | null =>
    a.state === 'idle' && a.relax !== null ? RELAX_SEATS[a.relax] : DESK_SEATS[a.desk] ?? null
  const clipFor = (a: OfficeActor): string => (a.state === 'working' ? 'interact-right' : 'sit')

  const place = (l: Live): void => {
    const seat = seatFor(l.a)
    if (!seat) return
    l.root.position.set(seat.x, seat.y, seat.z)
    l.root.rotation.y = seat.rotY
    const want = clipFor(l.a)
    if (l.mixer && want !== l.clip) {
      l.mixer.stopAllAction()
      const clip = THREE.AnimationClip.findByName(l.clips, want)
      if (clip) l.mixer.clipAction(clip).play()
      l.clip = want
    }
  }

  const attachModel = (l: Live): void => {
    const key = `${l.a.look.body}|${l.a.look.head}`
    l.lookKey = key
    const token = ++l.token
    void buildCharacter(l.a.look).then((c) => {
      if (token !== l.token || !live.has(l.a.sid)) return
      if (l.model) l.root.remove(l.model)
      c.root.scale.setScalar(0.95 / c.height)
      l.root.add(c.root)
      l.model = c.root
      l.clips = c.animations
      l.mixer = new THREE.AnimationMixer(c.root)
      l.clip = ''
      place(l)
    })
  }

  const setActors = (actors: OfficeActor[]): void => {
    const wanted = new Set(actors.map((a) => a.sid))
    for (const [sid, l] of live) {
      if (wanted.has(sid)) continue
      scene.remove(l.root)
      l.label.remove()
      live.delete(sid)
    }
    for (const a of actors) {
      if (!DESK_SEATS[a.desk]) continue
      let l = live.get(a.sid)
      if (!l) {
        const root = new THREE.Group()
        root.userData.sid = a.sid
        const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), blobMat)
        blob.rotation.x = -Math.PI / 2
        root.add(blob)
        const label = document.createElement('div')
        label.className = 'office-tag'
        label.addEventListener('click', () => onOpen(a.sid))
        const tag = new CSS2DObject(label)
        tag.position.set(0, 1.25, 0)
        root.add(tag)
        scene.add(root)
        l = { a, root, model: null, mixer: null, clips: [], clip: '', label, lookKey: '', token: 0 }
        live.set(a.sid, l)
      }
      l.a = a
      // Blob shadow stays on the floor whatever the seat height.
      const seat = seatFor(a)
      ;(l.root.children[0] as THREE.Mesh).position.y = 0.012 - (seat?.y ?? 0)
      if (l.lookKey !== `${a.look.body}|${a.look.head}`) attachModel(l)
      renderLabel(l)
      place(l)
    }
    // Monitors: lit with the occupant's accent while they're at the desk and
    // busy; dark for empty desks and idle (or away) occupants.
    screens.forEach((s, i) => {
      const a = actors.find((x) => x.desk === i)
      s.material = a && a.state !== 'idle' ? dashFor(a.accent) : M.screenOff
    })
  }

  // ---------------------------------------------------------------- picking

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let downAt: { x: number; y: number } | null = null
  const sidAt = (e: PointerEvent): string | null => {
    const r = renderer.domElement.getBoundingClientRect()
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const roots = [...live.values()].map((l) => l.root)
    for (const hit of raycaster.intersectObjects(roots, true)) {
      let o: THREE.Object3D | null = hit.object
      while (o && !o.userData.sid) o = o.parent
      if (o && (hit.object as THREE.SkinnedMesh).isSkinnedMesh) return o.userData.sid as string
    }
    return null
  }
  const onDown = (e: PointerEvent): void => {
    downAt = { x: e.clientX, y: e.clientY }
  }
  const onUp = (e: PointerEvent): void => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
    const sid = sidAt(e)
    if (sid) onOpen(sid)
  }
  const onMove = (e: PointerEvent): void => {
    renderer.domElement.style.cursor = sidAt(e) ? 'pointer' : ''
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('pointermove', onMove)

  // ---------------------------------------------------------------- sizing + loop

  const fit = (): void => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h)
    labels.setSize(w, h)
    const aspect = w / h
    // Fit the whole floor plan: it's wider than tall.
    const view = Math.max(11.6, 17.2 / aspect)
    Object.assign(camera, { left: (-view * aspect) / 2, right: (view * aspect) / 2, top: view / 2, bottom: -view / 2 })
    camera.updateProjectionMatrix()
  }
  fit()
  const ro = new ResizeObserver(fit)
  ro.observe(container)

  const FPS = 30
  const timer = new THREE.Timer()
  let last = 0
  let raf = 0
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    if (document.hidden || now - last < 1000 / FPS - 1) return
    last = now
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 0.1)
    for (const l of live.values()) l.mixer?.update(dt)
    renderer.render(scene, camera)
    labels.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)

  return {
    setActors,
    deskCount: DESK_SEATS.length,
    relaxCount: RELAX_SEATS.length,
    dispose: () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh && o.parent === statics) m.geometry.dispose()
      })
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      labels.domElement.remove()
    }
  }
}

// Merge every static mesh into one geometry per material: ~120 draw calls for
// the whole room instead of several hundred.
function mergeStatics(statics: THREE.Group): void {
  statics.updateMatrixWorld(true)
  const groups = new Map<string, { m: THREE.Material; list: THREE.BufferGeometry[] }>()
  const slice = (g: THREE.BufferGeometry, gr: { start: number; count: number }): THREE.BufferGeometry => {
    const src = g.index ? g.toNonIndexed() : g
    const out = new THREE.BufferGeometry()
    for (const [k, a] of Object.entries(src.attributes)) {
      const attr = a as THREE.BufferAttribute
      out.setAttribute(k, new THREE.BufferAttribute(attr.array.slice(gr.start * attr.itemSize, (gr.start + gr.count) * attr.itemSize), attr.itemSize))
    }
    return out
  }
  statics.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    const parts =
      mats.length > 1
        ? g.groups.map((gr) => ({ g: slice(g, gr), m: mats[gr.materialIndex ?? 0] }))
        : [{ g: g.index ? g.toNonIndexed() : g, m: mats[0] }]
    for (const { g: pg, m } of parts) {
      for (const key of Object.keys(pg.attributes)) if (!['position', 'normal', 'uv'].includes(key)) pg.deleteAttribute(key)
      if (!pg.attributes.uv) pg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pg.attributes.position.count * 2), 2))
      let entry = groups.get(m.uuid)
      if (!entry) {
        entry = { m, list: [] }
        groups.set(m.uuid, entry)
      }
      entry.list.push(pg)
    }
  })
  statics.clear()
  for (const { m, list } of groups.values()) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, m)
    mesh.castShadow = mesh.receiveShadow = true
    statics.add(mesh)
  }
}
