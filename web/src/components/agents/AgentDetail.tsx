/**
 * One agent from the Agents page: tracker state (SubagentStateBody), the
 * timeline and files from `subagent_get`, and the transcript highlights
 * (useSubAgentDetail) only once the user opens that section.
 */
import { useEffect, useState } from 'react';
import type { ConversationHighlight } from '../../types';
import type { SubagentGetResponse, SubagentState, SubagentSummary } from '../../types/subagents';
import { connectionManager } from '../../services/ConnectionManager';
import { isActiveStatus, summaryToSubAgent } from '../../services/subagents';
import { useSubAgentDetail } from '../../hooks/useSubAgentDetail';
import { SubagentStateBody, SubagentStatusChip } from '../SubagentState';
import { MessageBubble } from '../MessageBubble';

const FILES_SHOWN = 8;
const EVENTS_SHOWN = 10;

export interface AgentDetailProps {
  serverId: string;
  agentId: string;
  /** The live summary (from the page's watch); drives refetches. */
  summary?: SubagentSummary;
  sessionTitle?: string;
  openSessionId?: string;
  onOpenSession: (serverId: string, sessionId: string) => void;
  onBack: () => void;
}

function useAgentState(serverId: string, agentId: string, version: number | undefined): SubagentState | null {
  const [state, setState] = useState<SubagentState | null>(null);
  useEffect(() => {
    let alive = true;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;
    conn
      .sendRequest('subagent_get', { agentId })
      .then((res) => {
        if (alive && res.success && res.payload) setState((res.payload as SubagentGetResponse).agent);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [serverId, agentId, version]);
  return state;
}

export function AgentDetail({ serverId, agentId, summary, sessionTitle, openSessionId, onOpenSession, onBack }: AgentDetailProps) {
  const full = useAgentState(serverId, agentId, summary?.version);
  const s: SubagentSummary | undefined = summary ?? full ?? undefined;
  const [showTranscript, setShowTranscript] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const active = s ? isActiveStatus(s.status) : false;
  const { highlights, loading } = useSubAgentDetail(serverId, agentId, {
    enabled: showTranscript,
    version: active ? undefined : s?.version,
  });
  const timeline = full?.timeline ?? [];

  return (
    <div className="agents-detail">
      <header className="agents-page__header">
        <button type="button" className="agents-back" onClick={onBack} aria-label="Back to agents">
          {'←'}
        </button>
        <h1 className="agents-page__title agents-detail__name" title={s?.name}>
          {s?.name || agentId.slice(0, 8)}
        </h1>
        {s && <SubagentStatusChip agent={summaryToSubAgent(s)} />}
      </header>
      <div className="agents-page__body">
        {sessionTitle && (
          <div className="agents-detail__where">
            <span>in {sessionTitle}</span>
            {openSessionId && (
              <button type="button" className="agents-open-btn" onClick={() => onOpenSession(serverId, openSessionId)}>
                Open session
              </button>
            )}
          </div>
        )}
        {s ? <SubagentStateBody summary={s} /> : <div className="agents-empty">Loading…</div>}

        {full && full.files.length > 0 && (
          <section className="agents-detail__section">
            <h2>Files ({full.files.length})</h2>
            <ul className="agents-detail__files">
              {full.files.slice(0, FILES_SHOWN).map((f) => {
                const cut = f.path.lastIndexOf('/');
                return (
                  <li key={f.path} title={f.path}>
                    <span className="agents-detail__file">{cut >= 0 ? f.path.slice(cut + 1) : f.path}</span>
                    <span className="agents-detail__dir">{cut > 0 ? f.path.slice(0, cut) : ''}</span>
                    <span className="agents-detail__count">{f.count}</span>
                  </li>
                );
              })}
              {full.files.length > FILES_SHOWN && <li className="agents-detail__more">{`+${full.files.length - FILES_SHOWN} more`}</li>}
            </ul>
          </section>
        )}

        {timeline.length > 0 && (
          <section className="agents-detail__section">
            <h2>Timeline</h2>
            <ul className="subagent-events agents-detail__timeline">
              {[...timeline]
                .reverse()
                .slice(0, allEvents ? undefined : EVENTS_SHOWN)
                .map((e) => (
                  <li key={e.id} className={e.failed ? 'failed' : e.pending ? 'pending' : ''}>
                    <span className="subagent-event-kind">{e.tool || e.kind}</span>
                    <span className="subagent-event-text">{e.display}</span>
                  </li>
                ))}
            </ul>
            {!allEvents && timeline.length > EVENTS_SHOWN && (
              <button type="button" className="agents-fold" onClick={() => setAllEvents(true)}>
                {`Show all ${timeline.length}`}
              </button>
            )}
          </section>
        )}

        <section className="agents-detail__section">
          <button
            type="button"
            className="agents-fold agents-fold--section"
            aria-expanded={showTranscript}
            onClick={() => setShowTranscript((v) => !v)}
          >
            <span>Transcript</span>
            <span className="agents-fold__caret" aria-hidden>
              {showTranscript ? '▴' : '▾'}
            </span>
          </button>
          {showTranscript && (
            <div className="agents-detail__transcript">
              {loading && <div className="agents-empty">Loading…</div>}
              {!loading && highlights.length === 0 && <div className="agents-empty">No messages yet</div>}
              {!loading && highlights.map((m: ConversationHighlight) => <MessageBubble key={m.id} message={m} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
