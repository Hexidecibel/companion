import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { StuckError } from '../stuck/detector';
import { STUCK_LIMITS } from '../stuck/protocol';
import type { StuckErrorCode, StuckKind } from '../stuck/protocol';

type Obj = Record<string, unknown>;
const obj = (p: unknown): Obj =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {};
const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
const KINDS: StuckKind[] = [
  'repeated_failure',
  'loop',
  'oscillation',
  'no_progress',
  'stalled_tool',
];

/**
 * Stuck-session endpoints. Each request is answered with a response of the
 * SAME type ({ type, success, payload | error, requestId }); failures carry
 * `payload: { code: StuckErrorCode }`. Updates go out as the global
 * `stuck_update` event.
 */
export function registerStuckHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  const fail = (
    client: AuthenticatedClient,
    type: string,
    code: StuckErrorCode,
    error: string,
    requestId?: string
  ) => ctx.send(client.ws, { type, success: false, error, payload: { code }, requestId });

  const handle =
    (
      type: string,
      fn: (client: AuthenticatedClient, p: Obj) => Promise<unknown> | unknown
    ): MessageHandler =>
    async (client, payload, requestId) => {
      if (!ctx.stuck) {
        fail(client, type, 'unavailable', 'Stuck detection is not available', requestId);
        return;
      }
      try {
        const out = await fn(client, obj(payload));
        ctx.send(client.ws, { type, success: true, payload: out, requestId });
      } catch (err) {
        const code: StuckErrorCode = err instanceof StuckError ? err.code : 'unavailable';
        if (code === 'unavailable') console.error(`Stuck: ${type} failed:`, err);
        fail(client, type, code, err instanceof Error ? err.message : String(err), requestId);
      }
    };

  /** Sending to a session (ask / interrupt) needs dispatch on narrowed credentials. */
  const gate = (client: AuthenticatedClient): void => {
    const denied = client.originCredential ? ctx.requireRemoteCapability(client, 'dispatch') : null;
    if (denied) throw new StuckError('bad_request', denied);
  };

  const kindOf = (v: unknown): StuckKind | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string' && (KINDS as string[]).includes(v)) return v as StuckKind;
    throw new StuckError('bad_request', `kind must be one of ${KINDS.join(', ')}`);
  };

  return {
    stuck_list: handle('stuck_list', () => ({
      findings: ctx.stuck!.list(),
      settings: ctx.stuck!.getSettings(),
    })),

    stuck_snooze: handle('stuck_snooze', (_c, p) => {
      const sessionId = str(p.sessionId, 200);
      if (!sessionId) throw new StuckError('bad_request', 'sessionId is required');
      let minutes: number = STUCK_LIMITS.defaultSnoozeMin;
      if (p.minutes !== undefined) {
        if (typeof p.minutes !== 'number' || !Number.isFinite(p.minutes) || p.minutes < 0)
          throw new StuckError('bad_request', 'minutes must be a number >= 0');
        minutes = p.minutes;
      }
      const snoozedUntil = ctx.stuck!.snooze(sessionId, kindOf(p.kind), minutes);
      return { snoozedUntil, findings: ctx.stuck!.list() };
    }),

    stuck_dismiss: handle('stuck_dismiss', (_c, p) => {
      const findingId = str(p.findingId, 600);
      if (!findingId) throw new StuckError('bad_request', 'findingId is required');
      ctx.stuck!.dismiss(findingId);
      return { findings: ctx.stuck!.list() };
    }),

    stuck_ask: handle('stuck_ask', async (client, p) => {
      gate(client);
      const findingId = str(p.findingId, 600);
      if (!findingId) throw new StuckError('bad_request', 'findingId is required');
      return ctx.stuck!.ask(findingId, client.id);
    }),

    stuck_interrupt: handle('stuck_interrupt', (client, p) => {
      gate(client);
      const sessionId = str(p.sessionId, 200);
      if (!sessionId) throw new StuckError('bad_request', 'sessionId is required');
      return ctx.stuck!.interrupt(sessionId, client.id);
    }),

    stuck_get_settings: handle('stuck_get_settings', () => ({
      settings: ctx.stuck!.getSettings(),
    })),

    stuck_set_settings: handle('stuck_set_settings', (_c, p) => {
      if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings))
        throw new StuckError('bad_request', 'settings must be an object');
      return { settings: ctx.stuck!.setSettings(p.settings) };
    }),
  };
}
