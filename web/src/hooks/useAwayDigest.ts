import { useState, useEffect, useCallback, useRef } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { useConnections } from './useConnections';

export interface DigestEntry {
  id: string;
  timestamp: number;
  eventType: string;
  sessionId?: string;
  sessionName?: string;
  preview: string;
  tier: 'browser' | 'push' | 'both';
  acknowledged: boolean;
}

export interface DigestData {
  entries: DigestEntry[];
  total: number;
  since: number;
}

interface UseAwayDigestReturn {
  digest: DigestData | null;
  loading: boolean;
  dismissed: boolean;
  dismiss: () => void;
}

const AWAY_KEY = 'companion_last_active';

function getLastActive(): number {
  const stored = localStorage.getItem(AWAY_KEY);
  return stored ? parseInt(stored, 10) : 0;
}

function setLastActive(ts: number): void {
  localStorage.setItem(AWAY_KEY, String(ts));
}

export function useAwayDigest(): UseAwayDigestReturn {
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { snapshots } = useConnections();
  const fetchedRef = useRef(false);

  // Track when user leaves / returns
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setLastActive(Date.now());
      }
    };
    // Set initial last active on mount (page load = return from away)
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Fetch digest from the first connected server when app loads
  useEffect(() => {
    if (fetchedRef.current) return;
    const lastActive = getLastActive();
    if (!lastActive) {
      // First visit ever — set timestamp and skip digest
      setLastActive(Date.now());
      return;
    }

    const connected = snapshots.filter(s => s.state.status === 'connected');
    if (connected.length === 0) return;

    fetchedRef.current = true;
    setLoading(true);

    // Fetch digest from all connected servers and merge
    const fetchAll = async () => {
      const allEntries: DigestEntry[] = [];
      for (const snap of connected) {
        const conn = connectionManager.getConnection(snap.serverId);
        if (!conn || !conn.isConnected()) continue;
        try {
          const response = await conn.sendRequest('get_digest', { since: lastActive });
          if (response.success && response.payload) {
            const payload = response.payload as DigestData;
            allEntries.push(...(payload.entries ?? []));
          }
        } catch {
          // Ignore individual server failures
        }
      }

      if (allEntries.length > 0) {
        // Sort chronologically and dedupe by id
        const seen = new Set<string>();
        const unique = allEntries
          .sort((a, b) => a.timestamp - b.timestamp)
          .filter(e => {
            if (seen.has(e.id)) return false;
            seen.add(e.id);
            return true;
          });
        setDigest({ entries: unique, total: unique.length, since: lastActive });
      }
      setLoading(false);
      // Update last active after fetching
      setLastActive(Date.now());
    };

    fetchAll();
  }, [snapshots]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setDigest(null);
  }, []);

  return { digest, loading, dismissed, dismiss };
}
