import { useState } from 'react';
import { WorkerSession } from '../types';

interface WorkerCardProps {
  worker: WorkerSession;
  onView: () => void;
  onSendInput?: (text: string) => void;
  onRetry?: () => void;
}

const STATUS_LABELS: Record<WorkerSession['status'], string> = {
  spawning: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  completed: 'Done',
  error: 'Error',
};

const STATUS_CLASSES: Record<WorkerSession['status'], string> = {
  spawning: 'worker-status-spawning',
  working: 'worker-status-working',
  waiting: 'worker-status-waiting',
  completed: 'worker-status-completed',
  error: 'worker-status-error',
};

function formatDuration(start: number, end?: number): string {
  const ms = (end || Date.now()) - start;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function WorkerCard({ worker, onView, onSendInput, onRetry }: WorkerCardProps) {
  const [customInput, setCustomInput] = useState('');

  const handleOptionClick = (label: string) => {
    onSendInput?.(label);
  };

  const handleCustomSubmit = () => {
    if (customInput.trim()) {
      onSendInput?.(customInput.trim());
      setCustomInput('');
    }
  };

  return (
    <div className={`worker-card ${STATUS_CLASSES[worker.status]}`}>
      <div className="worker-card-header">
        <span className="worker-card-slug">{worker.taskSlug}</span>
        <span className={`worker-card-badge ${STATUS_CLASSES[worker.status]}`}>
          {STATUS_LABELS[worker.status]}
        </span>
      </div>

      {worker.taskDescription && (
        <div className="worker-card-desc">{worker.taskDescription}</div>
      )}

      {worker.lastActivity && worker.status === 'working' && (
        <div className="worker-card-activity">{worker.lastActivity}</div>
      )}

      {worker.status === 'waiting' && worker.lastQuestion && (
        <div className="worker-card-question">
          <div className="worker-card-question-text">{worker.lastQuestion.text}</div>
          {worker.lastQuestion.options && worker.lastQuestion.options.length > 0 && (
            <div className="worker-card-options">
              {worker.lastQuestion.options.map((opt, i) => (
                <button
                  key={i}
                  className="worker-card-option-btn"
                  onClick={(e) => { e.stopPropagation(); handleOptionClick(opt.label); }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <div className="worker-card-custom-input">
            <input
              type="text"
              placeholder="Type a response..."
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCustomSubmit(); }}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="worker-card-send-btn"
              onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }}
              disabled={!customInput.trim()}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {worker.status === 'error' && worker.error && (
        <div className="worker-card-error">{worker.error}</div>
      )}

      {worker.status === 'completed' && worker.commits.length > 0 && (
        <div className="worker-card-commits">
          {worker.commits.length} commit{worker.commits.length !== 1 ? 's' : ''}
        </div>
      )}

      <div className="worker-card-footer">
        <span className="worker-card-meta">
          {worker.branch}
        </span>
        <span className="worker-card-meta">
          {formatDuration(worker.startedAt, worker.completedAt)}
        </span>
        <div className="worker-card-actions">
          {worker.status === 'error' && onRetry && (
            <button
              className="worker-card-action-btn retry"
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
            >
              Retry
            </button>
          )}
          <button
            className="worker-card-action-btn view"
            onClick={(e) => { e.stopPropagation(); onView(); }}
          >
            View
          </button>
        </div>
      </div>
    </div>
  );
}
