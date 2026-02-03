import { useState, useEffect, useRef, useCallback } from 'react';
import { parseAnsiText, AnsiSpan } from '../utils/ansiParser';
import { connectionManager } from '../services/ConnectionManager';
import { useServers } from '../hooks/useServers';

interface TerminalPanelProps {
  serverId: string;
  tmuxSessionName: string;
}

const POLL_INTERVAL = 2000;
const INTERACTIVE_POLL_INTERVAL = 500;
const LINE_COUNT = 150;
const KEY_DEBOUNCE_MS = 50;

/** Map browser KeyboardEvent.key to tmux send-keys argument (raw mode, no -l). */
const SPECIAL_KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Backspace: 'BSpace',
  Tab: 'Tab',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Delete: 'DC',
};

/** Ctrl+key combos that should be sent as raw tmux keys. */
const CTRL_KEY_MAP: Record<string, string> = {
  c: 'C-c',
  d: 'C-d',
  z: 'C-z',
  l: 'C-l',
  a: 'C-a',
  e: 'C-e',
  r: 'C-r',
  u: 'C-u',
  k: 'C-k',
  w: 'C-w',
};

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
  const [interactive, setInteractive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const keyBufferRef = useRef<string[]>([]);
  const keyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { getServer } = useServers();

  const server = getServer(serverId);

  // Buffer and debounce raw key sends
  const sendRawKey = useCallback((key: string) => {
    keyBufferRef.current.push(key);
    if (keyFlushTimerRef.current) clearTimeout(keyFlushTimerRef.current);
    keyFlushTimerRef.current = setTimeout(() => {
      const batch = keyBufferRef.current.splice(0);
      if (batch.length > 0) {
        const conn = connectionManager.getConnection(serverId);
        if (conn?.isConnected()) {
          conn.sendRequest('send_terminal_keys', {
            sessionName: tmuxSessionName,
            keys: batch,
          });
        }
      }
    }, KEY_DEBOUNCE_MS);
  }, [serverId, tmuxSessionName]);

  // Send a printable character as a raw key (tmux interprets single chars as keystrokes)
  const sendLiteralChar = useCallback((ch: string) => {
    if (ch === ' ') {
      sendRawKey('Space');
    } else if (/^[a-zA-Z0-9\-+]$/.test(ch)) {
      sendRawKey(ch);
    }
    // Punctuation chars that fail the daemon's validation regex are dropped.
    // For full text entry, use the main input box instead.
  }, [sendRawKey]);

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

  // Poll for terminal output - faster when interactive
  useEffect(() => {
    fetchOutput();

    if (paused && !interactive) return;

    const interval = interactive ? INTERACTIVE_POLL_INTERVAL : POLL_INTERVAL;
    const timer = setInterval(fetchOutput, interval);
    return () => clearInterval(timer);
  }, [fetchOutput, paused, interactive]);

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

  // Keyboard handler for interactive mode
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;

    // Ctrl + key combos
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const mapped = CTRL_KEY_MAP[e.key.toLowerCase()];
      if (mapped) {
        e.preventDefault();
        sendRawKey(mapped);
        return;
      }
    }

    // Special keys
    const specialKey = SPECIAL_KEY_MAP[e.key];
    if (specialKey) {
      e.preventDefault();
      sendRawKey(specialKey);
      return;
    }

    // Printable characters (single char, no meta/ctrl/alt modifiers)
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sendLiteralChar(e.key);
      return;
    }
  }, [interactive, sendRawKey, sendLiteralChar]);

  // Focus the terminal output when interactive mode is toggled on
  useEffect(() => {
    if (interactive && outputRef.current) {
      outputRef.current.focus();
    }
  }, [interactive]);

  // Reset interactive mode when session changes
  useEffect(() => {
    setInteractive(false);
  }, [tmuxSessionName]);

  // Cleanup key flush timer on unmount
  useEffect(() => {
    return () => {
      if (keyFlushTimerRef.current) clearTimeout(keyFlushTimerRef.current);
    };
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

  const toggleInteractive = useCallback(() => {
    setInteractive(prev => {
      if (!prev) {
        // Turning on: also unpause
        setPaused(false);
      }
      return !prev;
    });
  }, []);

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
            className={`terminal-toolbar-btn ${interactive ? 'interactive-active' : ''}`}
            onClick={toggleInteractive}
            title={interactive ? 'Disable keyboard capture' : 'Enable keyboard capture (sends keys to tmux)'}
          >
            Interactive
          </button>
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
        className={`terminal-output ${interactive ? 'terminal-interactive-active' : ''}`}
        ref={outputRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={interactive ? 0 : undefined}
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
