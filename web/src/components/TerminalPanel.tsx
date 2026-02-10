import { useState, useEffect, useRef, useCallback } from 'react';
import { parseAnsiText, AnsiSpan } from '../utils/ansiParser';
import { connectionManager } from '../services/ConnectionManager';
import { useServers } from '../hooks/useServers';

interface TerminalPanelProps {
  serverId: string;
  tmuxSessionName: string;
  fastPoll?: boolean;
  onClose?: () => void;
}

const POLL_INTERVAL = 2000;
const FAST_POLL_INTERVAL = 500;
const LINE_COUNT = 150;

function spanStyle(span: AnsiSpan): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (span.inverse) {
    if (span.bgColor || span.color) {
      style.color = span.bgColor || '#0d1117';
      style.backgroundColor = span.color || '#c9d1d9';
    } else {
      style.color = '#0d1117';
      style.backgroundColor = '#c9d1d9';
    }
  } else {
    if (span.color) style.color = span.color;
    if (span.bgColor) style.backgroundColor = span.bgColor;
  }
  if (span.bold) style.fontWeight = 'bold';
  if (span.dim) style.opacity = 0.6;
  if (span.underline) style.textDecoration = 'underline';
  return style;
}

export function TerminalPanel({ serverId, tmuxSessionName, fastPoll, onClose }: TerminalPanelProps) {
  const [liveLines, setLiveLines] = useState<AnsiSpan[][]>([]);
  const [historyLines, setHistoryLines] = useState<AnsiSpan[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const totalLoadedRef = useRef(LINE_COUNT);
  const { getServer } = useServers();

  const server = getServer(serverId);

  const fetchOutput = useCallback(async () => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    try {
      const response = await conn.sendRequest('get_terminal_output', {
        sessionName: tmuxSessionName,
        lines: LINE_COUNT,
      });

      if (response.success && response.payload) {
        const payload = response.payload as { output: string };
        if (payload.output) {
          setLiveLines(parseAnsiText(payload.output));
          setError(null);
        }
      } else if (response.error) {
        setError(response.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch terminal output');
    }
  }, [serverId, tmuxSessionName]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setLoadingMore(false);
      return;
    }

    try {
      const offset = totalLoadedRef.current;
      const response = await conn.sendRequest('get_terminal_output', {
        sessionName: tmuxSessionName,
        lines: LINE_COUNT,
        offset,
      });

      if (response.success && response.payload) {
        const payload = response.payload as { output: string };
        if (payload.output) {
          const parsed = parseAnsiText(payload.output);
          if (parsed.length === 0) {
            setHasMore(false);
          } else {
            // Save scroll position
            const el = outputRef.current;
            const prevHeight = el?.scrollHeight || 0;

            setHistoryLines(prev => [...parsed, ...prev]);
            totalLoadedRef.current += parsed.length;

            if (parsed.length < LINE_COUNT) {
              setHasMore(false);
            }

            // Restore scroll position after prepend
            requestAnimationFrame(() => {
              if (el) {
                const newHeight = el.scrollHeight;
                el.scrollTop += newHeight - prevHeight;
              }
            });
          }
        } else {
          setHasMore(false);
        }
      }
    } catch {
      // Silently ignore
    } finally {
      setLoadingMore(false);
    }
  }, [serverId, tmuxSessionName, loadingMore, hasMore]);

  // Poll for terminal output
  useEffect(() => {
    fetchOutput();
    const interval = fastPoll ? FAST_POLL_INTERVAL : POLL_INTERVAL;
    const timer = setInterval(fetchOutput, interval);
    return () => clearInterval(timer);
  }, [fetchOutput, fastPoll]);

  // Reset history when session changes
  useEffect(() => {
    setHistoryLines([]);
    setHasMore(true);
    totalLoadedRef.current = LINE_COUNT;
  }, [serverId, tmuxSessionName]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScrollRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveLines]);

  // Track if user has scrolled up
  const handleScroll = useCallback(() => {
    if (!outputRef.current) return;
    const el = outputRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }, []);

  // Build SSH command
  const sshUser = server?.sshUser;
  const host = server?.host;
  const sshCommand = sshUser && host
    ? `ssh ${sshUser}@${host} -t 'tmux attach -t ${tmuxSessionName}'`
    : null;

  const handleCopy = useCallback(() => {
    if (!sshCommand) return;
    navigator.clipboard.writeText(sshCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [sshCommand]);

  const allLines = [...historyLines, ...liveLines];

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-left">
          {onClose && (
            <button
              className="terminal-toolbar-btn terminal-close-btn"
              onClick={onClose}
              title="Back to conversation"
            >
              ←
            </button>
          )}
          <span className="terminal-toolbar-label">
            tmux: {tmuxSessionName}
          </span>
        </div>
        <div className="terminal-toolbar-right">
          {sshCommand ? (
            <div className="ssh-command">
              <code className="ssh-command-text">{sshCommand}</code>
              <button
                className={`ssh-command-copy ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <span className="ssh-command-hint">
              Set SSH user in server settings for connect command
            </span>
          )}
          <button
            className="terminal-toolbar-btn"
            onClick={fetchOutput}
            title="Refresh now"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="terminal-error">{error}</div>
      )}

      <div
        className="terminal-output"
        ref={outputRef}
        onScroll={handleScroll}
        onClick={() => {
          if ('ontouchstart' in window && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        }}
      >
        {hasMore && (
          <button
            className="terminal-load-more"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : 'Load older output'}
          </button>
        )}
        {allLines.map((spans, i) => (
          <div key={i} className="terminal-line">
            {spans.map((span, j) => (
              <span key={j} style={spanStyle(span)}>
                {span.text || '\u200B'}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
