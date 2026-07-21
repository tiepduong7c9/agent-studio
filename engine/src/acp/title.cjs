'use strict';

// Generates a short conversation title out-of-band by calling /v1/messages with
// the host's Claude subscription-OAuth token — the same credential path as
// usage.cjs. This does NOT inject a turn into the ACP conversation: it reads the
// transcript Claude Code already wrote under ~/.claude/projects/<enc cwd>/ and
// asks a cheap model for a title. Counts against the account's subscription
// usage. Returns null on any failure (best-effort; caller keeps the old name).

const fs = require('fs');
const os = require('os');
const path = require('path');

// OAuth requests to /v1/messages are rejected unless the first system block is
// exactly this identity string — this is Claude Code's own credential path.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

// Cheap + fast; titles don't need a frontier model.
const TITLE_MODEL = 'claude-haiku-4-5';

// Keep the prompt bounded: the opening frames the topic, the tail reflects where
// it ended up — both matter for a recap, the middle rarely changes the title.
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;

function _projectDir(cwd) {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc);
}

// Pull human/assistant prose out of a transcript message's content, skipping the
// synthetic context blocks the harness injects (<ide_opened_file>, …) and
// tool_result blocks — same filtering rationale as acp-session._firstHumanText.
function _messageText(content) {
  const ok = (s) => typeof s === 'string' && s.trim() && !s.trim().startsWith('<');
  if (ok(content)) return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b && b.type === 'text' && ok(b.text)) parts.push(b.text.trim());
    }
    return parts.join('\n');
  }
  return '';
}

// Read the current conversation's log and condense it to a bounded transcript of
// "User:" / "Assistant:" lines for the title prompt.
async function _readTranscript(cwd, acpSessionId) {
  const file = path.join(_projectDir(cwd), `${acpSessionId}.jsonl`);
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (_) { return ''; }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if ((o.type === 'user' || o.type === 'assistant') && o.message) {
      const t = _messageText(o.message.content);
      if (t) lines.push(`${o.type === 'user' ? 'User' : 'Assistant'}: ${t}`);
    }
  }
  const joined = lines.join('\n\n').replace(/\s+\n/g, '\n');
  if (joined.length <= HEAD_CHARS + TAIL_CHARS) return joined;
  return `${joined.slice(0, HEAD_CHARS)}\n\n[...]\n\n${joined.slice(-TAIL_CHARS)}`;
}

function _cleanTitle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')  // surrounding quotes
    .replace(/[.\s]+$/, '')           // trailing period / whitespace
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

// Returns a generated title string, or null if the transcript is empty, the
// credentials are missing/expired, or the API call fails.
async function generateTitle({ cwd, acpSessionId }) {
  if (!acpSessionId) return null;
  const transcript = await _readTranscript(cwd, acpSessionId);
  if (!transcript) return null;

  let token;
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    token = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  } catch (_) { return null; }
  if (!token) return null;

  const body = {
    model: TITLE_MODEL,
    max_tokens: 30,
    system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }],
    messages: [{
      role: 'user',
      content:
        'Summarize this conversation as a title of at most 6 words. ' +
        'Reply with ONLY the title — no quotes, no trailing punctuation.\n\n' +
        transcript,
    }],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'User-Agent': 'claude-cli',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const out = (json.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
    const title = _cleanTitle(out);
    return title || null;
  } catch (_) {
    return null;
  }
}

module.exports = { generateTitle };
