'use strict';

// Fetches Claude account + subscription-usage details out-of-band (the ACP
// adapter forwards per-turn context usage, but not the account's rate-limit
// windows). Runs on the engine host — local or an SSH remote — which is where
// the Claude credentials live, so each host reports its own account's limits.
// Ported from ccremote's agentnode/src/usage.js.
//
//  - Account : `claude auth status --json`
//  - Usage   : GET https://api.anthropic.com/api/oauth/usage with the OAuth
//              access token from ~/.claude/.credentials.json

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function getAccount() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status', '--json'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve(null); }
    });
  });
}

async function getUsage() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
    if (!token) return null;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function getUsageDetail() {
  const [account, usage] = await Promise.all([getAccount(), getUsage()]);
  return { account, usage };
}

module.exports = { getUsageDetail };
