import { useState, useEffect, useRef } from 'react';
import { SubAgent, ConversationHighlight } from '../types';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { DispatchAgentCard } from './DispatchAgentCard';
import { MessageBubble } from './MessageBubble';
import { isMobileViewport } from '../utils/platform';

interface DispatchPanelProps {
  serverId: string;
  agents: SubAgent[];
  runningCount: number;
  totalAgents: number;
  height: number;
  collapsed: boolean;
  onCollapse: () => void;
}

function DetailView({
  serverId,
  agentId,
  onBack,
}: {
  serverId: string;
  agentId: string;
  onBack: () => void;
}) {
  const { agent, highlights, loading } = useSubAgentDetail(serverId, agentId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [highlights.length]);

  return (
    <>
      <div className="dispatch-toolbar">
        <div className="dispatch-toolbar-left">
          <button className="dispatch-back-btn" onClick={onBack}>
            {'\u2190'} Back
          </button>
          <span className="dispatch-toolbar-label">
            {agent?.slug || 'Agent'}
          </span>
          {agent && (
            <span className={`dispatch-toolbar-status dispatch-status-${agent.status}`}>
              {agent.status}
            </span>
          )}
        </div>
        {agent && (
          <div className="dispatch-toolbar-right">
            {agent.subagentType && (
              <span className="dispatch-toolbar-meta">{agent.subagentType}</span>
            )}
            <span className="dispatch-toolbar-meta">{agent.messageCount} msgs</span>
          </div>
        )}
      </div>
      {agent?.description && (
        <div className="dispatch-detail-desc">{agent.description}</div>
      )}
      <div className="dispatch-detail-conversation" ref={scrollRef}>
        {loading && (
          <div className="msg-list-empty">
            <div className="spinner" />
            <span>Loading agent conversation...</span>
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
    </>
  );
}

export function DispatchPanel({
  serverId,
  agents,
  runningCount,
  totalAgents,
  height,
  collapsed,
  onCollapse,
}: DispatchPanelProps) {
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);
  const mobile = isMobileViewport();

  // Reset focused agent when agents list changes significantly
  useEffect(() => {
    if (focusedAgentId && !agents.find((a) => a.agentId === focusedAgentId)) {
      setFocusedAgentId(null);
    }
  }, [agents, focusedAgentId]);

  if (totalAgents === 0) return null;

  // Sort: running first, then by lastActivity descending
  const sorted = [...agents].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return b.lastActivity - a.lastActivity;
  });

  const completedCount = totalAgents - runningCount;

  // Mobile: full-screen overlay
  if (mobile) {
    if (collapsed) {
      return (
        <div className="dispatch-mobile-bar" onClick={(e) => { e.stopPropagation(); onCollapse(); }}>
          <span className={`dispatch-mobile-dot ${runningCount > 0 ? 'dispatch-dot-running' : 'dispatch-dot-done'}`} />
          <span className="dispatch-mobile-label">
            {runningCount > 0
              ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
              : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} done`}
          </span>
        </div>
      );
    }

    return (
      <div className="dispatch-mobile-overlay" onClick={(e) => e.stopPropagation()}>
        {focusedAgentId ? (
          <DetailView
            serverId={serverId}
            agentId={focusedAgentId}
            onBack={() => setFocusedAgentId(null)}
          />
        ) : (
          <>
            <div className="dispatch-toolbar">
              <div className="dispatch-toolbar-left">
                <button className="dispatch-back-btn" onClick={onCollapse}>
                  {'\u2190'} Back
                </button>
                <span className="dispatch-toolbar-label">
                  {runningCount > 0
                    ? `${runningCount} running`
                    : `${totalAgents} agents`}
                  {completedCount > 0 && runningCount > 0 &&
                    ` / ${completedCount} done`}
                </span>
              </div>
            </div>
            <div className="dispatch-card-list">
              {sorted.map((agent) => (
                <DispatchAgentCard
                  key={agent.agentId}
                  agent={agent}
                  onClick={() => setFocusedAgentId(agent.agentId)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // Desktop: collapsed bar (always visible when agents exist)
  if (collapsed) {
    return (
      <div className="dispatch-collapsed-bar" onClick={(e) => { e.stopPropagation(); onCollapse(); }}>
        <span className={`dispatch-mobile-dot ${runningCount > 0 ? 'dispatch-dot-running' : 'dispatch-dot-done'}`} />
        <span className="dispatch-collapsed-label">
          {runningCount > 0
            ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
            : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} done`}
          {completedCount > 0 && runningCount > 0 &&
            ` / ${completedCount} done`}
        </span>
        <span className="dispatch-collapsed-expand">{'\u25B2'}</span>
      </div>
    );
  }

  return (
    <div className="dispatch-panel" style={{ height }}>
      {focusedAgentId ? (
        <DetailView
          serverId={serverId}
          agentId={focusedAgentId}
          onBack={() => setFocusedAgentId(null)}
        />
      ) : (
        <>
          <div className="dispatch-toolbar">
            <div className="dispatch-toolbar-left">
              <span className="dispatch-toolbar-label">
                {runningCount > 0
                  ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
                  : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''}`}
                {completedCount > 0 && runningCount > 0 &&
                  ` / ${completedCount} done`}
              </span>
            </div>
            <button className="dispatch-collapse-btn" onClick={onCollapse} title="Collapse panel">
              {'\u25BC'}
            </button>
          </div>
          <div className="dispatch-card-list">
            {sorted.map((agent) => (
              <DispatchAgentCard
                key={agent.agentId}
                agent={agent}
                onClick={() => setFocusedAgentId(agent.agentId)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
