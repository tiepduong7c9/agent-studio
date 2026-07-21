// ACP-only session manager for the engine daemon. Ported from ccremote's
// session-manager (the PTY paths dropped), it owns one AcpSession per session,
// mirrors Claude status onto persisted metadata, and exposes per-session event
// streams + a session-list change event as VS Code Events so the channel layer
// can forward them over IPC.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nanoid } from 'nanoid';
// CommonJS ACP driver, copied verbatim from ccremote; default export is the class.
import AcpSession from './acp-session.cjs';
import { Emitter, Event } from '../vendor/vs/base/common/event.js';
import { toDisposable, IDisposable } from '../vendor/vs/base/common/lifecycle.js';
import { STATE_DIR, SESSIONS_FILE } from '../constants.js';
import { listAllProjects } from './projects.js';
// CommonJS usage fetcher (account + rate-limit windows); esbuild interops the named export.
import { getUsageDetail } from './usage.cjs';
// CommonJS out-of-band title generator (subscription-OAuth call to /v1/messages).
import { generateTitle } from './title.cjs';
import type { AcpConversation, AcpEvent, AcpSnapshot, AcpUsageDetail, ClaudeStatus, CreateSessionOptions, ProjectConversations, SessionMeta } from './types.js';

const ADJECTIVES = ['amber', 'arctic', 'bold', 'brave', 'bright', 'calm', 'cool', 'crisp', 'dawn', 'deep', 'fast', 'fierce', 'gentle', 'golden', 'grand', 'hidden', 'jade', 'keen', 'lively', 'lucid', 'mellow', 'misty', 'noble', 'quiet', 'rapid', 'royal', 'shady', 'sharp', 'silent', 'silver', 'sleek', 'solar', 'still', 'sturdy', 'swift', 'teal', 'vivid', 'warm', 'wild', 'wise'];
const ANIMALS = ['bear', 'bison', 'boar', 'cobra', 'crane', 'crow', 'deer', 'dove', 'eagle', 'elk', 'falcon', 'finch', 'fox', 'goat', 'goose', 'hawk', 'heron', 'hound', 'jay', 'kite', 'lark', 'lion', 'lynx', 'mink', 'moose', 'newt', 'orca', 'otter', 'owl', 'panda', 'puma', 'quail', 'raven', 'robin', 'seal', 'shark', 'snipe', 'stag', 'swan', 'tiger', 'trout', 'viper', 'vole', 'wasp', 'weasel', 'whale', 'wolf', 'wren'];

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}-${animal}`;
}

interface SessionRecord {
  meta: SessionMeta;
  acp: any; // AcpSession instance (untyped CJS)
  statusListener?: (event: AcpEvent) => void;
}

export class SessionManager {
  private readonly _sessions = new Map<string, SessionRecord>();

  private readonly _onDidChangeSessions = new Emitter<SessionMeta[]>();
  /** Fires whenever the session list or any session's status changes. */
  readonly onDidChangeSessions: Event<SessionMeta[]> = this._onDidChangeSessions.event;

  constructor() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    this._loadPersisted();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  create(opts: CreateSessionOptions): SessionMeta {
    const id = nanoid(8);
    let name = opts.name;
    if (!name) {
      const base = randomName();
      const taken = new Set([...this._sessions.values()].map((s) => s.meta.name));
      name = taken.has(base) ? `${base}-${id.slice(0, 4)}` : base;
    }
    const cwd = path.resolve(opts.cwd.replace(/^~(?=$|\/)/, os.homedir()));

    const meta: SessionMeta = {
      id, name, mode: 'acp', status: 'running',
      // A name the caller chose is theirs to keep; an auto-generated one yields
      // to Claude's title once it lands.
      titleLocked: !!opts.name,
      cwd, acpSessionId: null, claudeStatus: undefined,
      createdAt: new Date().toISOString(), lastAttachedAt: null,
    };
    const acp = new AcpSession({ cwd, env: this._childEnv(id) });
    const rec: SessionRecord = { meta, acp };
    this._registerStatusMirror(rec);
    this._sessions.set(id, rec);

    acp.start()
      .then(() => { meta.acpSessionId = acp.acpSessionId; this._changed(); })
      .catch((err: any) => {
        acp._emit({ type: 'acp_error', message: `Failed to start Claude (ACP): ${err?.message || err}` });
        meta.status = 'suspended';
        this._changed();
      });

    this._changed();
    return { ...meta };
  }

  // Re-spawn a suspended session's adapter and load its prior conversation.
  private _resume(rec: SessionRecord): boolean {
    if (rec.meta.status !== 'suspended') return rec.meta.status === 'running';
    const { meta } = rec;
    const acp = new AcpSession({ cwd: meta.cwd, env: this._childEnv(meta.id) });
    rec.acp = acp;
    meta.status = 'running';
    meta.resumedAt = new Date().toISOString();
    delete meta.exitCode;
    this._registerStatusMirror(rec);
    acp.start({ resumeSessionId: meta.acpSessionId })
      .then(() => { meta.acpSessionId = acp.acpSessionId; this._changed(); })
      .catch((err: any) => {
        acp._emit({ type: 'acp_error', message: `Failed to resume Claude (ACP): ${err?.message || err}` });
        meta.status = 'suspended';
        this._changed();
      });
    this._changed();
    return true;
  }

  private _ensureRunning(id: string): SessionRecord | null {
    const rec = this._sessions.get(id);
    if (!rec) return null;
    if (rec.meta.status === 'suspended') this._resume(rec);
    return rec.meta.status === 'running' ? rec : null;
  }

  // ── queries ───────────────────────────────────────────────────────────────

  list(): SessionMeta[] {
    return [...this._sessions.values()].map((s) => ({ ...s.meta }));
  }

  // All Claude projects on this host with their resumable conversations, read
  // from ~/.claude/projects/ — independent of the sessions this daemon manages.
  listProjects(): Promise<ProjectConversations[]> {
    return listAllProjects();
  }

  // Account + subscription-usage windows for this host's Claude credentials.
  // Fetched out-of-band (the ACP adapter doesn't forward rate-limit windows);
  // returns nulls when credentials/endpoint are unavailable.
  getUsage(): Promise<AcpUsageDetail> {
    return getUsageDetail();
  }

  snapshot(id: string): AcpSnapshot | null {
    const rec = this._ensureRunning(id);
    if (!rec) return null;
    rec.meta.lastAttachedAt = new Date().toISOString();
    return rec.acp.snapshot();
  }

  // Per-session event stream. Resuming a suspended session on first subscription
  // means the caller sees the replayed history stream in after it fetches the
  // snapshot; the client dedupes by event seq.
  onSessionEvent(id: string): Event<AcpEvent> {
    const rec = this._ensureRunning(id);
    if (!rec) return Event.None;
    const forward = (e: AcpEvent) => emitter.fire(e);
    const emitter = new Emitter<AcpEvent>({
      onWillAddFirstListener: () => rec.acp.listeners.add(forward),
      onDidRemoveLastListener: () => rec.acp.listeners.delete(forward),
    });
    return emitter.event;
  }

  // ── ACP operations ──────────────────────────────────────────────────────────

  prompt(id: string, blocks: any[]): void {
    const rec = this._ensureRunning(id);
    rec?.acp.prompt(blocks).catch(() => {});
  }
  // cancel / resolvePermission act on a live turn only — a no-op on a dormant
  // (suspended) adapter is correct, so they don't force a resume.
  cancel(id: string): void { this._sessions.get(id)?.acp.cancel(); }
  resolvePermission(id: string, requestId: string, optionId: string | null): void {
    this._sessions.get(id)?.acp.resolvePermission(requestId, optionId);
  }
  resolveElicitation(id: string, requestId: string, response: unknown): void {
    this._sessions.get(id)?.acp.resolveElicitation(requestId, response);
  }
  // State-changing ops resume a suspended session first, so selecting a mode/model
  // or starting/switching a conversation before the first prompt (e.g. right after
  // a daemon restart) reaches a started adapter instead of being silently dropped.
  setMode(id: string, modeId: string): void { this._ensureRunning(id)?.acp.setMode(modeId); }
  setModel(id: string, modelId: string): void { this._ensureRunning(id)?.acp.setModel(modelId); }
  setEffort(id: string, effortId: string): void { this._ensureRunning(id)?.acp.setEffort(effortId); }
  listConversations(id: string): Promise<AcpConversation[]> {
    const rec = this._sessions.get(id);
    return rec ? rec.acp.listConversations() : Promise.resolve([]);
  }
  newConversation(id: string): void { this._ensureRunning(id)?.acp.newConversation().catch(() => {}); }
  resumeConversation(id: string, sessionId: string): void {
    this._ensureRunning(id)?.acp.resumeConversation(sessionId).catch(() => {});
  }

  rename(id: string, name: string): SessionMeta | null {
    const rec = this._sessions.get(id);
    if (!rec) return null;
    rec.meta.name = name;
    rec.meta.titleLocked = true;
    this._changed();
    return { ...rec.meta };
  }

  // Ask Claude to recap the conversation into a fresh title, out-of-band (no turn
  // injected into the session). Adopts the result like a manual rename — it
  // becomes user-owned, so Claude's own auto-titles won't override it. Returns
  // the updated meta, or null if the session is gone or a title couldn't be made
  // (empty conversation, missing/expired credentials, API failure).
  async regenerateTitle(id: string): Promise<SessionMeta | null> {
    const rec = this._sessions.get(id);
    if (!rec) return null;
    const title = await generateTitle({ cwd: rec.meta.cwd, acpSessionId: rec.meta.acpSessionId });
    if (!title) return null;
    // Re-check: the session may have been killed while the request was in flight.
    if (!this._sessions.has(id)) return null;
    rec.meta.name = title;
    rec.meta.titleLocked = true;
    this._changed();
    return { ...rec.meta };
  }

  kill(id: string): boolean {
    const rec = this._sessions.get(id);
    if (!rec) return false;
    try { rec.acp.kill(); } catch { /* ignore */ }
    this._sessions.delete(id);
    this._changed();
    return true;
  }

  // Suspend every live session (daemon shutdown): the adapters exit but the
  // conversations remain resumable by acpSessionId on next attach.
  suspendAll(): void {
    for (const rec of this._sessions.values()) {
      if (rec.meta.status === 'running') {
        try { rec.acp.kill(); } catch { /* ignore */ }
        rec.meta.status = 'suspended';
        delete rec.meta.claudeStatus;
      }
    }
    this._persist();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  // Keep an internal listener on the acp session that mirrors status/reset/exit
  // onto persisted metadata and broadcasts session-list changes.
  private _registerStatusMirror(rec: SessionRecord): void {
    const { meta, acp } = rec;
    const listener = (event: AcpEvent) => {
      if (event.type === 'acp_status') {
        const next = event.claudeStatus as ClaudeStatus | undefined;
        if (meta.claudeStatus !== next) {
          if (next === undefined) delete meta.claudeStatus; else meta.claudeStatus = next;
          this._changed();
        }
      } else if (event.type === 'acp_title') {
        // Claude generated a conversation title — adopt it as the session name
        // unless the user has claimed the name themselves.
        const title = String(event.title || '').trim();
        if (title && !meta.titleLocked && meta.name !== title) {
          meta.name = title;
          this._changed();
        }
      } else if (event.type === 'acp_reset') {
        meta.acpSessionId = event.acpSessionId;
        delete meta.claudeStatus;
        this._changed();
      } else if (event.type === 'exit') {
        if (meta.status === 'running') meta.status = 'suspended';
        delete meta.claudeStatus;
        this._changed();
      }
    };
    acp.listeners.add(listener);
    rec.statusListener = listener;
  }

  private _childEnv(sid: string): NodeJS.ProcessEnv {
    const extraBins = [
      path.dirname(process.execPath),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.npm-global', 'bin'),
    ];
    const parts = [...extraBins, process.env.PATH || ''].filter(Boolean);
    return { ...process.env, PATH: parts.join(path.delimiter), AGENT_STUDIO_SID: sid };
  }

  private _changed(): void {
    this._persist();
    this._onDidChangeSessions.fire(this.list());
  }

  private _persist(): void {
    try {
      const data = [...this._sessions.values()].map((s) => s.meta);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch { /* best effort */ }
  }

  private _loadPersisted(): void {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const saved: SessionMeta[] = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const meta of saved) {
        if (this._sessions.has(meta.id)) continue;
        if (meta.status === 'running') meta.status = 'suspended'; // was live when daemon stopped
        delete meta.claudeStatus;
        // Recreate a dormant AcpSession; it spawns lazily on first attach (_resume).
        const acp = new AcpSession({ cwd: meta.cwd, env: this._childEnv(meta.id) });
        const rec: SessionRecord = { meta, acp };
        this._registerStatusMirror(rec);
        this._sessions.set(meta.id, rec);
      }
    } catch { /* ignore malformed state */ }
  }
}
