import { DaemonRequestFailed } from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

/** The slice of DaemonPool this tool needs (a fake in tests). */
export interface SubagentStatusPool {
  get(server: string): {
    sendRequest<T = unknown>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  };
}

/** Mirrors daemon/src/subagents/protocol.ts SubagentFacts (only what we pass through). */
export interface RemoteSubagentFacts {
  rollup: string;
  running: number;
  total: number;
  sessions: Array<{
    conversationId: string;
    sessionId?: string;
    session: string;
    rollup: string;
    running: number;
    total: number;
    failed: number;
    agents: Array<Record<string, unknown>>;
    more: number;
  }>;
  moreSessions: number;
  generatedAt: number;
}

export interface RemoteSubagentStatusResult {
  server: string;
  session: string | null;
  /** Deterministic one-line answer to "where's it at?". */
  rollup: string;
  running: number;
  total: number;
  sessions: RemoteSubagentFacts['sessions'];
  moreSessions: number;
  generatedAt: number;
}

/**
 * Read-only "where's it at": the daemon's subagent tracker facts (subagent_rollup
 * with facts:true). No remote_capabilities needed (same as remote_list_sessions).
 * `session` = a tmux session name or a conversation id; omitted = every session
 * with running or recently finished agents.
 */
export async function remoteSubagentStatus(
  pool: SubagentStatusPool,
  args: { server: string; session?: string }
): Promise<RemoteSubagentStatusResult> {
  const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : null;
  const client = pool.get(args.server);
  const response = await client.sendRequest<DaemonResponse>('subagent_rollup', {
    ...(session ? { sessionId: session } : {}),
    facts: true,
  });
  if (!response.success) {
    const msg = response.error || 'unknown error';
    throw new DaemonRequestFailed(
      'subagent_rollup',
      /unknown message type/i.test(msg)
        ? `${msg} (this daemon predates subagent tracking; update it)`
        : msg
    );
  }
  const payload = (response.payload || {}) as {
    text?: string;
    running?: number;
    total?: number;
    facts?: RemoteSubagentFacts;
  };
  const facts = payload.facts;
  if (!facts) {
    // A daemon with the tracker but without facts support: the rollup line only.
    return {
      server: args.server,
      session,
      rollup: payload.text ?? '',
      running: payload.running ?? 0,
      total: payload.total ?? 0,
      sessions: [],
      moreSessions: 0,
      generatedAt: Date.now(),
    };
  }
  return {
    server: args.server,
    session,
    rollup: facts.rollup,
    running: facts.running,
    total: facts.total,
    sessions: Array.isArray(facts.sessions) ? facts.sessions : [],
    moreSessions: facts.moreSessions ?? 0,
    generatedAt: facts.generatedAt,
  };
}
