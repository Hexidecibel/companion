import { useState, useEffect, useCallback, useRef } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { useConnections } from './useConnections';
import { AWAY_KEY as AWAY_STORAGE_KEY } from '../services/storageKeys';

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

const AWAY_KEY = AWAY_STORAGE_KEY;
const DIGEST_DISMISSED_KEY = 'companion:digest_dismissed';

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
  const [dismissed, setDismissed] = useState(() => {
    const dismissedVal = localStorage.getItem(DIGEST_DISMISSED_KEY);
    const lastActive = getLastActive();
    return dismissedVal !== null && dismissedVal === String(lastActive);
  });
  const { snapshots } = useConnections();
  const fetchedRef = useRef(false);

  // Track when user leaves / returns
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setLastActive(Date.now());
        localStorage.removeItem(DIGEST_DISMISSED_KEY);
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

        // Skip digest if user was away for less than 2 minutes
        const awayDurationMs = Date.now() - lastActive;
        const MIN_AWAY_MS = 2 * 60 * 1000; // 2 minutes
        if (awayDurationMs < MIN_AWAY_MS) {
          setLoading(false);
          setLastActive(Date.now());
          return;
        }

        // Only show urgent events
        const URGENT_TYPES = new Set(['waiting_for_input', 'error_detected', 'worker_waiting', 'worker_error']);
        const urgentEntries = unique.filter(e => URGENT_TYPES.has(e.eventType));
        if (urgentEntries.length === 0) {
          setLoading(false);
          setLastActive(Date.now());
          return;
        }

        setDigest({ entries: urgentEntries, total: urgentEntries.length, since: lastActive });
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
    localStorage.setItem(DIGEST_DISMISSED_KEY, String(getLastActive()));
  }, []);

  return { digest, loading, dismissed, dismiss };
}
