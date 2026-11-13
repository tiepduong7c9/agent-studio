// 3D characters: building a character from a look, rendering its portrait, and
// driving the live preview in the character manager. Imported lazily (it pulls
// in three.js and the models), so nothing here costs anything until an avatar
// or the manager is first shown.
//
// Models are bundled as inline data and parsed from memory rather than fetched:
// the packaged app loads from file://, where fetch() isn't available.

import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import colormapUrl from '../assets/office/characters/colormap.png?inline'
import type { CharacterLook, CharacterModel } from '../characters-store'

// One lazy chunk per model, so only the models in use are loaded.
const MODEL_SOURCES = import.meta.glob<string>('../assets/office/characters/character-*.glb', {
  query: '?inline',
  import: 'default'
})
const sourceFor = (m: CharacterModel): (() => Promise<string>) => {
  const src = MODEL_SOURCES[`../assets/office/characters/character-${m}.glb`]
  if (!src) throw new Error(`Unknown character model: ${m}`)
  return src
}

export const dataUrlToBuffer = (url: string): ArrayBuffer => {
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

// One material for every character: the shared palette texture. Resolved only
// once the image has loaded, so a portrait never renders against a blank map.
let material: Promise<THREE.MeshStandardMaterial> | null = null
function sharedMaterial(): Promise<THREE.MeshStandardMaterial> {
  material ??= new THREE.TextureLoader().loadAsync(colormapUrl).then((map) => {
    map.colorSpace = THREE.SRGBColorSpace
    map.flipY = false // glTF UV convention
    return new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
  })
  return material
}

const loader = new GLTFLoader()
const models = new Map<CharacterModel, Promise<GLTF>>()
function loadModel(m: CharacterModel): Promise<GLTF> {
  let p = models.get(m)
  if (!p) {
    p = sourceFor(m)().then((url) => loader.parseAsync(dataUrlToBuffer(url), ''))
    p.catch(() => models.delete(m))
    models.set(m, p)
  }
  return p
}

export interface BuiltCharacter {
  root: THREE.Object3D
  animations: THREE.AnimationClip[]
  /** Model height in its own units, for framing. */
  height: number
}

/** A posable character: the body model's rig and animations with the head
 *  model's head mesh. Every model shares one skeleton, so the swap is just the
 *  head geometry. */
export async function buildCharacter(look: CharacterLook): Promise<BuiltCharacter> {
  const [body, head, mat] = await Promise.all([loadModel(look.body), loadModel(look.head), sharedMaterial()])
  const root = SkeletonUtils.clone(body.scene)
  if (look.head !== look.body) {
    let headGeom: THREE.BufferGeometry | null = null
    head.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'head-mesh') headGeom = (o as THREE.Mesh).geometry
    })
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'head-mesh' && headGeom) (o as THREE.Mesh).geometry = headGeom
    })
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat
  })
  const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y
  return { root, animations: body.animations, height }
}

// Soft studio light, matching the office scene.
function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x6a7280, 2.0))
  const key = new THREE.DirectionalLight(0xfff4e6, 2.2)
  key.position.set(-2, 4, 5)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xcfe0ff, 0.6)
  rim.position.set(3, 3, -4)
  scene.add(rim)
}

function pose(c: BuiltCharacter, clip = 'idle', time = 0): THREE.AnimationMixer {
  const mixer = new THREE.AnimationMixer(c.root)
  const anim = THREE.AnimationClip.findByName(c.animations, clip)
  if (anim) mixer.clipAction(anim).play()
  mixer.update(time)
  return mixer
}

// ---------------------------------------------------------------- portraits

/** The 3D render's size; avatars are composed from it at their display size. */
const PORTRAIT_PX = 160
let portraitStage: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera } | null = null
let queue: Promise<unknown> = Promise.resolve()

/** A round avatar of a look on its accent colour, as a PNG data URL. The
 *  disc, gradient and ring are baked into the image, so the page shows a plain
 *  <img> — cheap even down a long list like the session switcher. Renders are
 *  serialised through one WebGL renderer on a detached canvas. */
export function renderPortrait(look: CharacterLook, accent: string, px: number): Promise<string> {
  return serial(async () => {
    const c = await buildCharacter(look)
    const { renderer, scene, camera } = stage()
    pose(c, 'idle', 0.4)
    scene.add(c.root)
    frame(c, 0.29, 0.72)
    renderer.render(scene, camera)
    scene.remove(c.root)
    // A data URL rather than a blob: URL — the page's CSP allows data: images.
    return composeAvatar(renderer.domElement, accent, px).toDataURL('image/png')
  })
}

export interface AvatarSheet {
  /** PNG data URL: `frames` avatar frames side by side. */
  url: string
  frames: number
  /** Seconds for one loop. */
  duration: number
}

/** A looping animated avatar as a sprite strip — one clip sampled evenly over
 *  its length, each frame composed like a portrait — so the page can play it
 *  with a CSS animation instead of a live WebGL view per avatar. Framed a
 *  little wider than the portrait so arm movement shows. */
