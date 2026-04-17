#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config';
import { DaemonPool } from './daemon-client';
import { McpRemoteError } from './errors';
import { getOrCreateOrigin } from './origin';
import { remoteListServers } from './tools/remote_list_servers';
import { remoteRead } from './tools/remote_read';
import { remoteGetConversation } from './tools/remote_get_conversation';
import { remoteDispatch } from './tools/remote_dispatch';
import { remoteSendInput } from './tools/remote_send_input';
import { remoteCancel } from './tools/remote_cancel';
import { remoteExec } from './tools/remote_exec';
import { remoteWrite } from './tools/remote_write';

const config = loadConfig();
const origin = getOrCreateOrigin();
const pool = new DaemonPool(config.servers, origin);

const server = new Server(
  { name: 'companion-remote', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'remote_list_servers',
    description:
      'List Companion daemons configured in ~/.companion/mcp-servers.json, ' +
      'including current connection state and cached capabilities.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'remote_read',
    description: 'Read a file on a remote Companion daemon (proxies read_file).',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from mcp-servers.json' },
        path: { type: 'string', description: 'Absolute path or ~-prefixed path on the remote' },
      },
      required: ['server', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_get_conversation',
    description:
      'Fetch a conversation from a remote daemon. Mode "highlights" (default) returns ' +
      'the curated view; "full" returns every raw message.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['highlights', 'full'] },
      },
      required: ['server', 'sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_dispatch',
    description:
      'Spawn a new Claude session on a remote Companion daemon inside tmux. Requires the ' +
      'daemon to have the "dispatch" capability enabled. Returns the tmux session name, ' +
      'creation timestamp, resolved JSONL sessionId (null if not resolved within 5s), ' +
      'and the absolute path of the claude binary used.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from mcp-servers.json' },
        prompt: { type: 'string', description: 'Initial prompt for the spawned session' },
        cwd: { type: 'string', description: 'Absolute working directory on the remote host' },
        sessionName: {
          type: 'string',
          description: 'Optional tmux session name; daemon picks one if omitted',
        },
      },
      required: ['server', 'prompt', 'cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_send_input',
    description:
      'Send input text to a dispatched session on a remote daemon (proxies send_input). ' +
      'Requires the "dispatch" capability.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        sessionId: { type: 'string', description: 'JSONL session uuid' },
        input: { type: 'string' },
      },
      required: ['server', 'sessionId', 'input'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_cancel',
    description:
      'Cancel the current input/run on a dispatched session on a remote daemon ' +
      '(proxies cancel_input). Requires the "dispatch" capability.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['server', 'sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_exec',
    description:
      'Execute a shell command on a remote Companion daemon (proxies exec_command). ' +
      'Runs under /bin/sh -c on the target. Requires the "exec" capability. ' +
      'cwd must fall under the daemon\'s allowedPaths. timeout is in ms (default 30000, ' +
      'capped at 300000). stdout/stderr are truncated to 1 MiB each.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from mcp-servers.json' },
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Optional absolute working directory' },
        timeout: {
          type: 'number',
          description: 'Optional timeout in ms (default 30000, max 300000)',
        },
      },
      required: ['server', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'remote_write',
    description:
      'Write a file on a remote Companion daemon (proxies write_file). The path must be ' +
      'absolute and fall under one of the daemon\'s configured write roots. Requires the ' +
      '"write" capability.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from mcp-servers.json' },
        path: { type: 'string', description: 'Absolute path on the remote host' },
        content: { type: 'string', description: 'File contents (utf8 or base64 per encoding)' },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'Encoding of content (default utf8)',
        },
        createDirs: {
          type: 'boolean',
          description: 'Create parent directories if missing (default false)',
        },
      },
      required: ['server', 'path', 'content'],
      additionalProperties: false,
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;
    switch (name) {
      case 'remote_list_servers':
        result = remoteListServers(pool);
        break;
      case 'remote_read':
        result = await remoteRead(pool, args as { server: string; path: string });
        break;
      case 'remote_get_conversation':
        result = await remoteGetConversation(
          pool,
          args as { server: string; sessionId: string; mode?: 'highlights' | 'full' }
        );
        break;
      case 'remote_dispatch':
        result = await remoteDispatch(
          pool,
          args as { server: string; prompt: string; cwd: string; sessionName?: string }
        );
        break;
      case 'remote_send_input':
        result = await remoteSendInput(
          pool,
          args as { server: string; sessionId: string; input: string }
        );
        break;
      case 'remote_cancel':
        result = await remoteCancel(
          pool,
          args as { server: string; sessionId: string }
        );
        break;
      case 'remote_exec':
        result = await remoteExec(
          pool,
          args as { server: string; command: string; cwd?: string; timeout?: number }
        );
        break;
      case 'remote_write':
        result = await remoteWrite(
          pool,
          args as {
            server: string;
            path: string;
            content: string;
            encoding?: 'utf8' | 'base64';
            createDirs?: boolean;
          }
        );
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const code = err instanceof McpRemoteError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: message, code }, null, 2),
        },
      ],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[companion-remote-mcp] Ready. ${config.servers.length} server(s) configured. Origin: ${origin}\n`
  );
}

function shutdown(): void {
  pool.closeAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  process.stderr.write(`[companion-remote-mcp] Fatal: ${String(err)}\n`);
  process.exit(1);
});
