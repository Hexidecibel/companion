import { memo, useCallback } from 'react';
import type { SessionSummary } from '../../types';
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu';
import { formatAgo } from './SessionTile';
import { useTileMenu } from './useTileMenu';

export interface QuietRowProps {
  serverId: string;
  session: SessionSummary;
  serverLabel?: string;
  unseen?: boolean;
  now?: number;
  onOpen: (serverId: string, sessionId: string, pending: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/**
 * One compact line for a session with nothing going on (idle, or done and
 * already looked at): dot, name, relative time, unseen dot. Tap opens it;
 * long-press moves it within the Quiet section.
 */
export const QuietRow = memo(function QuietRow({
  serverId, session, serverLabel, unseen, now = Date.now(), onOpen, onMoveUp, onMoveDown,
}: QuietRowProps) {
  // Quiet rows never need the user, so they open without the pending-prompt flag.
  const open = useCallback(() => onOpen(serverId, session.id, false), [onOpen, serverId, session.id]);
  const { menu, closeMenu, handlers } = useTileMenu(open, !!onMoveUp || !!onMoveDown);
  const name = session.friendlyName || session.name;
  const time = session.lastActivity > 0 ? formatAgo(Math.max(0, now - session.lastActivity)) : '';
  const menuItems: ContextMenuEntry[] = [
    { label: 'Move up', onClick: () => onMoveUp?.(), disabled: !onMoveUp },
    { label: 'Move down', onClick: () => onMoveDown?.(), disabled: !onMoveDown },
    null,
    { label: 'Open', onClick: open },
  ];
  return (
    <div
      className={`mission-quiet${session.inactive ? ' mission-quiet--inactive' : ''}`}
      data-testid="mission-quiet"
      data-session-key={`${serverId}:${session.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name}, idle`}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}
      {...handlers}
    >
      <span className="mission-tile__dot mission-tile__dot--idle" aria-hidden="true" />
      <span className="mission-quiet__name">{name}</span>
      {serverLabel && <span className="mission-quiet__server">{serverLabel}</span>}
      {unseen && <span className="mission-tile__unseen" title="New activity" aria-label="New activity" />}
      <span className="mission-tile__time">{time}</span>
      {menu && <ContextMenu items={menuItems} position={menu} onClose={closeMenu} />}
    </div>
  );
});
