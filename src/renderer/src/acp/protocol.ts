// Rich ACP thread types, ported from ccremote's web/src/lib/protocol.ts. These
// type the structured event stream the engine forwards over IPC (window.studio.acp).

export type AcpContentBlock = { type: 'text'; text: string } | { type: string; [k: string]: unknown }

export interface AcpToolContent {
  type: string // 'content' | 'diff' | ...
  content?: AcpContentBlock
  path?: string
  oldText?: string | null
  newText?: string
  [k: string]: unknown
}

export interface AcpPlanEntry { content: string; priority?: string; status?: string }

export type AcpUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title?: string; kind?: string; status?: string; content?: AcpToolContent[] }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status?: string; title?: string; content?: AcpToolContent[] }
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
  | { sessionUpdate: string; [k: string]: unknown }

export interface AcpSessionMode { id: string; name: string; description?: string | null }
export interface AcpModeState { currentModeId: string; availableModes: AcpSessionMode[] }

export interface AcpModelInfo { id: string; name: string; description?: string | null }
export interface AcpModelState { currentModelId: string; availableModels: AcpModelInfo[] }

export interface AcpCommand { name: string; description: string; input?: { hint: string } | null }

export interface AcpPermissionOption { optionId: string; name: string; kind?: string }
export interface AcpPermissionRequest {
  options: AcpPermissionOption[]
  toolCall?: { title?: string; kind?: string; content?: AcpToolContent[]; [k: string]: unknown }
  [k: string]: unknown
}

export type AcpEvent = (
  | { type: 'acp_user'; blocks: AcpContentBlock[] }
  | { type: 'acp_update'; update: AcpUpdate }
  | { type: 'acp_permission'; requestId: string; request: AcpPermissionRequest; resolved?: string }
  | { type: 'acp_stop'; stopReason: string }
  | { type: 'acp_error'; message: string }
  | { type: 'acp_status'; claudeStatus?: 'working' | 'waiting' | 'idle' }
  | { type: 'acp_mode'; modeState: AcpModeState | null }
  | { type: 'acp_reset'; acpSessionId: string | null }
  | { type: 'acp_commands'; commands: AcpCommand[] }
  | { type: 'acp_model'; model: string | null; modelState?: AcpModelState | null }
  | { type: 'acp_notice'; notice: string; text: string }
) & { seq?: number }
