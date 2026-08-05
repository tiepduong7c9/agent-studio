// Discovers every Claude Code skill on this host: the host-level personal skills
// in ~/.claude/skills, plus the project-level skills under each known project's
// .claude/skills. A skill is a directory containing a SKILL.md (YAML frontmatter
// with name/description) alongside optional resource files. This never executes
// anything; it only reads the on-disk skill folders so the app can surface a
// unified "all skills, everywhere" view. Host decoration happens in the main
// process (mirrors listAllProjects).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listAllProjects } from './projects.js';
import type { SkillFile, SkillFiles, SkillRef } from './types.js';

/** Per-file cap when reading a skill's contents, so a stray huge resource can't
 *  balloon an RPC payload. Files past this are returned truncated. Sized to
 *  comfortably fit real skill assets (icons, fonts) so import copies them whole. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Guard rails on the resource walk so a pathological tree can't hang a scan. */
const MAX_RESOURCES = 200;
const MAX_DEPTH = 6;
/** Enough of SKILL.md to reach past the frontmatter block reliably. */
const FRONTMATTER_HEAD_BYTES = 16384;

function hostSkillsRoot(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

function projectSkillsRoot(cwd: string): string {
  return path.join(cwd, '.claude', 'skills');
}

// Read up to `bytes` from the start of a file as a raw buffer (skill files can be
// binary resources, so decoding is left to the caller).
async function readHeadBuffer(file: string, bytes: number): Promise<Buffer> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd?.close().catch(() => {});
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  return (await readHeadBuffer(file, bytes)).toString('utf8');
}

// Pull `name`/`description` out of a leading `--- ... ---` YAML frontmatter block.
// Deliberately minimal (no YAML dependency): handles the flat scalar fields
// skills use, tolerating quotes and multi-line folded (`>`) / literal (`|`)
// block scalars — their indented continuation lines are gathered and joined into
// the single-line value we display.
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]);
    if (!line) continue;
    let val = line[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      // Block/folded scalar: consume the following more-indented lines.
      const parts: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') { parts.push(''); continue; }
        if (/^\s/.test(lines[j])) parts.push(lines[j].trim());
        else break;
      }
      i = j - 1;
      val = parts.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      val = val.replace(/^['"]|['"]$/g, '');
    }
    (out as any)[line[1]] = val;
  }
  return out;
}

// Walk a skill directory collecting resource files (posix-relative paths + sizes),
// excluding the top-level SKILL.md. Bounded by depth/count so it stays cheap.
async function walkResources(dir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  async function recurse(cur: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_RESOURCES) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_RESOURCES) break;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await recurse(path.join(cur, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        if (!rel && e.name === 'SKILL.md') continue;
        let size = 0;
        try { size = (await fs.promises.stat(path.join(cur, e.name))).size; } catch { /* skip */ }
        out.push({ rel: childRel, size });
      }
    }
  }
  await recurse(dir, '', 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

// Scan one skills root (host or a project's .claude/skills). Each immediate
// subdirectory that has a SKILL.md becomes a skill; a subdir without one is
// skipped. Returns [] when the root is absent.
async function scanRoot(
  root: string,
  scope: SkillRef['scope'],
  projectPath?: string
): Promise<SkillRef[]> {
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }

  const skills: SkillRef[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const skillMd = path.join(dir, 'SKILL.md');
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(skillMd); } catch { continue; } // no SKILL.md → not a skill
    if (!stat.isFile()) continue;

    let fm: { name?: string; description?: string } = {};
    let invalid = false;
    try {
      fm = parseFrontmatter(await readHead(skillMd, FRONTMATTER_HEAD_BYTES));
      if (!fm.name && !fm.description) invalid = true;
    } catch { invalid = true; }

    const resources = await walkResources(dir);
    skills.push({
      id: `${scope}:${dir}`,
      name: fm.name?.trim() || d.name,
      description: fm.description?.trim() || '',
      scope,
      projectPath,
      dir,
      resources,
      mtime: stat.mtimeMs,
      invalid,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Every skill on this host: personal (~/.claude/skills) + one entry per project's
 *  .claude/skills. Host tagging is applied by the main process. */
export async function listSkills(): Promise<SkillRef[]> {
  const hostSkills = scanRoot(hostSkillsRoot(), 'host');
  const projects = await listAllProjects().catch(() => []);
  const projectSkills = await Promise.all(
    projects.map((p) => scanRoot(projectSkillsRoot(p.cwd), 'project', p.cwd).catch(() => [])),
  );
  return [...(await hostSkills), ...projectSkills.flat()];
}

// Confine skill file access to real skill roots so a crafted `dir` can't read
// arbitrary paths: it must sit directly under ~/.claude/skills or some
// */.claude/skills. Uses path segments (not a regex) so it holds on Windows,
// where path.resolve emits '\' rather than '/'.
function assertSkillDir(dir: string): void {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved); // .../.claude/skills
  const underHost = parent === hostSkillsRoot();
  const underProject =
    path.basename(parent) === 'skills' && path.basename(path.dirname(parent)) === '.claude';
  if (!underHost && !underProject) {
    throw new Error(`Refusing to read skill outside a .claude/skills root: ${dir}`);
  }
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov',
  '.wav', '.bin', '.exe', '.dll', '.so', '.dylib',
]);

/** Read a skill's files (SKILL.md first, then resources), for the viewer/editor.
 *  Text files return `text`; likely-binary files return `base64`. */
export async function readSkill(dir: string): Promise<SkillFiles> {
  assertSkillDir(dir);
  const resources = await walkResources(dir);
  const rels = ['SKILL.md', ...resources.map((r) => r.rel)];
  const files: SkillFile[] = [];
  for (const rel of rels) {
    const full = path.join(dir, rel);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const binary = BINARY_EXT.has(path.extname(rel).toLowerCase());
    const truncated = stat.size > MAX_FILE_BYTES;
    const buf = await readHeadBuffer(full, Math.min(stat.size, MAX_FILE_BYTES));
    const file: SkillFile = { rel, size: stat.size, binary, truncated };
    if (binary) file.base64 = buf.toString('base64');
    else file.text = buf.toString('utf8');
    files.push(file);
  }
  return { files };
}
