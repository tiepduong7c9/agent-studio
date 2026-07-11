// Shared shapes for the ACP session engine. The event/update payloads are kept
// loose here (typed richly on the renderer side); the engine only routes them.

export type ClaudeStatus = 'idle' | 'working' | 'waiting';

export interface SessionMeta {
  id: string;
  name: string;
  /** True once the name is user-owned (explicit at create, or a manual rename),
   *  so Claude's generated title no longer overrides it. */
  titleLocked?: boolean;
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

/** Context-window occupancy for a session, from the adapter's usage_update. */
export interface AcpUsage {
  /** Tokens occupying the context window after the latest turn. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
  /** Cumulative session cost, when the adapter reports it. */
  cost?: { amount: number; currency: string } | null;
}

/** One rate-limit window from the Anthropic OAuth usage endpoint. */
export interface AcpUsageWindow { utilization: number; resets_at: string }
/** Subscription usage across the account's rate-limit windows. */
export interface AcpUsageData {
  five_hour?: AcpUsageWindow | null;
  seven_day?: AcpUsageWindow | null;
  seven_day_opus?: AcpUsageWindow | null;
  seven_day_sonnet?: AcpUsageWindow | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
    currency: string;
    disabled_reason: string | null;
  } | null;
}
/** Claude account details from `claude auth status --json`. */
export interface AcpAccount {
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  [k: string]: any;
}
/** Account + subscription usage for one engine host. */
export interface AcpUsageDetail { account: AcpAccount | null; usage: AcpUsageData | null }

export interface AcpSnapshot {
  events: AcpEvent[];
  claudeStatus?: ClaudeStatus;
  acpSessionId: string | null;
  modeState?: any;
  availableCommands?: any[];
  model?: string | null;
  modelState?: any;
  usage?: AcpUsage | null;
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
