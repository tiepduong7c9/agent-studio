'use strict';

// Drives a Claude Code session over the Agent Client Protocol (ACP) instead of
// a raw PTY. Spawns the @agentclientprotocol/claude-agent-acp adapter as a
// stdio subprocess, speaks JSON-RPC to it via @agentclientprotocol/sdk's
// ClientSideConnection, and surfaces structured events to listeners using the
// same listener contract the PTY path uses (so SessionManager can treat both
// kinds of session alike).
//
// Events pushed to listeners (and replayed from history on attach):
//   { type: 'acp_user', blocks }                 — echo of the user's own prompt
//   { type: 'acp_update', update }               — raw ACP session/update payload
//   { type: 'acp_permission', requestId, request, resolved? } — pending tool permission
//   { type: 'acp_stop', stopReason }             — a prompt turn finished
//   { type: 'acp_status', claudeStatus }         — derived status change (not stored)
//   { type: 'acp_usage', usage }                 — latest context-window usage (not stored)
//   { type: 'acp_title', title }                 — Claude's generated conversation title (not stored)
//   { type: 'acp_error', message }               — adapter/turn error
//   { type: 'exit', code }                       — adapter subprocess exited

const { spawn } = require('child_process');
const { Writable, Readable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nanoid } = require('nanoid');

const MAX_HISTORY = 5000; // cap retained thread events for replay

// The SDK is ESM-only; agentnode is CommonJS. Load it lazily via dynamic import.
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@agentclientprotocol/sdk');
  return _sdkPromise;
}

// Absolute path to the adapter's entry module, resolved from our dependency.
function adapterEntry() {
  const pkgJson = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  return path.join(path.dirname(pkgJson), 'dist', 'index.js');
}

class AcpSession {
  constructor({ cwd, env }) {
    this.cwd = cwd;
    this._env = env || process.env;
    this.listeners = new Set();      // shared with the SessionManager session record
    this.history = [];               // ordered thread events for replay on attach
    this.claudeStatus = undefined;   // undefined = idle/never-prompted (green), like PTY
    this.acpSessionId = null;
    this.modeState = null;           // { currentModeId, availableModes:[{id,name,description}] }
    this.availableCommands = [];     // [{ name, description, input? }] — slash commands
    this.model = null;               // current model id (from configOptions, transcript fallback)
    this.modelState = null;          // { currentModelId, availableModels:[{id,name,description}] }
    this.effortState = null;         // { currentEffortId, availableEfforts:[{id,name,description}] } — null when the model has no effort levels
    this.usage = null;               // { used, size, cost? } — latest context-window occupancy
    this._lastTitle = null;          // last ai-title emitted, to dedupe acp_title events
    this._titleWatcher = null;       // fs.watch on the project dir → picks up ai-title whenever Claude writes it
    this._titleDebounce = null;
    this.alive = false;
    this.isReady = false;            // true once initialize + new/loadSession has resolved (note: ready() is a method)
    this._resumeRequested = false;   // true when started via resume (history will replay)

    this._conn = null;
    this._child = null;
    this._ready = null;              // resolves once initialize + new/loadSession done
    this._loadSupported = false;
    this._pending = new Map();       // requestId -> resolve(outcome)
    this._seq = 0;                   // monotonic id per stored event (browser dedupes on it)
  }

  // Spawn the adapter and establish the session. Returns the ACP sessionId.
  // Idempotent-ish: callers should await ready() rather than calling twice.
  start({ resumeSessionId } = {}) {
    if (this._ready) return this._ready;
    // A resume replays the prior conversation as streamed updates after attach,
    // so the initial snapshot is empty; flag it so browsers can hold a loading
    // overlay instead of watching the thread scroll in.
    this._resumeRequested = !!resumeSessionId;
    this._ready = this._start({ resumeSessionId });
    return this._ready;
  }

  ready() {
    return this._ready || Promise.reject(new Error('ACP session not started'));
  }

