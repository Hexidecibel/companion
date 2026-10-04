import { memo } from 'react';
import { useStuckFindings } from '../../hooks/useStuck';

/** Sidebar / mobile list: a small amber "Stuck?" when a session looks stuck. */
export const StuckBadge = memo(function StuckBadge({ serverId, sessionId }: { serverId: string; sessionId: string }) {
  const findings = useStuckFindings(serverId, sessionId);
  if (!findings.length) return null;
  const top = findings[0];
  return (
    <span className={`stuck-badge${top.severity === 'high' ? ' stuck-badge--high' : ''}`} title={top.summary} aria-label={`Looks stuck: ${top.summary}`}>
      Stuck?
    </span>
  );
});
