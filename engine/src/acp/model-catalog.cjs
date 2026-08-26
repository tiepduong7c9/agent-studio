'use strict';

// Fetches the account's live model catalog from Anthropic's /v1/models so the
// model picker can offer exactly the models this account can run — latest and
// legacy — without hardcoding a list that goes stale. It reuses whatever auth
// Claude Code already has: a raw ANTHROPIC_API_KEY if set, otherwise the
// claude.ai OAuth token persisted on disk (see claude-auth).
//
// The adapter (@agentclientprotocol/claude-agent-acp) only lets you SELECT a
// model that resolves to its curated short list; feeding these IDs in via
// CLAUDE_MODEL_CONFIG.availableModels (see acp-session) makes the older ones
// selectable too. Everything here is best-effort: any failure (no token, an
// API-key/enterprise setup that can't reach /v1/models, network) returns null
// and the caller falls back to the adapter's built-in list.

const { claudeConfigDir, readOAuthToken } = require('./claude-auth.cjs');

const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h — model lineups change rarely
const NEG_TTL_MS = 60 * 1000;          // 1m — how long a failure is remembered before retrying
const ENDPOINT = 'https://api.anthropic.com/v1/models?limit=100';

// Per-account cache. Keyed on auth identity so one daemon serving two accounts
// (distinct CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY) never serves A's catalog to
// B. Entries with models === null are negative results (short TTL) that stop a
// no-auth / unreachable account from re-reading credentials and re-fetching on
// every single session spawn.
const _cache = new Map();     // key -> { at:number, models:[{id,name}]|null }
const _inflight = new Map();  // key -> Promise<[{id,name}]|null>

// Prefer an explicit API key; otherwise fall back to the persisted OAuth token.
function readAuth(env) {
  const e = env || process.env;
  if (e.ANTHROPIC_API_KEY) return { header: 'x-api-key', value: e.ANTHROPIC_API_KEY, oauth: false };
  const tok = readOAuthToken(e);
  if (tok) return { header: 'authorization', value: `Bearer ${tok}`, oauth: true };
  return null;
}

// A stable identity for the resolved account: the config dir for OAuth (survives
// hourly token refresh without invalidating the cache), the key itself for API
// keys. `null` when there is no auth to key on.
function authCacheKey(env, auth) {
  if (!auth) return null;
  return auth.oauth ? `oauth:${claudeConfigDir(env)}` : `key:${auth.value}`;
}

function fresh(entry) {
  if (!entry) return false;
  const ttl = entry.models ? CATALOG_TTL_MS : NEG_TTL_MS;
  return (Date.now() - entry.at) < ttl;
}

// Returns [{ id, name }] for every model the account can run, or null on any
// failure (cached briefly). Cached per account; concurrent callers share one
// request.
async function fetchModelCatalog(env, { timeoutMs = 4000 } = {}) {
  const auth = readAuth(env);
  const key = authCacheKey(env, auth);
  if (key === null) return null; // no auth — nothing to fetch or cache

  const cached = _cache.get(key);
  if (fresh(cached)) return cached.models;

  const pending = _inflight.get(key);
  if (pending) return pending;

  const req = (async () => {
    const headers = { 'anthropic-version': '2023-06-01', [auth.header]: auth.value };
    if (auth.oauth) headers['anthropic-beta'] = 'oauth-2025-04-20';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let models = null;
    try {
      const res = await fetch(ENDPOINT, { headers, signal: ctrl.signal });
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body && body.data)) {
          const list = body.data
            .filter((m) => m && typeof m.id === 'string')
            .map((m) => ({ id: m.id, name: m.display_name || m.id }));
          if (list.length) models = list;
        }
      }
    } catch (_) {
      // network / abort / parse — leave models null (negative-cached below)
    } finally {
      clearTimeout(timer);
    }
    // Cache both hits and misses so a stable server answer isn't re-fetched on
    // every session; misses expire faster (NEG_TTL_MS) so a transient failure
    // self-heals soon.
    _cache.set(key, { at: Date.now(), models });
    return models;
  })();

  _inflight.set(key, req);
  try { return await req; } finally { _inflight.delete(key); }
}

// Synchronous, non-blocking read of the cached catalog for `env`: returns the
// cached models if fresh, otherwise null AND kicks off a background refresh so
// the next call is warm. Used on the session-spawn hot path so expanding the
// model list never adds latency — the daemon's startup warm-up (and this
// background refresh) fill the cache out of band.
function peekModelCatalog(env, opts) {
  const key = authCacheKey(env, readAuth(env));
  if (key === null) return null;
  const cached = _cache.get(key);
  if (fresh(cached)) return cached.models;
  void fetchModelCatalog(env, opts).catch(() => {}); // warm for next time
  return cached ? cached.models : null; // may be null; caller falls back
}

module.exports = { fetchModelCatalog, peekModelCatalog };
