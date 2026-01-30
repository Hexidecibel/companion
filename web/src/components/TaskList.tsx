import { useState } from 'react';
import { TaskItem } from '../types';

interface TaskListProps {
  tasks: TaskItem[];
  loading: boolean;
}

export function TaskList({ tasks, loading }: TaskListProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading || tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const total = tasks.length;
  const pctComplete = total > 0 ? (completed / total) * 100 : 0;
  const pctInProgress = total > 0 ? (inProgress / total) * 100 : 0;

  return (
    <div className="task-list-panel">
      <div
        className="task-list-header"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="task-progress-bar">
          <div
            className="task-progress-fill completed"
            style={{ width: `${pctComplete}%` }}
          />
          <div
            className="task-progress-fill in-progress"
            style={{ width: `${pctInProgress}%` }}
          />
        </div>
        <span className="task-list-summary">
          {completed}/{total} tasks
          {inProgress > 0 && ` (${inProgress} active)`}
          {pending > 0 && ` (${pending} pending)`}
        </span>
        <span className="task-list-toggle">{expanded ? '\u25B4' : '\u25BE'}</span>
      </div>

      {expanded && (
        <div className="task-list-items">
          {tasks.map((task) => (
            <TaskItemRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskItemRow({ task }: { task: TaskItem }) {
  const statusIcon =
    task.status === 'completed'
      ? '\u2713'
      : task.status === 'in_progress'
        ? '\u25CF'
        : '\u25CB';

  const statusClass =
    task.status === 'completed'
      ? 'task-item-completed'
      : task.status === 'in_progress'
        ? 'task-item-in-progress'
        : 'task-item-pending';

  return (
    <div className={`task-item ${statusClass}`}>
      <span className="task-item-icon">{statusIcon}</span>
      <span className="task-item-subject">{task.subject}</span>
    </div>
  );
}
