import { app } from 'electron'
import { promises as fsp } from 'fs'
import * as path from 'path'
import type { SkillFile, SkillFiles, SkillRef } from '../shared/acp'

// The app-owned skill library: a canonical collection the app manages, separate
// from any host's ~/.claude/skills. Skills are copied in from hosts/projects
// (import) and injected back out into projects/hosts. It lives on the local
// machine under userData, managed here with node fs directly — no engine needed.
// Browsing (list/read) plus authoring (create/import/duplicate/edit/delete) all
// operate on this local store; injecting back out to hosts/projects is Phase 3.

// Matches the engine scanner's cap; sized so real skill assets copy whole.
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RESOURCES = 200
const MAX_DEPTH = 6
const FRONTMATTER_HEAD_BYTES = 16384

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov',
  '.wav', '.bin', '.exe', '.dll', '.so', '.dylib'
])

/** The library root under userData. Not created until something is written to it. */
export function libraryRoot(): string {
  return path.join(app.getPath('userData'), 'skills')
}

// Ledger of source skills already collected into the library, keyed by their
// stable source id (`${host}:${scope}:${dir}`). It lets a Scan skip sources it
// has already pulled in, so a skill the user later deletes from the library does
// NOT reappear on the next scan, and library copies persist even after the source
// is removed from its host.
function ledgerPath(): string {
  return path.join(app.getPath('userData'), 'skills-collected.json')
}

/** Source ids already collected into the library. */
export async function getCollectedKeys(): Promise<Set<string>> {
  try {
    const raw = await fsp.readFile(ledgerPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

/** Record additional source ids as collected (merged with the existing set). */
export async function addCollectedKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const set = await getCollectedKeys()
  for (const k of keys) set.add(k)
  await fsp.mkdir(path.dirname(ledgerPath()), { recursive: true })
  await fsp.writeFile(ledgerPath(), JSON.stringify([...set], null, 2), 'utf8')
}

async function readHeadBuffer(file: string, bytes: number): Promise<Buffer> {
  const fd = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fd.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fd.close().catch(() => {})
  }
}

// Minimal `name`/`description` frontmatter parse — must stay in lockstep with
// the engine scanner's parseFrontmatter (engine/src/acp/skills.ts), so library
// copies parse identically to their host sources. Handles multi-line folded
// (`>`) / literal (`|`) block scalars by joining their indented lines.
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const line = /^(name|description)\s*:\s*(.*)$/.exec(lines[i])
    if (!line) continue
    let val = line[2].trim()
    if (/^[|>][+-]?$/.test(val)) {
      const parts: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') {
          parts.push('')
          continue
        }
        if (/^\s/.test(lines[j])) parts.push(lines[j].trim())
        else break
      }
      i = j - 1
      val = parts.join(' ').replace(/\s+/g, ' ').trim()
    } else {
      val = val.replace(/^['"]|['"]$/g, '')
    }
    ;(out as any)[line[1]] = val
  }
  return out
}

async function walkResources(dir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = []
  async function recurse(cur: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_RESOURCES) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_RESOURCES) break
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await recurse(path.join(cur, e.name), childRel, depth + 1)
      } else if (e.isFile()) {
        if (!rel && e.name === 'SKILL.md') continue
        let size = 0
        try {
          size = (await fsp.stat(path.join(cur, e.name))).size
        } catch {
          /* skip */
        }
        out.push({ rel: childRel, size })
      }
    }
  }
  await recurse(dir, '', 0)
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