  async _start({ resumeSessionId }) {
    const { ClientSideConnection, ndJsonStream } = await loadSdk();

    const child = spawn(process.execPath, [adapterEntry()], {
      cwd: this.cwd,
      env: this._env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._child = child;
    this.alive = true;

    child.stderr.on('data', (d) => process.stderr.write(`[acp ${this.acpSessionId || '?'}] ${d}`));
    child.on('exit', (code) => {
      this.alive = false;
      this._emit({ type: 'exit', code: code == null ? 0 : code });
      this.listeners.clear();
      // Reject any in-flight permission prompts so the adapter side unblocks.
      for (const [, fn] of this._pending) fn({ outcome: { outcome: 'cancelled' } });
      this._pending.clear();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );

    const client = {
      sessionUpdate: async (params) => { this._onUpdate(params); },
      requestPermission: async (params) => this._onPermission(params),
      // fs/* and terminal/* intentionally omitted — we do not advertise those
      // capabilities, so the Claude SDK runs file edits and bash internally and
      // reports them to us as tool_call updates.
    };

    this._conn = new ClientSideConnection(() => client, stream);

    const init = await this._conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'agent-studio', version: require('../../package.json').version },
    });
    this._loadSupported = !!(init.agentCapabilities && init.agentCapabilities.loadSession);

    if (resumeSessionId && this._loadSupported) {
      this.acpSessionId = resumeSessionId;
      const res = await this._conn.loadSession({ sessionId: resumeSessionId, cwd: this.cwd, mcpServers: [] });
      if (res && res.modes) this.modeState = res.modes;
      if (res) this._applyConfigOptions(res.configOptions);
    } else {
      const res = await this._conn.newSession({ cwd: this.cwd, mcpServers: [] });
      this.acpSessionId = res.sessionId;
      if (res.modes) this.modeState = res.modes;
      this._applyConfigOptions(res.configOptions);
    }
    this._emitMode();
    this._emitModel();
    this._emitEffort();
    this._refreshModel();
    this._refreshTitle();
    this._watchTitle();
    this.isReady = true;
    return this.acpSessionId;
  }

