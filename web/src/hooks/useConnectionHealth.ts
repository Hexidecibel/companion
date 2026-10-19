import { useState, useEffect, useRef, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { useConnections } from './useConnections';

/** How often message timestamps are published into state. */
const HEALTH_FLUSH_MS = 5000;

export interface ServerHealth {
  serverId: string;
  serverName: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'error';
  lastMessageAt: number | null;
  reconnectCount: number;
  latencyMs: number | null;
  error?: string;
}

export function useConnectionHealth(): ServerHealth[] {
  const { snapshots } = useConnections();
  const [healthMap, setHealthMap] = useState<Map<string, ServerHealth>>(new Map());
  const lastMessageRef = useRef<Map<string, number>>(new Map());
  const latencyTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Measure latency by timing a get_status request
  const measureLatency = useCallback(async (serverId: string): Promise<number | null> => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return null;
    try {
      const start = performance.now();
      await conn.sendRequest('get_status', undefined, 5000);
      return Math.round(performance.now() - start);
    } catch {
      return null;
    }
  }, []);

  // Update health entries when snapshots change
  useEffect(() => {
    setHealthMap(prev => {
      const next = new Map<string, ServerHealth>();
      for (const snap of snapshots) {
        const existing = prev.get(snap.serverId);
        next.set(snap.serverId, {
          serverId: snap.serverId,
          serverName: snap.serverName,
          status: snap.state.status,
          lastMessageAt: lastMessageRef.current.get(snap.serverId) ?? existing?.lastMessageAt ?? snap.state.lastConnected ?? null,
          reconnectCount: snap.state.reconnectAttempts,
          latencyMs: existing?.latencyMs ?? null,
          error: snap.state.error,
        });
      }
      return next;
    });
  }, [snapshots]);

  // Track last message timestamps WITHOUT a render per inbound message: the
  // timestamp goes into a ref and is published at most every HEALTH_FLUSH_MS
  // (only the hover tooltip shows it; a render per message re-rendered the
  // whole sidebar on every broadcast).
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    for (const snap of snapshots) {
      const conn = connectionManager.getConnection(snap.serverId);
      if (!conn) continue;
      unsubs.push(conn.onMessage(() => {
        lastMessageRef.current.set(snap.serverId, Date.now());
      }));
    }
    return () => unsubs.forEach(fn => fn());
  }, [snapshots]);

  useEffect(() => {
    const timer = setInterval(() => {
      setHealthMap(prev => {
        let next: Map<string, ServerHealth> | null = null;
        for (const [id, at] of lastMessageRef.current) {
          const entry = prev.get(id);
          if (!entry || entry.lastMessageAt === at) continue;
          if (!next) next = new Map(prev);
          next.set(id, { ...entry, lastMessageAt: at });
        }
        return next ?? prev;
      });
    }, HEALTH_FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  // Periodic latency measurement (every 30s for connected servers)
  useEffect(() => {
    // Clear old timers
    for (const [id, timer] of latencyTimers.current) {
      clearInterval(timer);
      latencyTimers.current.delete(id);
    }

    for (const snap of snapshots) {
      if (snap.state.status !== 'connected') continue;

      // Measure immediately
      measureLatency(snap.serverId).then(ms => {
        if (ms !== null) {
          setHealthMap(prev => {
            const entry = prev.get(snap.serverId);
            if (!entry) return prev;
            const next = new Map(prev);
            next.set(snap.serverId, { ...entry, latencyMs: ms });
            return next;
          });
        }
      });

      // Then every 30s
      const timer = setInterval(async () => {
        const ms = await measureLatency(snap.serverId);
        if (ms !== null) {
          setHealthMap(prev => {
            const entry = prev.get(snap.serverId);
            if (!entry) return prev;
            const next = new Map(prev);
            next.set(snap.serverId, { ...entry, latencyMs: ms });
            return next;
          });
        }
      }, 30000);

      latencyTimers.current.set(snap.serverId, timer);
    }

    return () => {
      for (const timer of latencyTimers.current.values()) {
        clearInterval(timer);
      }
      latencyTimers.current.clear();
    };
  }, [snapshots, measureLatency]);

  return Array.from(healthMap.values());
}
