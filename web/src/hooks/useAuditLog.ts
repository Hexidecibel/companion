import { useState, useCallback, useEffect, useRef } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { AuditEntry, AuditLogResponse } from '../types';

export type AuditLogErrorKind = 'unavailable' | 'unsupported' | 'other' | null;

interface UseAuditLogOptions {
  limit?: number;
  autoRefreshMs?: number;
}

interface UseAuditLogReturn {
  entries: AuditEntry[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  errorKind: AuditLogErrorKind;
  refresh: () => Promise<void>;
}

export function useAuditLog(
  serverId: string | null,
  options: UseAuditLogOptions = {},
): UseAuditLogReturn {
  const { limit = 200, autoRefreshMs } = options;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<AuditLogErrorKind>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    if (inFlightRef.current) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Not connected');
      setErrorKind('other');
      return;
    }

    inFlightRef.current = true;
    setLoading(true);
    try {
      const response = await conn.sendRequest('get_audit_log', { limit });
      if (response.success && response.payload) {
        const payload = response.payload as AuditLogResponse;
        setEntries(payload.entries ?? []);
        setHasMore(!!payload.hasMore);
        setError(null);
        setErrorKind(null);
      } else {
        const errStr = response.error ?? 'Failed to fetch audit log';
        setError(errStr);
        // Detect specific error kinds
        const lower = errStr.toLowerCase();
        if (lower.includes('audit_log_unavailable')) {
          setErrorKind('unavailable');
        } else if (lower.includes('unknown message type') || lower.includes('unknown type')) {
          setErrorKind('unsupported');
        } else {
          setErrorKind('other');
        }
      }
    } catch (err) {
      const errStr = String(err);
      setError(errStr);
      setErrorKind('other');
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [serverId, limit]);

  // Auto-load on mount / serverId change
  useEffect(() => {
    if (serverId) {
      refresh();
    } else {
      setEntries([]);
      setHasMore(false);
    }
  }, [serverId, refresh]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefreshMs || !serverId) return;
    const interval = setInterval(() => {
      // Skip if an older daemon doesn't support it — no point hammering
      if (errorKind === 'unsupported') return;
      refresh();
    }, autoRefreshMs);
    return () => clearInterval(interval);
  }, [autoRefreshMs, serverId, refresh, errorKind]);

  return { entries, hasMore, loading, error, errorKind, refresh };
}
