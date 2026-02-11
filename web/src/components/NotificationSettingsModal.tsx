import { useState, useEffect } from 'react';
import { useEscalationConfig, EscalationConfig } from '../hooks/useEscalationConfig';
import { useDeviceManagement } from '../hooks/useDeviceManagement';
import { useNotificationHistory } from '../hooks/useNotificationHistory';
import { useNotifications } from '../hooks/useNotifications';
import { useServers } from '../hooks/useServers';
import { useConnections } from '../hooks/useConnections';

type Tab = 'escalation' | 'devices' | 'history';

const EVENT_TYPE_LABELS: Record<string, string> = {
  waiting_for_input: 'Waiting for Input',
  error_detected: 'Error Detected',
  session_completed: 'Session Completed',
  worker_waiting: 'Worker Waiting',
  worker_error: 'Worker Error',
  work_group_ready: 'Group Ready to Merge',
  usage_warning: 'Usage Warning',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  waiting_for_input: 'var(--accent-amber)',
  error_detected: 'var(--accent-red)',
  session_completed: 'var(--accent-green)',
  worker_waiting: 'var(--accent-amber)',
  worker_error: 'var(--accent-red)',
  work_group_ready: 'var(--accent-blue)',
  usage_warning: 'var(--accent-amber)',
};

const ALL_EVENT_TYPES = ['waiting_for_input', 'error_detected', 'session_completed', 'worker_waiting', 'worker_error', 'work_group_ready', 'usage_warning'] as const;

const AVAILABLE_THRESHOLDS = [50, 75, 90, 95];

const PUSH_DELAY_OPTIONS = [
  { value: 0, label: 'Immediate' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
];

const RATE_LIMIT_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
];

const TIER_LABELS: Record<string, string> = {
  browser: 'Browser',
  push: 'Push',
  both: 'Both',
};

const TIER_COLORS: Record<string, string> = {
  browser: 'var(--accent-blue)',
  push: 'var(--accent-amber)',
  both: 'var(--accent-green)',
};

interface NotificationSettingsModalProps {
  serverId: string;
  onClose: () => void;
}

