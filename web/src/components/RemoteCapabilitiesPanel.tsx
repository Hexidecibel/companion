import { useState, useEffect } from 'react';
import { useCapabilities } from '../hooks/useCapabilities';
import { useAuditLog } from '../hooks/useAuditLog';
import { AuditEntry } from '../types';

interface RemoteCapabilitiesPanelProps {
  serverId: string;
  serverName: string;
  onClose: () => void;
}

const AUTO_REFRESH_MS = 5000;

export function RemoteCapabilitiesPanel({ serverId, serverName, onClose }: RemoteCapabilitiesPanelProps) {
  const { caps, loading: capsLoading, error: capsError, refresh: refreshCaps } = useCapabilities(serverId);
  const {
    entries,
    hasMore,
    loading: logLoading,
    errorKind,
    refresh: refreshLog,
  } = useAuditLog(serverId, { limit: 200, autoRefreshMs: AUTO_REFRESH_MS });

  const masterEnabled = caps?.remoteCapabilities.enabled ?? false;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: 900, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Remote Capabilities &mdash; {serverName}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
          <CapabilitiesCard
            caps={caps}
            loading={capsLoading}
            error={capsError}
            onRefresh={refreshCaps}
          />

          <div style={{ height: 16 }} />

          <AuditLogCard
            entries={entries}
            hasMore={hasMore}
            loading={logLoading}
            errorKind={errorKind}
            masterEnabled={masterEnabled}
            onRefresh={refreshLog}
          />
        </div>
      </div>
    </div>
  );
}

// --- Capabilities Card ---

