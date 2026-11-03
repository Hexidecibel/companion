import { memo, useCallback, useMemo, useState } from 'react';
import type { PendingPrompt, SessionSummary } from '../../types';
import { normalizeOptions } from '../QuestionBlock';
import { StuckBadge } from '../stuck/StuckBadge';
import { BabysitBadge } from '../babysit/BabysitBadge';
import { ProfileBadge } from '../ProfilePicker';
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu';
import { useStuckFindings } from '../../hooks/useStuck';
import { backgroundWorkLabel } from '../../utils/backgroundWork';
import { sendChoice } from '../../services/sendChoice';
import { missionState, type MissionState } from '../../services/missionState';
import { useTileMenu } from './useTileMenu';

export interface SessionTileProps {
  serverId: string;
  session: SessionSummary;
  /** Shown only when there are 2+ servers. */
  serverLabel?: string;
  /** The session did something since this device last opened it. */
  unseen?: boolean;
  /** Clock for relative times (MissionControl ticks it). */
  now?: number;
  /** needs_you / done / working / idle / error (default: derived from session + unseen). */
  state?: MissionState;
  /** Briefly highlighted (the "Needs you" strip pointed at it). */
  highlighted?: boolean;
  onOpen: (serverId: string, sessionId: string, pending: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/** Options that need typed text: never a one-tap answer on a tile. */
const FREE_TEXT_OPTION = /^(other|type something\.?|type here.*|chat about this\.?)$/i;

/** A prompt the tile can answer with one tap: one question, single choice. */
export function inlineAnswerable(p: PendingPrompt | undefined): boolean {
  if (!p) return false;
  if (p.kind !== 'choice' && p.kind !== 'approval' && p.kind !== 'trust') return false;
  if (p.multiSelect) return false;
  if ((p.questionCount ?? 1) > 1) return false;
  const opts = normalizeOptions(p.options);
  if (p.kind === 'trust') return opts.length >= 2;
  return opts.some((o) => !FREE_TEXT_OPTION.test(o.label.trim()));
}

export function formatAgo(ms: number): string {
  if (ms < 60_000) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** CSS tone per state (needs_you keeps the amber "waiting" style). */
export const TONE: Record<MissionState, string> = {
  needs_you: 'waiting', done: 'done', working: 'working', idle: 'idle', error: 'error',
};
export const STATE_LABEL: Record<MissionState, string> = {
  needs_you: 'needs you', done: 'done', working: 'working', idle: 'idle', error: 'error',
};

type AnswerState =
  | { step: 'sending'; signature: string; index: number }
  | { step: 'answered'; signature: string }
  | { step: 'stale'; signature: string }
  | { step: 'error'; signature: string };

export const SessionTile = memo(function SessionTile({
  serverId, session, serverLabel, unseen, state: stateProp, now = Date.now(), highlighted, onOpen, onMoveUp, onMoveDown,
}: SessionTileProps) {
  const stuck = useStuckFindings(serverId, session.id).length > 0;
  const state = stateProp ?? missionState(session, !!unseen);
  // Only a session that needs the user shows a prompt; a "done" one shows its report.
  const needs = state === 'needs_you';
  const prompt = needs ? session.pendingPrompt : undefined;
  const [answer, setAnswer] = useState<AnswerState | null>(null);

  // An answer state only belongs to the prompt it was made for.
  const current = answer && prompt && answer.signature === prompt.signature ? answer : null;
  const options = useMemo(() => (prompt ? normalizeOptions(prompt.options) : []), [prompt]);
  const inline = inlineAnswerable(prompt);

  const open = useCallback(() => onOpen(serverId, session.id, needs), [onOpen, serverId, session.id, needs]);
  const { menu, closeMenu, handlers } = useTileMenu(open, !!onMoveUp || !!onMoveDown);

  const choose = useCallback(async (index: number) => {
    if (!prompt) return;
    const signature = prompt.signature;
    setAnswer({ step: 'sending', signature, index });
    const result = await sendChoice(
      {
        selectedIndices: [index],
        optionCount: options.length,
        multiSelect: false,
        // The daemon answers the on-screen row with this label, never the index
        // alone (transcript and screen can list different rows).
        selectedLabels: [options[index].label],
        ...(prompt.kind === 'trust' ? { promptKind: 'trust' as const } : {}),
      },
      { serverId, sessionId: session.id, tmuxSessionName: session.tmuxSessionName, expectSignature: signature },
    );
    if (result.ok) setAnswer({ step: 'answered', signature });
    else setAnswer({ step: result.reason === 'stale' ? 'stale' : 'error', signature });
  }, [prompt, options, serverId, session.id, session.tmuxSessionName]);

  const menuItems: ContextMenuEntry[] = [
    { label: 'Move up', onClick: () => onMoveUp?.(), disabled: !onMoveUp },
    { label: 'Move down', onClick: () => onMoveDown?.(), disabled: !onMoveDown },
    null,
    { label: 'Open', onClick: open },
  ];

  const tone = stuck ? 'stuck' : TONE[state];
  const live = state === 'done'
    ? session.lastMessage || session.currentActivity
    : backgroundWorkLabel(session.backgroundWork) || session.currentActivity || session.lastMessage;
  const time = needs && session.waitingSince
    ? `waiting ${formatAgo(Math.max(0, now - session.waitingSince))}`
    : session.lastActivity > 0
      ? formatAgo(Math.max(0, now - session.lastActivity))
      : '';
  const name = session.friendlyName || session.name;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  let promptBody: React.ReactNode = null;
  if (needs) {
    if (current?.step === 'stale') {
      promptBody = (
        <button type="button" className="mission-tile__notice mission-tile__notice--stale" onClick={(e) => { stop(e); open(); }}>
          Prompt changed, tap to open
        </button>
      );
    } else if (current?.step === 'answered') {
      promptBody = <div className="mission-tile__notice" role="status">Answered</div>;
    } else if (prompt && inline) {
      const sending = current?.step === 'sending';
      const title = prompt.kind === 'trust' ? prompt.question.split('\n')[0] : prompt.question;
      promptBody = (
        <div className="mission-tile__prompt" onClick={stop} onTouchStart={stop}>
          {prompt.header && prompt.kind !== 'trust' && <div className="mission-tile__prompt-header">{prompt.header}</div>}
          {title && <div className="mission-tile__question">{title}</div>}
          <div className="mission-tile__options">
            {options.map((o, i) => (prompt.kind !== 'trust' && FREE_TEXT_OPTION.test(o.label.trim())) ? null : (
              <button
                key={i}
                type="button"
                className={`mission-tile__option${prompt.kind === 'trust' && i === 1 ? ' mission-tile__option--no' : ''}`}
                disabled={sending}
                title={o.description || undefined}
                onClick={() => { void choose(i); }}
              >
                {sending && current?.index === i ? 'Sending...' : o.label}
              </button>
            ))}
          </div>
          {current?.step === 'error' && (
            <div className="mission-tile__error" role="alert">Did not reach the session. Try again or open it.</div>
          )}
        </div>
      );
    } else {
      promptBody = (
        <div className="mission-tile__prompt">
          {prompt?.question && <div className="mission-tile__question">{prompt.question}</div>}
          <div className="mission-tile__open-hint">{prompt ? 'Open to answer' : 'Waiting for you, open to answer'}</div>
        </div>
      );
    }
  }

  return (
    <div
      className={`mission-tile mission-tile--${tone}${session.inactive ? ' mission-tile--inactive' : ''}${highlighted ? ' mission-tile--highlight' : ''}`}
      data-testid="mission-tile"
      data-session-key={`${serverId}:${session.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name}, ${STATE_LABEL[state]}`}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}
      {...handlers}
    >
      <div className="mission-tile__top">
        <span className={`mission-tile__dot mission-tile__dot--${tone}`} aria-hidden="true" />
        <span className="mission-tile__name">{name}</span>
        {session.agent === 'codex' && <span className="session-agent-label">Codex</span>}
        {session.profileId && <ProfileBadge label={session.profileLabel || session.profileId} />}
        <StuckBadge serverId={serverId} sessionId={session.id} />
        <BabysitBadge serverId={serverId} sessionId={session.id} />
        {unseen && <span className="mission-tile__unseen" title="New activity" aria-label="New activity" />}
        <span className={`mission-tile__time${needs ? ' mission-tile__time--waiting' : ''}`}>{time}</span>
      </div>
      {serverLabel && <div className="mission-tile__server">{serverLabel}</div>}
      {live && !promptBody && <div className="mission-tile__live">{live}</div>}
      {promptBody}
      {menu && (
        <ContextMenu items={menuItems} position={menu} onClose={closeMenu} />
      )}
    </div>
  );
});
