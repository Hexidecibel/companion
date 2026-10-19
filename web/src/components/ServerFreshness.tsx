import { useEffect, useState } from 'react';
import type { ConnectionState } from '../types';
import { getSummaryUpdatedAt } from '../services/offlineCache';
import { formatAgo } from '../utils/messageTime';

/**
 * A small pill next to a server's name while it is not connected and the
 * session list shown is the cached one: "Reconnecting · updated 3 min ago".
 * Renders nothing while connected. Ticks every 30 s only while shown.
 */
export function ServerFreshness({ serverId, status }: { serverId: string; status: ConnectionState['status'] }) {
  const live = status === 'connected';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);
  if (live) return null;
  const at = getSummaryUpdatedAt(serverId);
  const label = status === 'connecting' || status === 'reconnecting' ? 'Reconnecting' : 'Offline';
  return (
    <span className="server-freshness-pill" title={at ? `Showing the session list from ${new Date(at).toLocaleString()}` : undefined}>
      {label}{at ? ` · updated ${formatAgo(at, now)}` : ''}
    </span>
  );
}
