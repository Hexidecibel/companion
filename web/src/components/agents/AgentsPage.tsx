/**
 * All-sessions Agents page: "where's it at?" in ~2 seconds.
 *
 *   Agents            5 running · 1 stuck
 *   ! NEEDS ATTENTION   (stuck / failed, pinned)
 *   [session cards]     attention > running (newest first); <= 5 rows, "+N more", "N done" folded
 *   Finished in last 2h: dox (3) ›
 *
 * Click an agent row -> its detail (state, timeline, files, transcript).
 * Click a card header -> open that session.
 */
import { useState } from 'react';
import type { ServerSummary } from '../../types';
import { useAgentsOverview } from '../../hooks/useAgentsOverview';
import type { AgentRow, AgentsOverview, AttentionItem, SessionCard } from '../../services/agentsOverview';
import { AgentDetail } from './AgentDetail';

export interface AgentsPageProps {
  summaries?: Map<string, ServerSummary>;
  onOpenSession: (serverId: string, sessionId: string) => void;
  /** Back / close (mobile header, desktop close). */
  onClose?: () => void;
  /** Test seam: render this model instead of the live one. */
  overviewOverride?: AgentsOverview;
}

const DOT: Record<AgentRow['tone'], string> = {
  running: '●',
  waiting: '◐',
  stuck: '!',
  done: '✓',
  unconfirmed: '✓',
  failed: '✗',
  stopped: '■',
  lost: '?',
};

function Row({ row, onOpen }: { row: AgentRow; onOpen: (r: AgentRow) => void }) {
  return (
    <button
      type="button"
      className={`agents-row agents-row--${row.tone}`}
      style={row.indent ? { paddingLeft: `${8 + row.indent * 14}px` } : undefined}
      onClick={() => onOpen(row)}
      title={row.name}
    >
      <span className={`agents-dot agents-dot--${row.tone}`} aria-hidden>
        {DOT[row.tone]}
      </span>
      <span className="agents-row__name">{row.name}</span>
      {row.chip && <span className={`agents-chip agents-chip--${row.tone}`}>{row.chip}</span>}
      <span className="agents-row__elapsed">{row.elapsed}</span>
      <span className="agents-row__activity">{row.activity}</span>
    </button>
  );
}

