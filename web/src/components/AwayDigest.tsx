import { useMemo } from 'react';
import { DigestData, DigestEntry } from '../hooks/useAwayDigest';

interface AwayDigestProps {
  digest: DigestData;
  onDismiss: () => void;
  onSelectSession?: (sessionId: string) => void;
}

const EVENT_LABELS: Record<string, string> = {
  waiting_for_input: 'Waiting for input',
  error_detected: 'Error',
  session_completed: 'Completed',
  worker_waiting: 'Worker waiting',
  worker_error: 'Worker error',
  work_group_ready: 'Work group ready',
};

const EVENT_COLORS: Record<string, string> = {
  waiting_for_input: 'var(--accent-blue)',
  error_detected: 'var(--accent-red)',
  session_completed: 'var(--accent-green)',
  worker_waiting: 'var(--accent-amber)',
  worker_error: 'var(--accent-red)',
  work_group_ready: 'var(--accent-purple)',
};

interface SessionGroup {
  sessionId: string;
  sessionName: string;
  entries: DigestEntry[];
  latestTimestamp: number;
}

function formatTimeAgo(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AwayDigest({ digest, onDismiss, onSelectSession }: AwayDigestProps) {
  const groups = useMemo(() => {
    const map = new Map<string, SessionGroup>();
    for (const entry of digest.entries) {
      const key = entry.sessionId || 'unknown';
      if (!map.has(key)) {
        map.set(key, {
          sessionId: key,
          sessionName: entry.sessionName || key,
          entries: [],
          latestTimestamp: 0,
        });
      }
      const group = map.get(key)!;
      group.entries.push(entry);
      if (entry.timestamp > group.latestTimestamp) {
        group.latestTimestamp = entry.timestamp;
      }
    }
    // Sort groups by latest activity (most recent first)
    return Array.from(map.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }, [digest.entries]);

  const awayDuration = useMemo(() => {
    const delta = Date.now() - digest.since;
    const mins = Math.floor(delta / 60_000);
    if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''}`;
  }, [digest.since]);

  return (
    <div className="away-digest">
      <div className="away-digest-header">
        <div className="away-digest-title">
          While you were away
          <span className="away-digest-duration">{awayDuration}</span>
        </div>
        <button className="away-digest-dismiss" onClick={onDismiss} title="Dismiss">
          &#x2715;
        </button>
      </div>

      <div className="away-digest-body">
        {groups.map((group) => (
          <div
            key={group.sessionId}
            className="away-digest-session"
            onClick={() => onSelectSession?.(group.sessionId)}
            role={onSelectSession ? 'button' : undefined}
            tabIndex={onSelectSession ? 0 : undefined}
          >
            <div className="away-digest-session-header">
              <span className="away-digest-session-name">{group.sessionName}</span>
              <span className="away-digest-session-time">
                {formatTimeAgo(group.latestTimestamp)}
              </span>
            </div>
            <div className="away-digest-events">
              {group.entries.map((entry) => (
                <div key={entry.id} className="away-digest-event">
                  <span
                    className="away-digest-event-dot"
                    style={{ backgroundColor: EVENT_COLORS[entry.eventType] || 'var(--text-muted)' }}
                  />
                  <span className="away-digest-event-type">
                    {EVENT_LABELS[entry.eventType] || entry.eventType}
                  </span>
                  {entry.preview && (
                    <span className="away-digest-event-preview">{entry.preview}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="away-digest-footer">
        <span className="away-digest-count">
          {digest.total} event{digest.total !== 1 ? 's' : ''} across {groups.length} session{groups.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
