import { useState, useCallback, useEffect, useRef } from 'react';
import { ConversationHighlight, SessionStatus, FeedbackOption, TurnStats } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import {
  buildStatusLine,
  formatDuration,
  recentSteps,
  throttleLine,
  type ThrottledLine,
} from '../utils/sessionStatusLine';

interface WaitingIndicatorProps {
  status: SessionStatus | null;
  serverId?: string | null;
  sessionId?: string | null;
  tmuxSessionName?: string;
  /** Loaded messages + totals behind the line; without them it only shows the state. */
  highlights?: ConversationHighlight[];
  turn?: TurnStats | null;
  runningAgents?: number;
  projectPath?: string;
  canCancel?: boolean;
  onCancel?: () => void;
}

export function WaitingIndicator({ status, serverId, sessionId, tmuxSessionName, highlights, turn, runningAgents, projectPath, canCancel, onCancel }: WaitingIndicatorProps) {
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);

  // Only this component re-renders on the tick, not the chat.
  const now = Date.now();
  const next = buildStatusLine({ status, highlights, turn, runningAgents, projectPath, now });
  const shown = useRef<ThrottledLine | null>(null);
  shown.current = throttleLine(shown.current, `${serverId}:${sessionId}`, next, now);
  const phase = next?.phase;
  const ticking = phase === 'working' || phase === 'background';

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    setExpanded(false);
  }, [serverId, sessionId]);

  // Reset sent state when feedback prompt changes (new prompt appears)
  useEffect(() => {
    setFeedbackSent(false);
  }, [status?.feedbackPrompt?.question]);

  const handleFeedback = useCallback(async (option: FeedbackOption) => {
    if (!serverId || !sessionId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return;

    setFeedbackSent(true);

    try {
      await conn.sendRequest('send_feedback', {
        key: option.key,
        sessionId,
        tmuxSessionName: tmuxSessionName || sessionId,
      });
    } catch {
      // Still keep the "sent" state to avoid confusing double-sends
    }
  }, [serverId, sessionId, tmuxSessionName]);

  if (!status) return null;

  // Feedback prompt takes priority over other indicators
  if (status.feedbackPrompt && !feedbackSent) {
    return (
      <div className="feedback-prompt">
        <span className="feedback-prompt-question">{status.feedbackPrompt.question}</span>
        <div className="feedback-prompt-buttons">
          {status.feedbackPrompt.options.map((option) => (
            <button
              key={option.key}
              className={`feedback-prompt-btn${option.key === '0' ? ' dismiss' : ''}`}
              onClick={() => handleFeedback(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (status.feedbackPrompt && feedbackSent) {
    return (
      <div className="feedback-prompt feedback-prompt-sent">
        <span className="feedback-prompt-question">Sent</span>
      </div>
    );
  }

  const line = shown.current?.line;
  if (!line) return null;
  const live = line.phase === 'working' || line.phase === 'background';
  const steps = recentSteps(highlights ?? [], projectPath ?? status.projectPath);
  const canExpand = steps.length > 0;
  const summary = (
    <>
      {live ? <div className="spinner small" /> : <span className={`waiting-dot ${line.phase === 'done' ? 'status-line-dot-done' : 'blue'}`} />}
      <span className="status-line-activity">{line.activity}</span>
      {line.meta.length > 0 && <span className="status-line-meta">{line.meta.join(' \u00b7 ')}</span>}
    </>
  );

  return (
    <div className={`status-line status-line-${line.phase}`}>
      <div className={`waiting-banner ${line.phase === 'done' ? '' : 'waiting-banner-blue'} ${line.phase === 'background' ? 'background-work' : ''}`}>
        {canExpand ? (
          <button
            type="button"
            className="status-line-main"
            aria-expanded={expanded}
            title={expanded ? 'Hide recent steps' : 'Show recent steps'}
            onClick={() => setExpanded((v) => !v)}
          >
            {summary}
          </button>
        ) : (
          <div className="status-line-main">{summary}</div>
        )}
        {line.phase === 'working' && canCancel && onCancel && (
          <button className="cancel-btn" onClick={onCancel} title="Send Ctrl+C to cancel" aria-label="Cancel">
            <span className="status-line-cancel-text">Cancel</span>
            <span className="status-line-cancel-icon" aria-hidden="true">{'\u00d7'}</span>
          </button>
        )}
      </div>
      {expanded && canExpand && (
        <ol className="status-line-steps">
          {steps.map((step) => (
            <li key={step.id} className={`status-line-step status-line-step-${step.status}`}>
              <span className="status-line-step-dot" />
              <span className="status-line-step-label">{step.label}</span>
              {step.status === 'error' ? (
                <span className="status-line-step-time">failed</span>
              ) : step.durationMs !== undefined ? (
                <span className="status-line-step-time">{formatDuration(step.durationMs)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
