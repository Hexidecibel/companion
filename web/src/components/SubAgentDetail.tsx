import { SubAgent, ConversationHighlight } from '../types';
import { MessageBubble } from './MessageBubble';

interface SubAgentDetailProps {
  agent: SubAgent | null;
  highlights: ConversationHighlight[];
  loading: boolean;
  onClose: () => void;
}

function formatDuration(start: number, end?: number): string {
  const ms = (end || Date.now()) - start;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

const STATUS_CLASSES: Record<SubAgent['status'], string> = {
  running: 'subagent-status-running',
  completed: 'subagent-status-completed',
  error: 'subagent-status-error',
};

export function SubAgentDetail({ agent, highlights, loading, onClose }: SubAgentDetailProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content subagent-detail" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{agent?.slug || 'Agent Detail'}</h3>
          <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
        </div>

        {agent && (
          <div className="subagent-detail-meta">
            <span className={`subagent-detail-status ${STATUS_CLASSES[agent.status]}`}>
              {agent.status}
            </span>
            {agent.subagentType && (
              <span className="subagent-detail-type">{agent.subagentType}</span>
            )}
            <span className="subagent-detail-duration">
              {formatDuration(agent.startedAt, agent.completedAt)}
            </span>
            <span className="subagent-detail-msgs">
              {agent.messageCount} messages
            </span>
          </div>
        )}

        {agent?.description && (
          <div className="subagent-detail-desc">{agent.description}</div>
        )}

        <div className="subagent-detail-conversation">
          {loading && (
            <div className="msg-list-empty">
              <div className="spinner" />
              <span>Loading agent conversation...</span>
            </div>
          )}
          {!loading && highlights.length === 0 && (
            <div className="msg-list-empty">
              <span>No messages</span>
            </div>
          )}
          {!loading && highlights.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      </div>
    </div>
  );
}
