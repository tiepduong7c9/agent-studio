// Discovers every Claude Code project on this host and its resumable
// conversations, straight from ~/.claude/projects/. This is what powers the
// VS Code-style "all projects and their sessions" list — independent of which
// folders are open and of the sessions the daemon itself created. It never
// spawns a Claude process; it only reads the on-disk logs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AcpConversation, ProjectConversations } from './types.js';

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// The opening prompt can trail a large injected context block, so read a
// generous head (matches acp-session._readTitle) to reliably reach the first
// real user line without parsing the whole (potentially multi-MB) log.
const HEAD_BYTES = 262144;

// Pull the first genuine human-typed text out of a user message's content,
// skipping the synthetic context blocks the harness injects (they start with
// '<') and tool_result blocks. Mirrors acp-session._firstHumanText.
function firstHumanText(content: any): string | null {
  const ok = (s: any): boolean => typeof s === 'string' && !!s.trim() && !s.trim().startsWith('<');
  if (ok(content)) return (content as string).trim();
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && ok(b.text)) return String(b.text).trim();
    }
  }
  return null;
}

async function readHead(file: string, bytes: number): Promise<string> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fd?.close().catch(() => {});
  }
}

interface HeadInfo {
  cwd: string | null;
  /** summary / first-human-text fallback title. */
  fallbackTitle: string | null;
  /** ai-title lines found in this head, keyed by their sessionId. */
  aiTitles: Map<string, string>;
}

function parseHead(text: string): HeadInfo {
  const info: HeadInfo = { cwd: null, fallbackTitle: null, aiTitles: new Map() };
  const lines = text.split('\n');
  // Drop the trailing line — the head read may have cut it mid-JSON.
  if (lines.length > 1) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!info.cwd && typeof o.cwd === 'string' && o.cwd) info.cwd = o.cwd;
    if (o.type === 'ai-title' && o.sessionId && o.aiTitle) info.aiTitles.set(o.sessionId, String(o.aiTitle));
    if (!info.fallbackTitle) {
      if (o.type === 'summary' && o.summary) info.fallbackTitle = String(o.summary).replace(/\s+/g, ' ').slice(0, 80);
      else if (o.type === 'user' && o.message) {
        const t = firstHumanText(o.message.content);
        if (t) info.fallbackTitle = t.replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  }
  return info;
}

interface Scanned {
  sessionId: string;
  mtime: number;
  head: HeadInfo;
}

// Scan one project directory: read the head of each non-empty .jsonl once,
// derive the real cwd and per-conversation titles. Returns null for dirs with
// no usable logs.
async function scanProject(dir: string): Promise<ProjectConversations | null> {
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return null; }

  const scanned: Scanned[] = [];
  // ai-titles are cross-written across a project's logs, so pool them.
  const aiTitles = new Map<string, string>();
  let cwd: string | null = null;

  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(full); } catch { continue; }
    if (!stat.isFile() || !stat.size) continue;
    let head: HeadInfo;
    try { head = parseHead(await readHead(full, HEAD_BYTES)); } catch { continue; }
    if (!cwd && head.cwd) cwd = head.cwd;
    for (const [sid, title] of head.aiTitles) aiTitles.set(sid, title);
    scanned.push({ sessionId: f.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs, head });
  }

  if (!cwd || scanned.length === 0) return null;

  const conversations: AcpConversation[] = scanned.map((s) => ({
    sessionId: s.sessionId,
    title: aiTitles.get(s.sessionId) ?? s.head.fallbackTitle,
    mtime: s.mtime,
  }));
  conversations.sort((a, b) => b.mtime - a.mtime);

  return { cwd, name: path.basename(cwd) || cwd, conversations };
}

/** Enumerate all Claude projects on this host, most-recently-active first. */
export async function listAllProjects(): Promise<ProjectConversations[]> {
  const root = projectsRoot();
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }

  const results = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map((d) => scanProject(path.join(root, d.name)).catch(() => null)),
  );
  const projects = results.filter((p): p is ProjectConversations => p !== null);
  // Most-recently-active project first (by its newest conversation).
  projects.sort((a, b) => (b.conversations[0]?.mtime ?? 0) - (a.conversations[0]?.mtime ?? 0));
  return projects;
}