function Card({
  card,
  onOpenRow,
  onOpenSession,
}: {
  card: SessionCard;
  onOpenRow: (r: AgentRow) => void;
  onOpenSession: (serverId: string, sessionId: string) => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const openable = !!card.openSessionId;
  const header = (
    <>
      <span className="agents-card__title">{card.title}</span>
      <span className="agents-card__count">{`${card.done}/${card.total} done`}</span>
    </>
  );
  return (
    <section className={`agents-card${card.attention ? ' agents-card--attention' : ''}`} data-testid="agents-card">
      {openable ? (
        <button
          type="button"
          className="agents-card__header agents-card__header--link"
          onClick={() => onOpenSession(card.serverId, card.openSessionId!)}
          title={`Open ${card.title}`}
        >
          {header}
        </button>
      ) : (
        <div className="agents-card__header">{header}</div>
      )}
      {card.subtitle && <div className="agents-card__subtitle">{card.subtitle}</div>}
      {card.rows.map((r) => (
        <Row key={r.agentId} row={r} onOpen={onOpenRow} />
      ))}
      {card.moreRows.length > 0 &&
        (showMore ? (
          card.moreRows.map((r) => <Row key={r.agentId} row={r} onOpen={onOpenRow} />)
        ) : (
          <button type="button" className="agents-fold" onClick={() => setShowMore(true)}>
            {`+${card.moreRows.length} more running`}
          </button>
        ))}
      {card.finished.length > 0 && (
        <>
          <button
            type="button"
            className="agents-fold agents-fold--done"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            <span>{`✓ ${card.finished.length} done`}</span>
            <span className="agents-fold__caret" aria-hidden>
              {showDone ? '▴' : '▾'}
            </span>
          </button>
          {showDone && card.finished.map((r) => <Row key={r.agentId} row={r} onOpen={onOpenRow} />)}
        </>
      )}
    </section>
  );
}

function Attention({
  items,
  onOpenAgent,
  onOpenSession,
}: {
  items: AttentionItem[];
  onOpenAgent: (serverId: string, agentId: string) => void;
  onOpenSession: (serverId: string, sessionId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="agents-attention" aria-label="Needs attention">
      <div className="agents-attention__label">! Needs attention</div>
      {items.map((it) => (
        <div key={it.key} className="agents-attention__item">
          <button type="button" className="agents-attention__main" onClick={() => onOpenAgent(it.serverId, it.agentId)}>
            <span className="agents-attention__line">
              <span className="agents-attention__where">
                {it.sessionTitle} › {it.name}
              </span>
              <span className={`agents-chip agents-chip--${it.kind}`}>{it.chip}</span>
            </span>
            <span className="agents-attention__detail">{it.detail}</span>
          </button>
          {it.openSessionId && (
            <button
              type="button"
              className="agents-open-btn"
              onClick={() => onOpenSession(it.serverId, it.openSessionId!)}
            >
              Open
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function headline(o: AgentsOverview): string {
  const bits = [`${o.running} running`];
  if (o.stuck) bits.push(`${o.stuck} stuck`);
  if (o.failed) bits.push(`${o.failed} failed`);
  return bits.join(' · ');
}

export function AgentsPage({ summaries, onOpenSession, onClose, overviewOverride }: AgentsPageProps) {
  const live = useAgentsOverview(summaries);
  const overview = overviewOverride ?? live.overview;
  const [detail, setDetail] = useState<{ serverId: string; agentId: string } | null>(null);
  const [finishedOpen, setFinishedOpen] = useState(false);

  if (detail) {
    const row = overview.groups
      .flatMap((g) => [...g.cards, ...g.finishedOnly])
      .flatMap((c) => [...c.rows, ...c.moreRows, ...c.finished].map((r) => ({ r, c })))
      .find(({ r }) => r.serverId === detail.serverId && r.agentId === detail.agentId);
    return (
      <div className="agents-page">
        <AgentDetail
          serverId={detail.serverId}
          agentId={detail.agentId}
          summary={row?.r.summary}
          sessionTitle={row?.c.title}
          openSessionId={row?.c.openSessionId}
          onOpenSession={onOpenSession}
          onBack={() => setDetail(null)}
        />
      </div>
    );
  }

  const openRow = (r: AgentRow) => setDetail({ serverId: r.serverId, agentId: r.agentId });
  const finishedOnly = overview.groups.flatMap((g) => g.finishedOnly.map((c) => ({ c, g })));
  const anyCards = overview.groups.some((g) => g.cards.length > 0);

  return (
    <div className="agents-page">
      <header className="agents-page__header">
        {onClose && (
          <button type="button" className="agents-back" onClick={onClose} aria-label="Back">
            {'←'}
          </button>
        )}
        <h1 className="agents-page__title">Agents</h1>
        <span className={`agents-page__summary${overview.stuck + overview.failed ? ' agents-page__summary--alert' : ''}`}>
          {headline(overview)}
        </span>
      </header>
      <div className="agents-page__body">
        {!overviewOverride && !live.loaded ? (
          <div className="agents-empty">Loading…</div>
        ) : (
          <>
            <Attention
              items={overview.attention}
              onOpenAgent={(serverId, agentId) => setDetail({ serverId, agentId })}
              onOpenSession={onOpenSession}
            />
            {overview.emptyLine && !anyCards && <div className="agents-empty">{overview.emptyLine}</div>}
            {overview.groups.map((g) =>
              g.cards.length ? (
                <div key={g.serverId} className="agents-server">
                  {overview.multiServer && <div className="agents-server__name">{g.serverName}</div>}
                  {g.cards.map((c) => (
                    <Card key={c.key} card={c} onOpenRow={openRow} onOpenSession={onOpenSession} />
                  ))}
                </div>
              ) : null,
            )}
            {finishedOnly.length > 0 && (
              <div className="agents-finished">
                <button
                  type="button"
                  className="agents-finished__line"
                  aria-expanded={finishedOpen}
                  onClick={() => setFinishedOpen((v) => !v)}
                >
                  <span className="agents-finished__text">
                    Finished in last 2h:{' '}
                    {finishedOnly
                      .map(({ c, g }) => `${c.title}${overview.multiServer ? ` (${g.serverName})` : ''} (${c.total})`)
                      .join(', ')}
                  </span>
                  <span aria-hidden>{finishedOpen ? '▴' : '›'}</span>
                </button>
                {finishedOpen &&
                  finishedOnly.map(({ c }) => (
                    <Card key={c.key} card={c} onOpenRow={openRow} onOpenSession={onOpenSession} />
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
