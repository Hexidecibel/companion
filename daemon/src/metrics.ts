/**
 * Simple metrics singleton for tracking operational stats.
 * No external dependencies — just module-level counters.
 */

let messagesParsed = 0;
let tmuxOperations = 0;
let lastActivity: number | null = null;

export function incrementMessagesParsed(count: number = 1): void {
  messagesParsed += count;
}

export function incrementTmuxOperations(): void {
  tmuxOperations++;
}

export function updateLastActivity(): void {
  lastActivity = Date.now();
}

export function getMetrics(activeClients: number, sessionsWatched: number) {
  return {
    uptime_seconds: Math.floor(process.uptime()),
    active_clients: activeClients,
    sessions_watched: sessionsWatched,
    messages_parsed: messagesParsed,
    tmux_operations: tmuxOperations,
    memory_usage_mb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
    last_activity: lastActivity ? new Date(lastActivity).toISOString() : null,
  };
}
