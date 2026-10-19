import { useState, useEffect, useRef, useCallback } from 'react';
import { SubAgent, ConversationHighlight } from '../types';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { DispatchAgentCard } from './DispatchAgentCard';
import { MessageBubble } from './MessageBubble';
import { AgentTile } from './AgentTile';
import { SubagentStatusChip, SubagentStateBody } from './SubagentState';
import { indentOf, orderTree } from '../services/subagents';
import { isMobileViewport } from '../utils/platform';

interface DispatchPanelProps {
  serverId: string;
  agents: SubAgent[];
  runningCount: number;
  totalAgents: number;
  height: number;
  collapsed: boolean;
  onCollapse: () => void;
  /** Mobile: the user closed the quiet "N agents done" bar for this session. */
  doneBarDismissed?: boolean;
  onDismissDoneBar?: () => void;
}

function DetailView({
  serverId,
  agentId,
  listAgent,
  onBack,
}: {
  serverId: string;
  agentId: string;
  /** The agent as the live list knows it (tracker state on newer daemons). */
  listAgent?: SubAgent;
  onBack: () => void;
}) {
  const { agent: fetched, highlights, loading } = useSubAgentDetail(serverId, agentId, {
    version: listAgent && listAgent.status !== 'running' ? listAgent.summary?.version ?? listAgent.messageCount : undefined,
  });
  const agent = listAgent ?? fetched;
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
          {agent && <SubagentStatusChip agent={agent} />}
        </div>
        {agent && (
          <div className="dispatch-toolbar-right">
            {agent.subagentType && (
              <span className="dispatch-toolbar-meta">{agent.subagentType}</span>
            )}
            {!agent.summary && <span className="dispatch-toolbar-meta">{agent.messageCount} msgs</span>}
          </div>
        )}
      </div>
      {agent?.description && (
        <div className="dispatch-detail-desc">{agent.description}</div>
      )}
      {agent?.summary && (
        <div className="dispatch-detail-desc">
          <SubagentStateBody summary={agent.summary} />
        </div>
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
  doneBarDismissed = false,
  onDismissDoneBar,
}: DispatchPanelProps) {
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);
  const [dismissedAgents, setDismissedAgents] = useState<Set<string>>(new Set());
  const prevAgentStates = useRef<Map<string, { messageCount: number; status: string }>>(new Map());
  const mobile = isMobileViewport();

  // Reset focused agent when agents list changes significantly
  useEffect(() => {
    if (focusedAgentId && !agents.find((a) => a.agentId === focusedAgentId)) {
      setFocusedAgentId(null);
    }
  }, [agents, focusedAgentId]);

  // Un-dismiss agents that have new activity, then update prev states
  useEffect(() => {
    const prev = prevAgentStates.current;
    const toUndismiss: string[] = [];

    for (const agent of agents) {
      const old = prev.get(agent.agentId);
      if (old && dismissedAgents.has(agent.agentId)) {
        const hasNewMessages = agent.messageCount > old.messageCount;
        const becameActive = agent.status === 'running' && old.status !== 'running';
        if (hasNewMessages || becameActive) {
          toUndismiss.push(agent.agentId);
        }
      }
    }

    if (toUndismiss.length > 0) {
      setDismissedAgents(prev => {
        const next = new Set(prev);
        for (const id of toUndismiss) next.delete(id);
        return next;
      });
    }

    // Update prev states
    const nextMap = new Map<string, { messageCount: number; status: string }>();
    for (const agent of agents) {
      nextMap.set(agent.agentId, { messageCount: agent.messageCount, status: agent.status });
    }
    prevAgentStates.current = nextMap;
  }, [agents, dismissedAgents]);

  const handleDismiss = useCallback((agentId: string) => {
    setDismissedAgents(prev => new Set(prev).add(agentId));
  }, []);

  const handleShowAll = useCallback(() => {
    setDismissedAgents(new Set());
  }, []);

  if (totalAgents === 0) return null;

  // Tree order: running first, newest first; nested agents right under their parent.
  const sorted = orderTree(agents);

  const visibleAgents = sorted.filter(a => !dismissedAgents.has(a.agentId));
  const dismissedCount = dismissedAgents.size;
  const completedCount = totalAgents - runningCount;

  // Mobile: full-screen overlay
  if (mobile) {
    if (collapsed) {
      // Everything finished: a quieter "N agents done" bar keeps the results
      // reachable until the user closes it (per session, see SessionView).
      if (runningCount === 0) {
        if (doneBarDismissed) return null;
        return (
          <div className="dispatch-mobile-bar dispatch-mobile-bar-done" onClick={(e) => { e.stopPropagation(); onCollapse(); }}>
            <span className="dispatch-mobile-dot dispatch-dot-done" />
            <span className="dispatch-mobile-label">
              {`${totalAgents} agent${totalAgents !== 1 ? 's' : ''} done`}
            </span>
            {onDismissDoneBar && (
              <button
                className="dispatch-mobile-bar-close"
                onClick={(e) => { e.stopPropagation(); onDismissDoneBar(); }}
                title="Hide"
                aria-label="Hide finished agents bar"
              >
                {'\u2715'}
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="dispatch-mobile-bar" onClick={(e) => { e.stopPropagation(); onCollapse(); }}>
          <span className="dispatch-mobile-dot dispatch-dot-running" />
          <span className="dispatch-mobile-label">
            {`${runningCount} agent${runningCount !== 1 ? 's' : ''} running`}
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
            listAgent={agents.find((a) => a.agentId === focusedAgentId)}
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
              {visibleAgents.map((agent) => (
                <DispatchAgentCard
                  key={agent.agentId}
                  agent={agent}
                  indent={indentOf(agent, visibleAgents)}
                  onClick={() => setFocusedAgentId(agent.agentId)}
                  onDismiss={agent.status !== 'running' ? () => handleDismiss(agent.agentId) : undefined}
                />
              ))}
              {visibleAgents.length === 0 && dismissedCount > 0 && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 8 }}>
                    All agents dismissed
                  </div>
                  <button className="dispatch-show-all" onClick={handleShowAll}>
                    Show all ({dismissedCount})
                  </button>
                </div>
              )}
              {visibleAgents.length > 0 && dismissedCount > 0 && (
                <button className="dispatch-show-all" onClick={handleShowAll}>
                  Show {dismissedCount} dismissed
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // Desktop: when collapsed, the opener is the header chip (DispatchOpener)
  // rendered by SessionView in session-header-actions.
  if (collapsed) return null;

  return (
    <div className="dispatch-panel" style={{ height }}>
      <div className="dispatch-toolbar">
        <div className="dispatch-toolbar-left">
          <span className="dispatch-toolbar-label">
            {runningCount > 0
              ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
              : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''}`}
            {completedCount > 0 && runningCount > 0 &&
              ` / ${completedCount} done`}
          </span>
          {dismissedCount > 0 && (
            <button className="dispatch-show-all" onClick={handleShowAll} style={{ margin: 0, marginLeft: 8 }}>
              +{dismissedCount} dismissed
            </button>
          )}
        </div>
        <button className="dispatch-collapse-btn" onClick={onCollapse} title="Collapse panel">
          {'\u25BC'}
        </button>
      </div>
      <div className="dispatch-tile-container">
        {visibleAgents.map(agent => (
          <AgentTile
            key={agent.agentId}
            serverId={serverId}
            agent={agent}
            indent={indentOf(agent, visibleAgents)}
            onDismiss={agent.status !== 'running' ? () => handleDismiss(agent.agentId) : undefined}
          />
        ))}
        {visibleAgents.length === 0 && dismissedCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: 16 }}>
            <button className="dispatch-show-all" onClick={handleShowAll}>
              Show {dismissedCount} dismissed agent{dismissedCount !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
