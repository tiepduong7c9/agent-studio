// Shared shapes for the ACP session engine. The event/update payloads are kept
// loose here (typed richly on the renderer side); the engine only routes them.

export type ClaudeStatus = 'idle' | 'working' | 'waiting';

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  mode: 'acp';
  status: 'running' | 'suspended' | 'exited';
  claudeStatus?: ClaudeStatus;
  acpSessionId?: string | null;
  createdAt: string;
  lastAttachedAt?: string | null;
  resumedAt?: string;
  exitCode?: number;
}

// One thread event or transient state update fanned out to attached clients.
export type AcpEvent = { type: string; seq?: number; [k: string]: any };

export interface AcpSnapshot {
  events: AcpEvent[];
  claudeStatus?: ClaudeStatus;
  acpSessionId: string | null;
  modeState?: any;
  availableCommands?: any[];
  model?: string | null;
  modelState?: any;
  loading?: boolean;
}

export interface AcpConversation {
  sessionId: string;
  title: string | null;
  mtime: number;
}

/** A project folder discovered on disk with its resumable conversations. */
export interface ProjectConversations {
  /** Absolute project root (read from the logs, not the lossy dir encoding). */
  cwd: string;
  /** Display name — the folder basename of cwd. */
  name: string;
  /** Host the project lives on; decorated in the main process (null = local). */
  host?: string | null;
  conversations: AcpConversation[];
}

export interface CreateSessionOptions {
  name?: string;
  cwd: string;
}
