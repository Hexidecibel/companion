import type { SessionSummary } from '../types';
import { formatAgo } from '../utils/messageTime';

/** Muted 2-line clamped Claude Code recap under a session in the session list. */
export function SessionRecap({ recap }: { recap?: SessionSummary['latestRecap'] }) {
  if (!recap || !recap.text) return null;
  const ts = Date.parse(recap.timestamp);
  const ago = Number.isFinite(ts) ? formatAgo(ts, Date.now()) : '';
  return (
    <div className="session-recap" title={ago ? `${recap.text} (${ago})` : recap.text}>
      {recap.text}
    </div>
  );
}