/** Every skill in the library (empty when the store doesn't exist yet). */
export async function listLibrarySkills(): Promise<SkillRef[]> {
  const root = libraryRoot()
  let dirs: import('fs').Dirent[]
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillRef[] = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    const skillMd = path.join(dir, 'SKILL.md')
    let stat: import('fs').Stats
    try {
      stat = await fsp.stat(skillMd)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    let fm: { name?: string; description?: string } = {}
    let invalid = false
    try {
      fm = parseFrontmatter((await readHeadBuffer(skillMd, FRONTMATTER_HEAD_BYTES)).toString('utf8'))
      if (!fm.name && !fm.description) invalid = true
    } catch {
      invalid = true
    }
    skills.push({
      id: `local:library:${dir}`,
      name: fm.name?.trim() || d.name,
      description: fm.description?.trim() || '',
      scope: 'library',
      host: null,
      dir,
      resources: await walkResources(dir),
      mtime: stat.mtimeMs,
      invalid
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

// Confine reads to the library root so a crafted `dir` can't escape it.
function assertInLibrary(dir: string): void {
  const resolved = path.resolve(dir)
  const root = path.resolve(libraryRoot())
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to read outside the skill library: ${dir}`)
  }
}

/** Read a library skill's files (SKILL.md first, then resources). */
export async function readLibrarySkill(dir: string): Promise<SkillFiles> {
  assertInLibrary(dir)
  const resources = await walkResources(dir)
  const rels = ['SKILL.md', ...resources.map((r) => r.rel)]
  const files: SkillFile[] = []
  for (const rel of rels) {
    const full = path.join(dir, rel)
    let stat: import('fs').Stats
    try {
      stat = await fsp.stat(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const binary = BINARY_EXT.has(path.extname(rel).toLowerCase())
    const truncated = stat.size > MAX_FILE_BYTES
    const buf = await readHeadBuffer(full, Math.min(stat.size, MAX_FILE_BYTES))
    const file: SkillFile = { rel, size: stat.size, binary, truncated }
    if (binary) file.base64 = buf.toString('base64')
    else file.text = buf.toString('utf8')
    files.push(file)
  }
  return { files }
}

// ── authoring (writes; library-only) ──────────────────────────────────────────

// A skill's folder name is its `name`; keep it filesystem-safe and refuse names
// that would escape the library root or collide with nothing meaningful.
function sanitizeName(name: string): string {
  const clean = name.trim().replace(/[\\/]+/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ')
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid skill name')
  return clean
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

/** Whether the library already contains a skill with this (sanitized) name. Lets
 *  a Scan treat a same-named source as an already-collected duplicate. */
export async function libraryHasSkill(name: string): Promise<boolean> {
  try {
    return await exists(path.join(libraryRoot(), sanitizeName(name)))
  } catch {
    return false // unsanitizable name → nothing to collide with
  }
}

function refFor(dir: string, name: string, description: string, mtime: number): SkillRef {
  return {
    id: `local:library:${dir}`,
    name,
    description,
    scope: 'library',
    host: null,
    dir,
    resources: [],
    mtime
  }
}

/** Create a new, empty library skill from a SKILL.md template. Throws if a
 *  library skill with that name already exists. */
export async function createLibrarySkill(name: string, description = ''): Promise<SkillRef> {
  const clean = sanitizeName(name)
  const dir = path.join(libraryRoot(), clean)
  if (await exists(dir)) throw new Error(`A library skill named "${clean}" already exists`)
  await fsp.mkdir(dir, { recursive: true })
  const body =
    `---\nname: ${clean}\ndescription: ${description}\n---\n\n` +
    `# ${clean}\n\nDescribe what this skill does and when to use it.\n`
  await fsp.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8')
  const stat = await fsp.stat(path.join(dir, 'SKILL.md'))
  return refFor(dir, clean, description, stat.mtimeMs)
}

// Reject a resource path that would escape the skill directory.
function resolveWithin(dir: string, rel: string): string {
  const target = path.resolve(dir, rel)
  const base = path.resolve(dir)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Refusing to write outside the skill: ${rel}`)
  }
  return target
}

/** Overwrite (or create) one text file within a library skill. */
export async function writeLibraryFile(dir: string, rel: string, content: string): Promise<void> {
  assertInLibrary(dir)
  const target = resolveWithin(dir, rel)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, content, 'utf8')
}

/** Permanently delete a library skill (its whole directory). */
export async function deleteLibrarySkill(dir: string): Promise<void> {
  assertInLibrary(dir)
  const resolved = path.resolve(dir)
  const root = path.resolve(libraryRoot())
  if (path.dirname(resolved) !== root || resolved === root) {
    throw new Error('Not a library skill directory')
  }
  await fsp.rm(resolved, { recursive: true, force: true })
}

/** Copy a skill's files into the library under `name`, creating the folder.
 *  Backs both "import" (collect from a host/project) and "duplicate". Throws if
 *  the name is taken. `files` come from readSkill/readLibrarySkill. */
export async function importIntoLibrary(name: string, files: SkillFile[]): Promise<SkillRef> {
  const clean = sanitizeName(name)
  const dir = path.join(libraryRoot(), clean)
  if (await exists(dir)) throw new Error(`A library skill named "${clean}" already exists`)
  await fsp.mkdir(dir, { recursive: true })
  for (const f of files) {
    // A truncated binary is only a prefix of the real bytes, so writing it would
    // silently corrupt the file — skip it rather than ship a broken asset.
    if (f.binary && f.truncated) continue
    const target = resolveWithin(dir, f.rel)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    if (f.binary && f.base64 != null) {
      await fsp.writeFile(target, Buffer.from(f.base64, 'base64'))
    } else {
      await fsp.writeFile(target, f.text ?? '', 'utf8')
    }
  }
  const stat = await fsp.stat(dir)
  // Description is re-derived on the next scan; leave empty here.
  return refFor(dir, clean, '', stat.mtimeMs)
}
