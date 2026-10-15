import { useEffect, useRef, useState } from 'react';
import { SubAgent, ConversationHighlight } from '../types';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { MessageBubble } from './MessageBubble';
import { SubagentStatusChip, SubagentStateBody } from './SubagentState';

interface AgentTileProps {
  serverId: string;
  agent: SubAgent;
  /** Nesting level inside the panel (0 = dispatched by the main thread). */
  indent?: number;
  onDismiss?: () => void;
}

/**
 * One agent in the desktop dispatch panel. Shows the tracker state (status,
 * activity, checklist, tests, tokens, newest events) from the list it was given;
 * the conversation is fetched only while the tile is expanded. Older daemons
 * (no tracker state) keep the conversation view.
 */
export function AgentTile({ serverId, agent, indent = 0, onDismiss }: AgentTileProps) {
  const hasState = !!agent.summary;
  const [expanded, setExpanded] = useState(!hasState);
  const { highlights, loading } = useSubAgentDetail(serverId, agent.agentId, {
    enabled: expanded,
    // Running: the hook polls. Finished: refetch only when the state moves on.
    version: agent.status === 'running' ? undefined : (agent.summary?.version ?? agent.messageCount),
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [highlights.length, expanded]);

  return (
    <div className="dispatch-tile" style={indent ? { borderLeft: `${Math.min(indent, 4) * 3}px solid var(--border-color)` } : undefined}>
      <div className="dispatch-tile-header">
        <span className={`dispatch-tile-status-dot ${agent.status}`} />
        <span className="subagent-tile-name" title={agent.slug}>
          {indent > 0 ? '↳ ' : ''}
          {agent.slug || agent.agentId.slice(0, 8)}
        </span>
        <SubagentStatusChip agent={agent} />
        {hasState && (
          <button
            className="subagent-tile-toggle"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            title={expanded ? 'Show status' : 'Show conversation'}
          >
            {expanded ? 'Status' : 'Conversation'}
          </button>
        )}
        {onDismiss && (
          <button
            className="dispatch-tile-dismiss"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            title="Dismiss"
          >
            {'×'}
          </button>
        )}
      </div>
      {!expanded && agent.summary ? (
        <div className="dispatch-tile-conversation">
          <SubagentStateBody summary={agent.summary} />
        </div>
      ) : (
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
      )}
    </div>
  );
}
