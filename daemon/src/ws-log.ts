/**
 * WebSocket log volume control. Clients poll a handful of read-only requests
 * every few seconds (the terminal view ~2/s), which used to log two lines each
 * (">> recv" + "<< send"): ~400 lines/min with one app open. Those are now
 * counted and summarised once a minute instead; everything else (and every
 * failed response) is still logged per message. COMPANION_WS_DEBUG=1 restores
 * per-message logging for all of them.
 */
const POLLED_REQUESTS = new Set([
  'get_terminal_output',
  'get_agent_tree',
  'get_tasks',
  'get_server_summary',
  'get_work_groups',
  'get_status',
  'get_highlights',
  'herald_voice_status',
  'get_impact',
  'get_metrics',
  'stuck_list',
  'review_summary',
  'subagent_list',
]);
const POLLED_RESPONSES = new Set([
  'terminal_output',
  'agent_tree',
  'tasks',
  'server_summary',
  'work_groups',
  'status',
  'highlights',
  'herald_voice_status',
  'get_impact',
  'metrics',
  'stuck_list',
  'review_summary',
  'subagent_list',
]);

const counts = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

function debug(): boolean {
  return process.env.COMPANION_WS_DEBUG === '1';
}

function flush(): void {
  if (counts.size === 0) return;
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`);
  counts.clear();
  console.log(`WebSocket: polled requests in the last 60 s: ${parts.join(', ')}`);
}

function count(type: string): void {
  counts.set(type, (counts.get(type) || 0) + 1);
  if (!timer) {
    timer = setInterval(flush, 60_000);
    timer.unref?.();
  }
}

/** Log ">> recv" for this request type? (false = counted for the minute summary) */
export function logRecv(type: string): boolean {
  if (debug() || !POLLED_REQUESTS.has(type)) return true;
  count(type);
  return false;
}

/** Log "<< send" for this response? Failures always are. */
export function logSend(type: string, success: boolean | undefined): boolean {
  return debug() || success === false || !POLLED_RESPONSES.has(type);
}
