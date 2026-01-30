import { useState, useEffect, useRef } from 'react';
import { ServerSummary } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_INTERVAL = 5000;

/**
 * Polls `get_server_summary` on every connected server every 5s.
 * Returns a Map<serverId, ServerSummary>.
 */
export function useAllServerSummaries() {
  const [summaries, setSummaries] = useState<Map<string, ServerSummary>>(new Map());
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const snapshots = connectionManager.getSnapshots();
      const connected = snapshots.filter((s) => s.state.status === 'connected');

      const next = new Map<string, ServerSummary>();

      await Promise.all(
        connected.map(async (snap) => {
          const conn = connectionManager.getConnection(snap.serverId);
          if (!conn || !conn.isConnected()) return;
          try {
            const response = await conn.sendRequest('get_server_summary');
            if (response.success && response.payload) {
              next.set(snap.serverId, response.payload as ServerSummary);
            }
          } catch {
            // Connection may have dropped, skip
          }
        }),
      );

      if (!cancelled) {
        setSummaries(next);
      }
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL);

    // Also re-poll when connections change
    const unsub = connectionManager.onChange(() => {
      poll();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsub();
    };
  }, []);

  return summaries;
}
