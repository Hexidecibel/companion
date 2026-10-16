import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { rollupText } from '../subagents/rollup';
import type {
  SubagentErrorCode,
  SubagentGetResponse,
  SubagentListResponse,
  SubagentRollupResponse,
  SubagentWatchResponse,
} from '../subagents/protocol';
import { isActive } from '../subagents/completion';
import { convsForSession, factsFor, type SubagentLinkDeps } from '../subagents/links';

type Obj = Record<string, unknown>;
const obj = (p: unknown): Obj =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {};
const str = (v: unknown, max = 300): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

class SubagentError extends Error {
  constructor(
    readonly code: SubagentErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * Subagent tracker endpoints (read-only, in-memory; no subprocess, no LLM).
 * Same-type responses; failures carry `payload: { code }`.
 */
export function registerSubagentHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  /** A session id as the app names it (tmux session) -> its conversation id(s). */
  const links: SubagentLinkDeps = {
    watcher: ctx.watcher,
    sessionName: (id) => ctx.sessionNameStore.get(id),
    tracker: () => ctx.subAgentWatcher?.tracker ?? null,
  };
  const resolve = (sessionKey: string | null): string[] | null =>
    sessionKey ? convsForSession(links, sessionKey) : null;

  const tracker = () => {
    const t = ctx.subAgentWatcher?.tracker;
    if (!t) throw new SubagentError('unavailable', 'Subagent tracking is not available');
    return t;
  };

  const handle =
    (type: string, fn: (client: AuthenticatedClient, p: Obj) => unknown): MessageHandler =>
    async (client, payload, requestId) => {
      try {
        const out = await fn(client, obj(payload));
        ctx.send(client.ws, { type, success: true, payload: out, requestId });
      } catch (err) {
        const code: SubagentErrorCode = err instanceof SubagentError ? err.code : 'unavailable';
        if (code === 'unavailable' && !(err instanceof SubagentError))
          console.error(`Subagents: ${type} failed:`, err);
        ctx.send(client.ws, {
          type,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          payload: { code },
          requestId,
        });
      }
    };

  return {
    subagent_list: handle('subagent_list', (_c, p): SubagentListResponse => {
      tracker();
      const convs = resolve(str(p.sessionId) ?? null);
      const out = ctx.subAgentWatcher!.listSummaries(convs);
      return {
        agents: out.agents,
        running: out.running,
        total: out.agents.length,
        rollup: out.rollup,
        generatedAt: Date.now(),
      };
    }),

    subagent_get: handle('subagent_get', async (_c, p): Promise<SubagentGetResponse> => {
      const t = tracker();
      const agentId = str(p.agentId, 100);
      if (!agentId) throw new SubagentError('bad_request', 'agentId is required');
      const rec = await t.hydrate(agentId);
      if (!rec) throw new SubagentError('not_found', 'Agent not found');
      const agent = t.state(rec);
      return { agent, rollup: rollupText([agent], Date.now()) };
    }),

    subagent_rollup: handle('subagent_rollup', (_c, p): SubagentRollupResponse => {
      const t = tracker();
      const agentId = str(p.agentId, 100);
      let agents;
      if (agentId) {
        const rec = t.get(agentId);
        if (!rec) throw new SubagentError('not_found', 'Agent not found');
        agents = [t.summary(rec)];
      } else {
        agents = t.list(resolve(str(p.sessionId) ?? null)).map((r) => t.summary(r));
      }
      const out: SubagentRollupResponse = {
        text: rollupText(agents, Date.now()),
        running: agents.filter((a) => isActive(a.status)).length,
        total: agents.length,
      };
      if (p.facts === true && !agentId) {
        const facts = factsFor(links, str(p.sessionId));
        if (facts) out.facts = facts;
      }
      return out;
    }),

    subagent_watch: handle('subagent_watch', (client, p): SubagentWatchResponse => {
      tracker();
      if (typeof p.live !== 'boolean')
        throw new SubagentError('bad_request', 'live must be a boolean');
      const hub = ctx.subAgentWatcher!.hub(
        (clientId, payload) => ctx.sendToClient(clientId, 'subagent_update', payload),
        resolve
      );
      if (!hub) throw new SubagentError('unavailable', 'Subagent tracking is not available');
      try {
        return { watching: hub.watch(client.id, str(p.sessionId) ?? null, p.live) };
      } catch (err) {
        throw new SubagentError('busy', err instanceof Error ? err.message : String(err));
      }
    }),
  };
}