interface CapabilitiesCardProps {
  caps: ReturnType<typeof useCapabilities>['caps'];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function CapabilitiesCard({ caps, loading, error, onRefresh }: CapabilitiesCardProps) {
  if (loading && !caps) {
    return <div style={sectionCardStyle}><div style={{ color: 'var(--text-muted)' }}>Loading capabilities...</div></div>;
  }

  if (error && !caps) {
    return (
      <div style={sectionCardStyle}>
        <div style={{ color: 'var(--accent-red)' }}>Failed to load capabilities: {error}</div>
        <button style={refreshBtnStyle} onClick={onRefresh}>Retry</button>
      </div>
    );
  }

  if (!caps) {
    return <div style={sectionCardStyle}><div style={{ color: 'var(--text-muted)' }}>No capability data.</div></div>;
  }

  const rc = caps.remoteCapabilities;
  const masterEnabled = rc.enabled;
  const subDisabled = !masterEnabled;

  return (
    <div style={sectionCardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <div style={cardTitleStyle}>Capabilities</div>
          <div style={cardSubtitleStyle}>
            Daemon v{caps.daemonVersion} &middot; protocol v{caps.protocolVersion}
          </div>
        </div>
        <button style={refreshBtnStyle} onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {!masterEnabled && (
        <div style={bannerStyle}>
          Remote capabilities disabled. Enable with <code style={codeStyle}>bin/companion enable-remote</code> and restart the daemon.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <CapabilityRow label="Remote (master)" enabled={masterEnabled} />
        <CapabilityRow label="Exec" enabled={rc.exec} dimmed={subDisabled} />
        <CapabilityRow label="Dispatch" enabled={rc.dispatch} dimmed={subDisabled} />
        <CapabilityRow
          label="Write"
          enabled={rc.write.enabled}
          dimmed={subDisabled}
          detail={rc.write.enabled && rc.write.roots.length > 0 ? (
            <div style={{ marginTop: 6, paddingLeft: 18 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Allowed roots:</div>
              {rc.write.roots.map((root) => (
                <div key={root} style={rootChipStyle}>{root}</div>
              ))}
            </div>
          ) : null}
        />
      </div>
    </div>
  );
}

interface CapabilityRowProps {
  label: string;
  enabled: boolean;
  dimmed?: boolean;
  detail?: React.ReactNode;
}

function CapabilityRow({ label, enabled, dimmed, detail }: CapabilityRowProps) {
  const color = dimmed ? 'var(--text-muted)' : enabled ? 'var(--accent-green)' : 'var(--text-muted)';
  const dotColor = dimmed ? '#6b7280' : enabled ? 'var(--accent-green)' : '#6b7280';
  return (
    <div style={{ opacity: dimmed ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: dotColor,
            flexShrink: 0,
            boxShadow: enabled && !dimmed ? '0 0 6px rgba(34, 197, 94, 0.5)' : 'none',
          }}
        />
        <span style={{ color, fontSize: '0.9rem', fontWeight: 500 }}>{label}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: 'auto' }}>
          {enabled ? (dimmed ? 'enabled (parent off)' : 'enabled') : 'disabled'}
        </span>
      </div>
      {detail}
    </div>
  );
}

// --- Audit Log Card ---

interface AuditLogCardProps {
  entries: AuditEntry[];
  hasMore: boolean;
  loading: boolean;
  errorKind: ReturnType<typeof useAuditLog>['errorKind'];
  masterEnabled: boolean;
  onRefresh: () => void;
}

function AuditLogCard({ entries, hasMore, loading, errorKind, masterEnabled, onRefresh }: AuditLogCardProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const renderEmptyState = () => {
    if (errorKind === 'unsupported') {
      return <div style={emptyStateStyle}>This daemon doesn't support audit log (upgrade required).</div>;
    }
    if (errorKind === 'unavailable') {
      return <div style={emptyStateStyle}>Audit log unavailable.</div>;
    }
    if (!masterEnabled) {
      return <div style={emptyStateStyle}>Enable remote capabilities to start recording audit events.</div>;
    }
    if (entries.length === 0) {
      return <div style={emptyStateStyle}>No remote actions yet.</div>;
    }
    return null;
  };

  const empty = renderEmptyState();

  return (
    <div style={sectionCardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <div style={cardTitleStyle}>Audit Log</div>
          <div style={cardSubtitleStyle}>
            {entries.length > 0
              ? `${entries.length} recent entr${entries.length === 1 ? 'y' : 'ies'}${hasMore ? ' (more available)' : ''}`
              : 'Recent remote actions against this daemon'}
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>&middot; auto-refresh 5s</span>
          </div>
        </div>
        <button style={refreshBtnStyle} onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {empty ?? (
        <div style={{ marginTop: 12 }}>
          {isNarrow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entries.map((entry, idx) => (
                <AuditEntryCard
                  key={idx}
                  entry={entry}
                  expanded={expandedIndex === idx}
                  onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                />
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Time</th>
                    <th style={thStyle}>Action</th>
                    <th style={thStyle}>Origin</th>
                    <th style={thStyle}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, idx) => (
                    <AuditEntryRow
                      key={idx}
                      entry={entry}
                      expanded={expandedIndex === idx}
                      onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Audit Entry Row (desktop table) ---

interface AuditEntryRowProps {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}

function AuditEntryRow({ entry, expanded, onToggle }: AuditEntryRowProps) {
  const tone = classifyEntry(entry);
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          borderLeft: `3px solid ${tone.borderColor}`,
          background: expanded ? 'var(--bg-tertiary)' : 'transparent',
        }}
      >
        <td style={tdStyle}>
          <span title={new Date(entry.ts).toLocaleString()}>{formatRelative(entry.ts)}</span>
        </td>
        <td style={tdStyle}>
          <span style={actionBadgeStyle}>{entry.action}</span>
          {typeof entry.durationMs === 'number' && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: 6 }}>
              {entry.durationMs}ms
            </span>
          )}
        </td>
        <td style={tdStyle}>
          <OriginCell entry={entry} />
        </td>
        <td style={tdStyle}>
          <span style={{ ...resultBadgeStyle, color: tone.textColor, background: tone.bgColor, borderColor: tone.borderColor }}>
            {tone.label}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--bg-tertiary)' }}>
          <td colSpan={4} style={{ ...tdStyle, paddingTop: 0 }}>
            <AuditEntryDetail entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

// --- Audit Entry Card (mobile stacked) ---

function AuditEntryCard({ entry, expanded, onToggle }: { entry: AuditEntry; expanded: boolean; onToggle: () => void }) {
  const tone = classifyEntry(entry);
  return (
    <div
      onClick={onToggle}
      style={{
        cursor: 'pointer',
        borderLeft: `3px solid ${tone.borderColor}`,
        background: expanded ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
        borderRadius: 6,
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={actionBadgeStyle}>{entry.action}</span>
        <span style={{ marginLeft: 'auto', ...resultBadgeStyle, color: tone.textColor, background: tone.bgColor, borderColor: tone.borderColor }}>
          {tone.label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        <span title={new Date(entry.ts).toLocaleString()}>{formatRelative(entry.ts)}</span>
        {typeof entry.durationMs === 'number' && <span>{entry.durationMs}ms</span>}
        <span style={{ marginLeft: 'auto' }}>
          <OriginCell entry={entry} compact />
        </span>
      </div>
      {expanded && <AuditEntryDetail entry={entry} />}
    </div>
  );
}

// --- Origin display ---

function OriginCell({ entry, compact }: { entry: AuditEntry; compact?: boolean }) {
  const { origin } = entry;
  const label = origin.origin ?? (origin.isLocal ? 'local' : origin.addr);
  const tls = origin.tls ? 'TLS' : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: compact ? '0.75rem' : '0.8rem' }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: origin.isLocal ? 'var(--accent-green)' : 'var(--accent-blue)',
        }}
      />
      <span title={`${origin.addr} (${origin.clientId})`} style={{ fontFamily: 'monospace' }}>{label}</span>
      {tls && (
        <span style={{ color: 'var(--accent-green)', fontSize: '0.65rem', fontWeight: 600 }}>{tls}</span>
      )}
    </span>
  );
}

// --- Expanded detail ---

function AuditEntryDetail({ entry }: { entry: AuditEntry }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <DetailBlock label="Origin" value={entry.origin} />
      {entry.payload !== undefined && <DetailBlock label="Payload" value={entry.payload} />}
      <DetailBlock label="Result" value={entry.result} />
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <pre style={preStyle}>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

// --- Styling + helpers ---

interface EntryTone {
  label: string;
  textColor: string;
  borderColor: string;
  bgColor: string;
}

function classifyEntry(entry: AuditEntry): EntryTone {
  const result = entry.result as { ok: boolean; error?: string; code?: string; rateLimited?: boolean };
  const rateLimited = result.rateLimited === true || result.code === 'rate_limited' || (typeof result.error === 'string' && result.error.toLowerCase().includes('rate'));
  if (rateLimited) {
    return {
      label: 'rate-limited',
      textColor: 'var(--accent-amber)',
      borderColor: 'var(--accent-amber)',
      bgColor: 'rgba(245, 158, 11, 0.12)',
    };
  }
  if (result.ok) {
    return {
      label: 'ok',
      textColor: 'var(--accent-green)',
      borderColor: 'var(--accent-green)',
      bgColor: 'rgba(34, 197, 94, 0.12)',
    };
  }
  return {
    label: 'error',
    textColor: 'var(--accent-red)',
    borderColor: 'var(--accent-red)',
    bgColor: 'rgba(239, 68, 68, 0.12)',
  };
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const sectionCardStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 16,
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 2,
};

const cardSubtitleStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: 'var(--text-muted)',
};

const refreshBtnStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const bannerStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 12px',
  borderRadius: 6,
  background: 'rgba(245, 158, 11, 0.1)',
  border: '1px solid var(--accent-amber)',
  color: 'var(--accent-amber)',
  fontSize: '0.85rem',
  lineHeight: 1.5,
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  background: 'rgba(0, 0, 0, 0.25)',
  padding: '1px 5px',
  borderRadius: 3,
  color: 'var(--text-primary)',
};

const rootChipStyle: React.CSSProperties = {
  display: 'inline-block',
  fontFamily: 'monospace',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  padding: '2px 6px',
  marginRight: 6,
  marginBottom: 4,
  fontSize: '0.75rem',
  color: 'var(--text-primary)',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  color: 'var(--text-muted)',
  fontWeight: 500,
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: 'var(--text-primary)',
  verticalAlign: 'top',
  borderBottom: '1px solid var(--border-color)',
};

const actionBadgeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.8rem',
  color: 'var(--text-primary)',
};

const resultBadgeStyle: React.CSSProperties = {
  display: 'inline-block',
  border: '1px solid',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: '0.7rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const emptyStateStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '24px 16px',
  textAlign: 'center',
  color: 'var(--text-muted)',
  fontSize: '0.9rem',
  background: 'var(--bg-primary)',
  borderRadius: 6,
  border: '1px dashed var(--border-color)',
};

const preStyle: React.CSSProperties = {
  background: 'var(--bg-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  padding: '8px 10px',
  fontSize: '0.75rem',
  color: 'var(--text-primary)',
  overflowX: 'auto',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
