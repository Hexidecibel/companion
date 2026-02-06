import { useState, useEffect, useCallback } from 'react';
import { historyService, HistorySession } from '../services/history';

interface HistoryPanelProps {
  onViewSession?: (session: HistorySession) => void;
  onClose: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start: number, end: number): string {
  const mins = Math.round((end - start) / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export function HistoryPanel({ onViewSession, onClose }: HistoryPanelProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);

  useEffect(() => {
    historyService.load();
    setSessions(historyService.getSessions());
  }, []);

  const handleDelete = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    historyService.deleteSession(sessionId);
    setSessions(historyService.getSessions());
  }, []);

  const handleClearAll = useCallback(() => {
    historyService.clearAll();
    setSessions([]);
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="form-header">
          <button className="icon-btn small" onClick={onClose}>&larr;</button>
          <h2>Session History</h2>
          {sessions.length > 0 && (
            <button className="icon-btn small danger" onClick={handleClearAll} title="Clear all history">
              &#x1f5d1;
            </button>
          )}
        </div>
        <div className="history-panel" style={{ maxHeight: 500, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              <p>No session history yet.</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                History is saved automatically as you view sessions.
              </p>
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className="history-item"
                onClick={() => onViewSession?.(s)}
              >
                <div className="history-item-info">
                  <div className="history-item-name">
                    {s.serverName} {s.projectPath ? `- ${s.projectPath.split('/').pop()}` : ''}
                  </div>
                  <div className="history-item-meta">
                    {formatDate(s.startTime)} &middot; {formatDuration(s.startTime, s.endTime)} &middot; {s.messages.length} messages
                  </div>
                </div>
                <button className="history-item-delete" onClick={(e) => handleDelete(e, s.id)} title="Delete">
                  &times;
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
