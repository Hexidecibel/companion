import { useState, useEffect, useRef, useCallback } from 'react';
import { parseAnsiText, AnsiSpan } from '../utils/ansiParser';
import { connectionManager } from '../services/ConnectionManager';
import { useServers } from '../hooks/useServers';

interface TerminalPanelProps {
  serverId: string;
  tmuxSessionName: string;
}

const POLL_INTERVAL = 2000;
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

export function TerminalPanel({ serverId, tmuxSessionName }: TerminalPanelProps) {
  const [lines, setLines] = useState<AnsiSpan[][]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
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
          setLines(parseAnsiText(payload.output));
          setError(null);
        }
      } else if (response.error) {
        setError(response.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch terminal output');
    }
  }, [serverId, tmuxSessionName]);

  // Poll for terminal output
  useEffect(() => {
    fetchOutput();

    if (paused) return;

    const timer = setInterval(fetchOutput, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchOutput, paused]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScrollRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

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

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-left">
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
            className={`terminal-toolbar-btn ${paused ? 'active' : ''}`}
            onClick={() => setPaused(!paused)}
            title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
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
      >
        {lines.map((spans, i) => (
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
