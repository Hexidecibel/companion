import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface SessionUsage {
  sessionId: string;
  sessionName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  messageCount: number;
}

interface UsageStats {
  sessions: SessionUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  periodStart: number;
  periodEnd: number;
}

const WEEKLY_TOKEN_LIMIT = 5_000_000;

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function barClass(percentage: number): string {
  if (percentage >= 90) return 'critical';
  if (percentage >= 75) return 'warning';
  return 'normal';
}

interface UsagePanelProps {
  serverId: string;
  onClose: () => void;
}

export function UsagePanel({ serverId, onClose }: UsagePanelProps) {
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setError(null);
      const conn = connectionManager.getConnection(serverId);
      if (!conn) {
        setError('Not connected to server');
        setLoading(false);
        return;
      }
      const response = await conn.sendRequest('get_usage', {});
      if (response.success && response.payload) {
        setUsage(response.payload as UsageStats);
      } else {
        setError(response.error || 'Failed to load usage data');
      }
    } catch {
      setError('Failed to fetch usage statistics');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const totalTokens = usage ? usage.totalInputTokens + usage.totalOutputTokens : 0;
  const weeklyPct = Math.min((totalTokens / WEEKLY_TOKEN_LIMIT) * 100, 100);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="form-header">
          <button className="icon-btn small" onClick={onClose}>&larr;</button>
          <h2>Usage</h2>
          <button className="icon-btn small" onClick={loadUsage} disabled={loading}>
            &#x21bb;
          </button>
        </div>
        <div className="usage-panel">
          {loading ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <div className="spinner" style={{ margin: '0 auto' }} />
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--accent-red)' }}>
              <p>{error}</p>
              <button className="btn-primary" onClick={loadUsage} style={{ maxWidth: 140, marginTop: 12 }}>
                Retry
              </button>
            </div>
          ) : usage ? (
            <>
              {weeklyPct >= 75 && (
                <div className={`usage-warning ${weeklyPct >= 90 ? 'red' : 'amber'}`}>
                  {weeklyPct >= 90 ? 'Approaching weekly limit' : 'High usage this week'}
                  {' — '}{formatNumber(totalTokens)} / {formatNumber(WEEKLY_TOKEN_LIMIT)} tokens
                </div>
              )}

              <div className="usage-section">
                <div className="usage-section-title">Weekly Total</div>
                <div className="usage-bar-row">
                  <span className="usage-bar-label">Tokens</span>
                  <div className="usage-bar-track">
                    <div
                      className={`usage-bar-fill ${barClass(weeklyPct)}`}
                      style={{ width: `${weeklyPct}%` }}
                    />
                  </div>
                  <span className="usage-bar-value">{formatNumber(totalTokens)}</span>
                </div>
              </div>

              <div className="usage-section">
                <div className="usage-section-title">Breakdown</div>
                <div className="usage-bar-row">
                  <span className="usage-bar-label">Input</span>
                  <div className="usage-bar-track">
                    <div
                      className="usage-bar-fill normal"
                      style={{ width: `${totalTokens > 0 ? (usage.totalInputTokens / totalTokens) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="usage-bar-value">{formatNumber(usage.totalInputTokens)}</span>
                </div>
                <div className="usage-bar-row">
                  <span className="usage-bar-label">Output</span>
                  <div className="usage-bar-track">
                    <div
                      className="usage-bar-fill normal"
                      style={{ width: `${totalTokens > 0 ? (usage.totalOutputTokens / totalTokens) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="usage-bar-value">{formatNumber(usage.totalOutputTokens)}</span>
                </div>
                {usage.totalCacheCreationTokens > 0 && (
                  <div className="usage-bar-row">
                    <span className="usage-bar-label">Cache W</span>
                    <div className="usage-bar-track">
                      <div
                        className="usage-bar-fill normal"
                        style={{ width: `${totalTokens > 0 ? (usage.totalCacheCreationTokens / totalTokens) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="usage-bar-value">{formatNumber(usage.totalCacheCreationTokens)}</span>
                  </div>
                )}
                {usage.totalCacheReadTokens > 0 && (
                  <div className="usage-bar-row">
                    <span className="usage-bar-label">Cache R</span>
                    <div className="usage-bar-track">
                      <div
                        className="usage-bar-fill normal"
                        style={{ width: `${totalTokens > 0 ? (usage.totalCacheReadTokens / totalTokens) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="usage-bar-value">{formatNumber(usage.totalCacheReadTokens)}</span>
                  </div>
                )}
              </div>

              {usage.sessions.length > 0 && (
                <div className="usage-section">
                  <div className="usage-section-title">Per Session</div>
                  {usage.sessions.map((s) => {
                    const sTotal = s.totalInputTokens + s.totalOutputTokens;
                    const sPct = totalTokens > 0 ? (sTotal / totalTokens) * 100 : 0;
                    return (
                      <div key={s.sessionId} className="usage-bar-row">
                        <span className="usage-bar-label" title={s.sessionName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.sessionName || s.sessionId.slice(0, 12)}
                        </span>
                        <div className="usage-bar-track">
                          <div className="usage-bar-fill normal" style={{ width: `${sPct}%` }} />
                        </div>
                        <span className="usage-bar-value">{formatNumber(sTotal)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
