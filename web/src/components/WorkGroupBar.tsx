import { WorkGroup } from '../types';

interface WorkGroupBarProps {
  group: WorkGroup;
  onClick: () => void;
}

export function WorkGroupBar({ group, onClick }: WorkGroupBarProps) {
  const completed = group.workers.filter(w => w.status === 'completed').length;
  const waiting = group.workers.filter(w => w.status === 'waiting').length;
  const errored = group.workers.filter(w => w.status === 'error').length;
  const total = group.workers.length;

  let statusText = `${completed}/${total} workers complete`;
  if (waiting > 0) statusText += ` \u00B7 ${waiting} waiting`;
  if (errored > 0) statusText += ` \u00B7 ${errored} errored`;
  if (group.status === 'merging') statusText = 'Merging branches...';
  if (group.status === 'completed') statusText = `Merged \u2013 ${total} workers complete`;
  if (group.status === 'failed') statusText = `Merge failed \u2013 click to dismiss`;

  const isActive = group.status === 'active' && group.workers.some(w => w.status === 'working');

  return (
    <div className="workgroup-bar" onClick={onClick}>
      <div className="workgroup-bar-left">
        <span className={`workgroup-bar-indicator ${isActive ? 'active' : ''}`}>
          {isActive ? '\u25CF' : '\u25CB'}
        </span>
        <span className="workgroup-bar-status">{statusText}</span>
      </div>
      <div className="workgroup-bar-progress">
        <div
          className="workgroup-bar-progress-fill"
          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
        />
      </div>
      <span className="workgroup-bar-chevron">{'\u203A'}</span>
    </div>
  );
}
