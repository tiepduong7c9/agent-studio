'use strict';

// Shared Claude Code credential resolution. The daemon talks to Anthropic's API
// from several places (usage polling, title generation, the model catalog) and
// each needs the same claude.ai OAuth token that the CLI persists on disk. This
// is the single source of truth for where that token lives and how to read it,
// so the path/shape only has to change in one spot if the CLI's format moves.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The CLI honors CLAUDE_CONFIG_DIR; fall back to ~/.claude otherwise.
function claudeConfigDir(env) {
  const e = env || process.env;
  return e.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// The persisted claude.ai OAuth access token, or null if unreadable/absent.
function readOAuthToken(env) {
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(env), '.credentials.json'), 'utf8'));
    return (cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken) || null;
  } catch (_) {
    return null; // no credentials file / unreadable — caller treats as "no auth"
  }
}

module.exports = { claudeConfigDir, readOAuthToken };
