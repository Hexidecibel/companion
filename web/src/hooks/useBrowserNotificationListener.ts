import { useEffect, useRef } from 'react';
import { connectionManager, ConnectionSnapshot } from '../services/ConnectionManager';
import { browserNotifications } from '../services/BrowserNotifications';
import { WorkGroup, WebSocketResponse } from '../types';

/**
 * Listens for WS broadcast events on ALL connected servers and shows browser
 * notifications. Mount at Dashboard level so notifications fire regardless
 * of which modal/panel is open.
 *
 * Tracks muted sessions per server so muted sessions don't produce notifications.
 */
export function useBrowserNotificationListener(): void {
  const supported = browserNotifications.isSupported();

  // Track per-server subscriptions and mute state across renders
  const subsRef = useRef<Map<string, { unsubMessage: () => void; unsubMute: () => void }>>(new Map());
  const mutedRef = useRef<Map<string, Set<string>>>(new Map());
  const serverNamesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!supported) return;

    function isMuted(serverId: string, sessionId: string | undefined): boolean {
      if (!sessionId) return false;
      return mutedRef.current.get(serverId)?.has(sessionId) ?? false;
    }

    function handleMessage(serverId: string, msg: WebSocketResponse) {
      if (!msg.success) return;

      const serverName = serverNamesRef.current.get(serverId);
      const serverPrefix = serverName ? `[${serverName}] ` : '';
      const eventType = msg.type;

      if (eventType === 'status_change') {
        const payload = msg.payload as { isWaitingForInput?: boolean; sessionId?: string } | undefined;
        if (!payload?.isWaitingForInput) return;
        if (isMuted(serverId, payload.sessionId)) return;
        if (!browserNotifications.isEventEnabled('waiting_for_input')) return;
        browserNotifications.show('Waiting for input', {
          body: `${serverPrefix}A session is waiting for your input`,
          tag: `waiting-${serverId}-${payload.sessionId || 'unknown'}`,
        });
      } else if (eventType === 'error_detected') {
        if (!browserNotifications.isEventEnabled('error_detected')) return;
        const payload = msg.payload as { content?: string; sessionName?: string; sessionId?: string } | undefined;
        if (isMuted(serverId, payload?.sessionId)) return;
        browserNotifications.show('Error detected', {
          body: `${serverPrefix}${payload?.content?.substring(0, 100) || 'An error was detected in a session'}`,
          tag: `error-${serverId}-${payload?.sessionId || 'unknown'}`,
        });
      } else if (eventType === 'session_completed') {
        if (!browserNotifications.isEventEnabled('session_completed')) return;
        const payload = msg.payload as { sessionName?: string; sessionId?: string } | undefined;
        if (isMuted(serverId, payload?.sessionId)) return;
        browserNotifications.show('Session completed', {
          body: payload?.sessionName
            ? `${serverPrefix}Session "${payload.sessionName}" has completed`
            : `${serverPrefix}A session has completed`,
          tag: `completed-${serverId}-${payload?.sessionId || 'unknown'}`,
        });
      } else if (eventType === 'work_group_update') {
        const group = msg.payload as WorkGroup | undefined;
        if (!group) return;

        // All workers done - group ready to merge
        const allDone = group.workers.every(w => w.status === 'completed' || w.status === 'error');
        if (allDone && group.status === 'active' && group.workers.length > 0) {
          if (browserNotifications.isEventEnabled('work_group_ready')) {
            browserNotifications.show('Work group ready to merge', {
              body: `${serverPrefix}All ${group.workers.length} workers in "${group.name}" have finished`,
              tag: `work-group-ready-${group.id}`,
            });
          }
        }

        for (const worker of group.workers) {
          // Worker waiting notification
          if (worker.status === 'waiting') {
            if (!browserNotifications.isEventEnabled('worker_waiting')) continue;
            browserNotifications.show('Worker waiting for input', {
              body: `${serverPrefix}Worker "${worker.taskSlug}" needs input`,
              tag: `worker-waiting-${worker.id}`,
            });
          }
          // Worker error notification
          if (worker.status === 'error') {
            if (!browserNotifications.isEventEnabled('worker_error')) continue;
            browserNotifications.show('Worker error', {
              body: `${serverPrefix}Worker "${worker.taskSlug}" encountered an error`,
              tag: `worker-error-${worker.id}`,
            });
          }
        }
      }
    }

    function subscribeToServer(serverId: string, serverName: string) {
      // Already subscribed
      if (subsRef.current.has(serverId)) return;

      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return;

      serverNamesRef.current.set(serverId, serverName);

      // Fetch initial muted sessions
      conn.sendRequest('get_muted_sessions').then((response) => {
        if (response.success && response.payload) {
          const payload = response.payload as { sessionIds: string[] };
          mutedRef.current.set(serverId, new Set(payload.sessionIds ?? []));
        }
      }).catch(() => {
        // Server may not support mute - ignore
      });

      // Subscribe to messages for notifications
      const unsubMessage = conn.onMessage((msg) => handleMessage(serverId, msg));

      // Subscribe to mute changes
      const unsubMute = conn.onMessage((msg) => {
        if (msg.type === 'session_mute_changed' && msg.payload) {
          const payload = msg.payload as { sessionId: string; muted: boolean };
          const muted = mutedRef.current.get(serverId) ?? new Set();
          if (payload.muted) {
            muted.add(payload.sessionId);
          } else {
            muted.delete(payload.sessionId);
          }
          mutedRef.current.set(serverId, muted);
        }
      });

      subsRef.current.set(serverId, { unsubMessage, unsubMute });
    }

    function unsubscribeFromServer(serverId: string) {
      const subs = subsRef.current.get(serverId);
      if (subs) {
        subs.unsubMessage();
        subs.unsubMute();
        subsRef.current.delete(serverId);
      }
      mutedRef.current.delete(serverId);
      serverNamesRef.current.delete(serverId);
    }

    function syncSubscriptions(snapshots?: ConnectionSnapshot[]) {
      const current = snapshots ?? connectionManager.getSnapshots();
      const connectedIds = new Set<string>();

      for (const snap of current) {
        if (snap.state.status === 'connected') {
          connectedIds.add(snap.serverId);
          subscribeToServer(snap.serverId, snap.serverName);
        }
      }

      // Unsubscribe from servers that are no longer connected
      for (const serverId of subsRef.current.keys()) {
        if (!connectedIds.has(serverId)) {
          unsubscribeFromServer(serverId);
        }
      }
    }

    // Initial sync
    syncSubscriptions();

    // Re-sync when connections change
    const unsubChange = connectionManager.onChange((snapshots) => {
      syncSubscriptions(snapshots);
    });

    return () => {
      unsubChange();
      for (const serverId of [...subsRef.current.keys()]) {
        unsubscribeFromServer(serverId);
      }
    };
  }, [supported]);
}
