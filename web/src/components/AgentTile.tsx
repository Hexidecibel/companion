import { useEffect, useRef } from 'react';
import { SubAgent, ConversationHighlight } from '../types';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { MessageBubble } from './MessageBubble';

interface AgentTileProps {
  serverId: string;
  agent: SubAgent;
  onDismiss?: () => void;
}

export function AgentTile({ serverId, agent, onDismiss }: AgentTileProps) {
  const { highlights, loading } = useSubAgentDetail(serverId, agent.agentId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [highlights.length]);

  return (
    <div className="dispatch-tile">
      <div className="dispatch-tile-header">
        <span className={`dispatch-tile-status-dot ${agent.status}`} />
        <span
          style={{
            fontSize: 11,
            fontFamily: "'SF Mono', Monaco, 'Cascadia Code', monospace",
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.slug}
        </span>
        {onDismiss && (
          <button
            className="dispatch-tile-dismiss"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            title="Dismiss"
          >
            {'\u00D7'}
          </button>
        )}
      </div>
      <div className="dispatch-tile-conversation" ref={scrollRef}>
        {loading && (
          <div className="msg-list-empty">
            <div className="spinner" />
            <span>Loading...</span>
          </div>
        )}
        {!loading && highlights.length === 0 && (
          <div className="msg-list-empty">
            <span>No messages yet</span>
          </div>
        )}
        {!loading &&
          highlights.map((msg: ConversationHighlight) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
      </div>
    </div>
  );
}