  _emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (_) {}
    }
  }

  _pushHistory(item) {
    // Tag every stored event with a monotonic sequence id. The same event is
    // fanned out to every attached browser; keying dedup on seq means multiple
    // attachments to one session never double-render the thread.
    if (item.seq === undefined) item.seq = this._seq++;
    this.history.push(item);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  _setStatus(status) {
    if (this.claudeStatus === status) return;
    this.claudeStatus = status;
    this._emit({ type: 'acp_status', claudeStatus: status });
  }

  _emitMode() {
    this._emit({ type: 'acp_mode', modeState: this.modeState });
  }

  _emitModel() {
    this._emit({ type: 'acp_model', model: this.model, modelState: this.modelState });
  }

  _emitEffort() {
    this._emit({ type: 'acp_effort', effortState: this.effortState });
  }

  _emitUsage() {
    this._emit({ type: 'acp_usage', usage: this.usage });
  }

  // Pull the model + effort selectors out of the adapter's configOptions (the
  // authoritative source for the current values and the selectable ones).
  // Options may be a flat array or grouped (`{ group, options }`); flatten either
  // shape. The effort option only exists for models that support effort levels,
  // so it's cleared to null when absent (the UI hides its selector then).
  _applyConfigOptions(configOptions) {
    if (!Array.isArray(configOptions)) return;
    const flatten = (opt) => {
      const flat = [];
      for (const o of (opt.options || [])) {
        if (o && Array.isArray(o.options)) flat.push(...o.options);
        else if (o) flat.push(o);
      }
      return flat.map(o => ({ id: o.value, name: o.name, description: o.description == null ? null : o.description }));
    };

    const modelOpt = configOptions.find(o => o && o.type === 'select' && (o.id === 'model' || o.category === 'model'));
    if (modelOpt) {
      this.modelState = { currentModelId: modelOpt.currentValue, availableModels: flatten(modelOpt) };
      if (modelOpt.currentValue) this.model = modelOpt.currentValue;
    }

    const effortOpt = configOptions.find(o => o && o.type === 'select' && (o.id === 'effort' || o.category === 'thought_level'));
    this.effortState = effortOpt
      ? { currentEffortId: effortOpt.currentValue, availableEfforts: flatten(effortOpt) }
      : null;
  }

  _onUpdate(params) {
    const update = params.update;
    // Mode changes (incl. ones the agent makes autonomously) update state and
    // are surfaced as a transient acp_mode event rather than a thread entry.
    if (update && update.sessionUpdate === 'current_mode_update') {
      if (this.modeState) this.modeState.currentModeId = update.currentModeId;
      this._emitMode();
      return;
    }
    // Config option changes (incl. model switches the agent makes autonomously)
    // refresh the model state and surface it as a transient acp_model event.
    if (update && update.sessionUpdate === 'config_option_update') {
      this._applyConfigOptions(update.configOptions);
      this._emitModel();
      this._emitEffort();
      return;
    }
    // Slash-command catalog — metadata, surfaced as acp_commands (not a thread entry).
    if (update && update.sessionUpdate === 'available_commands_update') {
      this.availableCommands = update.availableCommands || [];
      this._emit({ type: 'acp_commands', commands: this.availableCommands });
      return;
    }
    // Context-window usage — the adapter emits this after each turn (and resets it
    // to 0 on compaction). Kept as transient session state (like mode/model) and
    // surfaced as acp_usage rather than a thread entry.
    if (update && update.sessionUpdate === 'usage_update') {
      this.usage = { used: update.used, size: update.size, cost: update.cost || null };
      this._emitUsage();
      return;
    }
    const item = { type: 'acp_update', update };
    this._pushHistory(item);
    this._emit(item);
  }

  async setMode(modeId) {
    await this.ready();
    if (!this._conn || !this.acpSessionId) return;
    try {
      await this._conn.setSessionMode({ sessionId: this.acpSessionId, modeId });
      if (this.modeState) this.modeState.currentModeId = modeId;
      this._emitMode();
    } catch (err) {
      this._emit({ type: 'acp_error', message: `Failed to set mode: ${err && err.message ? err.message : err}` });
    }
  }

  // Friendly display name for a model id, from the catalog (falls back to the id).
  _modelName(id) {
    const m = this.modelState && this.modelState.availableModels.find(x => x.id === id);
    return (m && m.name) || id;
  }

  async setModel(modelId) {
    await this.ready();
    if (!this._conn || !this.acpSessionId) return;
    const before = this.model;
    try {
      // The response carries the full configOptions set (changing the model can
      // shift the available modes/effort levels), so re-apply from it.
      const res = await this._conn.setSessionConfigOption({ sessionId: this.acpSessionId, configId: 'model', value: modelId });
      if (res && res.configOptions) this._applyConfigOptions(res.configOptions);
      else { if (this.modelState) this.modelState.currentModelId = modelId; this.model = modelId; }
      this._emitModel();
      // The available effort levels depend on the model, so surface any change.
      this._emitEffort();
      // Mark the switch inline in the thread so it shows where it happened and
      // survives re-attach — only when the model actually changed.
      if (this.model && this.model !== before) {
        const notice = { type: 'acp_notice', notice: 'model', text: `Switched to ${this._modelName(this.model)}` };
        this._pushHistory(notice);
        this._emit(notice);
      }
    } catch (err) {
      this._emit({ type: 'acp_error', message: `Failed to set model: ${err && err.message ? err.message : err}` });
    }
  }

  // Friendly display name for an effort id, from the catalog (falls back to the id).
  _effortName(id) {
    const e = this.effortState && this.effortState.availableEfforts.find(x => x.id === id);
    return (e && e.name) || id;
  }

  async setEffort(effortId) {
    await this.ready();
    if (!this._conn || !this.acpSessionId) return;
    const before = this.effortState && this.effortState.currentEffortId;
    try {
      const res = await this._conn.setSessionConfigOption({ sessionId: this.acpSessionId, configId: 'effort', value: effortId });
      if (res && res.configOptions) this._applyConfigOptions(res.configOptions);
      else if (this.effortState) this.effortState.currentEffortId = effortId;
      this._emitEffort();
      const now = this.effortState && this.effortState.currentEffortId;
      if (now && now !== before) {
        const notice = { type: 'acp_notice', notice: 'effort', text: `Effort set to ${this._effortName(now)}` };
        this._pushHistory(notice);
        this._emit(notice);
      }
    } catch (err) {
      this._emit({ type: 'acp_error', message: `Failed to set effort: ${err && err.message ? err.message : err}` });
    }
  }

  _onPermission(params) {
    const requestId = nanoid(8);
    const item = { type: 'acp_permission', requestId, request: params };
    this._pushHistory(item);
    this._setStatus('waiting');
    this._emit(item);
    return new Promise((resolve) => {
      this._pending.set(requestId, resolve);
    });
  }

  // Called when the browser answers a permission prompt. optionId === null
  // (or undefined) means cancelled.
  resolvePermission(requestId, optionId) {
    const fn = this._pending.get(requestId);
    if (!fn) return;
    this._pending.delete(requestId);
    // Mark resolved in history so a re-attach doesn't render a live prompt again.
    for (const h of this.history) {
      if (h.type === 'acp_permission' && h.requestId === requestId) {
        h.resolved = optionId || '__cancelled__';
      }
    }
    if (optionId) fn({ outcome: { outcome: 'selected', optionId } });
    else fn({ outcome: { outcome: 'cancelled' } });
    // Back to working; the turn continues. If the turn was actually finished the
    // next prompt result will flip us to idle.
    this._setStatus('working');
  }

  // blocks: ACP ContentBlock[] (e.g. [{ type: 'text', text: '...' }])
  async prompt(blocks) {
    await this.ready();
    if (!this._conn || !this.acpSessionId) throw new Error('ACP session not ready');

    const userItem = { type: 'acp_user', blocks };
    this._pushHistory(userItem);
    this._emit(userItem);

    this._setStatus('working');
    try {
      const res = await this._conn.prompt({ sessionId: this.acpSessionId, prompt: blocks });
      const stop = { type: 'acp_stop', stopReason: res.stopReason };
      this._pushHistory(stop);
      this._emit(stop);
      this._setStatus('idle');
      this._scheduleModelRefresh();
      this._scheduleTitleRefresh();
      return res;
    } catch (err) {
      const errItem = { type: 'acp_error', message: err && err.message ? err.message : String(err) };
      this._pushHistory(errItem);
      this._emit(errItem);
      this._setStatus('idle');
      throw err;
    }
  }

  cancel() {
    if (this._conn && this.acpSessionId) {
      Promise.resolve(this._conn.cancel({ sessionId: this.acpSessionId })).catch(() => {});
    }
  }

  // ── Conversation management (Claude-style new / resume) ───────────────────
  // Clears the live thread and tells listeners to start fresh.
  _resetThread() {
    this.history = [];
    this._seq = 0;
    this.claudeStatus = undefined;
    this.model = null;
    this._lastTitle = null;          // new conversation → let its own title surface
    this._emit({ type: 'acp_reset', acpSessionId: this.acpSessionId });
  }

  // Start a brand new conversation in the same cwd (like running `claude`).
  async newConversation() {
    await this.ready();
    if (!this._conn) return;
    const res = await this._conn.newSession({ cwd: this.cwd, mcpServers: [] });
    this.acpSessionId = res.sessionId;
    if (res.modes) this.modeState = res.modes;
    this._resetThread();
    this._applyConfigOptions(res.configOptions); // after reset — reset nulls this.model
    this._emitMode();
    this._emitModel();
  }

  // Resume a prior conversation by id (like `claude --resume`); the adapter
  // streams the whole conversation back, which rebuilds the thread.
  async resumeConversation(sessionId) {
    await this.ready();
    if (!this._conn) return;
    this.acpSessionId = sessionId;
    this._resetThread();
    try {
      const res = await this._conn.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] });
      if (res && res.modes) { this.modeState = res.modes; this._emitMode(); }
      if (res) { this._applyConfigOptions(res.configOptions); this._emitModel(); }
      this._refreshModel();
      this._refreshTitle();
    } catch (err) {
      this._emit({ type: 'acp_error', message: `Failed to resume conversation: ${err && err.message ? err.message : err}` });
    }
  }

  // The transcript's assistant line (with the model) is flushed slightly after
  // the prompt result returns, so retry a couple times after a turn.
  _scheduleModelRefresh() {
    this._refreshModel();
    setTimeout(() => this._refreshModel(), 1000);
    setTimeout(() => this._refreshModel(), 3000);
  }

  // The current model isn't exposed over ACP — read the latest assistant
  // message's model from the conversation transcript and emit acp_model.
  async _refreshModel() {
    if (!this.acpSessionId) return;
    try {
      const file = path.join(this._projectDir(), `${this.acpSessionId}.jsonl`);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || !stat.size) return;
      const start = Math.max(0, stat.size - 1024 * 1024);
      const fd = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(stat.size - start);
      await fd.read(buf, 0, buf.length, start);
      await fd.close();
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"model"')) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch (_) { continue; }
        if (o.type === 'assistant' && o.message && o.message.model && o.message.model !== '<synthetic>') {
          if (o.message.model !== this.model) {
            this.model = o.message.model;
            if (this.modelState) this.modelState.currentModelId = this.model;
            this._emitModel();
          }
          return;
        }
      }
    } catch (_) {
      // best-effort
    }
  }

  // Claude Code generates the conversation title asynchronously (a separate
  // background summarization), so it can land well after a turn ends. Poll a few
  // times AND watch the project dir so we catch it whenever it's written.
  _scheduleTitleRefresh() {
    this._refreshTitle();
    setTimeout(() => this._refreshTitle(), 2000);
    setTimeout(() => this._refreshTitle(), 6000);
    setTimeout(() => this._refreshTitle(), 15000);
    this._watchTitle();
  }

  // Watch the project's log dir; any write (Claude persisting the ai-title line)
  // triggers a debounced re-read. One watcher per session; retried until the dir
  // exists (it's created lazily on the first conversation).
  _watchTitle() {
    if (this._titleWatcher || !this.alive) return;
    const dir = this._projectDir();
    let watcher;
    try {
      watcher = fs.watch(dir, () => {
        clearTimeout(this._titleDebounce);
        this._titleDebounce = setTimeout(() => this._refreshTitle(), 400);
      });
    } catch (_) {
      // Dir not there yet — retry shortly while the session is alive.
      if (this.alive) setTimeout(() => this._watchTitle(), 1500);
      return;
    }
    watcher.on('error', () => {});
    this._titleWatcher = watcher;
  }

  // Read the AI-generated title for the current conversation from the project
  // logs and surface it as acp_title when it first appears or changes.
  async _refreshTitle() {
    if (!this.acpSessionId) return;
    try {
      const dir = this._projectDir();
      let names;
      try { names = await fs.promises.readdir(dir); } catch (_) { return; }
      const files = [];
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let stat;
        try { stat = await fs.promises.stat(full); } catch (_) { continue; }
        if (!stat.size) continue;
        files.push({ full, mtime: stat.mtimeMs });
      }
      const titles = await this._readAiTitles(files);
      const title = titles.get(this.acpSessionId);
      if (title && title !== this._lastTitle) {
        this._lastTitle = title;
        this._emit({ type: 'acp_title', title });
      }
    } catch (_) {
      // best-effort
    }
  }

  // Claude stores per-project conversation logs under ~/.claude/projects/<enc cwd>.
  _projectDir() {
    const enc = this.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', enc);
  }

  async listConversations() {
    const dir = this._projectDir();
    let names;
    try { names = await fs.promises.readdir(dir); } catch (_) { return []; }
    const files = [];
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let stat;
      try { stat = await fs.promises.stat(full); } catch (_) { continue; }
      if (!stat.size) continue;
      files.push({ sessionId: f.replace(/\.jsonl$/, ''), full, mtime: stat.mtimeMs });
    }
    // Prefer the AI-generated title Claude Code shows in its own pickers (TUI /
    // VS Code). They're persisted as {"type":"ai-title",...} lines, cross-written
    // across the project's logs, so we scan all of them once. Sessions without
    // one (degenerate/aborted) fall back to the opening prompt.
    const titles = await this._readAiTitles(files);
    const out = [];
    for (const { sessionId, full, mtime } of files) {
      out.push({ sessionId, title: titles.get(sessionId) || await this._readTitle(full), mtime });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  // Scan every log for {"type":"ai-title","aiTitle","sessionId"} lines and map
  // sessionId → title. Files are read oldest→newest so a regenerated title in a
  // newer log overwrites an earlier one. The cheap substring guard avoids JSON
  // parsing the vast majority of (non-title) lines.
  async _readAiTitles(files) {
    const map = new Map();
    const ordered = [...files].sort((a, b) => a.mtime - b.mtime);
    for (const { full } of ordered) {
      let text;
      try { text = await fs.promises.readFile(full, 'utf8'); } catch (_) { continue; }
      if (!text.includes('"ai-title"')) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"ai-title"')) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        if (o.type === 'ai-title' && o.sessionId && o.aiTitle) map.set(o.sessionId, String(o.aiTitle));
      }
    }
    return map;
  }

  // Pull the first genuine human-typed text out of a user message's content,
  // skipping synthetic context blocks the harness injects (<ide_opened_file>,
  // <command-message>, <system-reminder>, …) and tool_result blocks. The real
  // prompt is often the second text block of the first user message, after one
  // of those wrappers — so scan all blocks rather than taking just the first.
  static _firstHumanText(content) {
    const ok = (s) => typeof s === 'string' && s.trim() && !s.trim().startsWith('<');
    if (ok(content)) return content.trim();
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'text' && ok(b.text)) return b.text.trim();
      }
    }
    return '';
  }

  // Read just the head of a log to derive a human title (first real user line).
  async _readTitle(file) {
    let fd;
    try {
      fd = await fs.promises.open(file, 'r');
      // 256 KB: the opening prompt is sometimes preceded by a large injected
      // context block (pasted text, an attachment), so a small head can cut off
      // the first user line mid-JSON and miss the title entirely.
      const buf = Buffer.alloc(262144);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const text = buf.slice(0, bytesRead).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        if (o.type === 'summary' && o.summary) return String(o.summary).slice(0, 80);
        if (o.type === 'user' && o.message) {
          const t = AcpSession._firstHumanText(o.message.content);
          if (t) return t.replace(/\s+/g, ' ').slice(0, 80);
        }
      }
    } catch (_) {
      // ignore — title is best-effort
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
    return null;
  }

  // Snapshot for attach replay.
  snapshot() {
    return {
      events: this.history,
      claudeStatus: this.claudeStatus,
      acpSessionId: this.acpSessionId,
      modeState: this.modeState,
      availableCommands: this.availableCommands,
      model: this.model,
      modelState: this.modelState,
      effortState: this.effortState,
      usage: this.usage,
      // True while a resume is still replaying history; the snapshot is empty
      // now and the conversation will stream in via subsequent acp_event frames.
      loading: this._resumeRequested && !this.isReady,
    };
  }

  kill() {
    this.alive = false;
    clearTimeout(this._titleDebounce);
    try { if (this._titleWatcher) this._titleWatcher.close(); } catch (_) {}
    this._titleWatcher = null;
    try { if (this._child) this._child.kill(); } catch (_) {}
  }
}

module.exports = AcpSession;