export function renderAvatarSheet(look: CharacterLook, accent: string, clipName: string, px: number, frames = 16): Promise<AvatarSheet> {
  return serial(async () => {
    const c = await buildCharacter(look)
    const { renderer, scene, camera } = stage()
    const clip = THREE.AnimationClip.findByName(c.animations, clipName) ?? THREE.AnimationClip.findByName(c.animations, 'idle')
    const mixer = new THREE.AnimationMixer(c.root)
    if (clip) mixer.clipAction(clip).play()
    const duration = clip?.duration || 1
    scene.add(c.root)
    frame(c, 0.38, 0.62)
    const sheet = document.createElement('canvas')
    sheet.width = px * frames
    sheet.height = px
    const g = sheet.getContext('2d')!
    for (let i = 0; i < frames; i++) {
      mixer.setTime((duration * i) / frames)
      renderer.render(scene, camera)
      g.drawImage(composeAvatar(renderer.domElement, accent, px), i * px, 0)
    }
    scene.remove(c.root)
    return { url: sheet.toDataURL('image/png'), frames, duration }
  })
}

// One offscreen renderer for every portrait and sheet; jobs run one at a time.
function stage(): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera } {
  if (!portraitStage) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(PORTRAIT_PX, PORTRAIT_PX, false)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    const scene = new THREE.Scene()
    addLights(scene)
    portraitStage = { renderer, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100) }
  }
  return portraitStage
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn)
  queue = job.catch(() => undefined)
  return job
}
// Frame the upper body, seen slightly from above: `half` of the model height
// either side of `cy` (both as fractions of the height).
function frame(c: BuiltCharacter, half: number, cy: number): void {
  const camera = stage().camera
  const h = c.height
  Object.assign(camera, { left: -h * half, right: h * half, top: h * half, bottom: -h * half })
  camera.updateProjectionMatrix()
  camera.position.set(h * 0.25, h * cy + h * 0.35, h * 3)
  camera.lookAt(0, h * cy, 0)
}

// The character over a disc of its accent colour (lit from above), clipped to
// the circle, with a darker ring.
function composeAvatar(render: HTMLCanvasElement, accent: string, px: number): HTMLCanvasElement {
  // Composed at the exact pixel size it's shown at: the disc and ring are
  // drawn as vectors there, and the character is downscaled once with
  // high-quality smoothing, so edges stay smooth. (Letting CSS shrink a large
  // image, or canvas clip(), which isn't anti-aliased, left them jagged.)
  const out = document.createElement('canvas')
  out.width = out.height = px
  const g = out.getContext('2d')!
  const r = px / 2
  const ring = Math.max(1, px * 0.04)
  const light = new THREE.Color(accent).lerp(new THREE.Color('#ffffff'), 0.45).getStyle()
  const disc = g.createRadialGradient(r, r * 0.7, px * 0.05, r, r, r)
  disc.addColorStop(0, light)
  disc.addColorStop(1, accent)
  g.beginPath()
  g.arc(r, r, r - ring / 2, 0, Math.PI * 2)
  g.fillStyle = disc
  g.fill()
  // The character, masked to the circle with an anti-aliased fill.
  const figure = document.createElement('canvas')
  figure.width = figure.height = px
  const f = figure.getContext('2d')!
  f.imageSmoothingEnabled = true
  f.imageSmoothingQuality = 'high'
  f.drawImage(render, 0, 0, px, px)
  f.globalCompositeOperation = 'destination-in'
  f.beginPath()
  f.arc(r, r, r - ring / 2, 0, Math.PI * 2)
  f.fill()
  g.drawImage(figure, 0, 0)
  g.beginPath()
  g.arc(r, r, r - ring / 2, 0, Math.PI * 2)
  g.lineWidth = ring
  g.strokeStyle = new THREE.Color(accent).multiplyScalar(0.7).getStyle()
  g.stroke()
  return out
}

// ---------------------------------------------------------------- live preview

export interface Preview {
  setLook: (look: CharacterLook) => void
  dispose: () => void
}

/** A turntable preview on a canvas: idle animation, drag to rotate. Renders
 *  only while the canvas is on screen and the window is visible. */
export function mountPreview(canvas: HTMLCanvasElement, look: CharacterLook): Preview {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100)
  const turntable = new THREE.Group()
  scene.add(turntable)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
  )
  shadow.rotation.x = -Math.PI / 2
  scene.add(shadow)

  let current: { c: BuiltCharacter; mixer: THREE.AnimationMixer } | null = null
  let token = 0
  let yaw = 0.35
  let disposed = false

  const setLook = (l: CharacterLook): void => {
    const mine = ++token
    void buildCharacter(l).then((c) => {
      if (disposed || mine !== token) return
      if (current) turntable.remove(current.c.root)
      current = { c, mixer: pose(c, 'idle') }
      turntable.add(c.root)
      const h = c.height
      shadow.scale.setScalar(h * 0.8)
      camera.position.set(0, h * 0.75, h * 4.1)
      camera.lookAt(0, h * 0.48, 0)
    })
  }

  // Drag to spin; it eases back to a three-quarter view when let go.
  let dragging: number | null = null
  const down = (e: PointerEvent): void => {
    dragging = e.clientX
    canvas.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent): void => {
    if (dragging === null) return
    yaw += (e.clientX - dragging) * 0.012
    dragging = e.clientX
  }
  const up = (): void => {
    dragging = null
  }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)

  const clock = new THREE.Timer()
  let raf = 0
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    if (document.hidden || !canvas.isConnected) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    clock.update(now)
    const dt = Math.min(clock.getDelta(), 0.1)
    if (dragging === null) yaw += (0.35 - yaw) * Math.min(1, dt * 1.5)
    turntable.rotation.y = yaw
    current?.mixer.update(dt)
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)
  setLook(look)

  return {
    setLook,
    dispose: () => {
      disposed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      renderer.dispose()
      // Release the context now rather than at GC: Chromium caps live WebGL
      // contexts and drops the oldest (the shared portrait renderer) first.
      renderer.forceContextLoss()
    }
  }
}
