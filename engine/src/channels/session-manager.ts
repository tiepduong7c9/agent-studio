// Exposes the ACP SessionManager as a VS Code IPC channel. The server half
// (SessionManagerChannel) routes call/listen onto the manager; the client half
// (createSessionManagerClient) gives the Electron main process a typed proxy
// over an IChannel — regardless of whether that channel is local or SSH-tunneled.

import type { IChannel, IServerChannel } from '../net.js';
import type { Event } from '../net.js';
import type { SessionManager } from '../acp/session-manager.js';
import type { AcpConversation, AcpEvent, AcpSnapshot, AcpUsageDetail, CreateSessionOptions, ProjectConversations, SessionMeta } from '../acp/types.js';

export const SESSION_MANAGER_CHANNEL = 'sessionManager';

export class SessionManagerChannel implements IServerChannel {
  constructor(private readonly manager: SessionManager) {}

  async call(_ctx: string, command: string, arg?: any): Promise<any> {
    switch (command) {
      case 'list': return this.manager.list();
      case 'listProjects': return this.manager.listProjects();
      case 'getUsage': return this.manager.getUsage();
      case 'create': return this.manager.create(arg as CreateSessionOptions);
      case 'snapshot': return this.manager.snapshot(arg as string);
      case 'prompt': this.manager.prompt(arg.sid, arg.blocks); return;
      case 'cancel': this.manager.cancel(arg as string); return;
      case 'permissionResponse': this.manager.resolvePermission(arg.sid, arg.requestId, arg.optionId); return;
      case 'setMode': this.manager.setMode(arg.sid, arg.modeId); return;
      case 'setModel': this.manager.setModel(arg.sid, arg.modelId); return;
      case 'setEffort': this.manager.setEffort(arg.sid, arg.effortId); return;
      case 'listConversations': return this.manager.listConversations(arg as string);
      case 'newConversation': this.manager.newConversation(arg as string); return;
      case 'resumeConversation': this.manager.resumeConversation(arg.sid, arg.sessionId); return;
      case 'rename': return this.manager.rename(arg.sid, arg.name);
      case 'kill': return this.manager.kill(arg as string);
      default: throw new Error(`sessionManager channel: unknown command '${command}'`);
    }
  }

  listen(_ctx: string, event: string, arg?: any): Event<any> {
    switch (event) {
      case 'onDidChangeSessions': return this.manager.onDidChangeSessions;
      case 'onSessionEvent': return this.manager.onSessionEvent(arg as string);
      default: throw new Error(`sessionManager channel: no event '${event}'`);
    }
  }
}

// ── client-side proxy ─────────────────────────────────────────────────────────

export interface ISessionManagerClient {
  list(): Promise<SessionMeta[]>;
  listProjects(): Promise<ProjectConversations[]>;
  getUsage(): Promise<AcpUsageDetail>;
  create(opts: CreateSessionOptions): Promise<SessionMeta>;
  snapshot(sid: string): Promise<AcpSnapshot | null>;
  prompt(sid: string, blocks: any[]): Promise<void>;
  cancel(sid: string): Promise<void>;
  permissionResponse(sid: string, requestId: string, optionId: string | null): Promise<void>;
  setMode(sid: string, modeId: string): Promise<void>;
  setModel(sid: string, modelId: string): Promise<void>;
  setEffort(sid: string, effortId: string): Promise<void>;
  listConversations(sid: string): Promise<AcpConversation[]>;
  newConversation(sid: string): Promise<void>;
  resumeConversation(sid: string, sessionId: string): Promise<void>;
  rename(sid: string, name: string): Promise<SessionMeta | null>;
  kill(sid: string): Promise<boolean>;
  onDidChangeSessions: Event<SessionMeta[]>;
  onSessionEvent(sid: string): Event<AcpEvent>;
}

export function createSessionManagerClient(channel: IChannel): ISessionManagerClient {
  return {
    list: () => channel.call('list'),
    listProjects: () => channel.call('listProjects'),
    getUsage: () => channel.call('getUsage'),
    create: (opts) => channel.call('create', opts),
    snapshot: (sid) => channel.call('snapshot', sid),
    prompt: (sid, blocks) => channel.call('prompt', { sid, blocks }),
    cancel: (sid) => channel.call('cancel', sid),
    permissionResponse: (sid, requestId, optionId) => channel.call('permissionResponse', { sid, requestId, optionId }),
    setMode: (sid, modeId) => channel.call('setMode', { sid, modeId }),
    setModel: (sid, modelId) => channel.call('setModel', { sid, modelId }),
    setEffort: (sid, effortId) => channel.call('setEffort', { sid, effortId }),
    listConversations: (sid) => channel.call('listConversations', sid),
    newConversation: (sid) => channel.call('newConversation', sid),
    resumeConversation: (sid, sessionId) => channel.call('resumeConversation', { sid, sessionId }),
    rename: (sid, name) => channel.call('rename', { sid, name }),
    kill: (sid) => channel.call('kill', sid),
    onDidChangeSessions: channel.listen('onDidChangeSessions'),
    onSessionEvent: (sid) => channel.listen('onSessionEvent', sid),
  };
}
