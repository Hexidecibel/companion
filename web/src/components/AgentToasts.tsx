import React from 'react';
import type { AgentToast } from '../hooks/useAgentToasts';

interface AgentToastsProps {
  toasts: AgentToast[];
  onDismiss: (id: string) => void;
  onClick: () => void;
}

function truncate(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatToastText(toast: AgentToast): string {
  const desc = truncate(toast.description);
  switch (toast.type) {
    case 'started':
      return `Agent started: ${desc}`;
    case 'completed':
      return `Agent completed (${toast.duration}s): ${desc}`;
    case 'error':
      return `Agent error (${toast.duration}s): ${desc}`;
  }
}

const AgentToasts = React.memo(function AgentToasts({ toasts, onDismiss, onClick }: AgentToastsProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="agent-toasts-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`agent-toast agent-toast-${toast.type}`}
          onClick={() => {
            onClick();
            onDismiss(toast.id);
          }}
        >
          <span className="agent-toast-dot" />
          <span className="agent-toast-text">{formatToastText(toast)}</span>
          <button
            className="agent-toast-dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
});

export default AgentToasts;