export function NotificationSettingsModal({ serverId, onClose }: NotificationSettingsModalProps) {
  const [tab, setTab] = useState<Tab>('escalation');
  const escalation = useEscalationConfig(serverId);
  const devices = useDeviceManagement(serverId);
  const history = useNotificationHistory(serverId);
  const notifications = useNotifications(serverId);
  const { isParallelWorkersEnabled, toggleParallelWorkers } = useServers();
  const { snapshots } = useConnections();
  const gitEnabled = snapshots.find(s => s.serverId === serverId)?.gitEnabled ?? true;

  // Load data on mount / tab change
  useEffect(() => {
    if (tab === 'escalation') escalation.refresh();
    else if (tab === 'devices') devices.refresh();
    else if (tab === 'history') history.refresh();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content notif-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Notification Settings</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="notif-tabs">
          {(['escalation', 'devices', 'history'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`notif-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="notif-tab-content">
          {tab === 'escalation' && (
            <>
              {gitEnabled && (
                <div className="notif-section">
                  <div className="notif-card">
                    <div className="notif-card-top">
                      <div>
                        <div className="notif-card-name">Parallel Workers</div>
                        <div className="notif-card-detail">Show work group UI when Claude spawns parallel agents</div>
                      </div>
                      <label className="notif-toggle">
                        <input
                          type="checkbox"
                          checked={isParallelWorkersEnabled(serverId)}
                          onChange={() => toggleParallelWorkers(serverId)}
                        />
                        <span className="notif-toggle-slider" />
                      </label>
                    </div>
                  </div>
                </div>
              )}
              <EscalationTab
                {...escalation}
                browserNotifications={notifications}
              />
            </>
          )}
          {tab === 'devices' && <DevicesTab {...devices} />}
          {tab === 'history' && <HistoryTab {...history} />}
        </div>
      </div>
    </div>
  );
}

// --- Escalation Tab ---

function EscalationTab({
  config,
  loading,
  update,
  browserNotifications,
}: ReturnType<typeof useEscalationConfig> & {
  browserNotifications: ReturnType<typeof useNotifications>;
}) {
  if (loading && !config) {
    return <div className="notif-empty">Loading escalation config...</div>;
  }

  if (!config) {
    return <div className="notif-empty">Failed to load escalation config.</div>;
  }

  const handleEventToggle = (eventType: keyof EscalationConfig['events'], enabled: boolean) => {
    update({ events: { ...config.events, [eventType]: enabled } });
  };

  const handlePushDelay = (value: number) => {
    update({ pushDelaySeconds: value });
  };

  const handleRateLimit = (value: number) => {
    update({ rateLimitSeconds: value });
  };

  const handleQuietHoursToggle = (enabled: boolean) => {
    update({ quietHours: { ...config.quietHours, enabled } });
  };

  const handleQuietHoursStart = (start: string) => {
    update({ quietHours: { ...config.quietHours, start } });
  };

  const handleQuietHoursEnd = (end: string) => {
    update({ quietHours: { ...config.quietHours, end } });
  };

  return (
    <div className="notif-section">
      {/* Push escalation event types (server-side) */}
      <div className="notif-card">
        <div className="notif-card-name" style={{ marginBottom: 4 }}>Push Escalation Events</div>
        <div className="notif-card-detail" style={{ marginBottom: 8 }}>
          Which events trigger push notifications to mobile devices
        </div>
        {ALL_EVENT_TYPES.map((evt) => (
          <div key={evt} className="notif-browser-event-row">
            <span>{EVENT_TYPE_LABELS[evt]}</span>
            <label className="notif-toggle">
              <input
                type="checkbox"
                checked={config.events[evt]}
                onChange={(e) => handleEventToggle(evt, e.target.checked)}
              />
              <span className="notif-toggle-slider" />
            </label>
          </div>
        ))}
      </div>

      {/* Browser notification permission + per-event toggles */}
      <div className="notif-card">
        <div className="notif-card-top">
          <span className="notif-card-name">Browser Notifications</span>
          <span className={`notif-permission-badge ${browserNotifications.permission}`}>
            {browserNotifications.permission === 'granted' ? 'Enabled' : browserNotifications.permission === 'denied' ? 'Blocked' : 'Not Asked'}
          </span>
        </div>
        {browserNotifications.permission === 'default' && (
          <button className="notif-submit-btn" onClick={browserNotifications.requestPermission} style={{ marginTop: 8 }}>
            Enable Browser Notifications
          </button>
        )}
        {browserNotifications.permission === 'denied' && (
          <div className="notif-card-detail" style={{ marginTop: 4 }}>
            Notifications are blocked. Enable them in your browser settings.
          </div>
        )}
        {browserNotifications.permission === 'granted' && (
          <>
            <div className="notif-card-detail" style={{ marginTop: 8, marginBottom: 8 }}>
              Which events show desktop/browser notifications
            </div>
            <div className="notif-browser-event-row">
              <span style={{ fontWeight: 500 }}>All Notifications</span>
              <label className="notif-toggle">
                <input
                  type="checkbox"
                  checked={browserNotifications.prefs.enabled}
                  onChange={(e) => browserNotifications.updatePrefs({ enabled: e.target.checked })}
                />
                <span className="notif-toggle-slider" />
              </label>
            </div>
            {browserNotifications.prefs.enabled && (
              <>
                {ALL_EVENT_TYPES.map((evt) => (
                  <div key={evt} className="notif-browser-event-row">
                    <span>{EVENT_TYPE_LABELS[evt]}</span>
                    <label className="notif-toggle">
                      <input
                        type="checkbox"
                        checked={browserNotifications.prefs[evt]}
                        onChange={(e) => browserNotifications.updatePrefs({ [evt]: e.target.checked })}
                      />
                      <span className="notif-toggle-slider" />
                    </label>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Push delay */}
      <div className="notif-card">
        <div className="notif-card-name" style={{ marginBottom: 4 }}>Push Escalation Delay</div>
        <div className="notif-card-detail" style={{ marginBottom: 8 }}>
          How long to wait before sending push notification (if unacknowledged)
        </div>
        <select
          className="notif-select"
          value={config.pushDelaySeconds}
          onChange={(e) => handlePushDelay(Number(e.target.value))}
        >
          {PUSH_DELAY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Rate limit */}
      <div className="notif-card">
        <div className="notif-card-name" style={{ marginBottom: 4 }}>Rate Limit</div>
        <div className="notif-card-detail" style={{ marginBottom: 8 }}>
          Minimum time between notifications per session
        </div>
        <select
          className="notif-select"
          value={config.rateLimitSeconds}
          onChange={(e) => handleRateLimit(Number(e.target.value))}
        >
          {RATE_LIMIT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Quiet hours */}
      <div className="notif-card">
        <div className="notif-card-top">
          <span className="notif-card-name">Quiet Hours</span>
          <label className="notif-toggle">
            <input
              type="checkbox"
              checked={config.quietHours.enabled}
              onChange={(e) => handleQuietHoursToggle(e.target.checked)}
            />
            <span className="notif-toggle-slider" />
          </label>
        </div>
        {config.quietHours.enabled && (
          <div className="notif-quiet-hours-row">
            <label>
              <span className="notif-card-detail">From</span>
              <input
                type="time"
                className="notif-time-input"
                value={config.quietHours.start}
                onChange={(e) => handleQuietHoursStart(e.target.value)}
              />
            </label>
            <label>
              <span className="notif-card-detail">Until</span>
              <input
                type="time"
                className="notif-time-input"
                value={config.quietHours.end}
                onChange={(e) => handleQuietHoursEnd(e.target.value)}
              />
            </label>
          </div>
        )}
      </div>

      {/* Usage thresholds */}
      <div className="notif-card">
        <div className="notif-card-name" style={{ marginBottom: 4 }}>Usage Thresholds</div>
        <div className="notif-card-detail" style={{ marginBottom: 8 }}>
          Get notified when utilization crosses these levels
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {AVAILABLE_THRESHOLDS.map((t) => {
            const active = (config.usageThresholds || [50, 75, 90]).includes(t);
            return (
              <button
                key={t}
                onClick={() => {
                  const current = config.usageThresholds || [50, 75, 90];
                  const next = active ? current.filter((v) => v !== t) : [...current, t].sort((a, b) => a - b);
                  update({ usageThresholds: next });
                }}
                style={{
                  padding: '4px 12px',
                  borderRadius: '14px',
                  border: active ? '1px solid var(--accent-amber)' : '1px solid var(--border-color)',
                  backgroundColor: active ? 'rgba(245, 158, 11, 0.15)' : 'transparent',
                  color: active ? 'var(--accent-amber)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                }}
              >
                {t}%
              </button>
            );
          })}
        </div>
      </div>

      {/* Test buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {browserNotifications.permission === 'granted' && (
          <button className="notif-submit-btn" onClick={browserNotifications.testNotification}>
            Test Browser
          </button>
        )}
      </div>
    </div>
  );
}

// --- Devices Tab ---

function DevicesTab({
  devices,
  loading,
  removeDevice,
  sendTestNotification,
}: ReturnType<typeof useDeviceManagement>) {
  if (loading && devices.length === 0) {
    return <div className="notif-empty">Loading devices...</div>;
  }

  if (devices.length === 0) {
    return <div className="notif-empty">No registered devices. Connect from a mobile app to register push notifications.</div>;
  }

  return (
    <div className="notif-section">
      <div className="notif-section-header">
        <span>{devices.length} device{devices.length !== 1 ? 's' : ''}</span>
        <button className="notif-submit-btn" onClick={sendTestNotification}>
          Test Push
        </button>
      </div>
      <div className="notif-list">
        {devices.map((device) => (
          <div key={device.deviceId} className="notif-card">
            <div className="notif-card-top">
              <span className="notif-device-id">{device.deviceId}</span>
              <button
                className="notif-delete-btn"
                onClick={() => removeDevice(device.deviceId)}
                title="Remove device"
              >
                &times;
              </button>
            </div>
            <div className="notif-card-detail">
              Registered: {new Date(device.registeredAt).toLocaleDateString()}
            </div>
            <div className="notif-card-detail">
              Last seen: {formatRelative(device.lastSeen)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- History Tab ---

function HistoryTab({
  entries,
  total,
  loading,
  clear,
}: ReturnType<typeof useNotificationHistory>) {
  if (loading && entries.length === 0) {
    return <div className="notif-empty">Loading history...</div>;
  }

  return (
    <div className="notif-section">
      <div className="notif-section-header">
        <span>{total} notification{total !== 1 ? 's' : ''}</span>
        {entries.length > 0 && (
          <button className="notif-clear-btn" onClick={clear}>Clear All</button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="notif-empty">No notification history yet.</div>
      ) : (
        <div className="notif-list">
          {entries.map((entry) => (
            <div key={entry.id} className="notif-card">
              <div className="notif-card-top">
                <span
                  className="notif-event-badge"
                  style={{ background: EVENT_TYPE_COLORS[entry.eventType] || 'var(--bg-tertiary)' }}
                >
                  {EVENT_TYPE_LABELS[entry.eventType] || entry.eventType}
                </span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span
                    className="notif-event-badge"
                    style={{ background: TIER_COLORS[entry.tier] || 'var(--bg-tertiary)', fontSize: '0.7rem' }}
                  >
                    {TIER_LABELS[entry.tier] || entry.tier}
                  </span>
                  {entry.acknowledged && (
                    <span
                      className="notif-event-badge"
                      style={{ background: 'var(--accent-green)', fontSize: '0.7rem' }}
                    >
                      ACK
                    </span>
                  )}
                  <span className="notif-timestamp">{formatRelative(entry.timestamp)}</span>
                </div>
              </div>
              {entry.sessionName && (
                <div className="notif-card-name">{entry.sessionName}</div>
              )}
              <div className="notif-card-detail notif-preview">{entry.preview}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Helpers ---

function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
