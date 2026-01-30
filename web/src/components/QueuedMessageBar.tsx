import { QueuedMessage } from '../services/messageQueue';

interface QueuedMessageBarProps {
  messages: QueuedMessage[];
  onCancel: (id: string) => void;
  onClearAll: () => void;
}

export function QueuedMessageBar({ messages, onCancel, onClearAll }: QueuedMessageBarProps) {
  if (messages.length === 0) return null;

  const next = messages[0];
  const preview = next.text.length > 60 ? next.text.slice(0, 60) + '...' : next.text;

  return (
    <div className="queued-bar">
      <div className="queued-bar-info">
        <span className="queued-bar-count">
          {messages.length} queued message{messages.length !== 1 ? 's' : ''}
        </span>
        <span className="queued-bar-preview">Next: {preview}</span>
      </div>
      <div className="queued-bar-actions">
        {messages.length === 1 ? (
          <button className="queued-bar-cancel" onClick={() => onCancel(next.id)}>
            Cancel
          </button>
        ) : (
          <button className="queued-bar-cancel" onClick={onClearAll}>
            Clear All
          </button>
        )}
      </div>
    </div>
  );
}
