// The agent-studio MCP server, attached to every session (see SessionManager.
// _mcpServers). It lets a session's agent see and drive the other sessions in
// Agent Studio — on every host, not just this one — so you can ask one session
// to check on, prompt, or start another.
//
// Claude Code spawns this as a stdio MCP server on the session's own host. It
// only defines the tools: each call is relayed over the daemon socket to the
// desktop app (SessionManager.studioRequest), which is connected to every host
// and does the actual work. MCP's stdio transport is newline-delimited JSON-RPC,
// small enough to speak directly rather than pull in the SDK.

import * as net from 'net';
import * as readline from 'readline';
import { connectOverStream } from './connect-socket.js';
import { SESSION_MANAGER_CHANNEL, createSessionManagerClient, type ISessionManagerClient } from './channels/session-manager.js';
import { SOCKET_PATH, VERSION } from './constants.js';

const CALLER_SID = process.env.AGENT_STUDIO_SID || '';
const SOCKET = process.env.AGENT_STUDIO_SOCKET || SOCKET_PATH;

const sessionId = { type: 'string', description: 'The session id, from list_sessions.' };
const timeout = {
  type: 'integer',
  minimum: 1,
  maximum: 1800,
  description: 'How long to wait, in seconds (default 300, max 1800).',
};

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List Agent Studio sessions across all connected hosts (this machine and SSH hosts): id, name, host, project folder, and status ' +
      '(needs_you = waiting for an answer or stopped, running = working on a turn, scheduled = will wake itself later, idle). ' +
      'Your own session is marked "(this session)".',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: ['needs_you', 'running', 'scheduled', 'idle'] },
          description: 'Only include sessions in these states.',
        },
        host: { type: 'string', description: 'Only include sessions on this host: "local" or "user@host".' },
      },
    },
  },
  {
    name: 'read_session',
    description:
      "Read another session's recent conversation: the user prompts, the agent's replies, the tools it ran, and anything it is waiting on " +
      '(a permission prompt or question).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: sessionId,
        turns: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent turns to include (default 3).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'send_prompt',
    description:
      'Send a message to another session, as if the user typed it there (it is labelled as coming from your session). ' +
      'Fails if that session is in the middle of a turn — use wait_for_session first. Set wait=true to block until it ' +
      'finishes the turn and get its reply.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: sessionId,
        message: { type: 'string', description: 'What to send.' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish and return the reply (default false).' },
        timeout_seconds: timeout,
      },
      required: ['session_id', 'message'],
    },
  },
  {
    name: 'wait_for_session',
    description:
      'Wait until a session stops working — it finished its turn, or needs an answer from the user — then return its latest reply.',
    inputSchema: {
      type: 'object',
      properties: { session_id: sessionId, timeout_seconds: timeout },
      required: ['session_id'],
    },
  },
  {
    name: 'create_session',
    description:
      'Start a new Agent Studio session in a folder on a connected host, optionally with a first message. ' +
      'It appears on the user\'s board like any other session.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute folder on that host to run the session in.' },
        host: { type: 'string', description: 'Host to run on: "local" (default) or "user@host" from list_sessions.' },
        name: { type: 'string', description: 'Session name (default: generated from the conversation).' },
        message: { type: 'string', description: 'First message to send.' },
        wait: { type: 'boolean', description: 'With a message: wait for the first turn to finish and return the reply.' },
        timeout_seconds: timeout,
      },
      required: ['cwd'],
    },
  },
  {
    name: 'cancel_turn',
    description: "Stop another session's current turn (like the user pressing Stop).",
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'] },
  },
];

const INSTRUCTIONS =
  'Agent Studio runs many Claude sessions side by side, on this machine and on SSH hosts. These tools let you see and ' +
  'drive the other sessions: list them, read what they have been doing, send them messages, wait for them, or start new ' +
  'ones. Permission prompts in other sessions still go to the user — you cannot approve them.';

// ── daemon connection (lazy, reused across calls) ──────────────────────────────

let client: Promise<ISessionManagerClient> | null = null;
function sessionManager(): Promise<ISessionManagerClient> {
  if (!client) {
    client = new Promise<ISessionManagerClient>((resolve, reject) => {
      const socket = net.createConnection(SOCKET);
      socket.once('connect', () => {
        const conn = connectOverStream(socket, `studio-mcp-${CALLER_SID || process.pid}`);
        resolve(createSessionManagerClient(conn.getChannel(SESSION_MANAGER_CHANNEL)));
      });
      socket.once('error', (err) => { client = null; reject(err); });
      socket.once('close', () => { client = null; });
    });
  }
  return client;
}

// ── JSON-RPC over stdio ───────────────────────────────────────────────────────

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };
const reply = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string): void => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-studio', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const sm = await sessionManager();
        const res = await sm.studioRequest(CALLER_SID, name, params?.arguments || {});
        return reply(id, { content: [{ type: 'text', text: res.text }], isError: !!res.isError });
      } catch (err: any) {
        return reply(id, {
          content: [{ type: 'text', text: `Agent Studio engine unreachable: ${err?.message || err}` }],
          isError: true,
        });
      }
    }
    default:
      // Notifications (initialized, cancelled, …) need no answer.
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
