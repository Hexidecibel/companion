import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { HeraldRequestError } from '../herald/service';
import { VoiceError } from '../herald/voice/service';
import type { AuditOrigin } from '../audit-log';
import type { TriggerSource } from '../herald/trigger';

/**
 * Herald WS endpoints. Each request is answered with a response of the SAME type
 * as the request ({ type, success, payload | error, requestId }). Streaming replies
 * and state changes arrive separately as global `herald_event` pushes.
 */

function auditOrigin(ctx: HandlerContext, client: AuthenticatedClient): AuditOrigin {
  const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addr: ((client.ws as any)?._socket?.remoteAddress as string | undefined) || '',
    clientId: client.id,
    isLocal: client.isLocal,
    tls: Boolean(listener?.tls),
    origin: client.origin,
  };
}

const VOICE_OFF = 'Herald voice is not enabled on this daemon';

export function registerHeraldHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  /**
   * A trigger from a socket. Full-scope Companion clients are trusted; a
   * trigger-token socket is re-checked (revoked since login = refused) and
   * classified by its address like an HTTP trigger (mic opening needs a
   * trusted network).
   */
  const fireFromSocket = async (
    trigger: NonNullable<HandlerContext['heraldTrigger']>,
    client: AuthenticatedClient,
    payload: unknown,
    requestId: string | undefined
  ): Promise<void> => {
    const origin = auditOrigin(ctx, client);
    let source: TriggerSource = { via: 'ws', origin, auth: 'session' };
    if (client.scope === 'trigger') {
      const cred = client.triggerCredential;
      if (!cred || !trigger.credentialValid(cred)) {
        const out = trigger.rejectUnauthorized({ via: 'ws', origin }, payload ?? {});
        ctx.send(client.ws, {
          type: 'herald_trigger',
          success: false,
          error: out.ok ? 'unauthorized' : out.error,
          payload: { code: out.ok ? 'unauthorized' : out.code },
          requestId,
        });
        return;
      }
      const info = await trigger.classify(origin.addr, client.forwardedFor);
      source = {
        ...source,
        network: info.network,
        client: info.client,
        credential: cred.name,
        forwardedFor: client.forwardedFor,
      };
    }
    const out = trigger.fire(payload ?? {}, source);
    if (out.ok) {
      ctx.send(client.ws, {
        type: 'herald_trigger',
        success: true,
        payload: out.result,
        requestId,
      });
    } else {
      ctx.send(client.ws, {
        type: 'herald_trigger',
        success: false,
        error: out.error,
        payload: {
          code: out.code,
          ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}),
        },
        requestId,
      });
    }
  };

  const reply = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    run: () => unknown | Promise<unknown>
  ) =>
    (async () => {
      if (!ctx.herald) {
        ctx.send(client.ws, {
          type,
          success: false,
          error: 'Herald is not available on this daemon',
          requestId,
        });
        return;
      }
      try {
        const payload = await run();
        ctx.send(client.ws, { type, success: true, payload, requestId });
      } catch (err) {
        const known =
          err instanceof HeraldRequestError ||
          (err instanceof Error && err.message === 'Unknown action');
        if (!known) console.error(`Herald: ${type} failed:`, err);
        ctx.send(client.ws, {
          type,
          success: false,
          error: known ? (err as Error).message : `Internal error handling ${type}`,
          requestId,
        });
      }
    })();

  const voiceReply = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    run: (voice: NonNullable<HandlerContext['heraldVoice']>) => unknown | Promise<unknown>
  ) =>
    (async () => {
      const voice = ctx.heraldVoice;
      if (!voice) {
        ctx.send(client.ws, { type, success: false, error: VOICE_OFF, requestId });
        return;
      }
      try {
        const payload = await run(voice);
        ctx.send(client.ws, { type, success: true, payload, requestId });
      } catch (err) {
        const known = err instanceof VoiceError;
        if (!known) console.error(`Herald voice: ${type} failed:`, err);
        ctx.send(client.ws, {
          type,
          success: false,
          // `code` lets the client tell "service down" (fall back) from "cancelled".
          error: known ? (err as VoiceError).message : `Internal error handling ${type}`,
          payload: known ? { code: (err as VoiceError).code } : undefined,
          requestId,
        });
      }
    })();

  return {
    herald_get_state(client, _payload, requestId) {
      return reply(client, 'herald_get_state', requestId, () => ctx.herald!.getState());
    },

    herald_send(client, payload, requestId) {
      const p = (payload || {}) as { text?: unknown; mode?: unknown; intent?: unknown };
      return reply(client, 'herald_send', requestId, () =>
        ctx.herald!.send(p.text, { mode: p.mode, intent: p.intent })
      );
    },

    herald_set_verbosity(client, payload, requestId) {
      return reply(client, 'herald_set_verbosity', requestId, () =>
        ctx.herald!.setVerbosity((payload as { verbosity?: unknown } | undefined)?.verbosity)
      );
    },

    /** Monthly API cap: `{monthlyUsd: number | null}`; omit monthlyUsd to go back to config. */
    herald_set_budget(client, payload, requestId) {
      return reply(client, 'herald_set_budget', requestId, () => {
        const p = (payload || {}) as { monthlyUsd?: unknown };
        return ctx.herald!.setBudget('monthlyUsd' in p ? p.monthlyUsd : undefined);
      });
    },

    herald_set_pronunciations(client, payload, requestId) {
      return reply(client, 'herald_set_pronunciations', requestId, () =>
        ctx.herald!.setPronunciations(
          (payload as { pronunciations?: unknown } | undefined)?.pronunciations
        )
      );
    },

    herald_confirm(client, payload, requestId) {
      const p = (payload || {}) as {
        actionId?: unknown;
        decision?: unknown;
        method?: unknown;
        phrase?: unknown;
        streamId?: unknown;
      };
      return reply(client, 'herald_confirm', requestId, () =>
        ctx.herald!.confirm(p.actionId, p.decision, auditOrigin(ctx, client), {
          method: p.method,
          phrase: p.phrase,
          streamId: p.streamId,
          clientId: client.id,
        })
      );
    },

    /** "Show me": open a session on the active device (or `device`). See HeraldShowRequest. */
    herald_show(client, payload, requestId) {
      return reply(client, 'herald_show', requestId, () =>
        ctx.herald!.show(payload, { via: 'voice', requesterId: client.id })
      );
    },

    herald_mark_heard(client, payload, requestId) {
      return reply(client, 'herald_mark_heard', requestId, () => {
        const ids = (payload as { itemIds?: unknown } | undefined)?.itemIds;
        if (!Array.isArray(ids))
          throw new HeraldRequestError('itemIds must be an array of strings');
        ctx.herald!.markHeard(ids as string[]);
        return { ok: true };
      });
    },

    herald_reset(client, _payload, requestId) {
      return reply(client, 'herald_reset', requestId, () => ctx.herald!.reset());
    },

    // ---- voice (see the voice protocol section of herald/protocol.ts) ----

    herald_voice_status(client, _payload, requestId) {
      return voiceReply(client, 'herald_voice_status', requestId, (v) => v.status(client.id));
    },

    herald_tts(client, payload, requestId) {
      return voiceReply(client, 'herald_tts', requestId, (v) => v.synthesize(client.id, payload));
    },

    herald_tts_cancel(client, _payload, requestId) {
      return voiceReply(client, 'herald_tts_cancel', requestId, (v) => ({
        cancelled: v.cancelTts(client.id),
      }));
    },

    herald_voice_stream_start(client, payload, requestId) {
      return voiceReply(client, 'herald_voice_stream_start', requestId, (v) =>
        v.startStream(client.id, payload)
      );
    },

    herald_voice_audio(client, payload, requestId) {
      // Hot path (~10/s while talking): no reply unless the sender asked for one.
      if (!ctx.heraldVoice) {
        if (requestId) {
          ctx.send(client.ws, {
            type: 'herald_voice_audio',
            success: false,
            error: VOICE_OFF,
            requestId,
          });
        }
        return;
      }
      ctx.heraldVoice.pushAudio(client.id, payload);
      if (requestId) ctx.send(client.ws, { type: 'herald_voice_audio', success: true, requestId });
    },

    herald_voice_stream_end(client, payload, requestId) {
      return voiceReply(client, 'herald_voice_stream_end', requestId, (v) =>
        v.endStream(client.id, payload)
      );
    },

    herald_presence(client, payload, requestId) {
      return voiceReply(client, 'herald_presence', requestId, (v) =>
        v.setPresence(client.id, payload)
      );
    },

    /**
     * Remote trigger from an authenticated socket: the full daemon token, or the
     * scoped trigger token (which can send nothing else). Routed to the active
     * device, exactly like POST /herald/trigger.
     */
    herald_trigger(client, payload, requestId) {
      const trigger = ctx.heraldTrigger;
      if (!trigger) {
        ctx.send(client.ws, {
          type: 'herald_trigger',
          success: false,
          error: VOICE_OFF,
          payload: { code: 'unavailable' },
          requestId,
        });
        return;
      }
      void fireFromSocket(trigger, client, payload, requestId);
    },

    /** Make this device (or `deviceId`) the active one; `pin` keeps it there. */
    herald_claim_device(client, payload, requestId) {
      return voiceReply(client, 'herald_claim_device', requestId, (v) =>
        v.claimDevice(client.id, payload)
      );
    },

    herald_handsfree(client, payload, requestId) {
      const on = (payload as { on?: unknown } | undefined)?.on === true;
      return voiceReply(client, 'herald_handsfree', requestId, (v) =>
        v.setHandsFree(client.id, on)
      );
    },
  };
}
