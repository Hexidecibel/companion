import { HandlerContext, MessageHandler } from '../handler-context';
import { EscalationConfig } from '../types';
import {
  FCM_TOKEN_LOG_PREVIEW_LENGTH,
  DEFAULT_DIGEST_PERIOD_MS,
} from '../constants';

export function registerNotificationHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    register_push(client, payload, requestId) {
      const pushPayload = payload as { fcmToken: string; deviceId: string; tokenType?: string };
      if (pushPayload?.fcmToken && pushPayload?.deviceId) {
        const isExpoToken = pushPayload.fcmToken.startsWith('ExponentPushToken');
        console.log(
          `Push registration: device=${pushPayload.deviceId}, type=${isExpoToken ? 'expo' : 'fcm'}, token=${pushPayload.fcmToken.substring(0, FCM_TOKEN_LOG_PREVIEW_LENGTH)}...`
        );
        client.deviceId = pushPayload.deviceId;
        ctx.push.registerDevice(pushPayload.deviceId, pushPayload.fcmToken);
        ctx.send(client.ws, {
          type: 'push_registered',
          success: true,
          requestId,
        });
      } else {
        ctx.send(client.ws, {
          type: 'push_registered',
          success: false,
          error: 'Missing fcmToken or deviceId',
          requestId,
        });
      }
    },

    unregister_push(client, payload, requestId) {
      const unregPayload = payload as { deviceId: string };
      if (unregPayload?.deviceId) {
        ctx.push.unregisterDevice(unregPayload.deviceId);
        ctx.send(client.ws, {
          type: 'push_unregistered',
          success: true,
          requestId,
        });
      }
    },

    get_escalation_config(client, _payload, requestId) {
      const store = ctx.push.getStore();
      ctx.send(client.ws, {
        type: 'escalation_config',
        success: true,
        payload: { config: store.getEscalation() },
        requestId,
      });
    },

    update_escalation_config(client, payload, requestId) {
      const configPayload = payload as Partial<EscalationConfig>;
      const store = ctx.push.getStore();
      const updated = store.setEscalation(configPayload);
      ctx.send(client.ws, {
        type: 'escalation_config_updated',
        success: true,
        payload: { config: updated },
        requestId,
      });
    },

    get_pending_events(client, _payload, requestId) {
      const events = ctx.escalation.getPendingEvents();
      ctx.send(client.ws, {
        type: 'pending_events',
        success: true,
        payload: { events },
        requestId,
      });
    },

    get_devices(client, _payload, requestId) {
      const store = ctx.push.getStore();
      ctx.send(client.ws, {
        type: 'devices',
        success: true,
        payload: { devices: store.getDevices() },
        requestId,
      });
    },

    remove_device(client, payload, requestId) {
      const removePayload = payload as { deviceId: string };
      if (!removePayload?.deviceId) {
        ctx.send(client.ws, {
          type: 'device_removed',
          success: false,
          error: 'Missing deviceId',
          requestId,
        });
        return;
      }
      const store = ctx.push.getStore();
      const removed = store.removeDevice(removePayload.deviceId);
      ctx.send(client.ws, {
        type: 'device_removed',
        success: removed,
        error: removed ? undefined : 'Device not found',
        requestId,
      });
    },

    set_session_muted(client, payload, requestId) {
      const mutePayload = payload as { sessionId: string; muted: boolean };
      if (!mutePayload?.sessionId || mutePayload.muted === undefined) {
        ctx.send(client.ws, {
          type: 'session_muted_set',
          success: false,
          error: 'Missing sessionId or muted',
          requestId,
        });
        return;
      }
      const store = ctx.push.getStore();
      store.setSessionMuted(mutePayload.sessionId, mutePayload.muted);
      ctx.send(client.ws, {
        type: 'session_muted_set',
        success: true,
        payload: { sessionId: mutePayload.sessionId, muted: mutePayload.muted },
        requestId,
      });
      ctx.broadcast('session_mute_changed', {
        sessionId: mutePayload.sessionId,
        muted: mutePayload.muted,
      });
    },

    get_muted_sessions(client, _payload, requestId) {
      const store = ctx.push.getStore();
      ctx.send(client.ws, {
        type: 'muted_sessions',
        success: true,
        payload: { sessionIds: store.getMutedSessions() },
        requestId,
      });
    },

    get_notification_history(client, payload, requestId) {
      const histPayload = payload as { limit?: number } | undefined;
      const store = ctx.push.getStore();
      const history = store.getHistory(histPayload?.limit);
      ctx.send(client.ws, {
        type: 'notification_history',
        success: true,
        payload: history,
        requestId,
      });
    },

    get_digest(client, payload, requestId) {
      const digestPayload = payload as { since?: number } | undefined;
      const since = digestPayload?.since ?? Date.now() - DEFAULT_DIGEST_PERIOD_MS;
      const store = ctx.push.getStore();
      const digest = store.getHistorySince(since);
      ctx.send(client.ws, {
        type: 'digest',
        success: true,
        payload: { entries: digest.entries, total: digest.total, since },
        requestId,
      });
    },

    clear_notification_history(client, _payload, requestId) {
      const store = ctx.push.getStore();
      store.clearHistory();
      ctx.send(client.ws, {
        type: 'notification_history_cleared',
        success: true,
        requestId,
      });
    },

    async send_test_notification(client, _payload, requestId) {
      try {
        const result = await ctx.push.sendTestNotification();
        ctx.send(client.ws, {
          type: 'test_notification_sent',
          success: true,
          payload: result,
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'test_notification_sent',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },
  };
}
