// Wire contract between the Electron processes and the engine. These mirror
// engine/src/acp/types.ts (the server-side copy) — duplicated deliberately, as a
// process-boundary contract, so the app never imports engine source for types.

export type ClaudeStatus = 'idle' | 'working' | 'waiting'

export interface SessionMeta {
  id: string
  name: string
  /** True once the name is user-owned (explicit at create, or a manual rename),
   *  so Claude's generated title no longer overrides it. */
  titleLocked?: boolean
  cwd: string
  /** Host the session runs on: "user@host" for ssh, null/absent for local.
   *  Decorated in the main process when merging engines; not set by the engine. */
  host?: string | null
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

/** Context-window occupancy for a session, from the adapter's usage_update. */
export interface AcpUsage {
  /** Tokens occupying the context window after the latest turn. */
  used: number
  /** Total context window size in tokens. */
  size: number
  /** Cumulative session cost, when the adapter reports it. */
  cost?: { amount: number; currency: string } | null
}

/** One rate-limit window from the Anthropic OAuth usage endpoint. */
export interface AcpUsageWindow { utilization: number; resets_at: string }
/** Subscription usage across the account's rate-limit windows. */
export interface AcpUsageData {
  five_hour?: AcpUsageWindow | null
  seven_day?: AcpUsageWindow | null
  seven_day_opus?: AcpUsageWindow | null
  seven_day_sonnet?: AcpUsageWindow | null
  extra_usage?: {
    is_enabled: boolean
    monthly_limit: number
    used_credits: number
    utilization: number | null
    currency: string
    disabled_reason: string | null
  } | null
}
/** Claude account details from `claude auth status --json`. */
export interface AcpAccount {
  authMethod?: string
  email?: string
  orgName?: string
  subscriptionType?: string
  [k: string]: any
}
/** Account + subscription usage for one engine host. */
export interface AcpUsageDetail { account: AcpAccount | null; usage: AcpUsageData | null }

export interface AcpSnapshot {
  events: AcpEvent[]
  claudeStatus?: ClaudeStatus
  acpSessionId: string | null
  modeState?: any
  availableCommands?: any[]
  model?: string | null
  modelState?: any
  usage?: AcpUsage | null
  loading?: boolean
}

export interface AcpConversation {
  sessionId: string
  title: string | null
  mtime: number
}

/** A project folder discovered on a host with its resumable conversations. */
export interface ProjectConversations {
  /** Absolute project root on its host. */
  cwd: string
  /** Display name — the folder basename of cwd. */
  name: string
  /** Host the project lives on: "user@host" for ssh, null/absent for local.
   *  Decorated in the main process when merging engines. */
  host?: string | null
  conversations: AcpConversation[]
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
  listProjects(): Promise<ProjectConversations[]>
  getUsage(): Promise<AcpUsageDetail>
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
