// Wire contract between the Electron processes and the engine. These mirror
// engine/src/acp/types.ts (the server-side copy) — duplicated deliberately, as a
// process-boundary contract, so the app never imports engine source for types.

export type ClaudeStatus = 'idle' | 'working' | 'waiting'

export interface SessionMeta {
  id: string
  name: string
  cwd: string
  mode: 'acp'
  status: 'running' | 'suspended' | 'exited'
  claudeStatus?: ClaudeStatus
  acpSessionId?: string | null
  createdAt: string
  lastAttachedAt?: string | null
  resumedAt?: string
  exitCode?: number
}

/** One thread event or transient state update for a session. */
export type AcpEvent = { type: string; seq?: number; [k: string]: any }

export interface AcpSnapshot {
  events: AcpEvent[]
  claudeStatus?: ClaudeStatus
  acpSessionId: string | null
  modeState?: any
  availableCommands?: any[]
  model?: string | null
  modelState?: any
  loading?: boolean
}

export interface AcpConversation {
  sessionId: string
  title: string | null
  mtime: number
}

/** Payload pushed on the 'acp:event' channel (main → renderer). */
export interface AcpEventPayload {
  sid: string
  event: AcpEvent
}

// ── engine client module shape (dynamically imported in the main process) ─────

export interface Disposable { dispose(): void }
export type EventFn<T> = (listener: (e: T) => void) => Disposable

export interface ISessionManagerClient {
  list(): Promise<SessionMeta[]>
  create(opts: { cwd: string; name?: string }): Promise<SessionMeta>
  snapshot(sid: string): Promise<AcpSnapshot | null>
  prompt(sid: string, blocks: any[]): Promise<void>
  cancel(sid: string): Promise<void>
  permissionResponse(sid: string, requestId: string, optionId: string | null): Promise<void>
  setMode(sid: string, modeId: string): Promise<void>
  setModel(sid: string, modelId: string): Promise<void>
  listConversations(sid: string): Promise<AcpConversation[]>
  newConversation(sid: string): Promise<void>
  resumeConversation(sid: string, sessionId: string): Promise<void>
  rename(sid: string, name: string): Promise<SessionMeta | null>
  kill(sid: string): Promise<boolean>
  onDidChangeSessions: EventFn<SessionMeta[]>
  onSessionEvent(sid: string): EventFn<AcpEvent>
}

export interface EngineConnection { getChannel(name: string): any; dispose(): void }

export interface EngineModule {
  ensureDaemon(opts?: { nodePath?: string }): Promise<void>
  connect(path: string, clientId: string): Promise<EngineConnection>
  /** Build a client over any duplex stream — used for the SSH tunnel. */
  connectOverStream(stream: NodeJS.ReadWriteStream, clientId: string): EngineConnection
  createSessionManagerClient(channel: any): ISessionManagerClient
  SOCKET_PATH: string
  SESSION_MANAGER_CHANNEL: string
  VERSION: string
}
