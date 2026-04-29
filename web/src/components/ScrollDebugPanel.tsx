import { useEffect, useState, useCallback } from 'react';
import scrollDebugger, { ScrollEvent } from '../utils/scrollDebugger';

interface ScrollDebugPanelProps {
  sessionId: string | null;
  onClose?: () => void;
}

export function ScrollDebugPanel({ sessionId, onClose }: ScrollDebugPanelProps) {
  const [enabled, setEnabled] = useState<boolean>(scrollDebugger.enabled);
  const [tail, setTail] = useState<ScrollEvent[]>(() => scrollDebugger.getEvents().slice(-10));

  // Re-init buffer on session change
  useEffect(() => {
    if (sessionId) scrollDebugger.init(sessionId);
  }, [sessionId]);

  // Live tail refresh every 500ms while panel is mounted
  useEffect(() => {
    const id = setInterval(() => {
      setTail(scrollDebugger.getEvents().slice(-10));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const handleToggle = useCallback(() => {
    const next = !scrollDebugger.enabled;
    scrollDebugger.setEnabled(next);
    setEnabled(next);
  }, []);

  const handleExport = useCallback(() => {
    const csv = scrollDebugger.export();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const sid = sessionId || 'unknown';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `scroll-debug-${sid}-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sessionId]);

  const handleClear = useCallback(() => {
    scrollDebugger.clear();
    setTail([]);
  }, []);

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 60,
    right: 12,
    zIndex: 10000,
    width: 360,
    maxHeight: '70vh',
    background: '#111827',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#f3f4f6',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    padding: '6px 8px',
    background: '#1f2937',
    borderBottom: '1px solid #374151',
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const btnStyle: React.CSSProperties = {
    background: '#1f2937',
    border: '1px solid #374151',
    color: '#f3f4f6',
    padding: '3px 7px',
    borderRadius: 3,
    fontSize: 10,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  const accentBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: enabled ? '#3b82f6' : '#1f2937',
    borderColor: enabled ? '#3b82f6' : '#374151',
  };

  const tailContainerStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 8px',
    background: '#111827',
  };

  const rowStyle: React.CSSProperties = {
    padding: '2px 0',
    borderBottom: '1px solid #1f2937',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>scroll-debug</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={accentBtnStyle} onClick={handleToggle} title="Toggle recording">
            {enabled ? 'ON' : 'OFF'}
          </button>
          <button style={btnStyle} onClick={handleExport} title="Export CSV">CSV</button>
          <button style={btnStyle} onClick={handleClear} title="Clear buffer">Clear</button>
          {onClose && (
            <button style={btnStyle} onClick={onClose} title="Hide panel">X</button>
          )}
        </div>
      </div>
      <div style={{ padding: '4px 8px', fontSize: 10, color: '#9ca3af', borderBottom: '1px solid #374151' }}>
        sid={sessionId ? sessionId.slice(0, 8) : 'none'} | events={tail.length}
      </div>
      <div style={tailContainerStyle}>
        {tail.length === 0 ? (
          <div style={{ color: '#9ca3af', fontStyle: 'italic' }}>
            {enabled ? 'No events yet...' : 'Recording disabled. Click ON to start.'}
          </div>
        ) : (
          tail.map((ev, i) => (
            <div key={`${ev.timestamp}-${i}`} style={rowStyle}>
              <span style={{ color: '#9ca3af' }}>{Math.floor(ev.timestamp)}</span>
              {' '}
              <span style={{ color: '#3b82f6' }}>{ev.type}</span>
              {' '}
              <span style={{ color: '#10b981' }}>{ev.source}</span>
              {' '}
              <span style={{ color: '#f3f4f6' }}>
                t={ev.scrollTop} h={ev.scrollHeight} c={ev.clientHeight} n={ev.messageCount}
                {ev.prevMessageCount !== undefined ? ` p=${ev.prevMessageCount}` : ''}
                {ev.rAFCount !== undefined ? ` raf=${ev.rAFCount}` : ''}
                {ev.layoutShiftDelta !== undefined ? ` d=${Math.round(ev.layoutShiftDelta)}` : ''}
                {ev.nearBottom ? ' nb' : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
