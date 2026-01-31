import { useState } from 'react';
import { WorkGroup } from '../types';
import { WorkerCard } from './WorkerCard';

interface WorkGroupPanelProps {
  group: WorkGroup;
  onBack: () => void;
  onViewWorker: (sessionId: string) => void;
  onSendWorkerInput: (workerId: string, text: string) => void;
  onMerge: () => void;
  onCancel: () => void;
  onRetryWorker: (workerId: string) => void;
  merging?: boolean;
}

const STATUS_PRIORITY: Record<string, number> = {
  waiting: 0,
  working: 1,
  spawning: 2,
  error: 3,
  completed: 4,
};

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function WorkGroupPanel({
  group,
  onBack,
  onViewWorker,
  onSendWorkerInput,
  onMerge,
  onCancel,
  onRetryWorker,
  merging,
}: WorkGroupPanelProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const completed = group.workers.filter(w => w.status === 'completed').length;
  const total = group.workers.length;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  const sortedWorkers = [...group.workers].sort((a, b) => {
    const pDiff = (STATUS_PRIORITY[a.status] ?? 5) - (STATUS_PRIORITY[b.status] ?? 5);
    if (pDiff !== 0) return pDiff;
    return b.startedAt - a.startedAt;
  });

  const canMerge = completed > 0 && group.status === 'active';
  const allDone = group.workers.every(w => w.status === 'completed' || w.status === 'error');
  const hasErrors = group.workers.some(w => w.status === 'error');

  return (
    <div className="workgroup-panel">
      <div className="workgroup-panel-header">
        <button className="workgroup-panel-back" onClick={onBack}>
          {'\u2190'} Back to conversation
        </button>
      </div>

      <div className="workgroup-panel-title-area">
        <h2 className="workgroup-panel-title">{group.name}</h2>
        <span className="workgroup-panel-meta">
          Started {formatRelativeTime(group.createdAt)} {'\u00B7'} {total} worker{total !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="workgroup-panel-progress">
        <div className="workgroup-panel-progress-bar">
          <div
            className="workgroup-panel-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="workgroup-panel-progress-text">
          {completed}/{total} complete
        </span>
      </div>

      {group.status === 'merging' && (
        <div className="workgroup-panel-status-banner merging">
          Merging branches...
        </div>
      )}

      {group.status === 'completed' && (
        <div className="workgroup-panel-status-banner completed">
          Merged successfully {group.mergeCommit ? `(${group.mergeCommit.substring(0, 8)})` : ''}
        </div>
      )}

      {group.status === 'failed' && (
        <div className="workgroup-panel-status-banner failed">
          {group.error || 'Merge failed'}
        </div>
      )}

      <div className="workgroup-panel-workers">
        {sortedWorkers.map(worker => (
          <WorkerCard
            key={worker.id}
            worker={worker}
            onView={() => onViewWorker(worker.sessionId)}
            onSendInput={(text) => onSendWorkerInput(worker.id, text)}
            onRetry={() => onRetryWorker(worker.id)}
          />
        ))}
      </div>

      {group.status === 'active' && (
        <div className="workgroup-panel-actions">
          {canMerge && (
            <button
              className="workgroup-panel-merge-btn"
              onClick={onMerge}
              disabled={merging}
            >
              {merging ? 'Merging...' : allDone ? 'Merge All' : `Merge ${completed} Completed`}
            </button>
          )}

          {allDone && hasErrors && (
            <span className="workgroup-panel-note">
              Some workers errored. You can retry them or merge the completed ones.
            </span>
          )}

          {!confirmCancel ? (
            <button
              className="workgroup-panel-cancel-btn"
              onClick={() => setConfirmCancel(true)}
            >
              Cancel Group
            </button>
          ) : (
            <div className="workgroup-panel-confirm">
              <span>Kill all workers and remove worktrees?</span>
              <button className="workgroup-panel-confirm-yes" onClick={onCancel}>
                Yes, cancel
              </button>
              <button className="workgroup-panel-confirm-no" onClick={() => setConfirmCancel(false)}>
                No
              </button>
            </div>
          )}

          {canMerge && !allDone && (
            <div className="workgroup-panel-merge-note">
              Merge will combine completed branches
              ({group.workers.filter(w => w.status === 'completed').map(w => w.branch).join(', ')})
              into main. Workers still running will continue independently.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
