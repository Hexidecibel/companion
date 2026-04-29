import { useState, useCallback, useEffect } from 'react';
import { SessionStatus, FeedbackOption } from '../types';
import { connectionManager } from '../services/ConnectionManager';

interface WaitingIndicatorProps {
  status: SessionStatus | null;
  serverId?: string | null;
  sessionId?: string | null;
  tmuxSessionName?: string;
  canCancel?: boolean;
  onCancel?: () => void;
}

export function WaitingIndicator({ status, serverId, sessionId, tmuxSessionName, canCancel, onCancel }: WaitingIndicatorProps) {
  const [feedbackSent, setFeedbackSent] = useState(false);

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

  if (status.isWaitingForInput) {
    return (
      <div className="waiting-banner waiting-banner-blue">
        <span className="waiting-dot blue" />
        <span>Waiting for input</span>
      </div>
    );
  }

  if (status.currentActivity) {
    return (
      <div className="waiting-banner waiting-banner-blue">
        <div className="spinner small" />
        <span>{status.currentActivity}</span>
        {canCancel && onCancel && (
          <button
            className="cancel-btn"
            onClick={onCancel}
            title="Send Ctrl+C to cancel"
            style={{ marginLeft: 'auto' }}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  return null;
}
