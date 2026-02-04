import { useEffect } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { browserNotifications } from '../services/BrowserNotifications';
import { WorkGroup } from '../types';

/**
 * Standalone hook that listens for WS broadcast events and shows browser
 * notifications. Mount at Dashboard level so notifications fire regardless
 * of which modal/panel is open.
 */
export function useBrowserNotificationListener(serverId: string | null): void {
  const supported = browserNotifications.isSupported();

  useEffect(() => {
    if (!serverId || !supported) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;

    const unsubscribe = conn.onMessage((msg) => {
      if (!msg.success) return;

      const eventType = msg.type;

      if (eventType === 'status_change') {
        const payload = msg.payload as { isWaitingForInput?: boolean; sessionId?: string } | undefined;
        if (!payload?.isWaitingForInput) return;
        if (!browserNotifications.isEventEnabled('waiting_for_input')) return;
        browserNotifications.show('Waiting for input', {
          body: 'A session is waiting for your input',
          tag: `waiting-${payload.sessionId || 'unknown'}`,
        });
      } else if (eventType === 'error_detected') {
        if (!browserNotifications.isEventEnabled('error_detected')) return;
        const payload = msg.payload as { content?: string; sessionName?: string } | undefined;
        browserNotifications.show('Error detected', {
          body: payload?.content?.substring(0, 100) || 'An error was detected in a session',
          tag: `error-${Date.now()}`,
        });
      } else if (eventType === 'session_completed') {
        if (!browserNotifications.isEventEnabled('session_completed')) return;
        const payload = msg.payload as { sessionName?: string } | undefined;
        browserNotifications.show('Session completed', {
          body: payload?.sessionName ? `Session "${payload.sessionName}" has completed` : 'A session has completed',
          tag: `completed-${Date.now()}`,
        });
      } else if (eventType === 'work_group_update') {
        const group = msg.payload as WorkGroup | undefined;
        if (!group) return;

        // Show notification when all workers are done and group is still active
        const allDone = group.workers.every(w => w.status === 'completed' || w.status === 'error');
        if (allDone && group.status === 'active' && group.workers.length > 0) {
          if (!browserNotifications.isEventEnabled('work_group_ready')) return;
          browserNotifications.show('Work group ready to merge', {
            body: `All ${group.workers.length} workers in "${group.name}" have finished`,
            tag: `work-group-ready-${group.id}`,
          });
        }

        // Worker waiting notification
        for (const worker of group.workers) {
          if (worker.status === 'waiting') {
            if (!browserNotifications.isEventEnabled('worker_waiting')) return;
            browserNotifications.show('Worker waiting for input', {
              body: `Worker "${worker.taskSlug}" needs input`,
              tag: `worker-waiting-${worker.id}`,
            });
          }
        }
      }
    });

    return unsubscribe;
  }, [serverId, supported]);
}
