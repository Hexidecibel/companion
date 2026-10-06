import { memo } from 'react';
import { useBabysit } from '../../hooks/useBabysit';
import { answersText } from '../../services/babysit';

/** Sidebar / mobile list: a small blue "Babysit" while Herald is answering for a session. */
export const BabysitBadge = memo(function BabysitBadge({ serverId, sessionId }: { serverId: string; sessionId: string }) {
  const { babysit, active } = useBabysit(serverId, sessionId);
  if (!babysit || !active) return null;
  const detail = `Herald is babysitting this session: ${answersText(babysit.answersUsed)} so far`;
  return (
    <span className="babysit-badge" title={detail} aria-label={detail}>
      Babysit
    </span>
  );
});
