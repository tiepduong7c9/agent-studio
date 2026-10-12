'use strict';

// Shared Claude Code credential resolution. The daemon talks to Anthropic's API
// from several places (usage polling, title generation, the model catalog) and
// each needs the same claude.ai OAuth token that the CLI persists on disk. This
// is the single source of truth for where that token lives and how to read it,
// so the path/shape only has to change in one spot if the CLI's format moves.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The CLI honors CLAUDE_CONFIG_DIR; fall back to ~/.claude otherwise.
function claudeConfigDir(env) {
  const e = env || process.env;
  return e.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function tokenFrom(json) {
  const cred = JSON.parse(json);
  return (cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken) || null;
}

// On macOS the CLI keeps credentials in the login Keychain rather than on disk.
// The item's service name gains a hash suffix when CLAUDE_CONFIG_DIR is set.
function readKeychainToken(env) {
  const e = env || process.env;
  const service = e.CLAUDE_CONFIG_DIR
    ? `Claude Code-credentials-${crypto.createHash('sha256').update(claudeConfigDir(e)).digest('hex').slice(0, 8)}`
    : 'Claude Code-credentials';
  try {
    const out = execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', service, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return tokenFrom(out.trim());
  } catch (_) {
    return null; // no Keychain item / access denied
  }
}

// The persisted claude.ai OAuth access token, or null if unreadable/absent.
function readOAuthToken(env) {
  try {
    return tokenFrom(fs.readFileSync(path.join(claudeConfigDir(env), '.credentials.json'), 'utf8'));
  } catch (_) {
    // no credentials file / unreadable — on macOS try the Keychain, else "no auth"
    return process.platform === 'darwin' ? readKeychainToken(env) : null;
  }
}

module.exports = { claudeConfigDir, readOAuthToken };
