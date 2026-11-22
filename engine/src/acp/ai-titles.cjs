'use strict';

// Claude Code persists conversation titles as {"type":"ai-title","aiTitle",
// "sessionId"} lines, cross-written across a project's logs
// (~/.claude/projects/<enc cwd>/*.jsonl). Finding them used to mean reading
// every log whole, on every write to any of them (fs.watch), once per session —
// for a project with a few hundred MB of logs that is gigabytes of transient
// strings, and overlapping scans took the daemon past V8's heap limit.
//
// Instead, each log is scanned incrementally and only once per process: we
// remember how far we've read and pick up from there, reading fixed-size chunks
// as Buffers and decoding only short lines that contain the marker. The cache
// is module-level, so every session in the same project shares it, and a dir
// is never scanned by two callers at once.

const fs = require('fs');
const path = require('path');

const MARKER = Buffer.from('"ai-title"');
const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;
// A real ai-title line is ~150 bytes. Anything far longer is some other record
// (a tool result that merely mentions the marker), so it's never decoded and
// its bytes aren't buffered while we wait for the line to end.
const MAX_TITLE_LINE = 16 * 1024;

// full path -> { ino, offset, carry: Buffer|null, skipping, titles: Map<sessionId, title> }
const fileCache = new Map();
// dir -> { running: Promise|null, queued: Promise|null }
const dirState = new Map();

function scanLine(line, titles) {
  if (line.length > MAX_TITLE_LINE || line.indexOf(MARKER) === -1) return;
  let o;
  try { o = JSON.parse(line.toString('utf8')); } catch (_) { return; }
  if (o && o.type === 'ai-title' && o.sessionId && o.aiTitle) titles.set(o.sessionId, String(o.aiTitle));
}

// Read the bytes appended to `full` since the last scan, collecting titles.
async function scanFile(full, stat) {
  let entry = fileCache.get(full);
  // New file, or replaced/truncated since we last looked: start over.
  if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) {
    entry = { ino: stat.ino, offset: 0, carry: null, skipping: false, titles: new Map() };
    fileCache.set(full, entry);
  }
  if (entry.offset >= stat.size) return entry;

  const fd = await fs.promises.open(full, 'r');
  try {
    // Usually only a line or two was appended; don't allocate a full chunk for it.
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size - entry.offset));
    while (entry.offset < stat.size) {
      const want = Math.min(CHUNK_BYTES, stat.size - entry.offset);
      const { bytesRead } = await fd.read(buf, 0, want, entry.offset);
      if (!bytesRead) break;
      entry.offset += bytesRead;
      const view = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(NEWLINE, start);
        if (nl === -1) break;
        if (entry.skipping) {
          entry.skipping = false;
        } else {
          const piece = view.subarray(start, nl);
          scanLine(entry.carry ? Buffer.concat([entry.carry, piece]) : piece, entry.titles);
        }
        entry.carry = null;
        start = nl + 1;
      }
      // Keep the unterminated tail for the next chunk / next scan — unless the
      // line is already too long to be a title, in which case drop it.
      if (start < bytesRead && !entry.skipping) {
        const rest = view.subarray(start);
        const len = (entry.carry ? entry.carry.length : 0) + rest.length;
        if (len > MAX_TITLE_LINE) { entry.carry = null; entry.skipping = true; }
        else entry.carry = entry.carry ? Buffer.concat([entry.carry, rest]) : Buffer.from(rest);
      }
    }
  } finally {
    await fd.close().catch(() => {});
  }
  // A final line Claude hasn't terminated yet: if it's already complete JSON,
  // take its title now (it's parsed again, harmlessly, once the newline lands).
  if (entry.carry) scanLine(entry.carry, entry.titles);
  return entry;
}

async function scanDir(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (_) { return { files: [], titles: new Map() }; }
  const files = [];
  const seen = new Set();
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = await fs.promises.stat(full); } catch (_) { continue; }
    if (!stat.size) continue;
    seen.add(full);
    let entry;
    try { entry = await scanFile(full, stat); } catch (_) { continue; }
    files.push({ sessionId: f.replace(/\.jsonl$/, ''), full, mtime: stat.mtimeMs, titles: entry.titles });
  }
  // Forget logs that were deleted.
  const prefix = dir + path.sep;
  for (const full of fileCache.keys()) {
    if (full.startsWith(prefix) && !seen.has(full)) fileCache.delete(full);
  }
  // Oldest → newest, so a regenerated title in a newer log wins.
  const titles = new Map();
  for (const f of [...files].sort((a, b) => a.mtime - b.mtime)) {
    for (const [sid, t] of f.titles) titles.set(sid, t);
  }
  return { files: files.map(({ sessionId, full, mtime }) => ({ sessionId, full, mtime })), titles };
}

// The project's non-empty logs and its sessionId → ai-title map. Concurrent
// callers for one dir share a scan; a call arriving mid-scan waits for one more
// scan after it (so it sees writes that landed after the running one started),
// and any further callers join that same queued scan.
function readProjectTitles(dir) {
  let s = dirState.get(dir);
  if (!s) { s = { running: null, queued: null }; dirState.set(dir, s); }
  const start = () => {
    s.running = scanDir(dir).finally(() => { s.running = null; });
    return s.running;
  };
  // Between a scan finishing and the queued one starting, running is null but
  // queued is set: join it rather than starting a second, concurrent scan.
  if (s.queued) return s.queued;
  if (!s.running) return start();
  s.queued = s.running.catch(() => {}).then(() => { s.queued = null; return start(); });
  return s.queued;
}

module.exports = { readProjectTitles, _fileCache: fileCache };
